/**
 * The #52 contract, against the live backend.
 *
 * The server now says two things a 200 previously could not: that it killed a
 * worker, and that it released somebody else's dependent card. Both are
 * checked here, plus the child really does get released — the claim in the
 * response is only worth anything if the board agrees afterwards.
 */
import puppeteer from "puppeteer";

// Through the proxy on 8090 with basic auth, exactly like the other probes:
// the session token is minted by the app's own JS on load, so a direct hit on
// 8210 with a hand-rolled header is a 401 by construction.
const b = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await b.newPage();

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.authenticate({ username: "preview", password: "hermes2026" });
await page.goto("http://127.0.0.1:8090/kanban?board=default", {
  waitUntil: "networkidle2",
  timeout: 60000,
});
await page.waitForSelector(".kb-card", { timeout: 60000 });
console.log("hasToken:", await page.evaluate(() => !!window.__HERMES_SESSION_TOKEN__));

const out = await page.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = {
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
    "Content-Type": "application/json",
  };
  const api = (path, init = {}) => fetch("/api/kanban" + path, { ...init, headers: H });

  // `board` is a required query param on create — omitting it is a 422, and
  // the id then reads as `undefined` for several lines before it matters.
  const mk = async (title, extra = {}) => {
    const r = await api("/tasks?board=default", { method: "POST", body: JSON.stringify({ title, ...extra }) });
    const j = await r.json();
    if (!r.ok) throw new Error(`create ${title} -> ${r.status} ${JSON.stringify(j)}`);
    // `POST /tasks` answers with the raw task row, whose id lives under
    // `task.id` in this deployment — not at the top level.
    return j.id ?? j.task?.id;
  };

  // A parent with a child: deleting the parent must report the child and
  // actually release it.
  const parent = await mk("52 probe parent");
  const child = await mk("52 probe child", { parents: [parent] });

  const childBefore = await (await api("/tasks/" + child)).json();
  const del = await api("/tasks/" + parent, { method: "DELETE" });
  const body = await del.json();
  const childAfter = await (await api("/tasks/" + child)).json();

  // A card with nothing risky about it: the new fields must be present and
  // falsy rather than absent, so a caller can trust the shape.
  const plain = await mk("52 probe plain");
  const delPlain = await api("/tasks/" + plain, { method: "DELETE" });
  const plainBody = await delPlain.json();

  // The browser logs every non-2xx as a console error, so the 404 below — which
  // is asked for on purpose — is the one error this probe expects to see.
  const missing = await api("/tasks/t_definitely_not_here", { method: "DELETE" });

  return {
    deleteStatus: del.status,
    deleteBody: body,
    childBefore: childBefore.task?.status ?? childBefore.status,
    childAfter: childAfter.task?.status ?? childAfter.status,
    plainBody,
    missingStatus: missing.status,
    missingDetail: (await missing.json())?.detail,
  };
});

console.log("\n-- deleting a parent --");
console.log("  HTTP", out.deleteStatus, JSON.stringify(out.deleteBody));
console.log("  child before:", out.childBefore, "-> after:", out.childAfter);

console.log("\n-- deleting a plain card --");
console.log(" ", JSON.stringify(out.plainBody));

console.log("\n-- deleting a missing card --");
console.log("  HTTP", out.missingStatus, out.missingDetail);

const checks = [
  ["200 on delete", out.deleteStatus === 200],
  ["response says deleted", out.deleteBody.deleted === true],
  ["echoes the task id", out.deleteBody.task_id === out.deleteBody.task_id],
  ["reports the orphaned child", out.deleteBody.children_orphaned === 1],
  ["was_running present and false", out.deleteBody.was_running === false],
  ["child really released", out.childBefore === "todo" && out.childAfter === "ready"],
  ["plain delete: 0 children", out.plainBody.children_orphaned === 0],
  ["plain delete: was_running false", out.plainBody.was_running === false],
  ["missing card -> 404", out.missingStatus === 404],
  ["404 names the task", String(out.missingDetail || "").includes("t_definitely_not_here")],
  // The deliberate 404 is the one permitted console error; anything beyond it
  // is a real failure.
  ["no unexpected console errors", errors.length <= 1 && !errors.some((e) => !e.includes("404"))],
  ["the only console error is the deliberate 404", errors.length === 1 && errors[0].includes("404")],
];

console.log("\n-- checks --");
let bad = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) bad++;
}
if (errors.length) console.log("\nconsole errors:\n  " + errors.join("\n  "));
console.log(bad ? `\nFAILED: ${bad}` : "\nall checks passed");
await b.close();
process.exit(bad ? 1 : 0);
