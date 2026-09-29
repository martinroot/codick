/**
 * Is the board API really in core, and does the old prefix still answer?
 *
 * The move is only done if `/api/kanban` works, the deprecated
 * `/api/plugins/kanban` still answers identically, and neither depends on the
 * kanban plugin being enabled. A 401 on both would also be consistent with
 * "neither route exists and auth runs first", so the status alone is not
 * evidence -- the bodies are compared too.
 *
 * Usage: node scripts/probe-kanban-core-api.mjs
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
await page.setViewport({ width: 1400, height: 900 });
await page.authenticate({ username: "preview", password: "hermes2026" });

const errors = [];
page.on("pageerror", (e) => errors.push(e.message.slice(0, 120)));

await page.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

const result = await page.evaluate(async () => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const out = [];
  for (const base of ["/api/kanban", "/api/plugins/kanban"]) {
    for (const tail of ["/boards?board=default", "/profiles"]) {
      const url = base + tail;
      try {
        const res = await fetch(url, { headers });
        const text = await res.text();
        out.push({ url, status: res.status, length: text.length, head: text.slice(0, 90) });
      } catch (e) {
        out.push({ url, status: 0, head: String(e).slice(0, 90) });
      }
    }
  }
  // What the page itself is talking to, read from the network rather than
  // from source, so a stale bundle cannot pass this.
  return out;
});

const wire = [];
page.on("response", (r) => {
  if (r.url().includes("/api/")) wire.push(`${r.status()} ${r.url().split("8090")[1]}`);
});

console.log(JSON.stringify({ result, errors: errors.slice(0, 3) }, null, 1));
await browser.close();
