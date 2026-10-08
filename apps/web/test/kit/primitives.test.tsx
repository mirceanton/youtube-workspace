import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Alert } from "../../src/kit/Alert.tsx";
import { Badge } from "../../src/kit/Badge.tsx";
import { Button } from "../../src/kit/Button.tsx";
import { buttonClasses } from "../../src/kit/button-styles.ts";
import { Dialog } from "../../src/kit/Dialog.tsx";
import { SelectField, TextAreaField, TextField } from "../../src/kit/Field.tsx";
import { LastChangedBy } from "../../src/kit/LastChangedBy.tsx";
import { PageHeader } from "../../src/kit/PageHeader.tsx";
import { RequireAccess } from "../../src/kit/RequireAccess.tsx";
import { EmptyState, ErrorState, LoadingState } from "../../src/kit/states.tsx";
import { useOnlineStatus } from "../../src/kit/useOnlineStatus.ts";
import { ApiError, ForbiddenError, NetworkError } from "../../src/lib/errors.ts";
import { formatRelativeTime } from "../../src/lib/format.ts";
import { expectNoA11yViolations } from "../helpers/a11y.ts";
import { personaSession, renderWithSession, sessionWith, setOnline } from "../helpers/render.tsx";

afterEach(() => {
  setOnline(true);
});

function RefProbe() {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <Button ref={ref} data-testid="b" onClick={() => ref.current?.setAttribute("data-clicked", "")}>
      Go
    </Button>
  );
}

describe("Button", () => {
  it("is at least 44 px tall (and wide, for icon buttons)", () => {
    expect(buttonClasses()).toContain("min-h-11");
    expect(buttonClasses("primary", "icon")).toContain("min-h-11");
    expect(buttonClasses("primary", "icon")).toContain("min-w-11");
  });

  it("defaults to type=button so it never submits a form by accident", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "button");
  });

  it("is disabled and marked busy while an action runs", () => {
    render(<Button busy>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("passes refs and other props through", () => {
    render(<RefProbe />);
    fireEvent.click(screen.getByTestId("b"));
    expect(screen.getByTestId("b")).toHaveAttribute("data-clicked");
  });
});

describe("fields", () => {
  it("labels the input and wires hint and error text to it", () => {
    render(
      <TextField label="Title" hint="Shown on the board" error="Title is required" required />,
    );
    const input = screen.getByLabelText(/Title/);
    expect(input).toBeRequired();
    expect(input).toBeInvalid();
    expect(input).toHaveAccessibleDescription("Shown on the board Title is required");
    expect(screen.getByRole("alert")).toHaveTextContent("Title is required");
  });

  it("does not mark a valid field invalid", () => {
    render(<TextField label="Title" />);
    expect(screen.getByLabelText("Title")).toBeValid();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("supports textarea and select, and keeps the label for assistive technology when hidden", async () => {
    const user = userEvent.setup();
    render(
      <>
        <TextAreaField label="Body" rows={2} />
        <SelectField label="Stage" hideLabel defaultValue="b">
          <option value="a">A</option>
          <option value="b">B</option>
        </SelectField>
      </>,
    );
    await user.type(screen.getByLabelText("Body"), "hello");
    expect(screen.getByLabelText("Body")).toHaveValue("hello");
    expect(screen.getByRole("combobox", { name: "Stage" })).toHaveValue("b");
  });

  it("gives every control at least 44 px of height", () => {
    render(<TextField label="Title" />);
    expect(screen.getByLabelText("Title").className).toContain("min-h-11");
  });

  it("has no accessibility violations", async () => {
    const { container } = render(
      <form>
        <TextField label="Title" hint="hint" />
        <TextField label="Score" error="Too high" />
        <TextAreaField label="Pitch" />
        <SelectField label="Stage">
          <option>Inbox</option>
        </SelectField>
      </form>,
    );
    await expectNoA11yViolations(container);
  });
});

describe("Alert and Badge", () => {
  it("announce danger and warnings at once and info politely", () => {
    render(
      <>
        <Alert tone="danger" title="Not saved">
          The server said no.
        </Alert>
        <Alert tone="warn">Careful</Alert>
        <Alert tone="info">FYI</Alert>
        <Alert tone="ok">Saved</Alert>
      </>,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(screen.getByText("Not saved")).toBeInTheDocument();
  });

  it("badges carry their meaning in text", () => {
    render(<Badge tone="warn">Needs review</Badge>);
    expect(screen.getByText("Needs review")).toBeInTheDocument();
  });
});

describe("EmptyState, LoadingState, ErrorState", () => {
  it("EmptyState says what is missing and offers an action", () => {
    render(
      <EmptyState
        title="No ideas yet"
        description="Add the first one."
        action={<Button>New idea</Button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "No ideas yet" })).toBeInTheDocument();
    expect(screen.getByText("Add the first one.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New idea" })).toBeInTheDocument();
  });

  it("LoadingState announces its label politely, as a spinner or as placeholder lines", () => {
    const { rerender } = render(<LoadingState label="Loading ideas" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading ideas");
    rerender(<LoadingState lines={3} label="Loading notes" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading notes");
    expect(document.querySelectorAll('[aria-hidden="true"].animate-pulse')).toHaveLength(3);
  });

  it("ErrorState shows the server's message and retries on request", async () => {
    const user = userEvent.setup();
    const retry = vi.fn<() => void>();
    render(<ErrorState error={new ApiError("The database is down", 503)} onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The database is down");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("ErrorState explains an offline failure and a permission failure differently", () => {
    const { rerender } = render(<ErrorState error={new NetworkError()} />);
    expect(screen.getByRole("heading", { name: "You seem to be offline" })).toBeInTheDocument();
    rerender(<ErrorState error={new ForbiddenError("You need write access to ideas")} />);
    expect(screen.getByRole("heading", { name: "Not allowed" })).toBeInTheDocument();
    expect(screen.getByText("You need write access to ideas")).toBeInTheDocument();
    rerender(<ErrorState error={undefined} title="Custom" description="Plain words" />);
    expect(screen.getByText("Plain words")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("have no accessibility violations", async () => {
    const { container } = render(
      <>
        <EmptyState title="Empty" description="d" />
        <LoadingState />
        <ErrorState error={new Error("x")} onRetry={() => undefined} />
      </>,
    );
    await expectNoA11yViolations(container);
  });
});

describe("LastChangedBy", () => {
  it("says who changed it and when, with an exact time on hover", () => {
    const at = new Date(Date.now() - 5 * 60_000);
    render(<LastChangedBy actor="owner" actorType="human" at={at} />);
    expect(screen.getByText("Last changed by")).toBeInTheDocument();
    expect(screen.getByText("owner")).toBeInTheDocument();
    expect(screen.queryByText("Agent")).toBeNull();
    const time = screen.getByText("5 minutes ago");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("dateTime", at.toISOString());
    expect(time).toHaveAttribute("title");
  });

  it("marks agents in text", () => {
    render(
      <LastChangedBy
        actor="research-agent"
        actorType="agent"
        at="2026-01-01T00:00:00Z"
        label="Created by"
      />,
    );
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Created by")).toBeInTheDocument();
  });

  it("copes with an unreadable timestamp", () => {
    render(<LastChangedBy actor="owner" at="not a date" />);
    expect(screen.getByText("at an unknown time")).toBeInTheDocument();
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  it.each([
    ["2026-10-01T11:59:40Z", "just now"],
    ["2026-10-01T11:55:00Z", "5 minutes ago"],
    ["2026-10-01T09:00:00Z", "3 hours ago"],
    ["2026-09-30T12:00:00Z", "yesterday"],
    ["2026-09-20T12:00:00Z", "2 weeks ago"],
    ["2025-10-01T12:00:00Z", "last year"],
    ["2026-10-01T14:00:00Z", "in 2 hours"],
  ])("%s is %s", (value, expected) => {
    expect(formatRelativeTime(value, now)).toBe(expected);
  });
  it("copes with nonsense", () => {
    expect(formatRelativeTime("nope", now)).toBe("unknown time");
  });
});

describe("PageHeader", () => {
  it("renders the page's single h1, sets the tab title and offers a back link", () => {
    renderWithSession(
      <PageHeader
        title="Ideas"
        description="All your ideas"
        actions={<Button>New</Button>}
        back={{ to: "/", label: "Dashboard" }}
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Ideas" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
    expect(document.title).toBe("Ideas · YouTube Workspace");
  });
});

function Host({ dismissible = true }: { dismissible?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      onClose={() => undefined}
      title="Rename"
      description="Pick a new name"
      dismissible={dismissible}
      initialFocus={ref}
      footer={<Button ref={ref}>Save</Button>}
    >
      <p>Body</p>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("is a labelled modal dialog with description, body and footer", () => {
    render(<Host />);
    const dialog = screen.getByRole("dialog", { name: "Rename" });
    expect(dialog).toHaveAccessibleDescription("Pick a new name");
    expect(dialog).toHaveAttribute("open");
    expect(screen.getByText("Body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
  });

  it("closes only through the parent: open=false removes the content and closes the element", () => {
    const { rerender } = render(
      <Dialog open onClose={() => undefined} title="T">
        <p>Body</p>
      </Dialog>,
    );
    const element = document.querySelector("dialog") as HTMLDialogElement;
    expect(element.open).toBe(true);
    rerender(
      <Dialog open={false} onClose={() => undefined} title="T">
        <p>Body</p>
      </Dialog>,
    );
    expect(element.open).toBe(false);
    expect(screen.queryByText("Body")).toBeNull();
  });

  it("asks the parent to close on Escape and backdrop click, and cancels the browser's own close", () => {
    const onClose = vi.fn<() => void>();
    render(
      <Dialog open onClose={onClose} title="T">
        x
      </Dialog>,
    );
    const element = document.querySelector("dialog") as HTMLDialogElement;
    const cancel = new Event("cancel", { cancelable: true });
    act(() => {
      element.dispatchEvent(cancel);
    });
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("stacks its footer buttons full width on phones", () => {
    render(
      <Dialog open onClose={() => undefined} title="T" footer={<Button>Go</Button>}>
        x
      </Dialog>,
    );
    const footer = screen.getByRole("button", { name: "Go" }).parentElement as HTMLElement;
    expect(footer.className).toContain("max-sm:flex-col");
    expect(footer.className).toContain("max-sm:*:w-full");
  });

  it("a non-dismissible dialog ignores Escape, backdrop clicks and has no close button", () => {
    const onClose = vi.fn<() => void>();
    render(
      <Dialog open onClose={onClose} title="Decide" dismissible={false}>
        x
      </Dialog>,
    );
    const element = document.querySelector("dialog") as HTMLDialogElement;
    act(() => {
      element.dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    fireEvent.click(element);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close dialog" })).toBeNull();
  });

  it("closes the native dialog when it unmounts while open, so the page is not left inert", () => {
    const { unmount } = render(
      <Dialog open onClose={() => undefined} title="T">
        x
      </Dialog>,
    );
    const element = document.querySelector("dialog") as HTMLDialogElement;
    const close = vi.spyOn(element, "close");
    unmount();
    expect(close).toHaveBeenCalled();
  });

  it("has no accessibility violations", async () => {
    const { baseElement } = render(<Host />);
    await expectNoA11yViolations(baseElement);
  });
});

describe("RequireAccess", () => {
  it("renders its children when the user qualifies and a no-access message otherwise", () => {
    const { unmount } = renderWithSession(
      <RequireAccess requires={{ resource: "ideas", level: "write" }}>
        <p>Editor</p>
      </RequireAccess>,
      { session: personaSession("owner") },
    );
    expect(screen.getByText("Editor")).toBeInTheDocument();
    unmount();
    renderWithSession(
      <RequireAccess requires={{ resource: "ideas", level: "write" }}>
        <p>Editor</p>
      </RequireAccess>,
      { session: sessionWith({ ideas: "read" }) },
    );
    expect(screen.queryByText("Editor")).toBeNull();
    expect(screen.getByText("You do not have access to this")).toBeInTheDocument();
  });

  it("accepts several requirements (any one suffices) and a custom fallback", () => {
    renderWithSession(
      <RequireAccess
        requires={[
          { resource: "ideas", level: "write" },
          { resource: "activity", level: "read" },
        ]}
        fallback={<p>Nope</p>}
      >
        <p>Panel</p>
      </RequireAccess>,
      { session: sessionWith({ activity: "read" }) },
    );
    expect(screen.getByText("Panel")).toBeInTheDocument();
  });
});

describe("useOnlineStatus", () => {
  it("follows the browser's online and offline events", () => {
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
    act(() => setOnline(false));
    expect(result.current).toBe(false);
    act(() => setOnline(true));
    expect(result.current).toBe(true);
  });
});
