/**
 * The one gap #49 was left open for: the running-child link refusal, seen
 * through the UI.
 *
 * "a link that the dispatcher acts on immediately" — a *running* child is
 * refused by `kanban_db.link_tasks` (a dependency that did not constrain the
 * active run is worse than no dependency). The drawer-write probe could not
 * seed a genuinely running task without dispatching a real worker, so this
 * one runs in two phases:
 *
 *   seed:   create parent (blocked) + child (blocked) via the UI's own
 *           fetchJSON path, write their ids to a scratch file, exit.
 *   verify: (after the parent flips the child's row to `running` directly in
 *           the DB — the API refuses status=running by design, #45's guard)
 *           open the parent's drawer, type the child id into the dependency
 *           editor with side=Blocks, press Add, and require the server's own
 *           sentence "child is already running" rendered in the editor.
 *           Then clean up: unlink nothing (the edge must not exist), delete
 *           both seeded tasks, and verify the board holds no fixtures.
 *
 * Usage: node scripts/probe-kanban-drawer-running-link.mjs seed|verify
 */

import puppeteer from "puppeteer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";
const IDS_FILE = path.join(os.tmpdir(), "probe-running-link-ids.json");

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
const wire = [];
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/kanban/")) {
    const p = u.split("8090")[1]?.split("?")[0] ?? u;
    wire.push(`${r.request().method()} ${p} -> ${r.status()}`);
  }
});

await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

const short = (id) => (id ?? "").replace(/^t_/, "");

if (process.argv[2] === "seed") {
  const seed = await page.evaluate(async () => {
    const token = window.__HERMES_SESSION_TOKEN__;
    const H = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    };
    const mk = async (title) => {
      const res = await (
        await fetch("/api/kanban/tasks?board=default", {
          method: "POST",
          headers: H,
          body: JSON.stringify({ title, initialStatus: "blocked" }),
        })
      ).json();
      return res?.task?.id ?? null;
    };
    return {
      parent: await mk("running-link parent"),
      child: await mk("running-link child"),
    };
  });
  fs.writeFileSync(IDS_FILE, JSON.stringify(seed));
  console.log("SEEDED", JSON.stringify(seed));
  if (!seed.parent || !seed.child) {
    console.error("FAIL: seeding did not return both ids");
    process.exitCode = 1;
  }
  await browser.close();
} else {
  const seed = JSON.parse(fs.readFileSync(IDS_FILE, "utf8"));
  const { parent, child } = seed;

  // ── The UI attempt ──────────────────────────────────────────────────────
  // Open the parent card's drawer, Detail tab, dependency editor.
  await page.evaluate((title) => {
    const card = [...document.querySelectorAll(".kb-card")].find((c) =>
      c.textContent?.includes(title),
    );
    card?.click();
  }, "running-link parent");
  await new Promise((r) => setTimeout(r, 2000));

  // The editor lives on the Detail tab (already active); wait for it.
  const editorReady = await page.evaluate(() => !!document.querySelector(".kb-deps-add"));
  if (!editorReady) {
    console.error("FAIL: dependency editor not reachable on the Detail tab");
    await browser.close();
    process.exit(1);
  }

  // Side = Blocks (this task blocks the typed id; the typed one is the child).
  await page.select(".kb-deps-add select", "children");
  await new Promise((r) => setTimeout(r, 300));
  // Type the short form, as the drawer's own convention puts it.
  await page.type(".kb-deps-add input", short(child));
  await new Promise((r) => setTimeout(r, 300));

  // Instrument: the child's status as the SERVER sees it, immediately before
  // and immediately after the Add click. A 200 on a running child is the
  // suspected leak; a non-running status means something flipped it in between.
  const statusAroundClick = await page.evaluate(async ({ child }) => {
    const token = window.__HERMES_SESSION_TOKEN__;
    const H = token ? { Authorization: `Bearer ${token}` } : {};
    const st = await (await fetch(`/api/kanban/tasks/${child}?board=default`, { headers: H })).json();
    return st?.task?.status ?? null;
  }, { child });

  wire.length = 0;
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".kb-deps-add button")].find((b) =>
      b.textContent?.includes("Add"),
    );
    btn?.click();
  });
  await new Promise((r) => setTimeout(r, 2000));
  const statusAfterClick = await page.evaluate(async ({ child }) => {
    const token = window.__HERMES_SESSION_TOKEN__;
    const H = token ? { Authorization: `Bearer ${token}` } : {};
    const st = await (await fetch(`/api/kanban/tasks/${child}?board=default`, { headers: H })).json();
    return st?.task?.status ?? null;
  }, { child });
  console.log("STATUS_AROUND", JSON.stringify({ before: statusAroundClick, after: statusAfterClick }));

  const result = await page.evaluate(({ childShort }) => {
    const editor = document.querySelector(".kb-deps");
    const alert = editor?.querySelector(".kb-drawer-error[role='alert']");
    // The edge must NOT exist: no "Blocks" caption with the child's row.
    const text = editor?.textContent ?? "";
    return {
      refusalShown: alert?.textContent ?? null,
      saysRunning: text.includes("child is already running"),
      // The "Blocks" rows list is `.kb-deps-rows`; the select's option text
      // also contains "Blocks", so match the rendered rows only.
      blocksRowPresent: !!(editor?.querySelector(".kb-deps-rows")?.textContent ?? "").includes(childShort),
      inputKept: document.querySelector(".kb-deps-add input")?.value ?? null,
    };
  }, { childShort: short(child) });

  console.log("UI_RESULT", JSON.stringify({ ...result, wire: [...wire] }));
  await page.screenshot({
    path: "/home/grokwin/.hermes/cache/scratch/drawer-write-shots/running-link-refusal.png",
  });

  // ── Server reconciliation: the edge must not exist on the wire of truth ─
  const serverSide = await page.evaluate(async (parent) => {
    const token = window.__HERMES_SESSION_TOKEN__;
    const res = await (
      await fetch(`/api/kanban/tasks/${parent}?board=default`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
    ).json();
    return { links: res?.links ?? null };
  }, parent);
  console.log("SERVER_LINKS", JSON.stringify(serverSide));

  // ── Cleanup: delete both seeded tasks, verify the board is clean ───────
  const cleanup = await page.evaluate(async ({ parent, child }) => {
    const token = window.__HERMES_SESSION_TOKEN__;
    const H = token ? { Authorization: `Bearer ${token}` } : {};
    const del = async (id) => {
      const r = await fetch(`/api/kanban/tasks/${id}?board=default`, {
        method: "DELETE",
        headers: H,
      });
      return r.status;
    };
    return { parentStatus: await del(parent), childStatus: await del(child) };
  }, seed);
  await new Promise((r) => setTimeout(r, 1500));
  // Reload and confirm no fixture card remains.
  await page.reload({ waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 2000));
  const boardClean = await page.evaluate(
    () =>
      ![...document.querySelectorAll(".kb-card")].some((c) =>
        c.textContent?.includes("running-link "),
      ),
  );
  console.log("CLEANUP", JSON.stringify({ ...cleanup, boardClean, errors: errors.slice(0, 5) }));

  // The 400 on the link is the expected refusal; the browser logs it as a
  // console resource error. Anything else is a real page problem.
  const unexpected = errors.filter((e) => !e.includes("status of 400"));
  const ok =
    result.saysRunning &&
    result.refusalShown &&
    !result.blocksRowPresent &&
    serverSide.links?.children?.length === 0 &&
    boardClean &&
    unexpected.length === 0;
  console.log(ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
  await browser.close();
}
