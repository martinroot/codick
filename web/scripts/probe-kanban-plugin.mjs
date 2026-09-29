/**
 * Did the kanban plugin take over the board route, and did it actually draw?
 *
 * A plugin that registers and a plugin that renders are different claims:
 * the bundle self-registers into window.__HERMES_PLUGINS__, and only reading
 * the DOM afterwards shows whether it painted anything.
 *
 * Usage: node scripts/probe-kanban-plugin.mjs <route> <screenshot.png>
 */

import puppeteer from "puppeteer";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";

const route = process.argv[2] || "/kanban";
const shot = process.argv[3] || "/home/grokwin/.hermes/cache/scratch/plugin.png";

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath: CHROME,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text().slice(0, 160));
});

await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090" + route, {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 3500));

const out = await page.evaluate(() => ({
  scriptTags: [...document.querySelectorAll("script[src*=kanban]")].map((s) =>
    s.getAttribute("src"),
  ),
  cssTags: [...document.querySelectorAll("link[href*=kanban]")].map((l) =>
    l.getAttribute("href"),
  ),
  headings: [...document.querySelectorAll("h1, h2, h3")]
    .map((e) => e.textContent.trim().slice(0, 30))
    .slice(0, 8),
  buttons: document.querySelectorAll("button").length,
  text: document.body.innerText.replace(/\s+/g, " ").slice(0, 240),
}));

await page.screenshot({ path: shot });
console.log(JSON.stringify({ ...out, errors: errors.slice(0, 6) }, null, 1));
await browser.close();
