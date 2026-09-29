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
await page.setViewport({ width: 1400, height: 900 });
await page.goto("http://127.0.0.1:8090/chat", {
  waitUntil: "networkidle2",
  timeout: 60000,
});
await new Promise((r) => setTimeout(r, 2500));

const count = await page.evaluate(
  () => document.querySelectorAll("[data-bs-toggle]").length,
);
console.log("toggles on /chat:", count);

const toggles = await page.$$("[data-bs-toggle]");
for (let i = 0; i < toggles.length; i++) {
  const info = await toggles[i].evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      type: el.getAttribute("data-bs-toggle"),
      text: el.textContent.trim().slice(0, 28),
      y: Math.round(r.top),
    };
  });
  await toggles[i].click();
  await new Promise((r) => setTimeout(r, 400));
  const opened = await page.evaluate(() => {
    // Any menu that became visible since the click.
    const menus = [...document.querySelectorAll(".dropdown-menu")];
    return menus.filter((m) => m.getBoundingClientRect().height > 0).map(
      (m) => m.querySelectorAll(".dropdown-item").length + " items",
    );
  });
  console.log(
    `${info.type.padEnd(9)} "${info.text}" ->`,
    opened.length ? opened.join(",") : "NOTHING OPENED",
  );
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 250));
}

await page.screenshot({ path: process.argv[2] || "/tmp/dropdowns.png" });
await browser.close();
