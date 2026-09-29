import puppeteer from "puppeteer";

const url = process.argv[2] ?? "http://127.0.0.1:8090/sessions?profile=default";
const browser = await puppeteer.launch({
  executablePath:
    "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 1200));

const out = await page.evaluate(() => {
  const bar = document.querySelector(".app-rail ~ * .bg-body-tertiary")
    ?? [...document.querySelectorAll("div")].find((d) =>
      d.className?.toString?.().includes("ls-wide"));
  if (!bar) return { error: "no topbar" };
  const chain = [];
  let n = bar;
  while (n && n !== document.body) {
    const r = n.getBoundingClientRect();
    const s = getComputedStyle(n);
    chain.push({
      tag: n.tag,
      cls: n.className?.toString?.().slice(0, 70),
      left: Math.round(r.left),
      width: Math.round(r.width),
      display: s.display,
      minWidth: s.minWidth,
    });
    n = n.parentElement;
  }
  return { chain };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
