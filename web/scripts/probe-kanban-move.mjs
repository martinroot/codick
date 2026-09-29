/**
 * Reproduce "the card only moves after a page reload".
 *
 * A drag is dispatched as real HTML5 drag events rather than by calling the
 * handler, because the report is that dragging does not work and calling the
 * handler would prove nothing about dragging. The DOM is read immediately
 * after the drop -- the whole claim is that the board does not update until
 * something forces a re-read -- and the wire is logged to tell "no PATCH was
 * sent" apart from "PATCH landed and the UI ignored it".
 *
 * Usage: node scripts/probe-kanban-move.mjs [boardSlug]
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
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 140)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text().slice(0, 140));
});
// Both prefixes, because the board moved to /api/kanban and the old one is
// only a deprecated alias. Filtering on the old prefix would make the page
// look silent rather than moved.
const wire = [];
page.on("response", (res) => {
  const u = res.url();
  if (u.includes("/api/kanban") || u.includes("/api/plugins/kanban")) {
    wire.push(
      `${u.includes("/api/plugins/kanban") ? "ALIAS " : "CORE  "}` +
        `${res.request().method()} ${u.replace(/^.*\/api/, "/api")} -> ${res.status()}`,
    );
  }
});

await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto(`http://127.0.0.1:8090/kanban?board=${encodeURIComponent(board)}`, {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

// Seed a card in triage so there is something to drag.
const seeded = await page.evaluate(
  async (slug) => {
    const token = window.__HERMES_SESSION_TOKEN__;
    const q = `?board=${encodeURIComponent(slug)}`;
    const H = token ? { Authorization: `Bearer ${token}` } : {};
    const r = await fetch("/api/plugins/kanban/tasks" + q, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "drag probe card", triage: true }),
    });
    return (await r.json())?.task?.id ?? null;
  },
  board,
);
await new Promise((r) => setTimeout(r, 2000));
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2000));

const before = await page.evaluate(() => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) =>
    c.textContent?.includes("drag probe card"),
  );
  return {
    found: Boolean(card),
    inColumn: card?.closest(".kb-column")?.dataset.status ?? null,
  };
});

// Drag it to Todo with real HTML5 drag events.
wire.length = 0;
const drag = await page.evaluate(() => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) =>
    c.textContent?.includes("drag probe card"),
  );
  const target = document.querySelector('.kb-column[data-status="todo"]');
  if (!card || !target) return { ok: false, why: "card or target missing" };

  const dt = new DataTransfer();
  const fire = (el, type, extra = {}) =>
    el.dispatchEvent(
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, ...extra }),
    );
  fire(card, "dragstart");
  fire(target, "dragenter");
  fire(target, "dragover");
  fire(target, "drop");
  fire(card, "dragend");
  return { ok: true };
});
await new Promise((r) => setTimeout(r, 300));

const immediately = await page.evaluate(() => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) =>
    c.textContent?.includes("drag probe card"),
  );
  return card?.closest(".kb-column")?.dataset.status ?? "GONE";
});

await new Promise((r) => setTimeout(r, 2500));
const settled = await page.evaluate(() => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) =>
    c.textContent?.includes("drag probe card"),
  );
  return card?.closest(".kb-column")?.dataset.status ?? "GONE";
});

const onServer = await page.evaluate(
  async (slug, id) => {
    const token = window.__HERMES_SESSION_TOKEN__;
    const r = await fetch(
      `/api/plugins/kanban/tasks/${id}?board=${encodeURIComponent(slug)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    return (await r.json())?.task?.status ?? null;
  },
  board,
  seeded,
);

// Clean up.
await page.evaluate(
  async (slug, id) => {
    const token = window.__HERMES_SESSION_TOKEN__;
    await fetch(`/api/plugins/kanban/tasks/${id}?board=${encodeURIComponent(slug)}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
  board,
  seeded,
);

console.log(
  JSON.stringify(
    { before, drag, immediately, settled, onServer, wire, errors: errors.slice(0, 4) },
    null,
    1,
  ),
);
await browser.close();
