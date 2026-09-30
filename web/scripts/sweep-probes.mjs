/** Remove this session's probe fixtures by id, keep Martin's own cards.

 * This used to filter by a title-prefix allowlist (`/^(52 |lc |guard52|...)/`),
 * which silently kept every fixture whose title did not carry a marker — the
 * three `child` cards from the #52 parent/child probe and three finished
 * probe tasks all survived it, and the board filled up with this session's
 * own litter. Titles are not identity; ids are.
 */
import puppeteer from "puppeteer";

// Confirmed against the live board by event history, not by title.
const MINE = [
  "t_fc6e7d57", // child  (created -> dependency_wait -> promoted)
  "t_c0e79965", // child
  "t_5e216bf3", // child
  "t_e088bf22", // Run basic smoke test and report results
  "t_e5eb4fbf", // Verify pipeline guard probe binding and report status
  "t_250f3319", // Run pipeline guard probe and report health status
];
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await b.newPage();
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector(".kb-card", { timeout: 60000 });

const out = await page.evaluate(async (mineIds) => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${t}` };
  const board = await (await fetch("/api/kanban/board?board=default", { headers: H })).json();
  const cards = (board.columns || []).flatMap((c) => c.tasks || []);
  const ids = new Set(mineIds);
  const mine = cards.filter((c) => ids.has(c.id));
  const results = [];
  for (const c of mine) {
    const r = await fetch(`/api/kanban/tasks/${c.id}?board=default`, { method: "DELETE", headers: H });
    results.push({ id: c.id, title: c.title, status: r.status });
  }
  return {
    before: cards.length,
    removed: results.length,
    failures: results.filter((r) => r.status !== 200),
    kept: cards.filter((c) => !ids.has(c.id)).map((c) => c.title),
  };
}, MINE);

console.log(`before: ${out.before}, removed: ${out.removed}`);
if (out.failures.length) console.log("failures:", JSON.stringify(out.failures));
console.log("kept:", JSON.stringify(out.kept));
await b.close();
