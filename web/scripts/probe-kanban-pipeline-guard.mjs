/**
 * Verify the pipeline drag guard (issue #45) against the LIVE server.
 *
 * A card the executor owns (workflow_template_id set, exactly the way the
 * future executor will set it) must:
 *   1. arrive on the board with `pipeline: true` and render the chip,
 *   2. carry draggable="false" and never start a drag,
 *   3. be refused by the server on PATCH and bulk alike (400 / ok:false),
 *   4. leave an ordinary card fully draggable through the same path,
 *   5. still be deletable (probe fixtures depend on DELETE).
 *
 * The bind step shells out to python3 + sqlite3 with the same UPDATE the
 * executor will run — CreateTaskBody deliberately does not take workflow
 * fields, so there is no HTTP way to make a pipeline card yet.
 *
 * Usage: node scripts/probe-kanban-pipeline-guard.mjs [boardSlug]
 */

import puppeteer from "puppeteer";
import { execFileSync } from "node:child_process";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";
const board = process.argv[2] || "default";
const BOUND = "pipeline guard probe (bound)";
const PLAIN = "pipeline guard probe (plain)";

const BIND_SCRIPT =
  "import sqlite3,sys;" +
  "c=sqlite3.connect(sys.argv[1]);" +
  "c.execute('UPDATE tasks SET workflow_template_id=?, current_step_key=? WHERE id=?',('word-weekly','review',sys.argv[2]));" +
  "c.commit();c.close()";

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath: CHROME,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 140)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text().slice(0, 140));
});
const wire = [];
page.on("response", (res) => {
  const u = res.url();
  if (u.includes("/api/kanban")) {
    wire.push(`${res.request().method()} ${u.replace(/^.*\/api/, "/api")} -> ${res.status()}`);
  }
});

const writeWire = () => wire.filter((w) => /^(PATCH|POST|DELETE)/.test(w));

await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto(`http://127.0.0.1:8090/kanban?board=${encodeURIComponent(board)}`, {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

// --- seed two ordinary cards -------------------------------------------------
const seedIds = await page.evaluate(async (slug) => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const q = `?board=${encodeURIComponent(slug)}`;
  const H = token ? { Authorization: `Bearer ${token}` } : {};
  const mk = async (title) => {
    const r = await fetch("/api/kanban/tasks" + q, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      // Blocked, not triage: the background auto-promotion walks triage/todo
      // cards between columns, which would race the drag test. A blocked card
      // stays put, so the drop target (todo) is always a different column.
      body: JSON.stringify({ title, initial_status: "blocked" }),
    });
    return (await r.json())?.task?.id ?? null;
  };
  return { bound: await mk("pipeline guard probe (bound)"), plain: await mk("pipeline guard probe (plain)") };
}, board);
if (!seedIds?.bound || !seedIds?.plain) {
  console.log(JSON.stringify({ fatal: "seed failed", seedIds, errors: errors.slice(0, 4) }, null, 1));
  await browser.close();
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 1500));
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2000));

const domSnapshot = () =>
  page.evaluate(({ BOUND, PLAIN }) => {
    const cardByTitle = (needle) =>
      [...document.querySelectorAll(".kb-card")].find((c) => c.textContent?.includes(needle));
    const bound = cardByTitle(BOUND);
    const plain = cardByTitle(PLAIN);
    return {
      boundFound: Boolean(bound),
      boundDraggable: bound?.getAttribute("draggable"),
      boundHasChip: Boolean(bound?.querySelector(".kb-chip-pipeline")),
      boundChipText: bound?.querySelector(".kb-chip-pipeline")?.textContent?.trim() ?? null,
      boundClass: bound?.className ?? null,
      boundColumn: bound?.closest(".kb-column")?.dataset.status ?? null,
      plainFound: Boolean(plain),
      plainDraggable: plain?.getAttribute("draggable"),
      plainHasChip: Boolean(plain?.querySelector(".kb-chip-pipeline")),
      plainColumn: plain?.closest(".kb-column")?.dataset.status ?? null,
    };
  }, { BOUND, PLAIN });

// 1. baseline: both plain, both draggable
const baseline = await domSnapshot();

// --- 2. bind the card the way the executor will, WITHOUT reloading -----------
let bindOk = true;
try {
  execFileSync("python3", ["-c", BIND_SCRIPT, "/home/grokwin/.hermes/kanban.db", seedIds.bound], {
    timeout: 10000,
  });
} catch (e) {
  bindOk = false;
}

// --- 2b. stale-render drag: the client still thinks the card is ordinary ------
wire.length = 0;
const staleDrag = await page.evaluate(({ BOUND }) => {
  const cardByTitle = (needle) =>
    [...document.querySelectorAll(".kb-card")].find((c) => c.textContent?.includes(needle));
  const card = cardByTitle(BOUND);
  const target = document.querySelector('.kb-column[data-status="todo"]');
  if (!card || !target) return { ok: false, why: "card or target missing" };
  const dt = new DataTransfer();
  const fire = (el, type) =>
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  fire(card, "dragstart");
  fire(target, "dragenter");
  fire(target, "dragover");
  fire(target, "drop");
  fire(card, "dragend");
  return { ok: true };
}, { BOUND });
await new Promise((r) => setTimeout(r, 1200)); // real wait: PATCH + snapback + re-render

const staleAfter = await page.evaluate(({ BOUND }) => {
  const cardByTitle = (needle) =>
    [...document.querySelectorAll(".kb-card")].find((c) => c.textContent?.includes(needle));
  const notice = document.querySelector('[role="status"].alert');
  const card = cardByTitle(BOUND);
  return {
    column: card?.closest(".kb-column")?.dataset.status ?? "GONE",
    notice: notice?.textContent?.trim() ?? null,
    noticeClass: notice?.className ?? null,
  };
}, { BOUND });
const staleWrites = writeWire();

// --- 3. after reload: the guard is visible -----------------------------------
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2000));
const boundDom = await domSnapshot();

// --- 4. second drag on the guarded card: prevented, nothing is sent ----------
wire.length = 0;
const guardedDrag = await page.evaluate(({ BOUND }) => {
  const cardByTitle = (needle) =>
    [...document.querySelectorAll(".kb-card")].find((c) => c.textContent?.includes(needle));
  const card = cardByTitle(BOUND);
  const target = document.querySelector('.kb-column[data-status="todo"]');
  if (!card || !target) return { ok: false, why: "card or target missing" };
  const dt = new DataTransfer();
  const fire = (el, type) =>
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  const started = fire(card, "dragstart");
  fire(target, "dragenter");
  fire(target, "dragover");
  fire(target, "drop");
  fire(card, "dragend");
  return { ok: true, dragstartDefaultPrevented: !started };
}, { BOUND });
await new Promise((r) => setTimeout(r, 500));
const guardedWire = writeWire();
const guardedAfter = await page.evaluate(({ BOUND }) => {
  const cardByTitle = (needle) =>
    [...document.querySelectorAll(".kb-card")].find((c) => c.textContent?.includes(needle));
  const card = cardByTitle(BOUND);
  return { column: card?.closest(".kb-column")?.dataset.status ?? "GONE" };
}, { BOUND });

// --- server refusal through the page's own credential ------------------------
const patch = await page.evaluate(async (slug, id) => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const r = await fetch(`/api/kanban/tasks/${id}?board=${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "todo" }),
  });
  return { status: r.status, detail: (await r.json())?.detail ?? null };
}, board, seedIds.bound);

const bulk = await page.evaluate(async (slug, id) => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const r = await fetch(`/api/kanban/tasks/bulk?board=${encodeURIComponent(slug)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id], status: "todo" }),
  });
  return (await r.json())?.results?.[0] ?? null;
}, board, seedIds.bound);

// --- screenshot the bound card + its drawer ----------------------------------
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) =>
    c.textContent?.includes("pipeline guard probe (bound)"));
  card?.scrollIntoView({ block: "center" });
});
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: "/tmp/pipeline-guard-board.png" });

// open the drawer to see the read-only Pipeline row
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) =>
    c.textContent?.includes("pipeline guard probe (bound)"));
  card?.click();
});
await new Promise((r) => setTimeout(r, 800));
// The synthetic dragstart above armed the card's suppress-click guard (it
// exists so a real drag does not open the drawer); the first click is eaten,
// so click once more and confirm the drawer actually opened.
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) =>
    c.textContent?.includes("pipeline guard probe (bound)"));
  card?.click();
});
await new Promise((r) => setTimeout(r, 1500));
const detailTab = await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".kb-drawer-tab")].find((t) =>
    t.textContent?.includes("Detail"));
  tab?.click();
  return Boolean(tab);
});
await new Promise((r) => setTimeout(r, 1000));
const drawer = await page.evaluate(() => ({
  drawerOpen: Boolean(document.querySelector(".kb-drawer")),
  dtTexts: [...document.querySelectorAll(".kb-drawer-fields dt")].map((el) => el.textContent?.trim()),
  pipelineRow: (() => {
    const dt = [...document.querySelectorAll(".kb-drawer-fields dt")].find(
      (el) => el.textContent?.trim() === "Pipeline");
    return dt?.nextElementSibling?.textContent?.trim() ?? null;
  })(),
}));
await page.screenshot({ path: "/tmp/pipeline-guard-drawer.png" });

// --- cleanup -----------------------------------------------------------------
const cleanup = await page.evaluate(async (slug, ids) => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const q = `?board=${encodeURIComponent(slug)}`;
  const H = token ? { Authorization: `Bearer ${token}` } : {};
  const del = async (id) => (await fetch(`/api/kanban/tasks/${id}${q}`, { method: "DELETE", headers: H })).status;
  return { bound: await del(ids.bound), plain: await del(ids.plain) };
}, board, seedIds);

const boardClean = await page.evaluate(async (slug, ids) => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const r = await fetch(`/api/kanban/board?board=${encodeURIComponent(slug)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const b = await r.json();
  const remaining = b.columns
    .flatMap((c) => c.tasks)
    .filter((t) => t.id === ids.bound || t.id === ids.plain)
    .map((t) => t.id);
  return { remaining, totalCards: b.columns.reduce((n, c) => n + c.tasks.length, 0) };
}, board, seedIds);

console.log(
  JSON.stringify(
    {
      seedIds, bindOk, baseline, staleDrag, staleAfter, staleWrites,
      boundDom, guardedDrag, guardedWire, guardedAfter, patch, bulk, drawer,
      cleanup, boardClean, errors: errors.slice(0, 4),
    },
    null,
    1,
  ),
);
await browser.close();
