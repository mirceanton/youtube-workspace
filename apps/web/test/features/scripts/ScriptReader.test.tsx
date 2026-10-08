import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptEditor } from "../../../src/features/scripts/ScriptEditor.tsx";
import { ScriptReader } from "../../../src/features/scripts/ScriptReader.tsx";
import { renderWithSession } from "../../helpers/render.tsx";

afterEach(() => window.localStorage.clear());

describe("script reader and preview", () => {
  it("adjusts and remembers the reader text size", async () => {
    const first = renderWithSession(<ScriptReader markdown="# Read comfortably" />);
    expect(screen.getByRole("article", { name: "Script reader" })).toHaveStyle({
      fontSize: "18px",
    });
    fireEvent.click(screen.getByRole("button", { name: "Increase text size" }));
    expect(await screen.findByText("19px")).toBeInTheDocument();
    await waitFor(() =>
      expect(window.localStorage.getItem("ytw.script-reader-font-size")).toBe("19"),
    );

    first.unmount();
    renderWithSession(<ScriptReader markdown="Another script" />);
    expect(screen.getByRole("article", { name: "Script reader" })).toHaveStyle({
      fontSize: "19px",
    });
  });

  it("renders untrusted markdown as inert text in the editor preview", async () => {
    const hostile = "<script>window.compromised=true</script> <img src=x onerror=alert(1)>";
    const { container } = renderWithSession(
      <ScriptEditor value={hostile} onChange={() => undefined} />,
    );
    await waitFor(() => expect(container.querySelector("[data-markdown-loading]")).toBeNull());
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<script>window.compromised=true</script>");
  });
});
