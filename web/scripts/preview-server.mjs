#!/usr/bin/env node
/**
 * Design-preview server for the dashboard.
 *
 * Serves the production bundle in `web_dist` with a mock `/api`, so the
 * whole dashboard can be opened and reviewed without a running
 * `hermes dashboard` and without a session token.
 *
 * Why this exists: the real backend injects
 * `window.__HERMES_SESSION_TOKEN__` into `index.html`. A plain static
 * server does not, every `/api/*` call then 401s, and the SPA's 401
 * handler bounces the page to /login and back — an unusable preview.
 * This server injects the token and answers the endpoints the shell
 * needs, so pages render with data instead of an auth loop.
 *
 * Everything it returns is FAKE. It is a styling/UX surface, not a data
 * source; never point anything real at it.
 *
 *   node scripts/preview-server.mjs [--port 8090] [--dist ../preview-dist]
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const PORT = Number(arg("port", 8090));
const DIST = resolve(here, arg("dist", "../../preview-dist"));

/** The token the SPA reads. Any non-empty string satisfies the client;
 *  the mock API below never checks it. */
const SESSION_TOKEN = "preview-token";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

/* ------------------------------------------------------------------ */
/* Mock payloads                                                       */
/* ------------------------------------------------------------------ */

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const DAY = 86400;

const STATUS = {
  version: "0.21.3",
  release_date: "2026.9.14",
  config_version: 45,
  latest_config_version: 45,
  can_update_hermes: true,
  gateway_running: true,
  gateway_state: "running",
  gateway_platforms: {
    telegram: { state: "connected", error_code: null, error_message: null },
  },
  profiles: ["default"],
  active_profile: "default",
  memory: { total_bytes: 12_884_901_888, used_bytes: 8_053_063_680 },
  memory_pressure: "ok",
};

const KANBAN_TASKS = [
  {
    id: "T-1041", title: "Investigate 502s on /api/plugins/kanban/board",
    status: "triage", assignee: "grokwin", tenant: null, priority: 3,
    created_at: NOW - 5 * HOUR, started_at: null, completed_at: null,
    result: null, body: null, comment_count: 3,
  },
  {
    id: "T-1035", title: "Port kanban board to TSX in web/src",
    status: "todo", assignee: "grokwin", tenant: null, priority: 1,
    created_at: NOW - 2 * DAY, started_at: null, completed_at: null,
    result: null, body: null, comment_count: 5,
  },
  {
    id: "T-1036", title: "Migrate remaining dashboard pages to Bootstrap 5",
    status: "todo", assignee: "imoney", tenant: null, priority: 2,
    created_at: NOW - 3 * DAY, started_at: null, completed_at: null,
    result: null, body: null, comment_count: 2,
  },
  {
    id: "T-1030", title: "Trello-style card shadows and hover states",
    status: "ready", assignee: "grokwin", tenant: null, priority: 0,
    created_at: NOW - DAY, started_at: null, completed_at: null,
    result: null, body: null, comment_count: 4,
  },
  {
    id: "T-1028", title: "Bootstrap theme: dark palette on --bs-* tokens",
    status: "running", assignee: "grokwin", tenant: null, priority: 0,
    created_at: NOW - 6 * HOUR, started_at: NOW - HOUR, completed_at: null,
    result: null, body: null, comment_count: 7,
  },
  {
    id: "T-1029", title: "Modal focus trap without Radix",
    status: "running", assignee: "grokwin", tenant: null, priority: 0,
    created_at: NOW - 4 * HOUR, started_at: NOW - 900, completed_at: null,
    result: null, body: null, comment_count: 2,
  },
  {
    id: "T-1015", title: "Expose preview to the public without auth",
    status: "blocked", assignee: "martin", tenant: null, priority: 1,
    created_at: NOW - 2 * DAY, started_at: NOW - DAY, completed_at: null,
    result: null, body: null, comment_count: 6,
  },
  {
    id: "T-1010", title: "FilesPage migration to Bootstrap layer",
    status: "review", assignee: "grokwin", tenant: null, priority: 0,
    created_at: NOW - 3 * DAY, started_at: NOW - 2 * DAY, completed_at: NOW - HOUR,
    result: "Ten DS imports collapsed to one @/ui import.",
    body: null, comment_count: 3,
  },
  {
    id: "T-1005", title: "Add Bootstrap 5.3.8 as the UI foundation",
    status: "done", assignee: "grokwin", tenant: null, priority: 0,
    created_at: NOW - 4 * DAY, started_at: NOW - 3 * DAY, completed_at: NOW - 2 * DAY,
    result: "Committed as dbb1c05e.", body: null, comment_count: 1,
  },
];

const KANBAN_COLUMNS = [
  "triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done",
];

const KANBAN_BOARD = {
  columns: KANBAN_COLUMNS.map((name) => ({
    name,
    tasks: KANBAN_TASKS.filter((task) => task.status === name),
  })),
  tenants: [],
  assignees: ["grokwin", "imoney", "martin"],
  latest_event_id: 0,
  now: NOW,
};

const SESSIONS = [
  {
    id: "sess_preview_1", title: "Bootstrap 5 migration", source: "telegram",
    created_at: NOW - 2 * HOUR, updated_at: NOW - 300, message_count: 84,
    profile: "default",
  },
  {
    id: "sess_preview_2", title: "Kanban dispatcher triage", source: "cron",
    created_at: NOW - 8 * HOUR, updated_at: NOW - 3 * HOUR, message_count: 21,
    profile: "default",
  },
  {
    id: "sess_preview_3", title: "Nightly fapacrm rollup", source: "cron",
    created_at: NOW - DAY, updated_at: NOW - DAY, message_count: 12,
    profile: "default",
  },
];

/** Endpoints the SPA shell needs before anything renders. */
const ROUTES = {
  "/api/status": STATUS,
  "/api/profiles/active": { profile: "default" },
  "/api/profiles": { profiles: [{ name: "default", is_default: true, model: "", provider: "", description: "", skill_count: 0 }] },
  "/api/config": { dashboard: { show_token_analytics: true }, model: {}, kanban: {} },
  "/api/config/defaults": {},
  "/api/config/raw": {},
  "/api/config/schema": { schema: {}, version: 45 },
  "/api/auth/me": { authenticated: true, user: "preview", is_admin: true },
  "/api/auth/ws-ticket": { ticket: "preview-ticket" },
  "/api/dashboard/plugins": { plugins: [] },
  "/api/dashboard/themes": { themes: [] },
  "/api/dashboard/theme": { theme: "default" },
  "/api/dashboard/plugin-providers": { providers: [] },
  "/api/dashboard/plugins/catalog": { plugins: [] },
  "/api/dashboard/plugins/hub": { plugins: [] },
  "/api/sessions": { sessions: SESSIONS },
  "/api/gateway": STATUS,
  "/api/logs": { lines: [] },
  "/api/models": { providers: [] },
  "/api/model/options": { providers: [] },
  "/api/skills": { skills: [] },
  "/api/cron": { jobs: [] },
  "/api/plugins": { plugins: [] },
  "/api/mcp": { servers: [] },
  "/api/channels": { channels: [] },
  "/api/webhooks": { webhooks: [] },
  "/api/pairing": { requests: [] },
  "/api/analytics": { points: [], totals: {} },
  "/api/analytics/models": { models: [] },
  "/api/env": { keys: [] },
  "/api/credentials": { credentials: [] },
  "/api/credentials/pool": { credentials: [] },
  "/api/local-models": { models: [] },
  "/api/system": { info: {} },
  "/api/ops": { jobs: [] },
  "/api/curator": { state: "idle" },
  "/api/curator/paused": { paused: false },
  "/api/console": { output: [] },
  "/api/memory": { backends: [] },
  "/api/chat/workspaces": { workspaces: [] },
  "/api/dashboard/agent-plugins/install": { ok: true },
  "/api/plugins/kanban/board": KANBAN_BOARD,
  "/api/plugins/kanban/stats": { by_status: {}, by_assignee: {} },
  "/api/plugins/kanban/assignees": { assignees: ["grokwin", "imoney", "martin"] },
  "/api/plugins/kanban/boards": { boards: [], current: "default" },
  "/api/plugins/kanban/projects": { projects: [] },
  "/api/plugins/kanban/orchestration": {
    orchestrator_profile: "", default_assignee: "", auto_decompose: true,
    auto_promote_children: true, resolved_orchestrator_profile: "default",
    resolved_default_assignee: "default", active_profile: "default",
  },
  "/api/plugins/kanban/profiles": { profiles: [] },
  "/api/plugins/kanban/model-options": { providers: [] },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function sendJson(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

/** Files listing for the Files page — enough rows to judge row density. */
function filesPayload(pathname) {
  const entries = [
    { name: "web", path: "/root/web", is_directory: true, size: null, mtime: NOW - 300 },
    { name: "logs", path: "/root/logs", is_directory: true, size: null, mtime: NOW - 7200 },
    { name: "config.yaml", path: "/root/config.yaml", is_directory: false, size: 4821, mtime: NOW - 86400 },
    { name: "agent.log", path: "/root/agent.log", is_directory: false, size: 918_233, mtime: NOW - 120 },
    { name: "errors.log", path: "/root/errors.log", is_directory: false, size: 14_002, mtime: NOW - 900 },
  ];
  return { path: pathname || "/root", locked_root: null, can_change_path: true, entries };
}

/* ------------------------------------------------------------------ */
/* Static file serving                                                 */
/* ------------------------------------------------------------------ */

async function serveFile(res, filePath, status = 200) {
  const data = await readFile(filePath);
  res.writeHead(status, {
    "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  res.end(data);
}

/**
 * Inject the session token the real backend would have inlined. Without
 * it every /api call 401s and the SPA redirects to /login in a loop.
 */
async function serveIndex(res) {
  let html = await readFile(join(DIST, "index.html"), "utf8");
  const bootstrap = [
    `<script>window.__HERMES_SESSION_TOKEN__=${JSON.stringify(SESSION_TOKEN)};`,
    `window.__HERMES_DASHBOARD_EMBEDDED_CHAT__=false;`,
    `window.__HERMES_INITIAL_PROFILE__="";</script>`,
  ].join("");
  html = html.includes("</head>")
    ? html.replace("</head>", `${bootstrap}</head>`)
    : bootstrap + html;
  res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
  res.end(html);
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const { pathname } = url;

  try {
    if (pathname.startsWith("/api/") || pathname === "/api") {
      // Mutating verbs are accepted and answered so the UI's optimistic
      // paths settle instead of erroring — the data does not persist.
      if (req.method !== "GET") {
        await readBody(req);
        return sendJson(res, { ok: true, preview: true });
      }

      if (pathname === "/api/files") {
        return sendJson(res, filesPayload(url.searchParams.get("path")));
      }

      const route = ROUTES[pathname];
      if (route !== undefined) return sendJson(res, route);

      // Unknown endpoint: answer 200 with an empty object rather than
      // 404/401. A preview that errors teaches nothing about the design.
      return sendJson(res, {});
    }

    // Plugin scripts the SPA <script>-loads. Nothing to serve in preview.
    if (pathname.startsWith("/dashboard-plugins/")) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      return res.end("");
    }

    // Websockets cannot be mocked by a static server; refuse cleanly so
    // the client backs off instead of retrying forever.
    if (pathname === "/api/ws" || pathname === "/api/events" || pathname === "/api/pty") {
      res.writeHead(501, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "websocket not available in preview" }));
    }

    const candidate = join(DIST, normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
    if (candidate.startsWith(DIST) && pathname !== "/") {
      try {
        const info = await stat(candidate);
        if (info.isFile()) return await serveFile(res, candidate);
      } catch {
        /* fall through to the SPA shell */
      }
    }

    return await serveIndex(res);
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(error?.message ?? error) }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[preview] serving ${DIST}`);
  console.log(`[preview] http://0.0.0.0:${PORT}/  (mock API, fake data, no auth)`);
});
