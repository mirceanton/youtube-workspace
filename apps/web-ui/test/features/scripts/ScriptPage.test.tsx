import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { SCRIPTS_HISTORY_PATH, SCRIPTS_PATH, SCRIPTS_UPLOAD_PATH } from "@ytw/shared/api/scripts";
import type { ScriptKind, ScriptStatus } from "@ytw/shared/constants";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Component as ScriptPage } from "../../../src/features/scripts/ScriptPage.tsx";
import { SessionContext } from "../../../src/lib/session.ts";
import { createMockApi } from "../../../src/dev/mock-api.ts";
import { createTestQueryClient, personaSession } from "../../helpers/render.tsx";

const IDEA_ID = "0199c2a4-7b1e-7c3a-9d2f-000000000001";
const V1_ID = "0199c2a4-7b1e-7c3a-9d2f-000000000011";
const V2_ID = "0199c2a4-7b1e-7c3a-9d2f-000000000012";
const V3_ID = "0199c2a4-7b1e-7c3a-9d2f-000000000013";
const NOW = "2026-10-04T10:00:00.000Z";

interface MockScript {
  id: string;
  idea_id: string;
  kind: ScriptKind;
  version: number;
  status: ScriptStatus;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
  body_md: string;
}

function revision(id: string, version: number, body: string, updatedBy = "owner"): MockScript {
  return {
    id,
    idea_id: IDEA_ID,
    kind: "script",
    version,
    status: "draft",
    size_bytes: new TextEncoder().encode(body).byteLength,
    created_at: NOW,
    updated_at: NOW,
    created_by: "owner",
    updated_by: updatedBy,
    body_md: body,
  };
}

function scriptApi() {
  const api = createMockApi({ persona: "owner" });
  const versions = [revision(V1_ID, 1, "one\ntwo\nthree")];
  const byId = new Map(versions.map((item) => [item.id, item]));
  let conflictsOnce = false;

  api.router.get(SCRIPTS_HISTORY_PATH, () => ({
    json: {
      idea_id: IDEA_ID,
      idea_title: "A test idea",
      kind: "script",
      versions: versions.map(({ body_md: _body, ...metadata }) => metadata),
    },
  }));
  api.router.get(`${SCRIPTS_PATH}/:script_id`, (request) => {
    const found = byId.get(request.params.script_id ?? "");
    return found ? { json: { script: found } } : { status: 404, json: { error: "Not found" } };
  });
  api.router.post(SCRIPTS_PATH, (request) => {
    const body = request.body as { base_version?: number; body_md?: string };
    if (conflictsOnce) {
      conflictsOnce = false;
      const concurrent = revision(V2_ID, 2, "one\nagent edit\nthree", "research-agent");
      versions.unshift(concurrent);
      byId.set(concurrent.id, concurrent);
      return {
        status: 409,
        json: { error: "Version 1 is stale; version 2 exists.", latest: { version: 2 } },
      };
    }
    const nextVersion = (body.base_version ?? 0) + 1;
    const next = revision(nextVersion === 3 ? V3_ID : V2_ID, nextVersion, body.body_md ?? "");
    versions.unshift(next);
    byId.set(next.id, next);
    return {
      status: 201,
      json: { script: { ...next, body_md: undefined } },
    };
  });
  api.router.post(SCRIPTS_UPLOAD_PATH, () => {
    const next = revision(V2_ID, 2, "uploaded body");
    versions.unshift(next);
    byId.set(next.id, next);
    return { status: 201, json: { script: { ...next, body_md: undefined } } };
  });

  return {
    api,
    forceNextConflict() {
      conflictsOnce = true;
    },
  };
}

function renderScriptPage(fetchApi: ReturnType<typeof scriptApi>["api"]) {
  vi.stubGlobal("fetch", fetchApi.fetch);
  const router = createMemoryRouter([{ path: "/scripts/:ideaId/:kind", element: <ScriptPage /> }], {
    initialEntries: [`/scripts/${IDEA_ID}/script`],
  });
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <SessionContext value={personaSession("owner")}>
        <RouterProvider router={router} />
      </SessionContext>
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("script page", () => {
  it("shows the conflicting revision, merges disjoint edits, and saves against the refreshed base", async () => {
    const mock = scriptApi();
    mock.forceNextConflict();
    renderScriptPage(mock.api);
    expect(await screen.findByRole("article", { name: "Script reader" })).toHaveTextContent(
      "three",
    );
    await screen.findByRole("button", { name: "Edit latest version" });
    fireEvent.click(screen.getByRole("button", { name: "Edit latest version" }));

    const editor = await screen.findByLabelText("Markdown source");
    fireEvent.change(editor, { target: { value: "one\ntwo\nTHREE" } });
    fireEvent.click(screen.getByRole("button", { name: "Save new version" }));

    expect(
      await screen.findByRole("dialog", { name: "This script changed while you were editing" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Merge my changes" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Merge my changes" }));
    expect(screen.getByLabelText("Markdown source")).toHaveValue("one\nagent edit\nTHREE");
    fireEvent.click(screen.getByRole("button", { name: "Save new version" }));

    expect(await screen.findByText("Saved as version 3.")).toBeInTheDocument();
    const saves = mock.api.requests.filter(
      (request) => request.method === "POST" && request.path === SCRIPTS_PATH,
    );
    expect(saves.map((request) => request.body)).toEqual([
      { idea_id: IDEA_ID, kind: "script", base_version: 1, body_md: "one\ntwo\nTHREE" },
      { idea_id: IDEA_ID, kind: "script", base_version: 2, body_md: "one\nagent edit\nTHREE" },
    ]);
  });

  it("uploads a Markdown file using the selected revision as its base version", async () => {
    const mock = scriptApi();
    renderScriptPage(mock.api);
    expect(await screen.findByRole("article", { name: "Script reader" })).toHaveTextContent(
      "three",
    );
    fireEvent.change(screen.getByLabelText("Upload Markdown revision"), {
      target: {
        files: [
          new File(["---\nkind: script\nversion: 1\n---\n\nuploaded"], "draft.md", {
            type: "text/markdown",
          }),
        ],
      },
    });

    expect(await screen.findByText("Saved as version 2.")).toBeInTheDocument();
    const upload = mock.api.requests.find((request) =>
      request.path.startsWith(SCRIPTS_UPLOAD_PATH),
    );
    expect(upload).toMatchObject({
      method: "POST",
      path: `${SCRIPTS_UPLOAD_PATH}?idea_id=${IDEA_ID}&kind=script&base_version=1`,
    });
  });
});
