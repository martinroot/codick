/**
 * Screenshot the preview dashboard so the visual result can actually be
 * looked at, instead of inferred from a build log.
 *
 * The preview is behind a basic-auth proxy, so Chromium gets credentials
 * up front rather than replaying the 401 challenge. Console errors and
 * page errors are collected: a silent runtime failure looks identical to
 * "nothing changed" in a screenshot, and the two must not be confused.
 *
 * Usage: node web/scripts/shoot.mjs [route] [outfile] [width] [height]
 */

import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const route = process.argv[2] || "/sessions?profile=default";
const out = resolve(process.argv[3] || "/home/grokwin/.hermes/cache/scratch/shot.png");
const width = Number(process.argv[4] || 1440);
const height = Number(process.argv[5] || 900);

const BASE = "http://127.0.0.1:8090";
const USER = "preview";
const PASS = "hermes2026";

const browser = await puppeteer.launch({
  headless: "new",
  // Pinned explicitly: `npx puppeteer browsers install chrome` resolves
  // the "stable" alias to a build that is not published, and there is no
  // system Chrome here to fall back on.
  executablePath:
    process.env.CHROME_PATH ||
    "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.authenticate({ username: USER, password: PASS });
  await page.goto(BASE + route, { waitUntil: "networkidle2", timeout: 45000 });
  // Let the app settle: theme application and route hydration both run
  // after first paint.
  await new Promise((r) => setTimeout(r, 2500));

  // Report the facts a screenshot alone would hide.
  const report = await page.evaluate(() => {
    const de = document.documentElement;
    const aside = document.querySelector("#app-sidebar");
    const cs = aside ? getComputedStyle(aside) : null;
    // The rect comes from the element, not from the computed style —
    // getComputedStyle has no layout of its own.
    const ar = aside ? aside.getBoundingClientRect() : null;
    const overflowing = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > de.clientWidth + 1) {
        overflowing.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 70),
          right: Math.round(r.right),
        });
      }
      if (overflowing.length > 8) break;
    }
    return {
      bsTheme: de.getAttribute("data-bs-theme"),
      viewport: de.clientWidth,
      scrollWidth: de.scrollWidth,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      aside: cs && ar
        ? {
            position: cs.position,
            width: Math.round(ar.width),
            left: Math.round(ar.left),
            background: cs.backgroundColor,
          }
        : null,
      overflowing,
    };
  });

  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: false });

  console.log("screenshot:", out);
  console.log("route:", route, `${width}x${height}`);
  console.log(JSON.stringify(report, null, 2));
  if (consoleErrors.length) {
    console.log("\nconsole errors:");
    consoleErrors.slice(0, 8).forEach((e) => console.log("  " + e.slice(0, 160)));
  }
  if (pageErrors.length) {
    console.log("\npage errors:");
    pageErrors.slice(0, 8).forEach((e) => console.log("  " + e.slice(0, 160)));
  }
  if (!consoleErrors.length && !pageErrors.length) console.log("\nno console/page errors");
} finally {
  await browser.close();
}
