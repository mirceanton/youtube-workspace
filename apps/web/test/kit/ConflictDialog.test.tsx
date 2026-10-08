import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConflictDialog } from "../../src/kit/ConflictDialog.tsx";
import { LastChangedBy } from "../../src/kit/LastChangedBy.tsx";
import { ConflictError } from "../../src/lib/errors.ts";
import { expectNoA11yViolations } from "../helpers/a11y.ts";

const error = new ConflictError("Version 3 is no longer the latest; the latest is version 5.", {
  version: 5,
});

function setup(props: Partial<React.ComponentProps<typeof ConflictDialog>> = {}) {
  const handlers = {
    onReload: vi.fn<() => void>(),
    onMerge: vi.fn<() => void>(),
    onKeepEditing: vi.fn<() => void>(),
  };
  const view = render(<ConflictDialog open entity="idea" error={error} {...handlers} {...props} />);
  return { ...view, ...handlers };
}

describe("ConflictDialog", () => {
  it("renders nothing while closed", () => {
    setup({ open: false });
    expect(screen.queryByText(/changed while you were editing/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep editing" })).toBeNull();
  });

  it("explains the conflict with the server's message, naming the entity", () => {
    setup();
    expect(
      screen.getByRole("dialog", { name: "This idea changed while you were editing" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/the latest is version 5/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is overwritten unless you choose to/)).toBeInTheDocument();
  });

  it("falls back to a generic message without a server message", () => {
    setup({ error: null, entity: "script" });
    expect(
      screen.getByText(/Someone else saved a newer version of this script/),
    ).toBeInTheDocument();
  });

  it("offers reload, merge and keep editing, and never a save-anyway", () => {
    setup();
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toContain("Keep editing");
    expect(names).toContain("Discard mine and reload");
    expect(names).toContain("Merge my changes");
    expect(names.join(" ")).not.toMatch(/overwrite|save anyway|force/i);
  });

  it("omits merge when the screen cannot merge", () => {
    setup({ onMerge: undefined });
    expect(screen.queryByRole("button", { name: "Merge my changes" })).toBeNull();
    expect(screen.getByRole("button", { name: "Discard mine and reload" })).toBeInTheDocument();
  });

  it("calls the matching handler for each choice", async () => {
    const user = userEvent.setup();
    const { onReload, onMerge, onKeepEditing } = setup();
    await user.click(screen.getByRole("button", { name: "Discard mine and reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Merge my changes" }));
    expect(onMerge).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it("treats Escape and the close button as keep editing (never as reload)", async () => {
    const user = userEvent.setup();
    const { onReload, onKeepEditing } = setup();
    const dialog = screen.getByRole("dialog");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onKeepEditing).toHaveBeenCalledTimes(2);
    expect(onReload).not.toHaveBeenCalled();
  });

  it("treats a click on the backdrop as keep editing", () => {
    const { onKeepEditing, onReload } = setup();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
  });

  it("does not close when the content inside is clicked", async () => {
    const user = userEvent.setup();
    const { onKeepEditing } = setup({ latest: <p>latest text</p> });
    await user.click(screen.getByText("latest text"));
    expect(onKeepEditing).not.toHaveBeenCalled();
  });

  it("puts initial focus on Keep editing, the one choice that loses nothing", () => {
    setup();
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
  });

  it("shows who changed it and both versions side by side", () => {
    setup({
      changedBy: <LastChangedBy actor="research-agent" actorType="agent" at={new Date()} />,
      yours: <p>My title</p>,
      latest: <p>Their title</p>,
    });
    expect(screen.getByText("research-agent")).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your changes" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Latest version" })).toBeInTheDocument();
    expect(screen.getByText("My title")).toBeInTheDocument();
    expect(screen.getByText("Their title")).toBeInTheDocument();
  });

  it("closes when the parent sets open to false", () => {
    const view = setup();
    view.rerender(
      <ConflictDialog
        open={false}
        entity="idea"
        onReload={vi.fn<() => void>()}
        onKeepEditing={vi.fn<() => void>()}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("has no accessibility violations", async () => {
    const { baseElement } = setup({
      changedBy: <LastChangedBy actor="owner" at={new Date()} />,
      yours: <p>A</p>,
      latest: <p>B</p>,
    });
    await expectNoA11yViolations(baseElement);
  });
});
