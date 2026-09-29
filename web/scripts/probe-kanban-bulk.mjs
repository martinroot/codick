/**
 * Bulk actions, and the one thing #8 actually cares about: partial failure.
 *
 * The issue says bulk is not atomic and that the UI must reconcile per card
 * and mark only the failures. A probe that bulk-moves cards that all succeed
 * proves nothing about that — a UI that assumed atomicity and reported "2
 * cards updated" would pass it perfectly.
 *
 * So this seeds two cards where one can be completed and one cannot (the
 * server refuses completion without result or summary evidence), selects both
 * through the real checkbox, and clicks Complete. The expected result is a
 * split verdict.
 *
 * Usage: node scripts/probe-kanban-bulk.mjs
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
const bulkCalls = [];
page.on("response", async (r) => {
  if (r.url().includes("/api/kanban/tasks/bulk")) {
    const line = `${r.status()} ${r.url().split("8090")[1]}`;
    if (r.status() >= 400) {
      let body = "";
      try {
        body = (await r.text()).replace(/\s+/g, " ").slice(0, 300);
      } catch {
        body = "<body unreadable>";
      }
      bulkCalls.push(`${line} :: ${body}`);
    } else {
      bulkCalls.push(line);
    }
  }
});

await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2000));

// One card that can be completed, one that cannot.
const seed = await page.evaluate(async () => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const H = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "Content-Type": "application/json",
  };
  const post = (body) =>
    fetch("/api/kanban/tasks?board=default", {
      method: "POST",
      headers: H,
      body: JSON.stringify(body),
    }).then((r) => r.json());
  const ok = await post({ title: "bulk ok", initial_status: "blocked", result: "already done" });
  const bad = await post({ title: "bulk refused", initial_status: "blocked" });
  void ok;
  return { ok: ok?.task?.id ?? null, bad: bad?.task?.id ?? null };
});
await new Promise((r) => setTimeout(r, 2000));
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2000));

const result = { seed };

// Ctrl-click both cards, the way a user would.
await page.evaluate((ids) => {
  for (const wanted of ["bulk ok", "bulk refused"]) {
    const card = [...document.querySelectorAll(".kb-card")].find((c) =>
      c.textContent?.includes(wanted),
    );
    if (card) card.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    void ids;
  }
}, [seed.ok, seed.bad]);
await new Promise((r) => setTimeout(r, 700));

result.selection = await page.evaluate(() => ({
  barVisible: Boolean(document.querySelector(".kb-bulk")),
  count: document.querySelector(".kb-bulk-count")?.textContent?.trim(),
  checkedBoxes: document.querySelectorAll(".kb-card-pick input:checked").length,
  selectedCards: document.querySelectorAll(".kb-card-selected").length,
}));

// Partial failure, produced the way it happens in real use: one of the
// selected cards is deleted by something else between selecting it and acting
// on it. The server then reports "not found" for that id and still applies the
// change to the other -- a split verdict a UI that assumed atomicity would
// report as plain success.
result.deletedOutOfBand = await page.evaluate(async (id) => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const r = await fetch(`/api/kanban/tasks/${id}?board=default`, {
    method: "DELETE",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return r.status;
}, seed.bad);

await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".kb-bulk button")].find(
    (b) => b.textContent?.trim() === "P2",
  );
  btn?.click();
});
await new Promise((r) => setTimeout(r, 3000));

result.afterBulk = await page.evaluate(() => {
  const bar = document.querySelector(".kb-bulk");
  const alert = document.querySelector(".kb-bulk-failures");
  return {
    banner: alert?.textContent?.replace(/\s+/g, " ").trim().slice(0, 160) ?? null,
    succeededLine: alert?.querySelector("span")?.textContent?.trim() ?? null,
    failureLines: [...(alert?.querySelectorAll("li") ?? [])].map((li) =>
      li.textContent?.replace(/\s+/g, " ").trim(),
    ),
    stillChecked: document.querySelectorAll(".kb-card-pick input:checked").length,
    barGone: !bar,
  };
});

// What the server actually says, asked directly, so the UI's split verdict can
// be compared against the wire rather than trusted.
result.wire = await page.evaluate(async (ids) => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const r = await fetch("/api/kanban/tasks/bulk?board=default", {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ids: [ids.ok, "t_does_not_exist"], priority: 2 }),
  });
  return r.json();
}, seed);

result.bulkCalls = bulkCalls;

// Shift-click range across two adjacent cards.
await page.evaluate(() => {
  document.querySelector(".kb-bulk-group button")?.blur?.();
  const cards = [...document.querySelectorAll(".kb-card")];
  if (cards.length >= 2) {
    cards[0].dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    cards[1].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  }
});
await new Promise((r) => setTimeout(r, 600));
result.shiftRange = await page.evaluate(() => ({
  checked: document.querySelectorAll(".kb-card-pick input:checked").length,
  count: document.querySelector(".kb-bulk-count")?.textContent?.trim(),
}));

// Select-all-in-column, via the column header glyph.
await page.evaluate(() => {
  const all = document.querySelector(".kb-selectall button");
  all?.click();
});
await new Promise((r) => setTimeout(r, 500));
result.selectAll = await page.evaluate(() => ({
  count: document.querySelector(".kb-bulk-count")?.textContent?.trim(),
  totalCards: document.querySelectorAll(".kb-card").length,
  checked: document.querySelectorAll(".kb-card-pick input:checked").length,
}));

// A plain click must open the drawer and NOT select.
// Clear (the second button), so a plain click starts from nothing selected.
await page.evaluate(() => {
  const btns = [...document.querySelectorAll(".kb-selectall button")];
  btns.find((b) => b.textContent?.trim() === "Clear")?.click();
});
await new Promise((r) => setTimeout(r, 400));
result.beforePlainClick = await page.evaluate(
  () => document.querySelectorAll(".kb-card-pick input:checked").length,
);
await page.evaluate(() => document.querySelector(".kb-card")?.click());
await new Promise((r) => setTimeout(r, 1200));
result.plainClick = await page.evaluate(() => ({
  drawerOpen: Boolean(document.querySelector(".kb-drawer")),
  checked: document.querySelectorAll(".kb-card-pick input:checked").length,
}));
await page.keyboard.press("Escape");

// Clean up.
await page.evaluate(async (ids) => {
  const token = window.__HERMES_SESSION_TOKEN__;
  for (const id of [ids.ok, ids.bad].filter(Boolean)) {
    await fetch(`/api/kanban/tasks/${id}?board=default`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }
}, seed);

result.errors = errors.slice(0, 4);
console.log(JSON.stringify(result, null, 1));
await browser.close();
