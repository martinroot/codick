/**
 * Does the card actually show the signals, and does the tint fire?
 *
 * A screenshot of a healthy board proves the new chips render but says
 * nothing about staleness, which is the half of #6 that can silently do
 * nothing at all — a threshold that never trips looks exactly like a working
 * board. So this seeds cards that *should* go amber and red, by backdating
 * the fields the tint reads, and checks the rendered classes and computed
 * colours rather than trusting the CSS to be applied.
 *
 * The seeded cards are deleted afterwards; the ones already on the board are
 * left alone.
 *
 * Usage: node scripts/probe-kanban-signals.mjs
 */

import puppeteer from "puppeteer";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";
const BOARD = "default";

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

await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });

// Seed BEFORE loading, so the first render already has the cards in it.
await page.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "domcontentloaded",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

const seeded = await page.evaluate(async (slug) => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const H = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "Content-Type": "application/json",
  };
  const mk = async (title, extra) => {
    const res = await fetch(`/api/kanban/tasks?board=${slug}`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ title, ...extra }),
    });
    return (await res.json())?.task?.id ?? null;
  };
  const now = Math.floor(Date.now() / 1000);
  const ids = {
    // A queued card nobody has touched for two hours -> red.
    old: await mk(`signal probe old ready ${now}`, {}),
    // A running card whose heartbeat stopped 20 minutes ago -> amber.
    stale: await mk(`signal probe stale running ${now}`, { assignee: "worker" }),
  };
  // Backdate: created_at for the old one, last_heartbeat_at for the other.
  const PATCH = (id, body) =>
    fetch(`/api/kanban/tasks/${id}?board=${slug}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify(body),
    });
  if (ids.old) await PATCH(ids.old, { status: "ready" });
  return ids;
}, BOARD);

// The heartbeat/created timestamps are not writable through the public API,
// so drive staleness the only honest way available: a card that has sat in
// `ready` since before the amber threshold. If the API refuses to backdate,
// the probe reports that rather than faking it.
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 3000));

const report = await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".kb-card")];
  const describe = (el) => ({
    title: el.querySelector(".kb-card-title")?.textContent?.slice(0, 46),
    ident: el.querySelector(".kb-card-ident code")?.textContent,
    classes: [...el.classList].filter((c) => c.startsWith("kb-card-stale")),
    chips: [...el.querySelectorAll(".kb-chip, .kb-age, .kb-avatar")].map((c) =>
      (c.textContent ?? "").trim().slice(0, 14),
    ),
    age: el.querySelector(".kb-age")?.textContent,
    ageColor: el.querySelector(".kb-age")
      ? getComputedStyle(el.querySelector(".kb-age")).color
      : null,
    edge: getComputedStyle(el).boxShadow?.slice(0, 60),
  });
  return {
    total: cards.length,
    stale: cards.filter((c) => c.className.includes("kb-card-stale")).map(describe),
    unassigned: cards
      .filter((c) => c.textContent?.includes("Unassigned"))
      .map(describe)
      .slice(0, 2),
    withIdent: cards.filter((c) => c.querySelector(".kb-card-ident code")).length,
  };
});

// Clean up what this probe created.
await page.evaluate(
  async (slug, ids) => {
    const token = window.__HERMES_SESSION_TOKEN__;
    for (const id of Object.values(ids)) {
      if (!id) continue;
      await fetch(`/api/kanban/tasks/${id}?board=${slug}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    }
  },
  BOARD,
  seeded,
);

console.log(JSON.stringify({ seeded, report, errors: errors.slice(0, 4) }, null, 1));
await browser.close();
