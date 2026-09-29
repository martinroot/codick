/**
 * Does "Add a card" actually create a card?
 *
 * The button was inert for its whole life: no onClick, no prop, nothing. A
 * green typecheck says nothing about that, so this drives the real UI —
 * click, type, submit — and then checks the server rather than the DOM,
 * because a card can appear on screen and fail to persist.
 *
 * Usage: node scripts/probe-kanban-create.mjs [boardSlug]
 */

import puppeteer from "puppeteer";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";
const board = process.argv[2] || "default";
const TITLE = "created by the probe — deleted by this script";

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath: CHROME,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) =>
  // The message alone ("Cannot read properties of undefined") is useless when
  // a React render throws -- the stack is the whole point.
  errors.push("pageerror: " + e.message + "\n" + (e.stack ?? "").split("\n").slice(0, 5).join("\n")),
);
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text().slice(0, 160));
});
await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto(`http://127.0.0.1:8090/kanban?board=${encodeURIComponent(board)}`, {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

// Click "Add a card" in the first creatable column, type, submit.
const opened = await page.evaluate(() => {
  const btn = document.querySelector(".kb-add-card");
  if (!btn) return { found: false };
  btn.click();
  return { found: true, text: btn.textContent.trim() };
});
await new Promise((r) => setTimeout(r, 400));

await page.type(".kb-composer-input", TITLE);
await page.screenshot({ path: "/home/grokwin/.hermes/cache/scratch/create1.png" });

await page.evaluate(() => {
  document.querySelector(".kb-composer button[type=submit]")?.click();
});
await new Promise((r) => setTimeout(r, 2500));

const result = await page.evaluate(
  async (slug, title) => {
    const token = window.__HERMES_SESSION_TOKEN__;
    const res = await fetch(
      `/api/plugins/kanban/board?board=${encodeURIComponent(slug)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    const payload = await res.json();
    const all = (payload.columns ?? []).flatMap((c) => c.tasks ?? []);
    const hit = all.find((t) => t.title === title);
    return {
      cardsInDom: document.querySelectorAll(".kb-card").length,
      persisted: Boolean(hit),
      persistedStatus: hit?.status ?? null,
      persistedId: hit?.id ?? null,
      notice: document.querySelector("[role=status]")?.textContent?.trim() ?? null,
    };
  },
  board,
  TITLE,
);

await page.screenshot({ path: "/home/grokwin/.hermes/cache/scratch/create2.png" });

// Clean up through the API.
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
  result.persistedId,
);

console.log(
  JSON.stringify(
    { opened, result, deleteStatus: removed, errors: errors.slice(0, 4) },
    null,
    1,
  ),
);
await browser.close();
