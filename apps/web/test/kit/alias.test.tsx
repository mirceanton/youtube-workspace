import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { EmptyState } from "@/kit";

// Features import the kit as "@/kit" (a directory import of src/kit/index.ts); docs/web-ui.md says so.
it("resolves the @/kit directory import in Vite and TypeScript", () => {
  render(<EmptyState title="resolved" />);
  expect(screen.getByRole("heading", { name: "resolved" })).toBeInTheDocument();
});
