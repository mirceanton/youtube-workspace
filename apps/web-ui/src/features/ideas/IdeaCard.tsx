import { IDEA_STAGE_LABELS, type IdeaStage } from "@ytw/shared/constants";
import type { Idea } from "@ytw/shared/api/ideas";
import type { DragEvent } from "react";
import { GripVertical } from "lucide-react";
import { Link } from "react-router";
import { Badge, Card, LastChangedBy } from "@/kit";
import { formatRelativeTime } from "@/lib/format.ts";
import { IdeaStagePicker } from "./IdeaStagePicker.tsx";

export interface IdeaCardProps {
  idea: Idea;
  draggable?: boolean;
  onMove: (idea: Idea, stage: IdeaStage) => void;
  onDragStart?: (idea: Idea, event: DragEvent<HTMLButtonElement>) => void;
}

export function IdeaCard({ idea, draggable = false, onMove, onDragStart }: IdeaCardProps) {
  return (
    <article>
      <Card className="flex flex-col gap-3 p-3 shadow-sm transition-shadow hover:shadow-md">
        <div className="flex items-start justify-between gap-2">
          <Link
            to={`/ideas/${idea.id}`}
            className="min-h-11 min-w-0 flex-1 rounded-md text-base font-semibold leading-snug text-link hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {idea.title}
          </Link>
          {idea.score === null ? (
            <Badge>Unscored</Badge>
          ) : (
            <Badge tone={idea.score >= 70 ? "ok" : "neutral"}>Score {idea.score}</Badge>
          )}
          {draggable && onDragStart ? (
            <button
              type="button"
              draggable
              aria-label={`Drag ${idea.title} to another stage`}
              title="Drag to a new stage, or use the stage menu below."
              onDragStart={(event) => onDragStart(idea, event)}
              className="-mr-1 -mt-1 inline-flex size-11 shrink-0 cursor-grab items-center justify-center rounded-lg text-ink-muted active:cursor-grabbing"
            >
              <GripVertical aria-hidden="true" className="size-5" />
            </button>
          ) : null}
        </div>
        {idea.pitch ? <p className="line-clamp-3 text-sm text-ink-muted">{idea.pitch}</p> : null}
        {idea.tags.length > 0 ? (
          <ul aria-label="Tags" className="flex flex-wrap gap-1.5">
            {idea.tags.map((tag) => (
              <li key={tag}>
                <Badge>{tag}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-col gap-2 border-t border-line pt-2">
          <LastChangedBy actor={idea.updated_by} at={idea.updated_at} />
          <IdeaStagePicker
            ideaId={idea.id}
            title={idea.title}
            stage={idea.status}
            compact
            disabled={idea.archived_at !== null}
            onMove={(stage) => onMove(idea, stage)}
          />
        </div>
        <span className="sr-only">
          Current stage: {IDEA_STAGE_LABELS[idea.status]}. Updated{" "}
          {formatRelativeTime(idea.updated_at)}.
        </span>
      </Card>
    </article>
  );
}
