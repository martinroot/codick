/** The #52 delete confirm, with the consequences named. */
import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await b.newPage();
await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 1 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector(".kb-card", { timeout: 60000 });

const make = (title, extra = {}) =>
  page.evaluate(async (name, x) => {
    const t = window.__HERMES_SESSION_TOKEN__;
    const r = await fetch("/api/kanban/tasks?board=default", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
      body: JSON.stringify({ title: name, ...x }),
    });
    const j = await r.json();
    return j.id ?? j.task?.id;
  }, title, extra);

const parent = await make("Release my training data");
const child = await make("Ship the training data", { parents: [parent] });
await new Promise((r) => setTimeout(r, 3000));

const out = await page.evaluate(async (pid) => {
  const find = () => [...document.querySelectorAll(".kb-card")].find((c) => c.querySelector(`[title="${pid}"]`));
  for (let i = 0; i < 40 && !find(); i++) await new Promise((r) => setTimeout(r, 300));
  const card = find();
  if (!card) return { ok: false };
  card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1800));
  const btn = [...document.querySelectorAll("button")].find((x) =>
    /^delete this task$/i.test(x.textContent.trim()),
  );
  if (!btn) return { ok: false, drawer: true };
  btn.click();
  await new Promise((r) => setTimeout(r, 1000));
  return { ok: !!document.querySelector(".sku-backdrop") };
}, parent);
console.log("confirm open:", JSON.stringify(out));

const dlg = await page.$(".sku-backdrop");
if (dlg) await dlg.screenshot({ path: "/home/grokwin/.hermes/cache/scratch/del52.png" });
else await page.screenshot({ path: "/home/grokwin/.hermes/cache/scratch/del52.png" });
console.log("shot written");

// Leave the board clean.
await page.evaluate(async (ids) => {
  const t = window.__HERMES_SESSION_TOKEN__;
  for (const id of ids) {
    await fetch(`/api/kanban/tasks/${id}?board=default`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${t}` },
    });
  }
}, [parent, child]);
console.log("cleaned up");
await b.close();
