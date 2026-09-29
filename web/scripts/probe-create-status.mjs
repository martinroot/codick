/**
 * Which statuses does `POST /tasks` actually honour?
 *
 * A composer in every column is only honest if the server files the task
 * where it was asked to. This creates a task in each status in turn and
 * reports what came back, because a board that silently files everything in
 * `ready` looks exactly like a working board until you read the column.
 *
 * Cleans up after itself.
 */

import puppeteer from "puppeteer";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";
const STATUSES = ["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done"];

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath: CHROME,
});
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 1500));

const out = await page.evaluate(async (statuses) => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const H = token ? { Authorization: `Bearer ${token}` } : {};
  const q = "?board=default";
  const rows = [];
  const created = [];

  for (const wanted of statuses) {
    const res = await fetch("/api/plugins/kanban/tasks" + q, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ title: `status probe: asked for ${wanted}`, status: wanted }),
    });
    const body = await res.json().catch(() => null);
    const id = body?.task?.id ?? null;
    if (id) created.push(id);
    rows.push({
      asked: wanted,
      http: res.status,
      got: body?.task?.status ?? null,
      detail: res.ok ? null : (body?.detail ?? null),
    });
  }

  for (const id of created) {
    await fetch(`/api/plugins/kanban/tasks/${id}` + q, { method: "DELETE", headers: H });
  }
  return rows;
}, STATUSES);

console.log(
  ["asked      http  got", ...out.map((r) => `${r.asked.padEnd(10)} ${r.http}   ${r.got}${r.detail ? "  detail=" + r.detail : ""}`)].join("\n"),
);
await browser.close();
