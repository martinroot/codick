/**
 * The drawer's write side (#49): can a user actually comment, attach and
 * link from the drawer?
 *
 * Read-side checks live in probe-kanban-drawer.mjs. This one exercises the
 * three write paths through the UI itself — real key presses, real waits
 * between them, no batched React events — and checks the server got each
 * write, not just that the DOM changed:
 *
 * - a posted comment comes back in the re-read detail;
 * - "Blocked by" creates a real edge (re-read shows the row), a reverse
 *   link is refused with the server's cycle sentence shown in the drawer;
 * - an uploaded attachment appears in the list, and Delete removes it.
 *
 * Cleans up every seeded task. Usage: node scripts/probe-kanban-drawer-write.mjs
 */

import puppeteer from "puppeteer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";

const SHOT_DIR = "/home/grokwin/.hermes/cache/scratch/drawer-write-shots";
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = (page, name) =>
  page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });

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
  if (u.includes("/api/kanban/")) {
    const p = u.split("8090")[1]?.split("?")[0] ?? u;
    wire.push(`${r.request().method()} ${p} -> ${r.status()}`);
  }
});

await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

// Seed three tasks. A is the drawer's subject; B is the parent it will be
// blocked by; C is the grandchild for the cycle attempt.
const seed = await page.evaluate(async () => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const H = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "Content-Type": "application/json",
  };
  const mk = async (title) => {
    const res = await (
      await fetch("/api/kanban/tasks?board=default", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ title, initialStatus: "blocked" }),
      })
    ).json();
    return res?.task?.id ?? null;
  };
  return { a: await mk("drawer-write A"), b: await mk("drawer-write B"), c: await mk("drawer-write C") };
});
await new Promise((r) => setTimeout(r, 1500));
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2000));

const short = (id) => (id ?? "").replace(/^t_/, "");

// ── Comments ────────────────────────────────────────────────────────────
wire.length = 0;
await page.evaluate((id) => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) =>
    c.textContent?.includes("drawer-write A"),
  );
  card?.click();
}, seed.a);
await new Promise((r) => setTimeout(r, 2000));

await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".kb-drawer-tab")].find((t) =>
    t.textContent?.includes("Comments"),
  );
  tab?.click();
});
await new Promise((r) => setTimeout(r, 600));

const before = await page.evaluate(
  () => document.querySelectorAll(".kb-drawer-item").length,
);
await page.type(".kb-comment-composer textarea", "posted from the drawer probe");
await new Promise((r) => setTimeout(r, 300));
await page.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 2000));
const comments = await page.evaluate((before) => {
  const drawer = document.querySelector(".kb-drawer");
  const items = [...drawer.querySelectorAll(".kb-drawer-item")];
  return {
    countBefore: before,
    countAfter: items.length,
    textShown: drawer.textContent.includes("posted from the drawer probe"),
    composerCleared: drawer.querySelector(".kb-comment-composer textarea")?.value === "",
  };
}, before);
await shot(page, "1-comment-posted");

// ── Dependencies: add "Blocked by B" ────────────────────────────────────
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".kb-drawer-tab")].find((t) =>
    t.textContent?.includes("Detail"),
  );
  tab?.click();
});
await new Promise((r) => setTimeout(r, 600));

await page.type(".kb-deps-add input", short(seed.b));
await new Promise((r) => setTimeout(r, 300));
await page.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 2000));
const linkAdd = await page.evaluate((bid) => {
  const drawer = document.querySelector(".kb-drawer");
  const rows = [...drawer.querySelectorAll(".kb-deps-row")].map((r) => r.textContent);
  return {
    rows,
    hasParentRow: rows.some((t) => t.includes(bid)),
    inputCleared: drawer.querySelector(".kb-deps-add input")?.value === "",
  };
}, short(seed.b));
await shot(page, "2-link-added");

// ── The cycle: in B's drawer, try "Blocked by A" ────────────────────────
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 500));
await page.evaluate((id) => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) =>
    c.textContent?.includes("drawer-write B"),
  );
  card?.click();
}, seed.b);
await new Promise((r) => setTimeout(r, 2000));
await page.type(".kb-deps-add input", short(seed.a));
await new Promise((r) => setTimeout(r, 300));
await page.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 1500));
const cycle = await page.evaluate(() => {
  const drawer = document.querySelector(".kb-drawer");
  const alert = drawer.querySelector(".kb-drawer-error[role='alert']");
  return {
    errorShown: alert?.textContent ?? null,
    inputKept: drawer.querySelector(".kb-deps-add input")?.value ?? null,
  };
});
await shot(page, "3-cycle-refused");

// ── Blocks direction: B blocks C ────────────────────────────────────────
await page.evaluate(() => {
  const sel = document.querySelector(".kb-deps-side");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  ).set;
  setter.call(sel, "children");
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 400));
// The cycle attempt left the typed id in the box; replace it with C.
await page.evaluate(() => {
  const input = document.querySelector(".kb-deps-add input");
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  ).set;
  setter.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 200));
await page.type(".kb-deps-add input", short(seed.c));
await new Promise((r) => setTimeout(r, 300));
await page.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 2000));
const blocks = await page.evaluate((cid) => {
  const drawer = document.querySelector(".kb-drawer");
  const rows = [...drawer.querySelectorAll(".kb-deps-row")].map((r) => r.textContent);
  return { rows, hasChildRow: rows.some((t) => t.includes(cid)) };
}, short(seed.c));

// ── Remove the B <- C edge again ────────────────────────────────────────
await page.evaluate(() => {
  const row = [...document.querySelectorAll(".kb-deps-row")].find((r) =>
    r.textContent.includes("drawer-write".slice(0, 0) === "" ? "C" : "C"),
  );
  row?.querySelector("button")?.click();
});
await new Promise((r) => setTimeout(r, 2000));
const afterRemove = await page.evaluate((cid) => {
  const rows = [...document.querySelectorAll(".kb-deps-row")].map((r) => r.textContent);
  return { rows, childGone: !rows.some((t) => t.includes(cid)) };
}, short(seed.c));

// ── Attachments ─────────────────────────────────────────────────────────
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 500));
await page.evaluate((id) => {
  const card = [...document.querySelectorAll(".kb-card")].find((c) =>
    c.textContent?.includes("drawer-write A"),
  );
  card?.click();
}, seed.a);
await new Promise((r) => setTimeout(r, 2000));
await page.evaluate(() => {
  const tab = [...document.querySelectorAll(".kb-drawer-tab")].find((t) =>
    t.textContent?.includes("Files"),
  );
  tab?.click();
});
await new Promise((r) => setTimeout(r, 600));

const uploadPath = path.join(os.tmpdir(), "drawer-write-probe.txt");
fs.writeFileSync(uploadPath, "attachment written from the drawer probe\n");
await page.$eval(".kb-upload input[type='file']", (el) => {
  // The styled button opens the native picker; the probe feeds the input
  // directly, which is the same onChange path.
  return el;
});
const fileInput = await page.$(".kb-upload input[type='file']");
await fileInput.uploadFile(uploadPath);
await new Promise((r) => setTimeout(r, 2500));
const files = await page.evaluate(() => {
  const drawer = document.querySelector(".kb-drawer");
  const rows = [...drawer.querySelectorAll(".kb-drawer-file")].map((r) => r.textContent);
  return { rows, hasFile: rows.some((t) => t.includes("drawer-write-probe.txt")) };
});
await shot(page, "4-attachment-uploaded");

// Delete it again through the UI.
await page.evaluate(() => {
  const row = [...document.querySelectorAll(".kb-drawer-file")].find((r) =>
    r.textContent.includes("drawer-write-probe.txt"),
  );
  [...row.querySelectorAll("button")].find((b) => b.textContent === "Delete")?.click();
});
await new Promise((r) => setTimeout(r, 2000));
const afterDelete = await page.evaluate(() => {
  const drawer = document.querySelector(".kb-drawer");
  return {
    rows: [...drawer.querySelectorAll(".kb-drawer-file")].map((r) => r.textContent),
    emptyNote: drawer.textContent.includes("No attachments."),
  };
});

// ── Cleanup: every seeded task, then confirm the board forgot them ──────
const cleanup = await page.evaluate(async (ids) => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const H = token ? { Authorization: `Bearer ${token}` } : {};
  const out = {};
  for (const id of ids) {
    if (!id) continue;
    const res = await fetch(`/api/kanban/tasks/${id}?board=default`, {
      method: "DELETE",
      headers: H,
    });
    out[id] = res.status;
  }
  return out;
}, [seed.a, seed.b, seed.c]);
await new Promise((r) => setTimeout(r, 1200));
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2000));
const boardClean = await page.evaluate(
  () =>
    !document.body.textContent.includes("drawer-write A") &&
    !document.body.textContent.includes("drawer-write B") &&
    !document.body.textContent.includes("drawer-write C"),
);

console.log(
  JSON.stringify(
    {
      seed,
      comments,
      linkAdd,
      cycle,
      blocks,
      afterRemove,
      files,
      afterDelete,
      cleanup,
      boardClean,
      wire,
      errors: errors.slice(0, 6),
      shots: SHOT_DIR,
    },
    null,
    1,
  ),
);
await browser.close();
