// Development bootstrap, reached only from main.tsx behind `import.meta.env.DEV`: production
// builds drop this module, the mock API and the gallery.

import { ME_PATH } from "@/lib/contract.ts";
import { galleryFeature } from "./gallery/feature.ts";
import { seedNotes } from "./demo-data.ts";
import {
  createMockApi,
  isPersonaName,
  type MockApi,
  type MockRouter,
  type PersonaName,
} from "./mock-api.ts";

export { galleryFeature };

type FeatureMock = (router: MockRouter, api: MockApi) => void;

// A feature can ship `src/features/<feature>/mock.ts` (default export `(router, api) => void`) to
// answer its own /api routes in development before the web server has them.
const featureMocks = import.meta.glob<{ default: FeatureMock }>("../features/*/mock.ts", {
  eager: true,
});

const PERSONA_KEY = "ytw.mock.persona";

function chosenPersona(): PersonaName {
  const fromUrl = new URLSearchParams(window.location.search).get("mock_persona");
  try {
    if (isPersonaName(fromUrl)) {
      sessionStorage.setItem(PERSONA_KEY, fromUrl);
      return fromUrl;
    }
    const stored = sessionStorage.getItem(PERSONA_KEY);
    if (isPersonaName(stored)) return stored;
  } catch {
    // sessionStorage can be blocked; the default persona is fine.
  }
  return "owner";
}

/** A web server answers when /api/me gives anything but "not there" (404) or a proxy/server failure. */
async function backendIsUp(): Promise<boolean> {
  try {
    const response = await fetch(ME_PATH, { credentials: "same-origin" });
    return response.status !== 404 && response.status < 500;
  } catch {
    return false;
  }
}

/**
 * Puts the mock API in front of `window.fetch`. Mode from `VITE_MOCK_API`: `off` never mocks, `on`
 * always, `auto` (default) only when the Vite proxy finds no web server behind /api.
 */
export async function installDevMocks(): Promise<MockApi | null> {
  const mode = import.meta.env.VITE_MOCK_API ?? "auto";
  if (mode === "off" || (mode === "auto" && (await backendIsUp()))) return null;

  const persona = chosenPersona();
  const api = createMockApi({ persona, notes: seedNotes() });
  for (const mod of Object.values(featureMocks)) mod.default(api.router, api);
  window.fetch = api.fetch;
  console.info(
    `[dev] Mock API active (persona "${persona}"): no web server answered ${ME_PATH}. ` +
      "Switch with ?mock_persona=owner|collaborator|reader|newcomer|anonymous, " +
      "or set VITE_MOCK_API=off to disable.",
  );
  return api;
}
