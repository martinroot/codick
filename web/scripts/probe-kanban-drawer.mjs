/**
 * Does clicking a card open something real?
 *
 * The card's click handler used to write "open <id>" into a notice and stop,
 * so a green check here would mean a drawer rendered an empty pane. The probe
 * therefore checks the *content* came from the detail endpoint: a task id that
 * only exists in the response, and the full body text, which the board card
 * truncates and never carries.
 *
 * It also checks the log is NOT fetched on open -- that is the design, and a
 * regression that eagerly loads 100 KB per card click would be invisible in a
 * screenshot.
 *
 * Usage: node scripts/probe-kanban-drawer.mjs
 */

import puppeteer from "puppeteer";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath: CHROME,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 140)}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 140)}`);
});

const wire = [];
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/kanban/tasks/")) {
    wire.push(`${r.request().method()} ${u.split("8090")[1]} -> ${r.status()}`);
  }
});

await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

// Seed a task with a body and a comment, so the drawer has something the
// board card provably does not carry.
const seed = await page.evaluate(async () => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const H = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "Content-Type": "application/json",
  };
  const body = `Drawer probe body.

A paragraph with **bold** and a list:

- alpha
- beta

\`inline code\``;
  const created = await (
    await fetch("/api/kanban/tasks?board=default", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ title: "drawer probe", body }),
    })
  ).json();
  const id = created?.task?.id;
  if (!id) return { id: null };
  await fetch(`/api/kanban/tasks/${id}/comments?board=default`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ body: "drawer probe comment" }),
  });
  return { id };
});
await new Promise((r) => setTimeout(r, 2000));
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2000));

wire.length = 0;
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) =>
    c.textContent?.includes("drawer probe"),
  );
  card?.click();
});
await new Promise((r) => setTimeout(r, 2500));

const detail = await page.evaluate(() => {
  const d = document.querySelector(".kb-drawer");
  if (!d) return { open: false };
  return {
    open: true,
    title: d.querySelector(".kb-drawer-title")?.textContent,
    id: d.querySelector(".kb-drawer-sub code")?.textContent,
    tabs: [...d.querySelectorAll(".kb-drawer-tab")].map((t) =>
      t.textContent?.replace(/\d+$/, "").trim(),
    ),
    bodyRendered: d.querySelector(".kb-drawer-body")?.textContent?.includes("Drawer probe body"),
    strongRendered: Boolean(d.querySelector(".kb-drawer-body strong")),
    fields: d.querySelectorAll(".kb-drawer-fields dt").length,
    logFetchedYet: false,
  };
});

// Comments tab: the comment exists only on the detail payload.
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".kb-drawer-tab")].find((t) =>
    t.textContent?.includes("Comments"),
  );
  tab?.click();
});
await new Promise((r) => setTimeout(r, 800));
const comments = await page.evaluate(() => ({
  count: document.querySelectorAll(".kb-drawer-item").length,
  hasComment: document.querySelector(".kb-drawer-body")?.textContent?.includes("drawer probe comment"),
}));

// Log tab: the fetch must happen now, and only now.
const beforeLog = wire.filter((w) => w.includes("/log"));
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".kb-drawer-tab")].find((t) =>
    t.textContent?.includes("Log"),
  );
  tab?.click();
});
await new Promise((r) => setTimeout(r, 2000));
const afterLog = wire.filter((w) => w.includes("/log"));

// Escape closes.
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 600));
const closed = await page.evaluate(() => !document.querySelector(".kb-drawer"));

await page.evaluate(
  async (id) => {
    if (!id) return;
    const token = window.__HERMES_SESSION_TOKEN__;
    await fetch(`/api/kanban/tasks/${id}?board=default`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
  seed.id,
);

console.log(
  JSON.stringify(
    {
      seed,
      detail,
      comments,
      logFetchedOnOpen: beforeLog.length,
      logFetchedAfterTab: afterLog.length,
      escapeCloses: closed,
      wire,
      errors: errors.slice(0, 4),
    },
    null,
    1,
  ),
);
await browser.close();
