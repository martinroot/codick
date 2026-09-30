/** Remove the probe fixtures, keep Martin's own cards. */
import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await b.newPage();
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector(".kb-card", { timeout: 60000 });

const out = await page.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${t}` };
  const board = await (await fetch("/api/kanban/board?board=default", { headers: H })).json();
  const cards = (board.columns || []).flatMap((c) => c.tasks || []);
  // Anything this session's probes created is titled with its marker.
  const MINE = /^(52 |lc |guard52|tr |tr2 |tmp-|probe)/i;
  const mine = cards.filter((c) => MINE.test(c.title));
  const results = [];
  for (const c of mine) {
    const r = await fetch(`/api/kanban/tasks/${c.id}?board=default`, { method: "DELETE", headers: H });
    results.push({ id: c.id, title: c.title, status: r.status });
  }
  return {
    before: cards.length,
    removed: results.length,
    failures: results.filter((r) => r.status !== 200),
    kept: cards.filter((c) => !MINE.test(c.title)).map((c) => c.title),
  };
});

console.log(`before: ${out.before}, removed: ${out.removed}`);
if (out.failures.length) console.log("failures:", JSON.stringify(out.failures));
console.log("kept:", JSON.stringify(out.kept));
await b.close();
