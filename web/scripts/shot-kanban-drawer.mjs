/**
 * Open the drawer on a real task and photograph it.
 *
 * Usage: node scripts/shot-kanban-drawer.mjs [outfile]
 */
import puppeteer from "puppeteer";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";
const out = process.argv[2] || "/tmp/kb-drawer.png";

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath: CHROME,
});
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

// Open whichever card exists, so this works on an empty board too.
const opened = await page.evaluate(() => {
  const card = document.querySelector(".kb-card");
  if (!card) return null;
  card.click();
  return card.querySelector(".kb-card-title")?.textContent ?? null;
});
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: out });
console.log(JSON.stringify({ opened, out }));
await browser.close();
