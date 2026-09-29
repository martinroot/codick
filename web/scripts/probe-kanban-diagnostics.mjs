/**
 * The attention strip, on a diagnostic the backend really produced.
 *
 * ## Why this rule
 *
 * Nothing here is in distress on its own, and a fixture would prove only that
 * the fixture renders. The obvious candidate, `block_unblock_cycling`, is
 * **unreachable**: its threshold is 3 cycles, but
 * `kanban_db.BLOCK_RECURRENCE_LIMIT = 2` diverts the third block into a
 * `block_loop_detected` event and routes the task to triage, so no task can
 * ever accumulate three `blocked` events. Reported separately.
 *
 * `review_dependency_deadlock` is reachable entirely through the public API:
 * block a parent with a `review-required:` reason while a child waits in
 * `todo` for it to become terminal. Real rules, real events, no test hook.
 *
 * ## What is asserted
 *
 * The strip appears, renders the backend's own title/detail verbatim, orders
 * the server's suggested action first, and the `cli_hint` command is present
 * and copyable. The same diagnostic is also shown on the card in the drawer.
 *
 * Usage: node scripts/probe-kanban-diagnostics.mjs
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

await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2000));

const result = {};

// A parent blocked for review while its child waits on it. All public API.
const cycled = await page.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = {
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
    "Content-Type": "application/json",
  };
  const call = (method, path, body) =>
    fetch("/api/kanban" + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });

  const parent = (await (
    await call("POST", "/tasks?board=default", {
      title: "diagnostics probe: implementation awaiting review",
    })
  ).json())?.task?.id;
  const child = (await (
    await call("POST", "/tasks?board=default", { title: "diagnostics probe: dependent task" })
  ).json())?.task?.id;
  if (!parent || !child) return { parent: null, child: null };

  const linked = await call("POST", "/links?board=default", {
    parent_id: parent,
    child_id: child,
  });
  // A child whose parent is unfinished is created/placed in `todo`, which is
  // exactly the state the rule looks for.
  const blocked = await call("PATCH", `/tasks/${parent}?board=default`, {
    status: "blocked",
    block_reason: "review-required: implementation is complete and needs a reviewer",
  });
  return { parent, child, link: linked.status, block: blocked.status };
});
result.cycled = cycled;

await new Promise((r) => setTimeout(r, 1200));
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 3000));

result.strip = await page.evaluate(() => {
  const strip = document.querySelector(".kb-strip");
  if (!strip) return { present: false };
  const card = strip.querySelector(".kb-diag");
  return {
    present: true,
    heading: strip.querySelector(".kb-strip-count")?.textContent?.trim(),
    kind: card?.getAttribute("data-kind"),
    severity: card?.getAttribute("class"),
    title: card?.querySelector(".kb-diag-title")?.textContent,
    detail: (card?.querySelector(".kb-diag-detail")?.textContent ?? "").slice(0, 90),
    suggested: Boolean(card?.querySelector(".kb-diag-suggested")),
    // The server's suggested action must come first, before the others.
    firstAction: card?.querySelector(".kb-diag-action button, .kb-diag-action code")?.textContent?.trim(),
    cliCommand: card?.querySelector(".kb-diag-cli code")?.textContent,
    filters: [...strip.querySelectorAll(".kb-strip-filters button")].map((b) => b.textContent),
    taskLink: card?.querySelector(".kb-diag-open")?.textContent,
  };
});

// The copy affordance, which is the one action reachable without a claim.
result.copy = await page.evaluate(async () => {
  const btn = document.querySelector(".kb-diag-cli button");
  if (!btn) return { present: false };
  const before = btn.textContent?.trim();
  btn.click();
  await new Promise((r) => setTimeout(r, 400));
  return { present: true, before, after: btn.textContent?.trim() };
});

// Severity filter must reach the server, not just recolour the list.
result.filtered = await page.evaluate(async () => {
  const crit = [...document.querySelectorAll(".kb-strip-filters button")].find(
    (b) => b.textContent === "critical",
  );
  crit?.click();
  await new Promise((r) => setTimeout(r, 1200));
  return {
    stillHasCards: document.querySelectorAll(".kb-strip .kb-diag").length,
    count: document.querySelector(".kb-strip-count")?.textContent?.trim(),
  };
});
await page.evaluate(() => {
  const all = [...document.querySelectorAll(".kb-strip-filters button")].find(
    (b) => b.textContent === "all",
  );
  all?.click();
});
await new Promise((r) => setTimeout(r, 1000));

// The same diagnostic must also appear on the card in the drawer.
result.inDrawer = await page.evaluate(() => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) =>
    c.textContent?.includes("awaiting review"),
  );
  if (!card) return { opened: false };
  card.click();
  return { opened: true };
});
await new Promise((r) => setTimeout(r, 2500));
result.inDrawer = {
  ...result.inDrawer,
  kind: await page.evaluate(
    () => document.querySelector(".kb-drawer .kb-diag")?.getAttribute("data-kind") ?? null,
  ),
  count: await page.evaluate(() => document.querySelectorAll(".kb-drawer .kb-diag").length),
};
await page.keyboard.press("Escape");

// Clean up.
await page.evaluate(async (ids) => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = t ? { Authorization: `Bearer ${t}` } : {};
  // The link has to go first; deleting a parent that still has children is
  // refused.
  if (ids.parent && ids.child) {
    // DELETE /links takes query params, not a body — unlike its POST sibling.
    await fetch(
      `/api/kanban/links?board=default&parent_id=${ids.parent}&child_id=${ids.child}`,
      { method: "DELETE", headers: H },
    );
  }
  for (const id of [ids.child, ids.parent].filter(Boolean)) {
    await fetch(`/api/kanban/tasks/${id}?board=default`, { method: "DELETE", headers: H });
  }
}, cycled);

result.errors = errors.slice(0, 4);
console.log(JSON.stringify(result, null, 1));
await browser.close();
