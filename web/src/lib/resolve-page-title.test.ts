import { describe, expect, it } from "vitest";
import { resolvePageTitle } from "./resolve-page-title";
import type { Translations } from "@/i18n/types";

// Minimal translations stub — only the fields resolvePageTitle touches.
const t = {
  app: {
    webUi: "Web UI",
    nav: {
      analytics: "Analytics",
      chat: "Chat",
      config: "Config",
      cron: "Cron",
      documentation: "Documentation",
      keys: "Keys",
      logs: "Logs",
      models: "Models",
      profiles: "Profiles",
      plugins: "Plugins",
      sessions: "Sessions",
      skills: "Skills",
    },
  },
} as unknown as Translations;

describe("resolvePageTitle", () => {
  it("uses i18n nav keys for translated routes", () => {
    expect(resolvePageTitle("/sessions", t, [])).toBe("Sessions");
    expect(resolvePageTitle("/env", t, [])).toBe("Keys");
  });

  it("prefers plugin tab labels", () => {
    expect(
      resolvePageTitle("/kanban", t, [{ path: "/kanban", label: "Kanban" }]),
    ).toBe("Kanban");
  });

  it("falls back to capitalized path segment for unknown routes", () => {
    expect(resolvePageTitle("/whatever", t, [])).toBe("Whatever");
  });

  it("titles /kanban as Main, not from the plugin that used to own it", () => {
    // The plugin bundle used to register a tab at /kanban, and a plugin tab
    // outranks the builtin map. It now registers at /kanban-reference, so
    // the header must follow the nav item that opened it.
    expect(resolvePageTitle("/kanban", t, [])).toBe("Main");
    expect(resolvePageTitle("/kanban", t, [{ path: "/kanban-reference", label: "Kanban" }])).toBe(
      "Main",
    );
  });

  it("treats root as the dashboard, and trailing slashes as equivalent", () => {
    // Root is the dashboard, not a redirect to the session list: the tile
    // grid and the charts live there, and a title reading "Sessions" above
    // them was the mismatch.
    expect(resolvePageTitle("/", t, [])).toBe("Dashboard");
    expect(resolvePageTitle("/mcp/", t, [])).toBe("MCP");
  });
});
