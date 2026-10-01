import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Gallery } from "../../src/dev/gallery/Gallery.tsx";
import { galleryFeature } from "../../src/dev/gallery/feature.ts";
import { discoverFeatures } from "../../src/app/features.ts";
import { seedNotes } from "../../src/dev/demo-data.ts";
import { expectNoA11yViolations } from "../helpers/a11y.ts";
import { personaSession, renderApp, renderWithSession, stubApi } from "../helpers/render.tsx";

// The kit gallery is the dev page that shows every component; rendering it exercises the whole kit
// together against the mock API.

vi.mock("uplot", () => ({
  default: class FakePlot {
    setData() {}
    setSize() {}
    redraw() {}
    destroy() {}
  },
}));

describe("kit gallery", () => {
  it("is a valid feature declaration", () => {
    expect(
      discoverFeatures({ "../features/kit/routes.tsx": { default: galleryFeature } }),
    ).toHaveLength(1);
  });

  it("renders every kit component and has no accessibility violations", async () => {
    stubApi("owner", { notes: seedNotes() });
    const { container } = renderWithSession(<Gallery />, { session: personaSession("owner") });
    expect(screen.getByRole("heading", { level: 1, name: "UI kit" })).toBeInTheDocument();
    await screen.findByText(/Checked the last 12 uploads/);
    await waitFor(() => expect(container.querySelector("[data-markdown-loading]")).toBeNull());
    expect(screen.getByRole("img", { name: "Daily views and impressions" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Views, last 10 snapshots/ })).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("opens the conflict dialog from the gallery", async () => {
    stubApi("owner", { notes: seedNotes() });
    const user = userEvent.setup();
    renderWithSession(<Gallery />);
    await user.click(screen.getByRole("button", { name: "Show conflict dialog" }));
    expect(
      await screen.findByRole("dialog", { name: /changed while you were editing/ }),
    ).toBeInTheDocument();
  });

  it("works as a route in the shell", async () => {
    stubApi("owner", { notes: seedNotes() });
    renderApp([galleryFeature], "/kit");
    expect(await screen.findByRole("heading", { level: 1, name: "UI kit" })).toBeInTheDocument();
  });
});
