import { fireEvent, render, screen, within } from "@testing-library/react";
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

  it("keeps changed text visible in the bounded large-script phone diff", () => {
    const before = Array.from({ length: 700 }, (_, index) => `line ${index}`).join("\n");
    const afterLines = before.split("\n");
    afterLines[350] = "edited line 350";
    render(
      <ScriptDiff
        before={before}
        after={afterLines.join("\n")}
        beforeLabel="Version 1"
        afterLabel="Version 2"
      />,
    );

    const unified = screen.getByRole("list", { name: "Unified script diff" });
    expect(within(unified).getByText("line 350")).toBeInTheDocument();
    expect(within(unified).getByText("edited line 350")).toBeInTheDocument();
    expect(within(unified).getAllByRole("listitem")).toHaveLength(16);
  });

  it("opens complete version text so sparse changes outside the preview remain inspectable", () => {
    const before = Array.from({ length: 700 }, (_, index) => `line ${index}`).join("\n");
    const afterLines = before.split("\n");
    afterLines[0] = "changed first";
    afterLines[350] = "changed middle";
    render(
      <ScriptDiff
        before={before}
        after={afterLines.join("\n")}
        beforeLabel="Version 1"
        afterLabel="Version 2"
      />,
    );

    const unified = screen.getByRole("list", { name: "Unified script diff" });
    expect(within(unified).queryByText("changed middle")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Show complete versions"));
    expect(screen.getByRole("region", { name: "Version 2 complete text" })).toHaveTextContent(
      "changed middle",
    );
  });
});
