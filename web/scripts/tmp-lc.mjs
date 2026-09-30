/** Does /board actually report link_counts.children for a parent? */
import puppeteer from "puppeteer";
const b = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await b.newPage();
await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForSelector(".kb-card", { timeout: 60000 });

const out = await page.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = { "Content-Type": "application/json", Authorization: `Bearer ${t}` };
  const mk = async (title, extra = {}) => {
    const r = await fetch("/api/kanban/tasks?board=default", {
      method: "POST", headers: H, body: JSON.stringify({ title, ...extra }),
    });
    const j = await r.json();
    return j.id ?? j.task?.id;
  };
  const parent = await mk("lc parent");
  const child = await mk("lc child", { parents: [parent] });

  const board = await (await fetch("/api/kanban/board?board=default", { headers: H })).json();
  const cards = (board.columns || []).flatMap((c) => c.tasks || []);
  const pc = cards.find((c) => c.id === parent);
  const cc = cards.find((c) => c.id === child);
  return {
    parentId: parent,
    childId: child,
    totalCards: cards.length,
    parentOnBoard: !!pc,
    parentLinkCounts: pc?.link_counts ?? null,
    childLinkCounts: cc?.link_counts ?? null,
    parentKeys: pc ? Object.keys(pc).filter((k) => /link|child|parent|depend/i.test(k)) : null,
  };
});

console.log(JSON.stringify(out, null, 2));
await b.close();
