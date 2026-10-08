import { describe, expect, it } from "vitest";
import {
  IDEA_PIPELINE,
  IDEA_STAGE_TRANSITIONS,
  IDEA_STAGES,
  allowedNextStages,
  findIdeaStageTransition,
  type IdeaStage,
  type IdeaStageTransition,
} from "../src/index.js";

/** The stage rules, derived independently from the pipeline order. */
function expectedTransition(from: IdeaStage, to: IdeaStage): IdeaStageTransition | undefined {
  if (from === "dropped") {
    return to === "inbox" ? { from, to, kind: "restore", requiresNote: false } : undefined;
  }
  if (to === "dropped") return { from, to, kind: "drop", requiresNote: false };
  const pipeline: readonly IdeaStage[] = IDEA_PIPELINE;
  const step = pipeline.indexOf(to) - pipeline.indexOf(from);
  if (step === 1) return { from, to, kind: "forward", requiresNote: false };
  if (step === -1) return { from, to, kind: "backward", requiresNote: true };
  return undefined;
}

describe("idea stage transitions", () => {
  it("keeps dropped outside the pipeline", () => {
    expect(IDEA_PIPELINE).toEqual(IDEA_STAGES.filter((stage) => stage !== "dropped"));
  });

  it.each(IDEA_STAGES.flatMap((from) => IDEA_STAGES.map((to) => [from, to] as const)))(
    "%s -> %s",
    (from, to) => {
      expect(findIdeaStageTransition(from, to)).toEqual(expectedTransition(from, to));
    },
  );

  it("has no duplicate rows, and requires a note exactly for backward moves", () => {
    const keys = IDEA_STAGE_TRANSITIONS.map((t) => `${t.from}->${t.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of IDEA_STAGE_TRANSITIONS) expect(t.requiresNote).toBe(t.kind === "backward");
  });

  it("lists the valid next stages for menus and error messages", () => {
    expect(allowedNextStages("inbox")).toEqual(["shortlisted", "dropped"]);
    expect(allowedNextStages("scripting")).toEqual(["filming", "shortlisted", "dropped"]);
    expect(allowedNextStages("dropped")).toEqual(["inbox"]);
  });
});
