/**
 * Does the board update itself when something changes on the server?
 *
 * Two claims, and the second is the one that matters: the DOM must change
 * without a reload, and the change must be *server-driven* -- a test that
 * triggers the change through the page's own code would pass even with the
 * socket dead, because the page already knows it mutated something.
 *
 * So the change is made over the plain REST API from a separate fetch, the
 * way another agent, a dispatcher, or a second browser tab would. The DOM is
 * read twice: once after the mutation with no reload, and once more after a
 * pause, so a slow poll is not mistaken for a working socket.
 *
 * Usage: node scripts/probe-kanban-live-updates.mjs
 */

import puppeteer from "puppeteer";

const CHROME =
  process.env.CHROME_PATH ||
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";
const BOARD = "default";

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

const sockets = [];
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/kanban/board")) sockets.push(`${r.status()} ${u.split("8090")[1]}`);
});
page.on("websocketcreated", (ws) => sockets.push(`WS OPEN ${ws.url().split("8090")[1]}`));
page.on("websocketclosed", (ws) => sockets.push(`WS CLOSE ${ws.url().split("8090")[1]}`));

await page.setViewport({ width: 1500, height: 950 });
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto(`http://127.0.0.1:8090/kanban?board=${BOARD}`, {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 3000));

const title = `live probe ${Date.now()}`;
const inDom = () =>
  page.evaluate(
    (needle) => {
      const card = [...document.querySelectorAll(".kb-card")].find((c) =>
        c.textContent?.includes(needle),
      );
      return {
        present: Boolean(card),
        column: card?.closest(".kb-column")?.dataset.status ?? null,
      };
    },
    title,
  );

const before = await inDom();

// A second client mutates the board. Deliberately not the page's own code path.
const created = await page.evaluate(
  async (slug, t) => {
    const token = window.__HERMES_SESSION_TOKEN__;
    const res = await fetch(`/api/kanban/tasks?board=${slug}`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: t }),
    });
    return (await res.json())?.task?.id ?? null;
  },
  BOARD,
  title,
);

await new Promise((r) => setTimeout(r, 400));
const soon = await inDom();
await new Promise((r) => setTimeout(r, 4000));
const settled = await inDom();

// Now move it from the other client and see the column follow.
const moved = await page.evaluate(
  async (slug, id) => {
    if (!id) return null;
    const token = window.__HERMES_SESSION_TOKEN__;
    const res = await fetch(`/api/kanban/tasks/${id}?board=${slug}`, {
      method: "PATCH",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "review" }),
    });
    return res.status;
  },
  BOARD,
  created,
);
await new Promise((r) => setTimeout(r, 3000));
const afterMove = await inDom();

// Clean up.
await page.evaluate(
  async (slug, id) => {
    if (!id) return;
    const token = window.__HERMES_SESSION_TOKEN__;
    await fetch(`/api/kanban/tasks/${id}?board=${slug}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  },
  BOARD,
  created,
);

console.log(
  JSON.stringify(
    {
      createdId: created,
      moveStatus: moved,
      beforeCreate: before,
      shortlyAfterCreate: soon,
      settledAfterCreate: settled,
      afterExternalMove: afterMove,
      sockets: sockets.slice(0, 14),
      errors: errors.slice(0, 4),
    },
    null,
    1,
  ),
);
await browser.close();
