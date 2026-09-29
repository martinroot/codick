/**
 * Create a task, read the board back, and delete the task.
 *
 * The card shape cannot be verified against an empty board — a payload with
 * zero tasks proves only that the envelope is right. This exercises the
 * write path, reads the card the server actually built, and cleans up, so
 * the client's `KanbanTaskCard` is checked against a real card rather than
 * against the Python dataclass by inspection.
 *
 * Usage: node scripts/probe-kanban-card-shape.mjs [boardSlug]
 */

import puppeteer from "puppeteer";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";
const board = process.argv[2] || "default";
const TITLE = "contract probe — temporary, deleted by this script";

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath: CHROME,
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 1500));

const out = await page.evaluate(
  async (slug, title) => {
    const token = window.__HERMES_SESSION_TOKEN__;
    const q = `?board=${encodeURIComponent(slug)}`;
    const send = async (method, path, body) => {
      const res = await fetch(`/api/plugins/kanban${path}${q}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    // `POST /tasks` answers `{task: {...}}` -- the finished card, not a bare
    // id. Reading `.id` off the envelope is what made an earlier run of this
    // probe leave a task behind: no id, so no delete.
    const created = await send("POST", "/tasks", {
      title,
      status: "triage",
      body: "checking the card contract",
      priority: 1,
    });
    const id = created.body?.task?.id;

    // Clean up any card left by an earlier aborted run of this probe.
    const strays = [];
    const sweep = await send("GET", "/board");
    for (const col of sweep.body?.columns ?? []) {
      for (const t of col.tasks ?? []) {
        if (t.title === title && t.id !== id) strays.push(t.id);
      }
    }
    for (const s of strays) await send("DELETE", `/tasks/${encodeURIComponent(s)}`);

    const board = await send("GET", "/board");
    const card =
      board.body?.columns?.flatMap((c) => c.tasks ?? []).find((t) => t.id === id) ??
      null;

    const shape = card
      ? Object.fromEntries(
          Object.keys(card)
            .sort()
            .map((k) => [
              k,
              card[k] === null
                ? "null"
                : Array.isArray(card[k])
                  ? `array(${card[k].length})`
                  : typeof card[k] === "object" && card[k] !== null
                    ? `object{${Object.keys(card[k]).sort().join(",")}}`
                    : typeof card[k],
            ]),
        )
      : null;

    const removed = id ? await send("DELETE", `/tasks/${encodeURIComponent(id)}`) : null;
    return {
      createStatus: created.status,
      // The raw body: the client claims `POST /tasks` answers `{id}`, and
      // that claim has to be checked, not assumed.
      id,
      straysRemoved: strays,
      cardShape: shape,
      deleteStatus: removed?.status ?? null,
    };
  },
  board,
  TITLE,
);

console.log(JSON.stringify(out, null, 1));
await browser.close();
