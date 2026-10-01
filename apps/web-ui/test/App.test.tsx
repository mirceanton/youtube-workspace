import { cleanup, render, screen } from "@testing-library/react";
import { IDEA_PIPELINE, IDEA_STAGE_LABELS } from "@ytw/shared/constants";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App.tsx";

afterEach(cleanup);

describe("App", () => {
  it("renders the hello page with the idea pipeline from @ytw/shared", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { level: 1, name: "YouTube Channel Workspace" }),
    ).toBeTruthy();
    const stages = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(stages).toEqual(IDEA_PIPELINE.map((stage) => IDEA_STAGE_LABELS[stage]));
  });
});
