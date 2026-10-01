import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "../../src/kit/Button.tsx";
import { useWriteGuard } from "../../src/kit/useWriteGuard.ts";
import { WriteGuard } from "../../src/kit/WriteGuard.tsx";
import { expectNoA11yViolations } from "../helpers/a11y.ts";
import { personaSession, renderWithSession, sessionWith, setOnline } from "../helpers/render.tsx";

afterEach(() => {
  setOnline(true);
});

function Form() {
  return (
    <WriteGuard resource="ideas">
      <label>
        Title
        <input defaultValue="" />
      </label>
      <Button>Save</Button>
    </WriteGuard>
  );
}

describe("WriteGuard", () => {
  it("leaves the controls alone when the user has Write and is online", () => {
    renderWithSession(<Form />, { session: personaSession("owner") });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByLabelText("Title")).toBeEnabled();
    expect(screen.queryByText(/read-only/i)).toBeNull();
  });

  it("disables every control and says why when the user only has Read", () => {
    renderWithSession(<Form />, { session: sessionWith({ ideas: "read" }) });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.getByText(/read-only access to ideas/i)).toBeInTheDocument();
    expect(screen.getByRole("group")).toHaveAccessibleDescription(/read-only access to ideas/i);
  });

  it("disables for a user with None as well", () => {
    renderWithSession(<Form />, { session: sessionWith({ ideas: "none", notes: "write" }) });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("checks the level of the resource it is given, not of any other", () => {
    renderWithSession(
      <WriteGuard resource="notes">
        <Button>Add note</Button>
      </WriteGuard>,
      { session: sessionWith({ ideas: "write", notes: "read" }) },
    );
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();
    expect(screen.getByText(/read-only access to notes/i)).toBeInTheDocument();
  });

  it("can hide the controls from read-only users instead", () => {
    renderWithSession(
      <WriteGuard resource="ideas" whenReadOnly="hide">
        <Button>Archive</Button>
      </WriteGuard>,
      { session: sessionWith({ ideas: "read" }) },
    );
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("can skip the explanation", () => {
    renderWithSession(
      <WriteGuard resource="ideas" explain={false}>
        <Button>Save</Button>
      </WriteGuard>,
      { session: sessionWith({ ideas: "read" }) },
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByText(/read-only/i)).toBeNull();
  });

  it("disables with an offline explanation when the connection drops, and re-enables on reconnect", () => {
    renderWithSession(<Form />, { session: personaSession("owner") });
    act(() => setOnline(false));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    act(() => setOnline(true));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByText(/You are offline/)).toBeNull();
  });

  it("keeps offline controls visible even in hide mode (they come back with the connection)", () => {
    renderWithSession(
      <WriteGuard resource="ideas" whenReadOnly="hide">
        <Button>Save</Button>
      </WriteGuard>,
      { session: personaSession("owner") },
    );
    act(() => setOnline(false));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("reports the offline reason before the permission reason", () => {
    renderWithSession(<Form />, { session: sessionWith({ ideas: "read" }) });
    act(() => setOnline(false));
    expect(screen.getByText(/You are offline/)).toBeInTheDocument();
    expect(screen.queryByText(/read-only/i)).toBeNull();
  });

  it("does not remount its children when the state flips: half-typed text survives a dropped connection", async () => {
    const user = userEvent.setup();
    renderWithSession(<Form />, { session: personaSession("owner") });
    await user.type(screen.getByLabelText("Title"), "My half-written title");
    act(() => setOnline(false));
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.getByLabelText("Title")).toHaveValue("My half-written title");
    act(() => setOnline(true));
    expect(screen.getByLabelText("Title")).toHaveValue("My half-written title");
    expect(screen.getByLabelText("Title")).toBeEnabled();
  });

  it("has no accessibility violations enabled or disabled", async () => {
    const enabled = renderWithSession(<Form />, { session: personaSession("owner") });
    await expectNoA11yViolations(enabled.container);
    enabled.unmount();
    const disabled = renderWithSession(<Form />, { session: sessionWith({ ideas: "read" }) });
    await expectNoA11yViolations(disabled.container);
  });
});

function Probe() {
  const state = useWriteGuard("scripts");
  return <output>{`${state.allowed}|${state.reason}|${state.message ?? ""}`}</output>;
}

describe("useWriteGuard", () => {
  it("returns the decision and the reason", () => {
    const owner = renderWithSession(<Probe />, { session: personaSession("owner") });
    expect(screen.getByRole("status")).toHaveTextContent("true|null|");
    owner.unmount();

    renderWithSession(<Probe />, { session: sessionWith({ scripts: "read" }) });
    expect(screen.getByRole("status")).toHaveTextContent(
      "false|no-access|You have read-only access to scripts",
    );
  });
});
