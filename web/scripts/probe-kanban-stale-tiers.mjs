/**
 * The red staleness tier, honestly split into its two halves.
 *
 * Amber was observed on real data (cards 18-20 min old, past the 15 min
 * threshold). Red needs 60 minutes, and the one aged card on this board is in
 * `done` -- a terminal column, which is deliberately not tinted, so it cannot
 * stand in. Rather than backdate a row in the live database or wait an hour,
 * this checks the two halves separately and says which is which:
 *
 *   1. the class -> computed style, applied to a real card in a real DOM
 *   2. the idleSeconds/staleness arithmetic, over a table of inputs
 *
 * What this does NOT prove is that a naturally aged card turns red on its
 * own. That remains unobserved, and the distinction matters: the amber tier
 * is verified end to end, the red tier is verified in its parts.
 *
 * Usage: node scripts/probe-kanban-stale-tiers.mjs
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
await page.setViewport({ width: 1400, height: 900 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 2500));

// --- 1. the styles, on a real card ------------------------------------
const styles = await page.evaluate(() => {
  const card = document.querySelector(".kb-card");
  if (!card) return { error: "no card on the board" };

  // A clone, with the class set *before* it is attached. Two earlier versions
  // of this measured the live card instead and both were wrong: one fought
  // the live-update re-render, which puts React's own classes back, and the
  // other read getComputedStyle straight after a class change and got the
  // previous computed value. Setting the class pre-attach and dumping the
  // whole shadow avoids both.
  const probe = card.cloneNode(true);
  probe.classList.remove(
    ...[...probe.classList].filter((c) => c.startsWith("kb-card-stale")),
  );
  // A fresh clone per reading, with the class set *before* it is attached.
  // Toggling the class on an already-attached node makes Chrome hand back the
  // previous computed value even after a forced reflow, which is how two
  // earlier versions of this probe both reported red as amber and sent me
  // looking for a CSS bug that was not there.
  const board = document.querySelector(".kb-board");
  const read = (cls) => {
    const fresh = card.cloneNode(true);
    fresh.classList.remove(
      ...[...fresh.classList].filter((c) => c.startsWith("kb-card-stale")),
    );
    if (cls) fresh.classList.add(cls);
    board.appendChild(fresh);
    const value = getComputedStyle(fresh).boxShadow;
    const token = getComputedStyle(fresh)
      .getPropertyValue("--kb-stale-red")
      .trim();
    fresh.remove();
    return { shadow: value, token };
  };
  const none = read(null);
  const amber = read("kb-card-stale-amber");
  const red = read("kb-card-stale-red");
  const result = {
    none: none.shadow,
    amber: amber.shadow,
    red: red.shadow,
    redToken: red.token,
    distinct: amber.shadow !== red.shadow && red.shadow !== none.shadow,
  };
  probe.remove();
  return result;
});

// --- 2. the arithmetic, over the whole table ---------------------------
// Mirrors idleSeconds()/staleness() exactly. If the component's copy drifts,
// this stops being a check -- which is why the thresholds are restated here
// rather than imported, so the duplication is visible instead of hidden.
const arithmetic = await page.evaluate(() => {
  const AMBER = 15 * 60;
  const RED = 60 * 60;
  const idle = (task, now) => {
    if (now === null) return null;
    switch (task.status) {
      case "running":
      case "review":
        return task.last_heartbeat_at !== null ? now - task.last_heartbeat_at : null;
      case "triage":
      case "todo":
      case "ready":
        return task.created_at ? now - task.created_at : null;
      default:
        return null;
    }
  };
  const tier = (task, now) => {
    const s = idle(task, now);
    if (s === null || s < 0) return null;
    if (s >= RED) return "red";
    if (s >= AMBER) return "amber";
    return null;
  };
  const now = 1_000_000;
  const q = (status, extra) => ({ status, created_at: now, last_heartbeat_at: now, ...extra });
  const cases = [
    ["ready, brand new", q("ready"), null],
    ["ready, 14m", q("ready", { created_at: now - 14 * 60 }), null],
    ["ready, 15m exactly", q("ready", { created_at: now - 15 * 60 }), "amber"],
    ["ready, 59m", q("ready", { created_at: now - 59 * 60 }), "amber"],
    ["ready, 60m exactly", q("ready", { created_at: now - 60 * 60 }), "red"],
    ["ready, 6h", q("ready", { created_at: now - 6 * 3600 }), "red"],
    ["running, fresh heartbeat", q("running", { last_heartbeat_at: now }), null],
    ["running, 20m stale heartbeat", q("running", { last_heartbeat_at: now - 20 * 60 }), "amber"],
    ["running, 90m stale heartbeat", q("running", { last_heartbeat_at: now - 90 * 60 }), "red"],
    ["running, never started", q("running", { last_heartbeat_at: null }), null],
    ["done, 6h old", q("done", { created_at: now - 6 * 3600 }), null],
    ["blocked, 6h old", q("blocked", { created_at: now - 6 * 3600 }), null],
    ["clock skew backwards", q("ready", { created_at: now + 500 }), null],
  ];
  return cases.map(([label, task, want]) => {
    const got = tier(task, now);
    return { label, want, got, pass: got === want };
  });
});

const failing = arithmetic.filter((c) => !c.pass);
console.log(
  JSON.stringify(
    {
      styles: {
        none: styles.none,
        amber: styles.amber,
        red: styles.red,
        redToken: styles.redToken,
        tiersAreDistinct: styles.distinct,
      },
      arithmetic: `${arithmetic.length - failing.length}/${arithmetic.length} pass`,
      failing,
      notObserved: "a naturally aged card reaching red on its own",
    },
    null,
    1,
  ),
);
await browser.close();
