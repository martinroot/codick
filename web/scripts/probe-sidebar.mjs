/**
 * Why is the rail still `position: fixed` at 1280px when the compiled
 * stylesheet plainly contains `.sticky` inside a 64rem media query?
 *
 * Dumps the element's class list, its resolved position, and — the part
 * that matters — every rule in the document that sets `position` and
 * matches the element, in cascade order. Cascade layers and source order
 * decide the winner, and neither is visible from a screenshot.
 */

import puppeteer from "puppeteer";

const BASE = "http://127.0.0.1:8090";
const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: CHROME,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 857 });
  await page.authenticate({ username: "preview", password: "hermes2026" });
  await page.goto(BASE + (process.argv[2] || "/sessions?profile=default"), {
    waitUntil: "networkidle2",
    timeout: 45000,
  });
  await new Promise((r) => setTimeout(r, 2000));

  const out = await page.evaluate(() => {
    const el = document.querySelector("#app-sidebar");
    if (!el) return { error: "no #app-sidebar" };

    // Every rule that sets `position` and matches this element, walking
    // stylesheets in order. Later entries win at equal specificity.
    const hits = [];
    const diag = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        diag.push({ href: sheet.href, error: "unreadable: " + e.message });
        continue;
      }
      let walked = 0;
      const walk = (list, mq) => {
        for (const rule of list) {
          // Recurse into anything with nested rules — media queries AND
          // `@layer` blocks. A CSSLayerBlockRule has `.cssRules` but no
          // `.media`, so gating on `.media` alone skips the entire
          // legacy-utilities layer, which is exactly where `.fixed` and
          // the media-scoped `.sticky` live.
          if (rule.cssRules) {
            const cond =
              mq || (rule.media && (rule.conditionText || rule.media.mediaText)) || null;
            walk(rule.cssRules, cond);
            continue;
          }
          walked++;
          if (!rule.selectorText || !rule.style) continue;
          const pos = rule.style.getPropertyValue("position");
          if (!pos) continue;
          let matches = false;
          try {
            matches = el.matches(rule.selectorText);
          } catch {}
          if (matches) hits.push({ selector: rule.selectorText, pos, mq: mq || null });
        }
      };
      walk(rules, null);
      diag.push({ href: sheet.href, topLevel: rules.length, walked });
    }

    return {
      computedPosition: getComputedStyle(el).position,
      matchedPositionRules: hits,
      stylesheets: diag,
    };
  });

  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
}
