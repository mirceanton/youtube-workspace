import { describe, expect, it } from "vitest";
import {
  IDEA_PIPELINE,
  IDEA_STAGE_LABELS,
  IDEA_STAGE_TRANSITIONS,
  IDEA_STAGES,
  allowedNextStages,
  findIdeaStageTransition,
  ideaStageSchema,
  type IdeaStage,
  type IdeaStageTransition,
} from "../src/index.js";

/** The PRD 4 rules, derived independently from the pipeline order. */
function expectedTransition(from: IdeaStage, to: IdeaStage): IdeaStageTransition | undefined {
  if (from === "dropped") {
    return to === "inbox" ? { from, to, kind: "restore", requiresNote: false } : undefined;
  }
  if (to === "dropped") {
    return { from, to, kind: "drop", requiresNote: false };
  }
  const pipeline: readonly IdeaStage[] = IDEA_PIPELINE;
  const step = pipeline.indexOf(to) - pipeline.indexOf(from);
  if (step === 1) return { from, to, kind: "forward", requiresNote: false };
  if (step === -1) return { from, to, kind: "backward", requiresNote: true };
  return undefined;
}

describe("idea stages", () => {
  it("lists the PRD stages with the pipeline in order and dropped outside it", () => {
    expect(IDEA_STAGES).toEqual([
      "inbox",
      "shortlisted",
      "scripting",
      "filming",
      "editing",
      "published",
      "dropped",
    ]);
    expect(IDEA_PIPELINE).toEqual(IDEA_STAGES.filter((s) => s !== "dropped"));
    expect(Object.keys(IDEA_STAGE_LABELS).toSorted()).toEqual(IDEA_STAGES.toSorted());
  });

  it.each(IDEA_STAGES.flatMap((from) => IDEA_STAGES.map((to) => [from, to] as const)))(
    "%s -> %s matches the PRD rules",
    (from, to) => {
      expect(findIdeaStageTransition(from, to)).toEqual(expectedTransition(from, to));
    },
  );

  it("has no duplicate rows and no self-transitions", () => {
    const keys = IDEA_STAGE_TRANSITIONS.map((t) => `${t.from}->${t.to}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(IDEA_STAGE_TRANSITIONS.filter((t) => t.from === t.to)).toEqual([]);
  });

  it("requires a note exactly for backward moves", () => {
    for (const t of IDEA_STAGE_TRANSITIONS) {
      expect(t.requiresNote).toBe(t.kind === "backward");
    }
  });

  it("lists the valid next stages for error messages and menus", () => {
    expect(allowedNextStages("inbox")).toEqual(["shortlisted", "dropped"]);
    expect(allowedNextStages("scripting")).toEqual(["filming", "shortlisted", "dropped"]);
    expect(allowedNextStages("published")).toEqual(["editing", "dropped"]);
    expect(allowedNextStages("dropped")).toEqual(["inbox"]);
  });

  it("validates stage names with zod", () => {
    expect(ideaStageSchema.parse("filming")).toBe("filming");
    expect(ideaStageSchema.safeParse("archived").success).toBe(false);
  });
});
