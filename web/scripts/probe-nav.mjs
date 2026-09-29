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
  const nav = document.querySelector(".app-rail nav");
  if (!nav) return { error: "no nav" };
  const cs = getComputedStyle(nav);
  return {
    navClass: nav.className,
    display: cs.display,
    flexDirection: cs.flexDirection,
    flexWrap: cs.flexWrap,
    width: cs.width,
    children: [...nav.children].slice(0, 6).map((c) => {
      const s = getComputedStyle(c);
      return {
        tag: c.tag,
        cls: c.className?.toString().slice(0, 60),
        display: s.display,
        width: s.width,
        left: Math.round(c.getBoundingClientRect().left),
      };
    }),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
