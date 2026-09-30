/**
 * Does the delete confirm name what the delete will do?
 *
 * The server fix in #52 makes deleting a running task kill a worker and
 * deleting a parent release someone else's card. A confirm that still says
 * only "cannot be undone" would leave both invisible, so the fix would be
 * real on the backend and absent from the thing the user actually reads.
 */
import puppeteer from "puppeteer";

const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await b.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 120)}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text().slice(0, 120)}`));
await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector(".kb-card", { timeout: 60000 });

const settle = (ms = 1600) => new Promise((r) => setTimeout(r, ms));

const make = (title, extra = {}) =>
  page.evaluate(async (name, x) => {
    const t = window.__HERMES_SESSION_TOKEN__;
    const r = await fetch("/api/kanban/tasks?board=default", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ title: name, ...x }),
    });
    const j = await r.json();
    return j.id ?? j.task?.id;
  }, title, extra);

const parent = await make("52 ui parent");
const child = await make("52 ui child", { parents: [parent] });
console.log(`parent ${parent} -> child ${child}`);

// Open the confirm for the parent alone. It must name the dependent card.
const sample = await page.evaluate(() => {
  const el = document.querySelector(".kb-card");
  // The first [title] is the selection label, not the id — reach the <code>.
  return el?.querySelector("code[title]")?.getAttribute("title") ?? null;
});
console.log("board sample card:", sample);

const out = await page.evaluate(async (pid) => {
  // Wait for the board to have the new cards.
  // A card has no data-id; its id is on the <code title={task.id}> inside.
  const find = () =>
    [...document.querySelectorAll(".kb-card")].find((c) => c.querySelector(`[title="${pid}"]`));
  for (let i = 0; i < 40 && !find(); i++) await new Promise((r) => setTimeout(r, 300));
  const card = find();
  if (!card) return { found: false };

  // The confirm reads the page's OWN board snapshot, and that snapshot only
  // learns about the child once a refetch lands. Clicking the instant the card
  // appears measures the probe's impatience rather than the product, so give
  // the refetch the same settle the other probes in this repo use.
  await new Promise((r) => setTimeout(r, 2500));

  card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1500));
  // The drawer opened; take the Delete route from there.
  // The drawer's action reads "Delete this task", not "Delete".
  const btn = [...document.querySelectorAll("button")].find((b) =>
    /^delete this task$/i.test(b.textContent.trim()),
  );
  if (!btn) return { found: true, deleteButton: false };
  btn.click();
  await new Promise((r) => setTimeout(r, 900));
  const backdrop = document.querySelector(".sku-backdrop");
  if (!backdrop) return { found: true, deleteButton: true, confirm: false };
  return {
    found: true,
    deleteButton: true,
    confirm: true,
    text: backdrop.innerText.replace(/\s+/g, " ").trim(),
    warn: !!backdrop.querySelector(".kb-confirm-warn"),
    warnColor: backdrop.querySelector(".kb-confirm-warn")
      ? getComputedStyle(backdrop.querySelector(".kb-confirm-warn")).borderLeftColor
      : null,
    warnWidth: backdrop.querySelector(".kb-confirm-warn")
      ? getComputedStyle(backdrop.querySelector(".kb-confirm-warn")).borderLeftWidth
      : null,
    dangerButton: (() => {
      const d = [...backdrop.querySelectorAll("button")].find((x) => /delete/i.test(x.textContent));
      return d ? { text: d.textContent.trim(), bg: getComputedStyle(d).backgroundColor } : null;
    })(),
  };
}, parent);

console.log("\n-- the confirm for a parent card --");
console.log(JSON.stringify(out, null, 2).slice(0, 1400));

// A plain card must NOT carry the warning: an always-on block would train
// people to stop reading it.
const plain = await make("52 ui plain");
const plainOut = await page.evaluate(async (pid) => {
  const find = () =>
    [...document.querySelectorAll(".kb-card")].find((c) => c.querySelector(`[title="${pid}"]`));
  for (let i = 0; i < 40 && !find(); i++) await new Promise((r) => setTimeout(r, 300));
  const card = find();
  if (!card) return { found: false };
  card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1500));
  // The drawer's action reads "Delete this task", not "Delete".
  const btn = [...document.querySelectorAll("button")].find((b) =>
    /^delete this task$/i.test(b.textContent.trim()),
  );
  if (!btn) return { found: true, deleteButton: false };
  btn.click();
  await new Promise((r) => setTimeout(r, 900));
  const backdrop = document.querySelector(".sku-backdrop");
  if (!backdrop) return { found: true, deleteButton: true, confirm: false };
  return { found: true, confirm: true, warn: !!backdrop.querySelector(".kb-confirm-warn") };
}, plain);

console.log("\n-- the confirm for a plain card --");
console.log(JSON.stringify(plainOut));

const checks = [
  ["the parent card was on the board", out.found === true],
  ["its Delete action exists", out.deleteButton === true],
  ["a confirm opened", out.confirm === true],
  ["the warning block is present", out.warn === true],
  ["it names the dependent card", /depend/i.test(out.text || "")],
  ["it says the card is released", /released/i.test(out.text || "")],
  ["it still says it cannot be undone", /cannot be undone/i.test(out.text || "")],
  ["a plain card gets no warning", plainOut.warn === false],
  ["no page errors", errors.filter((e) => e.startsWith("pageerror")).length === 0],
];

console.log("\n-- checks --");
let bad = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) bad++;
}
if (errors.length) console.log("\nerrors:\n  " + errors.slice(0, 6).join("\n  "));
console.log(bad ? `\nFAILED: ${bad}` : "\nall checks passed");

await page.evaluate(async (ids) => {
  const t = window.__HERMES_SESSION_TOKEN__;
  for (const id of ids) {
    await fetch(`/api/kanban/tasks/${id}?board=default`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${t}` },
    });
  }
}, [parent, child, plain].filter(Boolean));

await b.close();
process.exit(bad ? 1 : 0);
