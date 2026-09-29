/**
 * Does the composer create in the column it was opened from?
 *
 * `POST /tasks` cannot be asked for a status, so this creates through the UI
 * in every creatable column and reports which column each card actually
 * landed in. The card title encodes the target, so a card that shows up in
 * the wrong column is caught by name rather than by eye.
 *
 * Usage: node scripts/probe-create-columns.mjs [boardSlug]
 */

import puppeteer from "puppeteer";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";
const board = process.argv[2] || "default";
// `running` is excluded: it is not a creatable column by design.
const TARGETS = ["triage", "todo", "scheduled", "ready", "blocked", "review", "done"];

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath: CHROME,
});
const page = await browser.newPage();
const errors = [];
// Watch the actual requests. The DOM checks said the button was enabled and
// the click landed, yet most creates never reached the server; without the
// wire we are guessing between "no request" and "request refused".
const net = [];
page.on("response", async (res) => {
  const url = res.url();
  if (!url.includes("/api/plugins/kanban")) return;
  let body = "";
  try {
    body = (await res.text()).slice(0, 160);
  } catch {}
  net.push(`${res.request().method()} ${url.split("/kanban")[1]} -> ${res.status()} ${body}`);
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 120)));
await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto(`http://127.0.0.1:8090/kanban?board=${encodeURIComponent(board)}`, {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

const created = [];

for (const target of TARGETS) {
  const title = `column probe: asked for ${target}`;
  const ok = await page.evaluate(
    async (colStatus, text) => {
      const section = document.querySelector(`.kb-column[data-status="${colStatus}"]`);
      const btn = section?.querySelector(".kb-add-card");
      if (!btn) return { ok: false, why: "no add button" };
      btn.click();
      await new Promise((r) => setTimeout(r, 250));
      const input = section.querySelector(".kb-composer-input");
      if (!input) return { ok: false, why: "composer did not open" };
      // React listens to its own synthetic events; a raw value set is not
      // enough, so type through the real input.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      ).set;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 150));
      // Check the button is actually enabled: React only enables it once
      // `draft` is non-empty, and a click on a disabled button is a no-op
      // that looks exactly like a successful submit.
      const submit = section.querySelector(".kb-composer button[type=submit]");
      const state = {
        submitFound: Boolean(submit),
        disabled: submit ? submit.disabled : null,
        inputValue: input.value,
      };
      submit?.click();
      // Wait for the card to actually reach the target column rather than
      // sleeping a fixed interval: creating is a POST, then a PATCH, then a
      // board re-read, and a fixed wait produced a MISMATCH for `todo` that
      // did not exist -- the same code path passes when run on its own.
      const token = window.__HERMES_SESSION_TOKEN__;
      const deadline = Date.now() + 8000;
      let landedIn = null;
      while (Date.now() < deadline) {
        const res = await fetch("/api/plugins/kanban/board?board=default", {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const payload = await res.json();
        const hit = (payload.columns ?? [])
          .flatMap((col) => col.tasks.map((t) => [col.name, t]))
          .find(([, t]) => t.title === text);
        if (hit) {
          landedIn = hit[0];
          if (landedIn === colStatus) break;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return { ok: true, landedIn, ...state };
    },
    target,
    title,
  );

  if (!ok.ok || ok.submitFound === false || ok.disabled) {
    console.log(
      `${target.padEnd(10)} SUBMIT NOT SENT: ${ok.why ?? ""} ` +
        `submitFound=${ok.submitFound} disabled=${ok.disabled} value=${JSON.stringify(ok.inputValue)}`,
    );
    continue;
  }
  created.push({ target, title });
}

// Where did each one actually land?
const placement = await page.evaluate(
  async (slug, items) => {
    const token = window.__HERMES_SESSION_TOKEN__;
    const res = await fetch(`/api/plugins/kanban/board?board=${encodeURIComponent(slug)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const payload = await res.json();
    const out = [];
    const ids = [];
    for (const col of payload.columns ?? []) {
      for (const t of col.tasks ?? []) {
        const hit = items.find((i) => i.title === t.title);
        if (hit) {
          out.push({ asked: hit.target, landedIn: col.name, ok: col.name === hit.target });
          ids.push(t.id);
        }
      }
    }
    // Clean up.
    for (const id of ids) {
      await fetch(`/api/plugins/kanban/tasks/${id}?board=${encodeURIComponent(slug)}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    }
    return out;
  },
  board,
  created,
);

console.log("");
for (const row of placement.sort((a, b) => a.asked.localeCompare(b.asked))) {
  console.log(
    `${row.asked.padEnd(10)} -> ${row.landedIn.padEnd(10)} ${row.ok ? "OK" : "MISMATCH"}`,
  );
}
const bad = placement.filter((r) => !r.ok);
console.log(`\n${placement.length} created, ${bad.length} in the wrong column`);
console.log("\n--- wire ---");
for (const line of net) console.log("  " + line);
if (errors.length) console.log("errors:", errors.slice(0, 3));
await browser.close();
