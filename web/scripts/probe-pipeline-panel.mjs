// Visual + computed-style verification of the pipeline panel on /kanban.
// The build being green says nothing about whether the panel is on the page,
// whether Bootstrap's classes actually resolved to values, or whether anything
// overflows. This asks the browser.
import puppeteer from "puppeteer";

const b = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath:
    "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome",
});
const p = await b.newPage();
await p.setViewport({ width: 1500, height: 1000 });

const consoleErrors = [];
p.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
const apiCalls = [];
p.on("response", (r) => {
  const u = new URL(r.url());
  if (u.pathname.startsWith("/api/pipelines")) apiCalls.push(`${r.status()} ${u.pathname}`);
});

await p.authenticate({ username: "preview", password: "hermes2026" });
await p.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

const report = await p.evaluate(() => {
  // The panel is the card holding the template select.
  const select = document.querySelector("#pipeline-template");
  const panel = select?.closest(".card");
  if (!panel) return { found: false };

  const cs = getComputedStyle(panel);
  const sel = getComputedStyle(select);

  // Tailwind leftovers would show up as utility classes on the panel's subtree.
  const tailwindish = [...panel.querySelectorAll("*")]
    .flatMap((el) => [...el.classList])
    .filter((c) => /^(flex|grid|p-|m[trblxy]?-|text-(xs|sm|base|lg|xl)|bg-(gray|white|black|zinc|neutral)-|rounded-(sm|md|lg|xl)|w-full|h-full)$/.test(c));

  // Overflow only matters when it reaches the document. The board's column
  // strip scrolls horizontally on purpose, so an element wider than the viewport
  // inside a scroll container is the design working, not a defect — flagging it
  // would train us to ignore this check.
  const inScroller = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if (o === "auto" || o === "scroll") return true;
    }
    return false;
  };
  const overflowing = [...document.querySelectorAll("body *")]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > window.innerWidth + 2 && !inScroller(el);
    })
    .slice(0, 8)
    .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`);

  return {
    found: true,
    panelDisplay: cs.display,
    panelRadius: cs.borderRadius,
    // A Tailwind build would leave these as 0px; Bootstrap's .card does not.
    selectBorder: sel.borderWidth,
    selectRadius: sel.borderRadius,
    buttonCount: panel.querySelectorAll("button").length,
    runButton: [...panel.querySelectorAll("button")].find((x) => x.textContent.trim() === "Run")
      ? { disabled: [...panel.querySelectorAll("button")].find((x) => x.textContent.trim() === "Run").disabled }
      : null,
    jsonButton: [...panel.querySelectorAll("button")].some((x) => x.textContent.includes("Load JSON")),
    tabsVisible: panel.textContent.includes("Run") || panel.textContent.includes("Template"),
    hint: (panel.textContent.match(/No card selected[^\n]*/) || [""])[0],
    tailwindish: [...new Set(tailwindish)],
    overflowing,
    bodyScrollW: document.body.scrollWidth,
    innerW: window.innerWidth,
    // The real question: does the document itself scroll sideways?
    documentOverflows: document.body.scrollWidth > window.innerWidth + 2,
  };
});

await p.screenshot({ path: process.argv[2], fullPage: false });
console.log(JSON.stringify({ report, apiCalls, consoleErrors: consoleErrors.slice(0, 6) }, null, 2));
await b.close();
