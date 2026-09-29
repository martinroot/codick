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

// What the page actually has for behaviour.
const env = await page.evaluate(() => ({
  bootstrapGlobal: typeof window.bootstrap,
  toggles: document.querySelectorAll("[data-bs-toggle]").length,
  modalToggles: document.querySelectorAll('[data-bs-toggle="modal"]').length,
  dropdownToggles: document.querySelectorAll('[data-bs-toggle="dropdown"]').length,
}));
console.log("bootstrap global:", env.bootstrapGlobal);
console.log("data-bs-toggle elements:", env.toggles,
            `(dropdown ${env.dropdownToggles}, modal ${env.modalToggles})`);

// Click the status dropdown and see whether anything opens.
const btn = await page.$('[data-bs-toggle="dropdown"]');
if (!btn) {
  console.log("no dropdown toggle found");
} else {
  await btn.click();
  await new Promise((r) => setTimeout(r, 500));
  const after = await page.evaluate(() => {
    const menu = document.querySelector(".dropdown-menu");
    if (!menu) return { found: false };
    const cs = getComputedStyle(menu);
    return {
      found: true,
      display: cs.display,
      visible: cs.display !== "none" && menu.getBoundingClientRect().height > 0,
      items: menu.querySelectorAll(".dropdown-item").length,
      text: menu.textContent.trim().slice(0, 60),
    };
  });
  console.log("after click:", JSON.stringify(after));
}

await browser.close();
