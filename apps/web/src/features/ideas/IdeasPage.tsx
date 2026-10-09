import { useQuery } from "@tanstack/react-query";
import { IDEA_STAGE_LABELS, IDEA_STAGES, type IdeaStage } from "@ytw/shared/constants";
import type { Idea, ListIdeasQuery } from "@ytw/shared/api/ideas";
import { useMemo, useState, type DragEvent } from "react";
import { Link } from "react-router";
import { ArrowDown, ArrowUp, Columns3, List, Plus } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  WriteGuard,
  useWideLayout,
  useWriteGuard,
} from "@/kit";
import { IDEA_STAGE_TRANSITIONS } from "@ytw/shared/constants";
import { useCan } from "@/lib/session.ts";
import { describeError } from "@/lib/errors.ts";
import { usePersistedState } from "@/lib/persisted-state.ts";
import {
  BOARD_COLUMN_WIDTH_KEYS,
  BOARD_COLUMN_WIDTHS,
  DEFAULT_BOARD_COLUMN_WIDTH,
  boardGridColumns,
  isBoardColumnWidth,
} from "./board-columns.ts";
import { IdeaCard } from "./IdeaCard.tsx";
import { IdeaEditorDialog } from "./IdeaEditorDialog.tsx";
import { IdeaStagePicker } from "./IdeaStagePicker.tsx";
import { StageMoveDialog } from "./StageMoveDialog.tsx";
import { fetchIdeas, ideasQueryKey } from "./api.ts";

const IDEA_SORT_FIELDS = [
  "title",
  "status",
  "score",
  "source",
  "created_at",
  "updated_at",
  "status_changed_at",
] as const;
type IdeaSortField = (typeof IDEA_SORT_FIELDS)[number];
type IdeaSortOrder = "asc" | "desc";
type View = "board" | "table";

interface MoveRequest {
  idea: Idea;
  target: IdeaStage;
}

const PAGE_SIZE = 100;

export function Component() {
  useWideLayout(true);
  const canWrite = useCan("ideas", "write");
  const writeGuard = useWriteGuard("ideas");
  const [stage, setStage] = useState<IdeaStage | "">("");
  const [tag, setTag] = useState("");
  const [source, setSource] = useState("");
  const [scoreMin, setScoreMin] = useState("");
  const [scoreMax, setScoreMax] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [sortBy, setSortBy] = useState<IdeaSortField>("updated_at");
  const [sortOrder, setSortOrder] = useState<IdeaSortOrder>("desc");
  const [view, setView] = useState<View>("board");
  const [columnWidth, setColumnWidth] = usePersistedState(
    "ytw.ideas-board-column-width",
    DEFAULT_BOARD_COLUMN_WIDTH,
    isBoardColumnWidth,
  );
  const [offset, setOffset] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [moveRequest, setMoveRequest] = useState<MoveRequest | null>(null);
  const [draggedIdeaId, setDraggedIdeaId] = useState<string | null>(null);

  const filters = useMemo<Partial<ListIdeasQuery>>(
    () => ({
      ...(stage ? { stage } : {}),
      ...(tag.trim() ? { tag: tag.trim() } : {}),
      ...(scoreMin !== "" ? { score_min: Number(scoreMin) } : {}),
      ...(scoreMax !== "" ? { score_max: Number(scoreMax) } : {}),
      ...(source.trim() ? { source: source.trim() } : {}),
      sort_by: sortBy,
      sort_order: sortOrder,
      limit: PAGE_SIZE,
      offset,
      include_archived: includeArchived,
    }),
    [includeArchived, offset, scoreMax, scoreMin, sortBy, sortOrder, source, stage, tag],
  );

  const ideasQuery = useQuery({
    queryKey: ideasQueryKey.list(filters),
    queryFn: ({ signal }) => fetchIdeas(filters, signal),
  });

  const ideas = ideasQuery.data?.ideas ?? [];
  const page = ideasQuery.data?.page;
  const hasActiveFilters = Boolean(
    stage || tag.trim() || source.trim() || scoreMin || scoreMax || includeArchived,
  );

  function changeFilter<T>(setValue: (value: T) => void, value: T) {
    setValue(value);
    setOffset(0);
  }

  function toggleSort(field: IdeaSortField) {
    setOffset(0);
    if (sortBy === field) setSortOrder((current) => (current === "asc" ? "desc" : "asc"));
    else {
      setSortBy(field);
      setSortOrder(field === "title" || field === "status" || field === "source" ? "asc" : "desc");
    }
  }

  function moveTo(idea: Idea, target: IdeaStage) {
    if (target === idea.status) return;
    setMoveRequest({ idea, target });
  }

  function onDrop(event: DragEvent<HTMLElement>, target: IdeaStage) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain") || draggedIdeaId;
    const idea = ideas.find((candidate) => candidate.id === id);
    if (idea) moveTo(idea, target);
    setDraggedIdeaId(null);
  }

  const actions = (
    <WriteGuard resource="ideas" className="contents">
      <Button variant="primary" onClick={() => setCreateOpen(true)}>
        <Plus aria-hidden="true" className="size-4" />
        New idea
      </Button>
    </WriteGuard>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Ideas"
        description="Track video concepts from the inbox through production and publication."
        actions={actions}
      />

      {!writeGuard.allowed && writeGuard.message ? (
        <Alert tone="info" title="Ideas are read-only">
          {writeGuard.message}
        </Alert>
      ) : null}

      <Card className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <SelectField
          label="Filter by stage"
          value={stage}
          onChange={(event) => {
            const next = IDEA_STAGES.find((item) => item === event.target.value) ?? "";
            changeFilter(setStage, next);
          }}
        >
          <option value="">All stages</option>
          {IDEA_STAGES.map((item) => (
            <option key={item} value={item}>
              {IDEA_STAGE_LABELS[item]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Filter by tag"
          value={tag}
          onChange={(event) => changeFilter(setTag, event.target.value)}
          maxLength={64}
        />
        <TextField
          label="Source contains"
          value={source}
          onChange={(event) => changeFilter(setSource, event.target.value)}
          maxLength={200}
        />
        <TextField
          label="Minimum score"
          type="number"
          min={0}
          max={100}
          step={1}
          value={scoreMin}
          onChange={(event) => changeFilter(setScoreMin, event.target.value)}
        />
        <TextField
          label="Maximum score"
          type="number"
          min={0}
          max={100}
          step={1}
          value={scoreMax}
          onChange={(event) => changeFilter(setScoreMax, event.target.value)}
        />
        <label className="flex min-h-11 items-center gap-3 self-end rounded-lg border border-line px-3 py-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-5 accent-accent"
            checked={includeArchived}
            onChange={(event) => changeFilter(setIncludeArchived, event.target.checked)}
          />
          Include archived
        </label>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <fieldset className="flex items-center gap-2">
            <legend className="sr-only">Idea view</legend>
            <Button
              variant={view === "board" ? "primary" : "secondary"}
              aria-pressed={view === "board"}
              onClick={() => setView("board")}
            >
              <Columns3 aria-hidden="true" className="size-4" /> Board
            </Button>
            <Button
              variant={view === "table" ? "primary" : "secondary"}
              aria-pressed={view === "table"}
              onClick={() => setView("table")}
            >
              <List aria-hidden="true" className="size-4" /> Table
            </Button>
          </fieldset>
          {/* The board is only drawn from the md breakpoint up; phones get a single list. */}
          {view === "board" ? (
            <fieldset className="hidden items-center gap-2 md:flex">
              <legend className="sr-only">Board column width</legend>
              <span aria-hidden="true" className="text-sm text-ink-muted">
                Column width
              </span>
              {BOARD_COLUMN_WIDTH_KEYS.map((key) => (
                <Button
                  key={key}
                  variant={columnWidth === key ? "primary" : "secondary"}
                  aria-pressed={columnWidth === key}
                  onClick={() => setColumnWidth(key)}
                >
                  {BOARD_COLUMN_WIDTHS[key].label}
                </Button>
              ))}
            </fieldset>
          ) : null}
        </div>
        <p className="text-sm text-ink-muted" aria-live="polite">
          {page
            ? `${page.total.toLocaleString()} ${includeArchived ? "ideas" : "active ideas"}`
            : "Loading ideas"}
        </p>
      </div>

      {ideasQuery.isPending ? (
        <LoadingState label="Loading ideas" lines={5} />
      ) : ideasQuery.isError && !ideasQuery.data ? (
        <ErrorState
          error={ideasQuery.error}
          onRetry={() => void ideasQuery.refetch()}
          retrying={ideasQuery.isFetching}
        />
      ) : ideas.length === 0 ? (
        <EmptyState
          title={
            stage
              ? `No ${IDEA_STAGE_LABELS[stage].toLowerCase()} ideas`
              : hasActiveFilters
                ? "No ideas match these filters"
                : "No ideas yet"
          }
          description={
            hasActiveFilters
              ? "Try changing or clearing one of the filters."
              : "Create the first idea to start a channel pipeline."
          }
          action={
            canWrite && !hasActiveFilters ? (
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                Create an idea
              </Button>
            ) : undefined
          }
        />
      ) : view === "board" ? (
        <>
          {/* `relative`: the visually hidden (absolutely positioned) text in the cards must scroll with the board, not widen the page. */}
          <div
            className="relative hidden overflow-x-auto pb-3 md:block"
            aria-label="Ideas by stage"
          >
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: boardGridColumns(IDEA_STAGES.length, columnWidth) }}
            >
              {IDEA_STAGES.map((item) => {
                const stageIdeas = ideas.filter((idea) => idea.status === item);
                const nextStages = IDEA_STAGE_TRANSITIONS.filter((move) => move.from === item).map(
                  (move) => move.to,
                );
                return (
                  // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- these are pointer drop targets; the stage picker provides the keyboard and touch alternative.
                  <section
                    key={item}
                    aria-label={`${IDEA_STAGE_LABELS[item]} ideas`}
                    className="min-h-52 rounded-xl bg-subtle p-2"
                    onDragOver={(event) => {
                      if (writeGuard.allowed) event.preventDefault();
                    }}
                    onDrop={(event) => onDrop(event, item)}
                  >
                    <h2 className="mb-2 flex items-center justify-between gap-1 px-1 text-sm font-semibold">
                      <span>{IDEA_STAGE_LABELS[item]}</span>
                      <Badge>{stageIdeas.length}</Badge>
                    </h2>
                    {stageIdeas.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-line-strong px-2 py-5 text-center text-xs text-ink-muted">
                        Drop an idea here
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {stageIdeas.map((idea) => (
                          <li key={idea.id}>
                            <IdeaCard
                              idea={idea}
                              draggable={
                                writeGuard.allowed &&
                                idea.archived_at === null &&
                                nextStages.length > 0
                              }
                              onDragStart={(dragged, event) => {
                                setDraggedIdeaId(dragged.id);
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("text/plain", dragged.id);
                              }}
                              onMove={moveTo}
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
          <div className="space-y-3 md:hidden">
            <SelectField
              label="Show one stage"
              value={stage}
              onChange={(event) => {
                const next = IDEA_STAGES.find((item) => item === event.target.value) ?? "";
                changeFilter(setStage, next);
              }}
            >
              <option value="">All stages</option>
              {IDEA_STAGES.map((item) => (
                <option key={item} value={item}>
                  {IDEA_STAGE_LABELS[item]}
                </option>
              ))}
            </SelectField>
            {ideas.length === 0 ? (
              <EmptyState
                compact
                title={
                  stage
                    ? `No ${IDEA_STAGE_LABELS[stage].toLowerCase()} ideas`
                    : "No ideas match these filters"
                }
                description="Choose another stage or change the filters."
              />
            ) : (
              <ul className="flex flex-col gap-3">
                {ideas.map((idea) => (
                  <li key={idea.id}>
                    <IdeaCard idea={idea} onMove={moveTo} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[850px] border-collapse text-left text-sm">
            <caption className="sr-only">
              Ideas, sortable by title, stage, score, source or update time
            </caption>
            <thead className="border-b border-line bg-subtle text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <SortHeader
                  label="Title"
                  field="title"
                  sortBy={sortBy}
                  sortOrder={sortOrder}
                  onSort={toggleSort}
                />
                <SortHeader
                  label="Stage"
                  field="status"
                  sortBy={sortBy}
                  sortOrder={sortOrder}
                  onSort={toggleSort}
                />
                <SortHeader
                  label="Score"
                  field="score"
                  sortBy={sortBy}
                  sortOrder={sortOrder}
                  onSort={toggleSort}
                />
                <SortHeader
                  label="Source"
                  field="source"
                  sortBy={sortBy}
                  sortOrder={sortOrder}
                  onSort={toggleSort}
                />
                <th scope="col" className="px-3 py-3">
                  Tags
                </th>
                <SortHeader
                  label="Updated"
                  field="updated_at"
                  sortBy={sortBy}
                  sortOrder={sortOrder}
                  onSort={toggleSort}
                />
                <th scope="col" className="px-3 py-3">
                  Move to stage
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ideas.map((idea) => (
                <tr key={idea.id}>
                  <th scope="row" className="max-w-sm px-3 py-3 font-semibold">
                    <Link
                      to={`/ideas/${idea.id}`}
                      className="rounded text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {idea.title}
                    </Link>
                  </th>
                  <td className="px-3 py-3">
                    <Badge>{IDEA_STAGE_LABELS[idea.status]}</Badge>
                  </td>
                  <td className="px-3 py-3">{idea.score ?? "—"}</td>
                  <td className="max-w-48 truncate px-3 py-3">{idea.source ?? "—"}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1">
                      {idea.tags.map((item) => (
                        <Badge key={item}>{item}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <time
                      dateTime={idea.updated_at}
                      title={new Date(idea.updated_at).toLocaleString()}
                    >
                      {new Date(idea.updated_at).toLocaleDateString()}
                    </time>
                    <span className="mt-1 block text-xs text-ink-muted">{idea.updated_by}</span>
                  </td>
                  <td className="px-3 py-3">
                    <IdeaStagePicker
                      ideaId={idea.id}
                      title={idea.title}
                      stage={idea.status}
                      compact
                      disabled={idea.archived_at !== null}
                      onMove={(target) => moveTo(idea, target)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ideasQuery.isError && ideasQuery.data ? (
        <Alert tone="warn" title="Showing the last loaded results">
          {describeError(ideasQuery.error)}
        </Alert>
      ) : null}

      {page && page.total > PAGE_SIZE ? (
        <nav aria-label="Ideas pages" className="flex items-center justify-between gap-3">
          <p className="text-sm text-ink-muted">
            Showing {page.total === 0 ? 0 : offset + 1}–
            {Math.min(offset + ideas.length, page.total)} of {page.total.toLocaleString()}
          </p>
          <div className="flex gap-2">
            <Button
              disabled={offset === 0}
              onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
            >
              Previous
            </Button>
            <Button
              disabled={offset + PAGE_SIZE >= page.total}
              onClick={() => setOffset((current) => current + PAGE_SIZE)}
            >
              Next
            </Button>
          </div>
        </nav>
      ) : null}

      <IdeaEditorDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <StageMoveDialog
        idea={moveRequest?.idea ?? null}
        target={moveRequest?.target ?? null}
        onClose={() => setMoveRequest(null)}
        onMoved={() => setMoveRequest(null)}
      />
    </div>
  );
}

interface SortHeaderProps {
  label: string;
  field: IdeaSortField;
  sortBy: IdeaSortField;
  sortOrder: IdeaSortOrder;
  onSort: (field: IdeaSortField) => void;
}

function SortHeader({ label, field, sortBy, sortOrder, onSort }: SortHeaderProps) {
  const active = sortBy === field;
  return (
    <th
      scope="col"
      aria-sort={active ? (sortOrder === "asc" ? "ascending" : "descending") : "none"}
      className="px-3 py-2"
    >
      <Button variant="ghost" size="md" className="-ms-2" onClick={() => onSort(field)}>
        {label}
        {active ? (
          sortOrder === "asc" ? (
            <ArrowUp aria-hidden="true" className="size-3.5" />
          ) : (
            <ArrowDown aria-hidden="true" className="size-3.5" />
          )
        ) : null}
      </Button>
    </th>
  );
}
