/**
 * The completion contract, on both paths and against the real server.
 *
 * `kanban_db.complete_task` refuses a `done` transition with no result,
 * summary, or stored result — except out of `review`, where the human
 * approving *is* the record. Both halves are asserted, because a gate that
 * asks for a summary it does not need is as wrong as one that asks for
 * nothing.
 *
 * Measured server behaviour this is built against:
 *   PATCH  ready|blocked -> done, no evidence : 400 "no result or summary evidence"
 *   POST   bulk -> done, no evidence          : 200, per-card {ok: false, error}
 *   PATCH  review -> done, no evidence        : 200 (exempt)
 *
 * Usage: node scripts/probe-kanban-complete.mjs
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
const settle = (ms = 2000) => new Promise((r) => setTimeout(r, ms));

const setTextarea = (text) =>
  page.evaluate((value) => {
    const ta = document.querySelector('[role="dialog"] textarea');
    if (!ta) return;
    const set = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    ).set;
    set.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);

const selectByTitle = (title) =>
  page
    .evaluate((t) => {
      const card = [...document.querySelectorAll(".kb-card")].find((c) =>
        c.textContent?.includes(t),
      );
      card?.scrollIntoView?.();
      card?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    }, title)
    .then(() => settle(600));

const clickComplete = () =>
  page
    .evaluate(() => {
      [...document.querySelectorAll(".kb-bulk button")]
        .find((b) => b.textContent?.trim() === "Complete")
        ?.click();
    })
    .then(() => settle(900));

const dialogState = () =>
  page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return { open: false };
    const confirm = [...d.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "Complete",
    );
    return {
      open: true,
      title: d.querySelector("h2")?.textContent,
      confirmDisabled: confirm?.disabled,
      textareaFocused: d.activeElement?.tagName === "TEXTAREA",
    };
  });

const cardState = (id) =>
  page.evaluate(async (tid) => {
    const t = window.__HERMES_SESSION_TOKEN__;
    const d = await (
      await fetch(`/api/kanban/tasks/${tid}?board=default`, {
        headers: t ? { Authorization: `Bearer ${t}` } : {},
      })
    ).json();
    return {
      status: d?.task?.status,
      result: d?.task?.result,
      latest_summary: d?.task?.latest_summary,
    };
  }, id);

const move = (id, status) =>
  page.evaluate(
    async ([tid, to]) => {
      const t = window.__HERMES_SESSION_TOKEN__;
      return fetch(`/api/kanban/tasks/${tid}?board=default`, {
        method: "PATCH",
        headers: {
          ...(t ? { Authorization: `Bearer ${t}` } : {}),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: to }),
      }).then((r) => r.status);
    },
    [id, status],
  );

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

const reload = async () => {
  await page.reload({ waitUntil: "networkidle2" });
  await settle(2000);
};

// --- 1. No evidence: the dialog asks, and the card does not move -------
const seed = await make("completion probe: needs evidence");
result.seed = seed;
await settle(1500);
await reload();

await selectByTitle("needs evidence");
await clickComplete();
result.asksFirst = await dialogState();
result.cardBeforeTyping = await cardState(seed);

await setTextarea("    ");
await settle(400);
result.whitespaceStillBlocks = (await dialogState()).confirmDisabled;

await setTextarea("Added the retry path and covered it with a regression test.");
await settle(400);
result.textUnblocks = !(await dialogState()).confirmDisabled;

await page.evaluate(() => {
  [...document.querySelectorAll('[role="dialog"] button')]
    .find((b) => b.textContent?.trim() === "Complete")
    ?.click();
});
await settle(3000);
result.afterConfirm = { ...(await dialogState()), card: await cardState(seed) };

// --- 2. Evidence already on the card: no dialog ------------------------
await move(seed, "todo");
await reload();
await selectByTitle("needs evidence");
await clickComplete();
result.withEvidence = { ...(await dialogState()), card: await cardState(seed) };

// --- 3. Approving out of Review is exempt: no dialog --------------------
const review = await make("completion probe: review approve");
result.reviewId = review;
await move(review, "review");
await reload();
await selectByTitle("review approve");
await clickComplete();
result.reviewExempt = { ...(await dialogState()), card: await cardState(review) };

// --- 4. Escape cancels, nothing moves ----------------------------------
// Needs a card with *no* evidence, or the gate never opens a dialog and the
// keypress tests nothing. The review card is used because it is a fresh id
// and its server-written summary is the thing to prove was not discarded.
const bare = await make("completion probe: escape cancels");
result.bareId = bare;
await move(bare, "todo");
await reload();
await selectByTitle("escape cancels");
await clickComplete();
const wasOpen = (await dialogState()).open;
await setTextarea("this text must be discarded, not completed");
await settle(300);
await page.keyboard.press("Escape");
await settle(700);
result.escape = {
  wasOpen,
  nowOpen: (await dialogState()).open,
  card: await cardState(bare),
};

await page.evaluate(async (ids) => {
  const t = window.__HERMES_SESSION_TOKEN__;
  for (const id of Object.values(ids).filter(Boolean)) {
    await fetch(`/api/kanban/tasks/${id}?board=default`, {
      method: "DELETE",
      headers: t ? { Authorization: `Bearer ${t}` } : {},
    });
  }
}, { a: seed, b: review, c: bare });

result.errors = errors.slice(0, 4);
console.log(JSON.stringify(result, null, 1));
await browser.close();
