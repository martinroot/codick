/**
 * Compare the kanban client's types against what the server actually sends.
 *
 * A TypeScript interface is a claim, and claims about a payload nobody
 * asserts against drift. This fetches the real board through the browser's
 * authenticated session and prints the keys, so the two can be compared by
 * eye against `web/src/lib/kanban-api.ts`.
 *
 * Usage: node scripts/probe-kanban-contract.mjs [boardSlug]
 */

import puppeteer from "puppeteer";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";
const board = process.argv[2] || "default";

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath: CHROME,
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.authenticate({ username: "preview", password: "hermes2026" });
// Land on the plugin board so the SPA has a session token injected.
await page.goto("http://127.0.0.1:8090/kanban", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 1500));

const result = await page.evaluate(async (slug) => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const get = async (path) => {
    const res = await fetch(path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const q = `?board=${encodeURIComponent(slug)}`;
  const boardRes = await get(`/api/plugins/kanban/board${q}`);
  const boardsRes = await get("/api/plugins/kanban/boards");
  const statsRes = await get(`/api/plugins/kanban/stats${q}`);

  const firstTask =
    boardRes.body?.columns?.flatMap((c) => c.tasks ?? []).find(Boolean) ?? null;

  return {
    boardStatus: boardRes.status,
    envelopeKeys: boardRes.body ? Object.keys(boardRes.body).sort() : null,
    columnNames: boardRes.body?.columns?.map((c) => c.name) ?? null,
    columnKeys: boardRes.body?.columns?.[0]
      ? Object.keys(boardRes.body.columns[0]).sort()
      : null,
    // A board with no tasks proves nothing about the card shape, so report
    // honestly rather than printing an empty object.
    cardKeys: firstTask ? Object.keys(firstTask).sort() : "NO TASKS — card shape unverified",
    boardsStatus: boardsRes.status,
    boardSummaryKeys: boardsRes.body?.boards?.[0]
      ? Object.keys(boardsRes.body.boards[0]).sort()
      : "NO BOARDS",
    statsStatus: statsRes.status,
    statsKeys: statsRes.body ? Object.keys(statsRes.body).sort() : null,
  };
}, board);

console.log(JSON.stringify(result, null, 1));
await browser.close();
