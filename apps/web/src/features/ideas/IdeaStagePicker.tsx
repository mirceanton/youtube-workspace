import { IDEA_STAGE_LABELS, IDEA_STAGES, type IdeaStage } from "@ytw/shared/constants";
import { SelectField, WriteGuard } from "@/kit";

export interface IdeaStagePickerProps {
  ideaId: string;
  title: string;
  stage: IdeaStage;
  onMove: (stage: IdeaStage) => void;
  compact?: boolean;
  disabled?: boolean;
}

/** Explicit stage control for touch, keyboard and screen-reader users. Rules remain server enforced. */
export function IdeaStagePicker({
  ideaId,
  title,
  stage,
  onMove,
  compact = false,
  disabled = false,
}: IdeaStagePickerProps) {
  return (
    <WriteGuard resource="ideas" explain={!compact}>
      <SelectField
        label={`Move ${title} to stage`}
        hideLabel
        value={stage}
        disabled={disabled}
        onChange={(event) => {
          const next = IDEA_STAGES.find((candidate) => candidate === event.target.value);
          if (next && next !== stage) onMove(next);
        }}
        aria-label={`Move ${title} to stage`}
        data-idea-stage-picker={ideaId}
        className="min-w-32"
      >
        {IDEA_STAGES.map((item) => (
          <option key={item} value={item}>
            {IDEA_STAGE_LABELS[item]}
          </option>
        ))}
      </SelectField>
    </WriteGuard>
  );
}
