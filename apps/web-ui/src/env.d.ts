/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Dev server only. `auto` (default): use the mock API when no web server answers /api/me;
   * `on`: always mock; `off`: never mock (production builds ignore the mock layer entirely).
   */
  readonly VITE_MOCK_API?: "auto" | "on" | "off";
}
