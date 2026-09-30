/**
 * The trash zone, both of its paths.
 *
 * The point being tested is not "can it delete" — it obviously can. It is that
 * a drop target built only on `dragover` is a mouse affordance that a
 * touchscreen never fires, so the zone has to be a real button as well, and
 * the button has to reach the *same* confirm as the drawer and the bar rather
 * than deleting on contact.
 *
 * Usage: node scripts/probe-kanban-trash.mjs
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
const confirm = () =>
  page.evaluate(() => {
    const d = document.querySelector('[role="dialog"].sku-backdrop');
    if (!d) return { open: false };
    const btn = [...d.querySelectorAll("button")].find((b) =>
      b.className.includes("btn-danger"),
    );
    return {
      open: true,
      title: d.querySelector("h2")?.textContent,
      confirmLabel: btn?.textContent?.trim(),
      danger: Boolean(btn),
    };
  });
const zone = () =>
  page.evaluate(() => {
    const z = document.querySelector(".kb-trash");
    const b = z?.querySelector("button");
    if (!z) return { present: false };
    return {
      present: true,
      label: z.querySelector(".kb-trash-label")?.textContent?.trim(),
      disabled: b?.disabled,
      // Keyboard reachability is the whole claim, so it is checked as a fact
      // rather than inferred from the markup being a <button>.
      tabIndex: b?.tabIndex,
      ariaLabel: b?.getAttribute("aria-label"),
      armed: z.className.includes("kb-trash-armed"),
    };
  });

// --- Idle: present, inert, and it says why ---------------------------
result.idle = await zone();

// --- Selecting a card arms it -----------------------------------------
const one = await make("trash probe: dropped card");
result.one = one;
await reload();
await page.evaluate((t) => {
  const c = [...document.querySelectorAll(".kb-card")].find((x) => x.textContent?.includes(t));
  c?.scrollIntoView?.();
  c?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
}, "trash probe");
await settle(700);
result.armed = await zone();

// --- Clicking the button opens the same confirm -----------------------
await page.evaluate(() => document.querySelector(".kb-trash button")?.click());
await settle(900);
result.clickConfirm = await confirm();
await page.keyboard.press("Escape");
await settle(700);
result.afterCancel = { confirmGone: !(await confirm()).open, taskStatus: await exists(one) };

// --- A real HTML5 drop on the zone -------------------------------------
// The board's drag is HTML5, so the drop has to be real DragEvents with a
// populated dataTransfer. Reading the id off stale React state is the mistake
// that made an earlier drag probe pass without moving anything.
const two = await make("trash probe: html5 dropped");
result.two = two;
await reload();
// Each event is fired in its own turn, with a beat in between.
//
// Firing all four in one `evaluate` looks equivalent and is not: React batches
// the state updates from `dragstart`, so by the time `drop` runs the zone has
// not re-rendered into its armed state and the handler stands down. A real
// drag has real time between its events; a probe that skips it is testing a
// different event sequence than the browser ever produces.
const fire = (selector, type, tid) =>
  page.evaluate(
    ([sel, t, id]) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const dt = new DataTransfer();
      if (id) dt.setData("text/plain", id);
      el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    },
    [selector, type, tid],
  );

result.drop = {};
await page.evaluate((t) => {
  const c = [...document.querySelectorAll(".kb-card")].find((x) => x.textContent?.includes(t));
  if (c) c.dataset.trashProbe = "1";
}, "html5 dropped");
result.drop.started = await fire('[data-trash-probe="1"]', "dragstart", two);
await settle(500);
result.drop.armedAfterStart = (await zone()).armed;
result.drop.entered = await fire(".kb-trash", "dragenter");
await settle(400);
result.drop.overAfterEnter = await page.evaluate(() =>
  document.querySelector(".kb-trash")?.className.includes("kb-trash-over"),
);
await fire(".kb-trash", "dragover");
await settle(400);
// The id travels on the drop, as it does in a real browser: one DataTransfer
// is shared for the whole drag, so what `dragstart` set is what `drop` reads.
result.drop.dropped = await fire(".kb-trash", "drop", two);
await settle(1200);
result.dropConfirm = await confirm();
await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"].sku-backdrop');
  [...(d?.querySelectorAll("button") ?? [])]
    .find((b) => b.className.includes("btn-danger"))
    ?.click();
});
await settle(3000);
result.afterDropConfirm = { taskStatus: await exists(two), confirmGone: !(await confirm()).open };

// --- Keyboard: Tab must be able to reach it ---------------------------
await reload();
await page.evaluate((t) => {
  const c = [...document.querySelectorAll(".kb-card")].find((x) => x.textContent?.includes(t));
  c?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
}, "trash probe");
await settle(600);
const focusable = await page.evaluate(() => {
  const b = document.querySelector(".kb-trash button");
  b?.focus();
  return document.activeElement === b;
});
result.keyboard = { focusable, activeTag: await page.evaluate(() => document.activeElement?.className) };

await page.evaluate(async (ids) => {
  const t = window.__HERMES_SESSION_TOKEN__;
  for (const id of ids.filter(Boolean)) {
    await fetch(`/api/kanban/tasks/${id}?board=default`, {
      method: "DELETE",
      headers: t ? { Authorization: `Bearer ${t}` } : {},
    });
  }
}, [one, two]);

result.errors = errors.slice(0, 4);
console.log(JSON.stringify(result, null, 1));
await browser.close();
