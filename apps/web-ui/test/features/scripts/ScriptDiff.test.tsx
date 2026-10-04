import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScriptDiff } from "../../../src/features/scripts/ScriptDiff.tsx";

describe("ScriptDiff", () => {
  it("renders the comparison on desktop and as a unified diff for phones", () => {
    render(
      <ScriptDiff
        before={"Opening\nOld line\nEnding"}
        after={"Opening\nNew line\nEnding"}
        beforeLabel="Version 1"
        afterLabel="Version 2"
      />,
    );

    expect(screen.getByRole("heading", { name: "Version 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Version 2" })).toBeInTheDocument();
    const unified = screen.getByRole("list", { name: "Unified script diff" });
    const unifiedLines = within(unified).getAllByRole("listitem");
    expect(unifiedLines[1]).toHaveTextContent("−Old line");
    expect(unifiedLines[2]).toHaveTextContent("+New line");
    expect(screen.getByRole("list", { name: "Version 1 lines" })).toHaveTextContent("Old line");
    expect(screen.getByRole("list", { name: "Version 2 lines" })).toHaveTextContent("New line");
    expect(screen.getByText("1 added lines, 1 removed lines.")).toBeInTheDocument();
  });
});
