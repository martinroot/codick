import puppeteer from "puppeteer";

const CHROME =
  "/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome";
const b = await puppeteer.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  executablePath: CHROME,
});
const p = await b.newPage();

// Installed before any page script runs, so the very first socket is caught.
// Puppeteer's own websocketcreated event is not reliably emitted, and a
// wrapper installed after load would miss a socket that is already open --
// which is exactly the check this is trying to make.
await p.evaluateOnNewDocument(() => {
  window.__sockets = [];
  const Orig = window.WebSocket;
  const Wrapped = function (url, proto) {
    const entry = { url: String(url), opened: false, frames: [], closed: null };
    window.__sockets.push(entry);
    const ws = new Orig(url, proto);
    ws.addEventListener("open", () => {
      entry.opened = true;
    });
    ws.addEventListener("message", (e) => {
      if (entry.frames.length < 3) entry.frames.push(String(e.data).slice(0, 200));
    });
    ws.addEventListener("close", (e) => {
      entry.closed = e.code;
    });
    return ws;
  };
  Wrapped.prototype = Orig.prototype;
  Object.assign(Wrapped, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  window.WebSocket = Wrapped;
});

await p.setViewport({ width: 1400, height: 900 });
await p.authenticate({ username: "preview", password: "hermes2026" });
await p.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 45000,
});
await new Promise((r) => setTimeout(r, 3000));

const out = await p.evaluate(async () => {
  const atLoad = JSON.parse(JSON.stringify(window.__sockets));
  const token = window.__HERMES_SESSION_TOKEN__;
  const res = await fetch("/api/kanban/tasks?board=default", {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: "ws frame probe " + Date.now() }),
  });
  const created = (await res.json())?.task?.id ?? null;
  await new Promise((r) => setTimeout(r, 6000));
  if (created) {
    await fetch(`/api/kanban/tasks/${created}?board=default`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }
  return {
    atLoad,
    now: JSON.parse(JSON.stringify(window.__sockets)),
    cardVisible: [...document.querySelectorAll(".kb-card")].some((c) =>
      c.textContent?.includes("ws frame probe"),
    ),
  };
});
console.log(JSON.stringify(out, null, 1));
await b.close();
