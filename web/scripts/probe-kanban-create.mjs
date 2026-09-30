/**
 * The create form, against the live server.
 *
 * The failure this exists to prevent is silent: `CreateTaskBody` is a pydantic
 * model with no `extra="forbid"`, so a field the client sends and the server
 * does not know is discarded with a 200 and no warning. Every field filled in
 * here is therefore read back **off the server**, not off the form. A form that
 * looks correctly filled in and drops half of it on the floor is the whole bug.
 *
 * Usage: node scripts/probe-kanban-create.mjs
 */

import puppeteer from "puppeteer";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";

const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath: CHROME,
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 140)}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 140)}`);
});
await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 45000,
});

const settle = (ms = 1600) => new Promise((r) => setTimeout(r, ms));
const result = {};

const setValue = (selector, value) =>
  page.evaluate(
    ([sel, val]) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const proto =
        el.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : el.tagName === "SELECT"
            ? window.HTMLSelectElement.prototype
            : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    [selector, value],
  );

const openForm = async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "New task")
      ?.click();
  });
  await settle(900);
};

const drop = (ids) =>
  page.evaluate(async (list) => {
    const t = window.__HERMES_SESSION_TOKEN__;
    for (const id of list.filter(Boolean)) {
      await fetch(`/api/kanban/tasks/${id}?board=default`, {
        method: "DELETE",
        headers: t ? { Authorization: `Bearer ${t}` } : {},
      });
    }
  }, ids);

// --- The form opens, and an empty title disables Create ----------------
await openForm();
result.form = await page.evaluate(() => {
  const d = document.querySelector(".kb-create");
  if (!d) return { open: false };
  const create = [...d.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Create task"),
  );
  return {
    open: true,
    title: d.querySelector("h2")?.textContent,
    createDisabledWhenEmpty: create?.disabled,
    fields: [...d.querySelectorAll("input, textarea, select")]
      .map((f) => f.id)
      .filter(Boolean),
  };
});

// --- A parent picker that changes where the card lands ------------------
// `kanban_db.create_task` files a card `todo` while a parent is unfinished, so
// the form has to say so before submit, not after.
const parent = await page.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = {
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
    "Content-Type": "application/json",
  };
  const c = await (
    await fetch("/api/kanban/tasks?board=default", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ title: "create probe: the parent" }),
    })
  ).json();
  return c?.task?.id;
});
result.parent = parent;
await page.reload({ waitUntil: "networkidle2" });
await settle(2000);
await openForm();
await setValue("#kb-create-parents", parent);
await settle(600);
result.parentHint = await page.evaluate(
  () =>
    document
      .querySelector("#kb-create-parents")
      ?.parentElement?.querySelector(".form-text")
      ?.textContent?.trim(),
);

// --- Fill every field, submit, and read it back off the server ---------
await setValue("#kb-create-title", "create probe: full field set");
await setValue("#kb-create-body", "Body written by the create form probe.");
await setValue("#kb-create-assignee", "probe-owner");
await setValue("#kb-create-priority", "2");
await setValue("#kb-create-skills", "python, review ,  api ");
await setValue("#kb-create-workspace", "dir");
await setValue("#kb-create-path", "/tmp/codick-probe");
await page.evaluate(() => {
  const c = document.querySelector("#kb-create-goal");
  if (c && !c.checked) c.click();
});
await settle(500);
await setValue("#kb-create-turns", "7");
// The advanced block is collapsed until asked for.
await page.evaluate(() => {
  [...document.querySelectorAll(".kb-create button")]
    .find((b) => b.textContent?.includes("model overrides"))
    ?.click();
});
await settle(500);
result.advanced = await page.evaluate(() => ({
  visible: Boolean(document.querySelector("#kb-create-model")?.offsetParent),
  turns: document.querySelector("#kb-create-turns")?.value,
}));
await setValue("#kb-create-model", "probe-model");
await setValue("#kb-create-provider", "probe-provider");
await setValue("#kb-create-effort", "high");
await setValue("#kb-create-runtime", "900");

const sent = [];
page.on("request", (r) => {
  if (r.method() === "POST" && r.url().includes("/api/kanban/tasks?")) sent.push(r.postData());
});
await page.evaluate(() => {
  [...document.querySelectorAll(".kb-create button")]
    .find((b) => b.textContent?.includes("Create task"))
    ?.click();
});
await settle(3500);
result.sent = sent[0] ? JSON.parse(sent[0]) : null;
result.dialogClosed = await page.evaluate(() => !document.querySelector(".kb-create"));

const created = await page.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = t ? { Authorization: `Bearer ${t}` } : {};
  const bd = await (await fetch("/api/kanban/board?board=default", { headers: H })).json();
  const card = bd.columns
    .flatMap((c) => c.tasks)
    .find((c) => c.title === "create probe: full field set");
  if (!card) return null;
  const d = await (await fetch(`/api/kanban/tasks/${card.id}?board=default`, { headers: H })).json();
  const task = d?.task ?? {};
  return {
    id: card.id,
    status: card.status,
    // `link_tasks` is a *sibling* of `task`, not a key inside it. Reading it
    // as `task.link_tasks` yields undefined and looks like a dropped
    // dependency when nothing was dropped.
    link_tasks: d?.link_tasks,
    assignee: task.assignee,
    body: task.body,
    priority: task.priority,
    skills: task.skills,
    workspace_kind: task.workspace_kind,
    workspace_path: task.workspace_path,
    goal_mode: task.goal_mode,
    goal_max_turns: task.goal_max_turns,
    model_override: task.model_override,
    provider_override: task.provider_override,
    reasoning_effort: task.reasoning_effort,
    max_runtime_seconds: task.max_runtime_seconds,
  };
});
result.readBack = created;

await drop([created?.id, parent]);
result.errors = errors.slice(0, 4);
console.log(JSON.stringify(result, null, 1));
await browser.close();
