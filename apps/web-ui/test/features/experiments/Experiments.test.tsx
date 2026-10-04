import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ReactNode } from "react";
import {
  EXPERIMENTS_PATH,
  EXPERIMENT_VIDEOS_PATH,
  type Experiment,
  type ExperimentVariant,
} from "@ytw/shared/api/experiments";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component as ExperimentDetailPage } from "../../../src/features/experiments/ExperimentDetailPage.tsx";
import { Component as ExperimentsPage } from "../../../src/features/experiments/ExperimentsPage.tsx";
import { createMockApi } from "../../../src/dev/mock-api.ts";
import { SessionContext } from "../../../src/lib/session.ts";
import { createTestQueryClient, personaSession } from "../../helpers/render.tsx";

const EXPERIMENT_ID = "0199c2a4-7b1e-7c3a-9d2f-000000000041";
const VIDEO_ID = "0199c2a4-7b1e-7c3a-9d2f-000000000051";
const CONTROL_ID = "0199c2a4-7b1e-7c3a-9d2f-000000000061";
const TEST_ID = "0199c2a4-7b1e-7c3a-9d2f-000000000062";
const NOW = "2026-10-04T10:00:00.000Z";

function variant(
  partial: Partial<ExperimentVariant> & Pick<ExperimentVariant, "id" | "label">,
): ExperimentVariant {
  return {
    content: "Current title",
    is_control: false,
    impressions: null,
    ctr: null,
    ctr_vs_control: null,
    ctr_lift_pct: null,
    is_winner: false,
    created_by: "owner",
    updated_by: "owner",
    ...partial,
  };
}

function experiment(partial: Partial<Experiment> = {}): Experiment {
  return {
    id: EXPERIMENT_ID,
    video_id: VIDEO_ID,
    video_title: "Test channel title",
    type: "title",
    status: "running",
    hypothesis: "Specific titles may raise click-through rate.",
    starts_at: "2026-10-01T12:00:00.000Z",
    ends_at: null,
    winner_variant_id: null,
    conclusion: null,
    version: 2,
    created_at: "2026-10-01T11:00:00.000Z",
    updated_at: NOW,
    created_by: "owner",
    updated_by: "research-agent",
    variants: [
      variant({
        id: CONTROL_ID,
        label: "Current",
        content: "The current title",
        is_control: true,
        impressions: "1200",
        ctr: "4.0",
        ctr_vs_control: "0",
        ctr_lift_pct: "0",
      }),
      variant({
        id: TEST_ID,
        label: "Specific",
        content: "A more specific title",
        impressions: "900",
        ctr: "5.0",
        ctr_vs_control: "1.0",
        ctr_lift_pct: "25.0",
      }),
    ],
    ...partial,
  };
}

function renderRoute(
  page: ReactNode,
  path: string,
  persona: "owner" | "collaborator" | "reader" = "owner",
  detailPage: ReactNode = page,
) {
  const router = createMemoryRouter(
    [
      { path: "/experiments/:experimentId", element: detailPage },
      { path: "/experiments", element: page },
    ],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <SessionContext value={personaSession(persona)}>
        <RouterProvider router={router} />
      </SessionContext>
    </QueryClientProvider>,
  );
}

function detailApi(initial = experiment(), persona: "owner" | "collaborator" | "reader" = "owner") {
  const api = createMockApi({ persona });
  let current = structuredClone(initial);
  api.router.get(`${EXPERIMENTS_PATH}/:experiment_id`, () => ({ json: { experiment: current } }));
  api.router.get(`${EXPERIMENTS_PATH}/:experiment_id/ctr-history`, () => ({
    json: { history: [] },
  }));
  api.router.patch(`${EXPERIMENTS_PATH}/:experiment_id/variants/:variant_id/stats`, (request) => {
    const variantId = request.params.variant_id;
    const target = current.variants.find((item) => item.id === variantId);
    if (!target) return { status: 404, json: { error: "Variant not found" } };
    const body = request.body as { impressions?: string; ctr?: string };
    Object.assign(target, body, { updated_by: persona });
    return { json: { variant: { ...target, experiment_id: current.id } } };
  });
  api.router.post(`${EXPERIMENTS_PATH}/:experiment_id/conclude`, (request) => {
    const body = request.body as {
      winner_variant_id: string | null;
      conclusion: string;
    };
    current = {
      ...current,
      status: "concluded",
      version: current.version + 1,
      winner_variant_id: body.winner_variant_id,
      conclusion: body.conclusion,
      ends_at: NOW,
      updated_at: NOW,
      updated_by: persona,
      variants: current.variants.map((item) => ({
        ...item,
        is_winner: item.id === body.winner_variant_id,
      })),
    };
    return {
      json: {
        experiment: {
          id: current.id,
          status: current.status,
          starts_at: current.starts_at,
          ends_at: current.ends_at,
          version: current.version,
          updated_at: current.updated_at,
          updated_by: current.updated_by,
          winner_variant_id: current.winner_variant_id,
          conclusion: current.conclusion,
        },
      },
    };
  });
  return { api, getCurrent: () => current };
}

afterEach(() => vi.unstubAllGlobals());

describe("Experiments feature", () => {
  it("creates a planned experiment with a video and exactly one control", async () => {
    const api = createMockApi({ persona: "collaborator" });
    const created = experiment({ status: "planned", starts_at: null, version: 1 });
    api.router.get(EXPERIMENTS_PATH, () => ({ json: { experiments: [] } }));
    api.router.get(EXPERIMENT_VIDEOS_PATH, () => ({
      json: { videos: [{ id: VIDEO_ID, title: "Test channel title" }] },
    }));
    api.router.post(EXPERIMENTS_PATH, () => ({ json: { experiment: created }, status: 201 }));
    api.router.get(`${EXPERIMENTS_PATH}/:experiment_id`, () => ({ json: { experiment: created } }));
    api.router.get(`${EXPERIMENTS_PATH}/:experiment_id/ctr-history`, () => ({
      json: { history: [] },
    }));
    vi.stubGlobal("fetch", api.fetch);

    renderRoute(<ExperimentsPage />, "/experiments", "collaborator", <ExperimentDetailPage />);
    await screen.findByText("No experiments yet");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New experiment" }));
    await screen.findByRole("option", { name: "Test channel title" });
    await user.selectOptions(screen.getByLabelText(/Video/), VIDEO_ID);
    const labels = screen.getAllByLabelText(/Variant label/);
    await user.clear(labels[0] as HTMLElement);
    await user.type(labels[0] as HTMLElement, "Current title");
    await user.clear(labels[1] as HTMLElement);
    await user.type(labels[1] as HTMLElement, "Specific title");
    const content = screen.getAllByLabelText(/Variant content or thumbnail URL/);
    await user.type(content[0] as HTMLElement, "Current title");
    await user.type(content[1] as HTMLElement, "A specific title");
    await user.click(screen.getByRole("button", { name: "Create experiment" }));

    expect(await screen.findByRole("heading", { name: "Variants" })).toBeInTheDocument();
    const request = api.requests.find(
      (item) => item.method === "POST" && item.path === EXPERIMENTS_PATH,
    );
    expect(request?.body).toMatchObject({
      video_id: VIDEO_ID,
      type: "title",
      variants: [
        { label: "Current title", content: "Current title", is_control: true },
        { label: "Specific title", content: "A specific title", is_control: false },
      ],
    });
  });

  it("records stats and concludes with the chosen winner", async () => {
    const mock = detailApi(experiment(), "collaborator");
    vi.stubGlobal("fetch", mock.api.fetch);
    renderRoute(<ExperimentDetailPage />, `/experiments/${EXPERIMENT_ID}`, "collaborator");
    await screen.findByRole("heading", { name: "Variants" });
    expect(screen.getByText("+1.00 percentage points")).toBeInTheDocument();
    expect(screen.getByText(/not attributed to individual variants/i)).toBeInTheDocument();

    const cards = screen.getAllByRole("heading", { name: /Current|Specific/ });
    const currentCard = cards[0]?.closest("div.rounded-xl");
    expect(currentCard).toBeTruthy();
    const user = userEvent.setup();
    await user.clear(within(currentCard as HTMLElement).getByLabelText("CTR (%)"));
    await user.type(within(currentCard as HTMLElement).getByLabelText("CTR (%)"), "4.2");
    await user.click(
      within(currentCard as HTMLElement).getByRole("button", { name: "Record stats" }),
    );
    expect(within(currentCard as HTMLElement).getByLabelText("CTR (%)")).toHaveValue(4.2);

    await user.selectOptions(screen.getByLabelText("Winning variant"), TEST_ID);
    await user.type(screen.getByLabelText(/^Conclusion/), "The specific title won.");
    await user.click(screen.getByRole("button", { name: "Save conclusion" }));

    expect(await screen.findByText("Winner")).toBeInTheDocument();
    expect(screen.getByText("The specific title won.")).toBeInTheDocument();
    expect(mock.getCurrent()).toMatchObject({
      status: "concluded",
      winner_variant_id: TEST_ID,
      conclusion: "The specific title won.",
    });
    expect(mock.api.requests.some((request) => request.method === "PATCH")).toBe(true);
    expect(
      mock.api.requests.some(
        (request) => request.method === "POST" && request.path.includes("/conclude"),
      ),
    ).toBe(true);
  });

  it("shows list loading, empty and recoverable error states", async () => {
    const api = createMockApi({ persona: "owner" });
    let fail = true;
    api.router.get(EXPERIMENTS_PATH, () =>
      fail
        ? { status: 503, json: { error: "The database is unavailable" } }
        : { json: { experiments: [] } },
    );
    vi.stubGlobal("fetch", api.fetch);
    renderRoute(<ExperimentsPage />, "/experiments");
    expect(screen.getByRole("status")).toHaveTextContent("Loading experiments");
    expect(await screen.findByRole("alert")).toHaveTextContent("The database is unavailable");
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No experiments yet")).toBeInTheDocument();
  });

  it("disables mutations for a reader even when the detail is visible", async () => {
    const mock = detailApi(experiment(), "reader");
    vi.stubGlobal("fetch", mock.api.fetch);
    renderRoute(<ExperimentDetailPage />, `/experiments/${EXPERIMENT_ID}`, "reader");
    await screen.findByRole("heading", { name: "Variants" });
    expect(screen.getAllByRole("button", { name: "Record stats" })[0]).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save conclusion" })).toBeDisabled();
    expect(mock.api.requests.filter((request) => request.method !== "GET")).toEqual([]);
  });
});
