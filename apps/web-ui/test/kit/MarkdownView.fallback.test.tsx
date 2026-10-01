import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The renderer chunk takes a moment to arrive; until then the raw text is shown, as text.
vi.mock("../../src/kit/MarkdownViewImpl.tsx", async (importOriginal) => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return importOriginal();
});

describe("MarkdownView while its renderer loads", () => {
  it("shows the markdown source as plain text, then the rendered result", async () => {
    const { MarkdownView } = await import("../../src/kit/MarkdownView.tsx");
    const { container } = render(<MarkdownView markdown={"**hello** <script>alert(1)</script>"} />);

    const loading = container.querySelector("[data-markdown-loading]");
    expect(loading).not.toBeNull();
    expect(loading?.textContent).toBe("**hello** <script>alert(1)</script>");
    expect(container.querySelector("script")).toBeNull();

    await waitFor(() => expect(container.querySelector("[data-markdown-loading]")).toBeNull());
    expect(screen.getByText("hello").tagName).toBe("STRONG");
    expect(container.querySelector("script")).toBeNull();
  });
});
