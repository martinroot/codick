/**
 * Deletion and archive confirmations, on the live board.
 *
 * `kanban_db.delete_task` is a hard DELETE with no guard — no check for a
 * running card, no check for children, no undo. So the thing under test here
 * is not the deletion, it is the confirm: that it names what it destroys,
 * that cancelling destroys nothing, and that a per-card refusal is reported
 * as a per-card refusal rather than as one cheerful verdict.
 *
 * Usage: node scripts/probe-kanban-delete.mjs
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

const settle = (ms = 1800) => new Promise((r) => setTimeout(r, ms));
const result = {};

const make = (title) =>
  page.evaluate(async (name) => {
    const t = window.__HERMES_SESSION_TOKEN__;
    const H = {
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      "Content-Type": "application/json",
    };
    const c = await (
      await fetch("/api/kanban/tasks?board=default", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ title: name }),
      })
    ).json();
    return c?.task?.id ?? null;
  }, title);

const exists = (id) =>
  page.evaluate(async (tid) => {
    const t = window.__HERMES_SESSION_TOKEN__;
    const r = await fetch(`/api/kanban/tasks/${tid}?board=default`, {
      headers: t ? { Authorization: `Bearer ${t}` } : {},
    });
    return r.status;
  }, id);

const reload = async () => {
  await page.reload({ waitUntil: "networkidle2" });
  await settle(2000);
};
const select = (title) =>
  page
    .evaluate((t) => {
      const card = [...document.querySelectorAll(".kb-card")].find((c) =>
        c.textContent?.includes(t),
      );
      card?.scrollIntoView?.();
      card?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    }, title)
    .then(() => settle(500));
const clickBulk = (label) =>
  page
    .evaluate((text) => {
      [...document.querySelectorAll(".kb-bulk button")]
        .find((b) => b.textContent?.trim() === text)
        ?.click();
    }, label)
    .then(() => settle(900));
const CONFIRM = '[role="dialog"].sku-backdrop';

const dialog = () =>
  page.evaluate((sel) => {
    // Scoped to the confirm's own backdrop class. Three things on this page are
    // `role="dialog"` — the confirm, the create form (`.kb-create`) and the
    // task drawer — so a bare attribute query finds whichever mounted first and
    // reports the drawer's title and close button as though they were the
    // confirm's. Which is exactly what it did.
    const d = document.querySelector(sel);
    if (!d) return { open: false };
    const confirm = [...d.querySelectorAll("button")].find(
      (b) => b.className.includes("btn-") && !b.textContent?.includes("Cancel"),
    );
    return {
      open: true,
      title: d.querySelector("h2")?.textContent,
      body: d.textContent?.replace(/\s+/g, " ").trim().slice(0, 200),
      confirmLabel: confirm?.textContent?.trim(),
      confirmClass: confirm?.className,
      // A delete confirm must not ask for typed text: an empty field here
      // would mean the completion dialog's plumbing leaked into it.
      hasTextarea: Boolean(d.querySelector("textarea")),
      listedCards: d.querySelectorAll(".kb-confirm-list li").length,
    };
  }, CONFIRM);

// --- 1. One card: the confirm names it and the button is danger ---------
const one = await make("delete probe: keep the work");
result.one = one;
await reload();
await select("keep the work");
await clickBulk("Delete");
result.single = await dialog();

// --- 2. Cancelling destroys nothing ------------------------------------
await page.keyboard.press("Escape");
await settle(700);
result.afterCancel = { dialogOpen: (await dialog()).open, taskStatus: await exists(one) };

// --- 3. Confirming actually deletes ------------------------------------
await select("keep the work");
await clickBulk("Delete");
result.reopenState = await page.evaluate(() => ({
  dialog: Boolean(document.querySelector('[role="dialog"]')),
  selected: document.querySelectorAll(".kb-card-pick input:checked").length,
  count: document.querySelector(".kb-bulk-count")?.textContent,
  bulkLabels: [...document.querySelectorAll(".kb-bulk button")].map((b) => b.textContent?.trim()),
  cardPresent: [...document.querySelectorAll(".kb-card")].some((c) =>
    c.textContent?.includes("keep the work"),
  ),
}));
await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return;
  [...d.querySelectorAll("button")].find((b) => b.className.includes("btn-danger"))?.click();
});
await settle(3000);
result.afterConfirm = { taskStatus: await exists(one), dialogOpen: (await dialog()).open };

// --- 4. Several cards: the list is the authority on the count ----------
const many = [];
for (const n of [1, 2, 3]) many.push(await make(`delete probe: batch ${n} of 3`));
result.many = many;
await reload();
for (const n of [1, 2, 3]) await select(`batch ${n} of 3`);
await clickBulk("Delete");
result.bulk = await dialog();
result.bulk.selected = await page.evaluate(
  () => document.querySelector(".kb-bulk-count")?.textContent,
);

// --- 5. A card vanishes while the confirm is open ---------------------
// `delete_task` has no guards, so nothing refuses a *live* card: the only
// refusal it can produce is a 404. That is exactly the race worth testing —
// the confirm holds the cards as of when it opened, so a card that disappears
// underneath it must come back as a per-card refusal and must stay selected,
// while its sibling is deleted. A single "deleted 2 cards" here would be a
// lie the board contradicts on the next refetch.
const race = [];
for (const n of [1, 2]) race.push(await make(`delete probe: race ${n} of 2`));
result.race = race;
await reload();
for (const n of [1, 2]) await select(`race ${n} of 2`);
await clickBulk("Delete");
result.raceDialog = await dialog();

// Pull one out from under the open dialog.
await page.evaluate(async (ids) => {
  const t = window.__HERMES_SESSION_TOKEN__;
  await fetch(`/api/kanban/tasks/${ids[0]}?board=default`, {
    method: "DELETE",
    headers: t ? { Authorization: `Bearer ${t}` } : {},
  });
}, race);
await settle(900);
result.raceDialogHeld = (await dialog()).confirmLabel;
await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return;
  [...d.querySelectorAll("button")].find((b) => b.className.includes("btn-danger"))?.click();
});
await settle(3000);
result.raceOutcome = await page.evaluate(() => ({
  bar: document.querySelector(".kb-bulk-failures")?.textContent?.replace(/\s+/g, " ").trim(),
  // The bar unmounts when the selection empties, which is exactly the state a
  // delete refusal creates — so the outcome has to be readable somewhere that
  // does not depend on the selection.
  notice: document.querySelector(".alert")?.textContent?.replace(/\s+/g, " ").trim(),
  stillSelected: document.querySelectorAll(".kb-card-pick input:checked").length,
}));
result.raceSurvivors = [];
for (const id of race) result.raceSurvivors.push(await exists(id));

// --- 5b. The drawer's own delete goes through the same gate -------------
const viaDrawer = await make("delete probe: from the drawer");
result.viaDrawer = viaDrawer;
await reload();
await page.evaluate((t) => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) => c.textContent?.includes(t));
  card?.scrollIntoView?.();
  card?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}, "from the drawer");
await settle(1500);
result.drawerHasButton = await page.evaluate(
  () => Boolean(document.querySelector(".kb-drawer-danger button")),
);
await page.evaluate(() => {
  document.querySelector(".kb-drawer-danger button")?.click();
});
await settle(900);
result.drawerConfirm = await dialog();
await page.keyboard.press("Escape");
await settle(700);
result.afterDrawerCancel = { confirmGone: !(await dialog()).open, taskStatus: await exists(viaDrawer) };

// --- 6. Archive is confirmed too, and is not styled as danger ---------
const arch = await make("archive probe: reversible");
result.arch = arch;
await reload();
await select("reversible");
await clickBulk("Archive");
result.archive = await dialog();
await page.keyboard.press("Escape");
await settle(600);

await page.evaluate(async (ids) => {
  const t = window.__HERMES_SESSION_TOKEN__;
  for (const id of Object.values(ids).filter(Boolean)) {
    await fetch(`/api/kanban/tasks/${id}?board=default`, {
      method: "DELETE",
      headers: t ? { Authorization: `Bearer ${t}` } : {},
    });
  }
}, { a: arch, b: [...many, ...race, viaDrawer].filter(Boolean) });

result.errors = errors.slice(0, 4);
console.log(JSON.stringify(result, null, 1));
await browser.close();
