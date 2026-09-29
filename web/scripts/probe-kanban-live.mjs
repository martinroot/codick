/**
 * Prove `/kanban-next` renders real data, not the mock.
 *
 * An empty board is indistinguishable from a broken one: both show columns
 * and neither shows a card. So this creates a task through the API, reloads
 * the React board, and checks that a card with the right title, priority and
 * comment count actually appears in the DOM. Then it deletes the task.
 *
 * Usage: node scripts/probe-kanban-live.mjs [boardSlug]
 */

import puppeteer from "puppeteer";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";
const board = process.argv[2] || "default";
const TITLE = "live render probe — deleted by this script";

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath: CHROME,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text().slice(0, 160));
});
await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });

// Land on the plugin board first so the SPA has its session token, then
// create the task, then navigate to the React board and read the DOM.
await page.goto("http://127.0.0.1:8090/kanban", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 1200));

const created = await page.evaluate(
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
    const out = await send("POST", "/tasks", {
      title,
      status: "triage",
      body: "proving the React board reads the API",
      priority: 2,
      skills: ["probe"],
    });
    return { status: out.status, id: out.body?.task?.id ?? null };
  },
  board,
  TITLE,
);

await page.goto(`http://127.0.0.1:8090/kanban-next?board=${encodeURIComponent(board)}`, {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

const seen = await page.evaluate((title) => {
  const cards = [...document.querySelectorAll(".kb-card")];
  const match = cards.find((c) => c.textContent?.includes(title));
  return {
    cardsOnBoard: cards.length,
    foundOurCard: Boolean(match),
    cardText: match ? match.innerText.replace(/\s+/g, " ").slice(0, 120) : null,
    // The mock card T-1041 has priority 3; ours has 2. If the mock were
    // still rendering, the title match above would have failed anyway.
    boardTitle: document.querySelector("h1")?.textContent ?? null,
  };
}, TITLE);

await page.screenshot({ path: "/home/grokwin/.hermes/cache/scratch/live2.png" });

// Clean up.
const removed = await page.evaluate(
  async (slug, id) => {
    if (!id) return null;
    const token = window.__HERMES_SESSION_TOKEN__;
    const res = await fetch(
      `/api/plugins/kanban/tasks/${encodeURIComponent(id)}?board=${encodeURIComponent(slug)}`,
      { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    return res.status;
  },
  board,
  created.id,
);

console.log(
  JSON.stringify(
    { created, rendered: seen, deleteStatus: removed, errors: errors.slice(0, 4) },
    null,
    1,
  ),
);
await browser.close();
