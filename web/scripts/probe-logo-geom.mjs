import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath:
    process.env.CHROME_PATH ||
    "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome",
  headless: true,
});

const page = await browser.newPage();
await page.authenticate({
  username: process.env.PREVIEW_USER || "preview",
  password: process.env.PREVIEW_PASS || "hermes2026",
});
await page.setViewport({ width: 1500, height: 500 });
await page.goto("http://127.0.0.1:8090/", {
  waitUntil: "networkidle2",
  timeout: 60000,
});

const info = await page.evaluate(() =>
  [...document.querySelectorAll(".codick-logo")]
    .filter((i) => getComputedStyle(i).display !== "none")
    .map((i) => {
      const r = i.getBoundingClientRect();
      return {
        src: i.currentSrc.split("/").pop(),
        attrW: i.getAttribute("width"),
        attrH: i.getAttribute("height"),
        natW: i.naturalWidth,
        natH: i.naturalHeight,
        natRatio: +(i.naturalWidth / i.naturalHeight).toFixed(3),
        boxW: Math.round(r.width),
        boxH: Math.round(r.height),
        boxRatio: +(r.width / r.height).toFixed(3),
        cssH: getComputedStyle(i).height,
        cssW: getComputedStyle(i).width,
      };
    }),
);
console.log(JSON.stringify(info, null, 1));
await browser.close();
