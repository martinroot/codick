import puppeteer from "puppeteer";

const url = "http://127.0.0.1:8090/";
const out = process.argv[2] || "/tmp/dark.png";

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath:
    process.env.CHROME_PATH ||
    "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome",
  headless: true,
});

const page = await browser.newPage();
// The preview is behind a basic-auth proxy; credentials go up front
// rather than through the 401 challenge.
await page.authenticate({
  username: process.env.PREVIEW_USER || "preview",
  password: process.env.PREVIEW_PASS || "hermes2026",
});
await page.setViewport({ width: 1500, height: 420 });
await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
await page.evaluate(() =>
  document.documentElement.setAttribute("data-bs-theme", "dark"),
);
await new Promise((r) => setTimeout(r, 600));

// Which of the two images is actually painted, and is it visible?
const state = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll(".codick-logo")];
  return imgs.map((i) => {
    const r = i.getBoundingClientRect();
    return {
      src: i.currentSrc.split("/").pop(),
      shown: getComputedStyle(i).display !== "none",
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
});
console.log(JSON.stringify(state, null, 1));

await page.screenshot({ path: out });
await browser.close();
console.log("saved", out);
