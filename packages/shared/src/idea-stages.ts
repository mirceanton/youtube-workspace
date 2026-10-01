import { z } from "zod";

/** Every stage an idea can be in (PRD 4, "Idea stages"). */
export const IDEA_STAGES = [
  "inbox",
  "shortlisted",
  "scripting",
  "filming",
  "editing",
  "published",
  "dropped",
] as const;
export type IdeaStage = (typeof IDEA_STAGES)[number];
export const ideaStageSchema = z.enum(IDEA_STAGES);

/** The forward pipeline in order. `dropped` sits outside it. */
export const IDEA_PIPELINE = [
  "inbox",
  "shortlisted",
  "scripting",
  "filming",
  "editing",
  "published",
] as const satisfies readonly IdeaStage[];

export const IDEA_STAGE_LABELS: Readonly<Record<IdeaStage, string>> = {
  inbox: "Inbox",
  shortlisted: "Shortlisted",
  scripting: "Scripting",
  filming: "Filming",
  editing: "Editing",
  published: "Published",
  dropped: "Dropped",
};

/**
 * - `forward`: one stage ahead in the pipeline.
 * - `backward`: one stage back in the pipeline; a note explaining why is required.
 * - `drop`: any pipeline stage to `dropped`.
 * - `restore`: `dropped` back to `inbox`.
 */
export type IdeaTransitionKind = "forward" | "backward" | "drop" | "restore";

export interface IdeaStageTransition {
  readonly from: IdeaStage;
  readonly to: IdeaStage;
  readonly kind: IdeaTransitionKind;
  readonly requiresNote: boolean;
}

/**
 * Every allowed stage move, as data. Anything not listed here is rejected.
 *
 * The database function that moves ideas (T12) is the only enforcement point; its SQL must match
 * this table exactly and a test asserts that it does. Clients use the table only to offer valid
 * moves and to explain errors, never to decide what is allowed.
 */
export const IDEA_STAGE_TRANSITIONS: readonly IdeaStageTransition[] = [
  { from: "inbox", to: "shortlisted", kind: "forward", requiresNote: false },
  { from: "shortlisted", to: "scripting", kind: "forward", requiresNote: false },
  { from: "scripting", to: "filming", kind: "forward", requiresNote: false },
  { from: "filming", to: "editing", kind: "forward", requiresNote: false },
  { from: "editing", to: "published", kind: "forward", requiresNote: false },

  { from: "shortlisted", to: "inbox", kind: "backward", requiresNote: true },
  { from: "scripting", to: "shortlisted", kind: "backward", requiresNote: true },
  { from: "filming", to: "scripting", kind: "backward", requiresNote: true },
  { from: "editing", to: "filming", kind: "backward", requiresNote: true },
  { from: "published", to: "editing", kind: "backward", requiresNote: true },

  { from: "inbox", to: "dropped", kind: "drop", requiresNote: false },
  { from: "shortlisted", to: "dropped", kind: "drop", requiresNote: false },
  { from: "scripting", to: "dropped", kind: "drop", requiresNote: false },
  { from: "filming", to: "dropped", kind: "drop", requiresNote: false },
  { from: "editing", to: "dropped", kind: "drop", requiresNote: false },
  { from: "published", to: "dropped", kind: "drop", requiresNote: false },

  { from: "dropped", to: "inbox", kind: "restore", requiresNote: false },
];

/** The transition from `from` to `to`, or `undefined` when that move is not allowed. */
export function findIdeaStageTransition(
  from: IdeaStage,
  to: IdeaStage,
): IdeaStageTransition | undefined {
  return IDEA_STAGE_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** Stages an idea in `from` may move to, in table order. */
export function allowedNextStages(from: IdeaStage): IdeaStage[] {
  return IDEA_STAGE_TRANSITIONS.filter((t) => t.from === from).map((t) => t.to);
}
