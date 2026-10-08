import { render, screen } from "@testing-library/react";
import type { Level, Resource } from "@ytw/shared/constants";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { discoverFeatures, navEntriesFor } from "../../src/app/features.ts";
import { RequireAccess } from "../../src/kit/RequireAccess.tsx";
import { SessionContext, type MeResponse } from "../../src/lib/session.ts";

function session(levels: Partial<Record<Resource, Level>>, isAdmin = false): MeResponse {
  return {
    user: { id: "u", username: "tester", displayName: "Tester", email: "t@x.test", isAdmin },
    levels: {
      ideas: "none",
      scripts: "none",
      experiments: "none",
      videos: "none",
      notes: "none",
      activity: "none",
      ...levels,
    },
  };
}

// The same discovery the app runs at startup, over the real feature folders.
const features = discoverFeatures(
  import.meta.glob("../../src/features/*/routes.tsx", { eager: true }),
);
const navIds = (me: MeResponse) => navEntriesFor(features, me).map((entry) => entry.id);

describe("feature access", () => {
  it("every feature declaration is valid", () => {
    expect(features.length).toBeGreaterThan(0);
  });

  it("shows only what the user's levels allow, but settings to everyone signed in", () => {
    expect(navIds(session({}))).toEqual(["settings"]);
    const reader = navIds(session({ ideas: "read" }));
    expect(reader).toContain("ideas");
    expect(reader).not.toContain("scripts");
  });

  it("gives an admin every screen", () => {
    expect(navIds(session({}, true))).toEqual(features.filter((f) => f.nav).map((f) => f.id));
  });
});

function renderGuarded(me: MeResponse, level: "read" | "write") {
  return render(
    <MemoryRouter>
      <SessionContext value={me}>
        <RequireAccess requires={{ resource: "ideas", level }}>
          <p>secret page</p>
        </RequireAccess>
      </SessionContext>
    </MemoryRouter>,
  );
}

describe("RequireAccess", () => {
  it("renders its content when the level is enough", () => {
    renderGuarded(session({ ideas: "write" }), "write");
    expect(screen.getByText("secret page")).toBeInTheDocument();
  });

  it("explains instead of rendering when the level is too low", () => {
    renderGuarded(session({ ideas: "read" }), "write");
    expect(screen.queryByText("secret page")).toBeNull();
    expect(screen.getByText("You do not have access to this")).toBeInTheDocument();
  });
});
