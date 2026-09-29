/**
 * Recovery actions, on real board state.
 *
 * The conditional logic is the substance of #9: a panel that offers reclaim on
 * a card with no claim trains the operator to click a button that 409s. So
 * this asserts the *absence* as carefully as the presence.
 *
 * The dispatcher may or may not claim a task while the probe runs, so the
 * reclaim check reports what it actually saw rather than assuming either way.
 *
 * Usage: node scripts/probe-kanban-recovery.mjs
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
const calls = [];
page.on("response", (r) => {
  const u = r.url();
  if (/\/api\/kanban\/(tasks|runs)\//.test(u) && r.request().method() !== "GET") {
    calls.push(`${r.request().method()} ${u.split("8090")[1]} -> ${r.status()}`);
  }
});

await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2000));

const result = {};

// A card in `blocked` must offer Unblock; one with nothing wrong must not.
const seed = await page.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = {
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
    "Content-Type": "application/json",
  };
  const post = (b) =>
    fetch("/api/kanban/tasks?board=default", {
      method: "POST",
      headers: H,
      body: JSON.stringify(b),
    }).then((r) => r.json());
  const blocked = await post({ title: "recovery probe blocked", initial_status: "blocked" });
  const healthy = await post({ title: "recovery probe healthy", initial_status: "triage", triage: true });
  return { blocked: blocked?.task?.id ?? null, healthy: healthy?.task?.id ?? null };
});
await new Promise((r) => setTimeout(r, 2000));
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2000));

const openFor = async (title) => {
  await page.evaluate((t) => {
    const rail = document.querySelector(".kb-rail");
    const card = [...document.querySelectorAll(".kb-card")].find((c) =>
      c.textContent?.includes(t),
    );
    if (rail && card) rail.scrollLeft = Math.max(0, card.offsetLeft - 40);
    card?.click();
  }, title);
  await new Promise((r) => setTimeout(r, 1800));
  return page.evaluate(() => {
    const panel = document.querySelector(".kb-drawer");
    if (!panel) return { open: false };
    const buttons = [...panel.querySelectorAll(".kb-recovery-actions button")].map(
      (b) => b.textContent?.trim(),
    );
    return {
      open: true,
      heading: [...panel.querySelectorAll(".kb-drawer-h3")].map((h) => h.textContent),
      hasRecovery: panel.textContent?.includes("Recovery") ?? false,
      nothingToRecover: panel.textContent?.includes("Nothing to recover") ?? false,
      buttons,
      reasonPlaceholder: panel
        .querySelector(".kb-recovery-reason input")
        ?.getAttribute("placeholder"),
    };
  });
};

result.blockedCard = await openFor("recovery probe blocked");

// Unblock is a real PATCH; click it and confirm the card actually moved.
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".kb-recovery-actions button")].find(
    (b) => b.textContent?.trim() === "Unblock",
  );
  btn?.click();
});
await new Promise((r) => setTimeout(r, 2500));
result.afterUnblock = await page.evaluate(() => ({
  stillHasUnblock: [...document.querySelectorAll(".kb-recovery-actions button")].some(
    (b) => b.textContent?.trim() === "Unblock",
  ),
  nothingToRecover: document.querySelector(".kb-drawer")?.textContent?.includes("Nothing to recover"),
}));
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 600));

result.healthyCard = await openFor("recovery probe healthy");
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 500));

// Whether the dispatcher claimed anything at all — reported, not assumed.
result.claims = await page.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = t ? { Authorization: `Bearer ${t}` } : {};
  const board = await (await fetch("/api/kanban/board?board=default", { headers: H })).json();
  const cards = board.columns.flatMap((c) => c.tasks);
  const claimed = cards.filter((c) => c.claim_lock);
  return {
    total: cards.length,
    claimed: claimed.map((c) => ({ id: c.id, lock: c.claim_lock, expires: c.claim_expires })),
  };
});

result.calls = calls;
await page.evaluate(async (ids) => {
  const t = window.__HERMES_SESSION_TOKEN__;
  for (const id of Object.values(ids).filter(Boolean)) {
    await fetch(`/api/kanban/tasks/${id}?board=default`, {
      method: "DELETE",
      headers: t ? { Authorization: `Bearer ${t}` } : {},
    });
  }
}, seed);
result.seed = seed;
result.errors = errors.slice(0, 4);
console.log(JSON.stringify(result, null, 1));
await browser.close();
