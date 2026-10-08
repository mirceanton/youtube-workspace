/**
 * Typed wrappers for packaging experiments: `create_experiment`, `update_experiment_status`,
 * `record_variant_stats`, `conclude_experiment`, and `getExperiment` to read one back with its
 * variants.
 *
 * An experiment moves planned -> running -> concluded, or to cancelled from planned or running;
 * concluded and cancelled are final. A move the machine forbids is an {@link InvalidTransitionError}
 * whose `allowed` lists the valid next statuses; a stale `expectedVersion` is a
 * {@link VersionConflictError} (`latestVersion`); a winner that is not one of the experiment's own
 * variants is a {@link ValidationError} (`field` "winner_variant_id", `allowed` the valid ids) raised
 * before anything is written.
 *
 * Variant impressions and CTR come back as strings (`bigint` and `numeric` are exact in the
 * database); pass numbers, or strings for exact values.
 */
import type { ExperimentStatus, ExperimentType } from "@ytw/shared/constants";
import { rejectNul, requireInteger, requireUuid } from "./args.js";
import type { ActorTx, Queryable } from "./client.js";
import { decimalText, type DecimalInput } from "./value-args.js";

/** An experiment as stored. */
export interface ExperimentRecord {
  id: string;
  videoId: string;
  type: ExperimentType;
  hypothesis: string | null;
  status: ExperimentStatus;
  /** When it was set running; null before. */
  startsAt: Date | null;
  /** When a running experiment was concluded or cancelled; null before. */
  endsAt: Date | null;
  /** The winning variant of a concluded experiment; null while open, or when no variant won. */
  winnerVariantId: string | null;
  conclusion: string | null;
  /** Optimistic-concurrency version: pass it as `expectedVersion` when changing the status. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

/** A variant as stored. */
export interface VariantRecord {
  id: string;
  experimentId: string;
  /** Short name, unique within the experiment (compared ignoring case and surrounding spaces). */
  label: string;
  /** The title or description text, or the thumbnail's URL or path. */
  content: string;
  isControl: boolean;
  impressions: string | null;
  /** Click-through rate in percent, 0 to 100. */
  ctr: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

export interface ExperimentWithVariants extends ExperimentRecord {
  /** The control first, then the others by label. */
  variants: VariantRecord[];
}

const EXPERIMENT_COLUMNS = `id, video_id AS "videoId", type, hypothesis, status,
       starts_at AS "startsAt", ends_at AS "endsAt", winner_variant_id AS "winnerVariantId",
       conclusion, version, created_at AS "createdAt", updated_at AS "updatedAt",
       created_by AS "createdBy", updated_by AS "updatedBy"`;

const VARIANT_COLUMNS = `id, experiment_id AS "experimentId", label, content,
       is_control AS "isControl", impressions::text AS impressions, ctr::text AS ctr,
       created_at AS "createdAt", updated_at AS "updatedAt", created_by AS "createdBy",
       updated_by AS "updatedBy"`;

export interface VariantInput {
  /** 1-200 characters, unique within the experiment. */
  label: string;
  /** What is tested: the title or description text, or the thumbnail's URL or path. */
  content: string;
  /** Exactly one variant of an experiment is the control (the current version). */
  isControl?: boolean;
}

export interface CreateExperimentInput {
  videoId: string;
  type: ExperimentType;
  /** What you expect to happen; up to 20 000 characters. */
  hypothesis?: string | null;
  /** 2 to 10 variants, exactly one of them the control. */
  variants: readonly VariantInput[];
}

/**
 * Creates a planned experiment with its variants in one call (`create_experiment`). The video must
 * exist ({@link NotFoundError}) and not be archived ({@link InvalidTransitionError}).
 */
export async function createExperiment(
  tx: ActorTx,
  input: CreateExperimentInput,
): Promise<ExperimentWithVariants> {
  requireUuid("video_id", input.videoId);
  rejectNul("type", input.type);
  rejectNul("hypothesis", input.hypothesis);
  const variants = Array.isArray(input.variants)
    ? input.variants.map((variant: unknown) => variantJson(variant))
    : input.variants;
  const { rows } = await tx.query<ExperimentRecord>(
    `SELECT ${EXPERIMENT_COLUMNS}
       FROM public.create_experiment($1::text, $2::text, $3::uuid, $4::uuid, $5::text, $6::text,
                                     $7::jsonb)`,
    [
      tx.actor.name,
      tx.actor.type,
      tx.actor.tokenId,
      input.videoId,
      input.type,
      input.hypothesis ?? null,
      JSON.stringify(variants),
    ],
  );
  const experiment = firstRow(rows, "create_experiment");
  return { ...experiment, variants: await listVariants(tx, experiment.id) };
}

export interface UpdateExperimentStatusInput {
  id: string;
  /** The `version` of the experiment the caller read. */
  expectedVersion: number;
  /**
   * `running` or `cancelled`. Concluding is {@link concludeExperiment}, which also records the
   * winner and the conclusion; asking for `concluded` here is a {@link ValidationError} saying so.
   */
  newStatus: ExperimentStatus;
}

/**
 * Starts (`running`) or cancels an experiment (`update_experiment_status`). Starting sets
 * `startsAt`; cancelling a running experiment sets `endsAt`. A move the status machine forbids
 * fails with {@link InvalidTransitionError}, `allowed` listing the valid next statuses.
 */
export async function updateExperimentStatus(
  tx: ActorTx,
  input: UpdateExperimentStatusInput,
): Promise<ExperimentRecord> {
  requireUuid("id", input.id);
  requireInteger("expected_version", input.expectedVersion);
  rejectNul("new_status", input.newStatus);
  const { rows } = await tx.query<ExperimentRecord>(
    `SELECT ${EXPERIMENT_COLUMNS}
       FROM public.update_experiment_status($1::text, $2::text, $3::uuid, $4::uuid, $5::integer,
                                            $6::text)`,
    [
      tx.actor.name,
      tx.actor.type,
      tx.actor.tokenId,
      input.id,
      input.expectedVersion,
      input.newStatus,
    ],
  );
  return firstRow(rows, "update_experiment_status");
}

export interface RecordVariantStatsInput {
  /** The id of the variant (a {@link VariantRecord} `id`), not of the experiment. */
  variantId: string;
  /** Whole number, at least 0; omitted or null leaves the stored value as it is. */
  impressions?: DecimalInput | null;
  /** Percent from 0 to 100 (4.5 means 4.5 %); omitted or null leaves the stored value as it is. */
  ctr?: DecimalInput | null;
}

/**
 * Records the impressions and/or CTR of one variant (`record_variant_stats`), while its experiment
 * is planned or running; a concluded or cancelled experiment refuses with an
 * {@link InvalidTransitionError} (reason `terminal`). Give at least one of the two values. The last
 * writer wins; recording the stored values again changes nothing.
 */
export async function recordVariantStats(
  tx: ActorTx,
  input: RecordVariantStatsInput,
): Promise<VariantRecord> {
  requireUuid("variant_id", input.variantId);
  const impressions =
    input.impressions === undefined || input.impressions === null
      ? null
      : decimalText("impressions", input.impressions);
  const ctr = input.ctr === undefined || input.ctr === null ? null : decimalText("ctr", input.ctr);
  const { rows } = await tx.query<VariantRecord>(
    `SELECT ${VARIANT_COLUMNS}
       FROM public.record_variant_stats($1::text, $2::text, $3::uuid, $4::uuid, $5::numeric,
                                        $6::numeric)`,
    [tx.actor.name, tx.actor.type, tx.actor.tokenId, input.variantId, impressions, ctr],
  );
  return firstRow(rows, "record_variant_stats");
}

export interface ConcludeExperimentInput {
  id: string;
  /** The `version` of the experiment the caller read. */
  expectedVersion: number;
  /**
   * The winning variant: one of this experiment's own variants, or null when no variant won. A
   * foreign or unknown id fails with a {@link ValidationError} listing the valid ids.
   */
  winnerVariantId: string | null;
  /** What the experiment showed; required, up to 20 000 characters. */
  conclusion: string;
}

/**
 * Concludes a running experiment (`conclude_experiment`): status `concluded`, the winner and the
 * conclusion. Final: concluding twice, or concluding a planned or cancelled experiment, fails with
 * an {@link InvalidTransitionError}.
 */
export async function concludeExperiment(
  tx: ActorTx,
  input: ConcludeExperimentInput,
): Promise<ExperimentRecord> {
  requireUuid("id", input.id);
  requireInteger("expected_version", input.expectedVersion);
  if (input.winnerVariantId !== null) {
    requireUuid("winner_variant_id", input.winnerVariantId);
  }
  rejectNul("conclusion", input.conclusion);
  const { rows } = await tx.query<ExperimentRecord>(
    `SELECT ${EXPERIMENT_COLUMNS}
       FROM public.conclude_experiment($1::text, $2::text, $3::uuid, $4::uuid, $5::integer,
                                       $6::uuid, $7::text)`,
    [
      tx.actor.name,
      tx.actor.type,
      tx.actor.tokenId,
      input.id,
      input.expectedVersion,
      input.winnerVariantId,
      input.conclusion,
    ],
  );
  return firstRow(rows, "conclude_experiment");
}

/** One experiment with its variants, or null. Needs only SELECT on the two tables. */
export async function getExperiment(
  db: Queryable,
  id: string,
): Promise<ExperimentWithVariants | null> {
  requireUuid("id", id);
  const { rows } = await db.query<ExperimentRecord>(
    `SELECT ${EXPERIMENT_COLUMNS} FROM public.experiments WHERE id = $1::uuid`,
    [id],
  );
  const experiment = rows[0];
  return experiment === undefined
    ? null
    : { ...experiment, variants: await listVariants(db, experiment.id) };
}

/** The variants of an experiment: the control first, then by label. */
async function listVariants(db: Queryable, experimentId: string): Promise<VariantRecord[]> {
  const { rows } = await db.query<VariantRecord>(
    `SELECT ${VARIANT_COLUMNS}
       FROM public.experiment_variants
      WHERE experiment_id = $1::uuid
      ORDER BY is_control DESC, label, id`,
    [experimentId],
  );
  return rows;
}

/** A variant with the names the database function knows; unknown keys go through to be refused. */
function variantJson(variant: unknown): unknown {
  if (typeof variant !== "object" || variant === null || Array.isArray(variant)) {
    return variant;
  }
  const json: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(variant)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      rejectNul(key, value);
    }
    json[key === "isControl" ? "is_control" : key] = value;
  }
  return json;
}

function firstRow<R>(rows: R[], fn: string): R {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`${fn} returned no row`);
  }
  return row;
}
