import puppeteer from "puppeteer";
const b = await puppeteer.launch({args:["--no-sandbox","--disable-dev-shm-usage"],
  executablePath:"/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome"});
const p = await b.newPage();
await p.setViewport({width:1500,height:950});
await p.authenticate({username:"preview",password:"hermes2026"});
await p.goto("http://127.0.0.1:8090/kanban",{waitUntil:"networkidle2",timeout:45000});
await new Promise(r=>setTimeout(r,2500));
const T = "solo todo probe";
console.log(JSON.stringify(await p.evaluate(async (title) => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = {Authorization:`Bearer ${t}`,"Content-Type":"application/json"};
  const q = "?board=default";
  const snap = async (label) => {
    const j = await (await fetch("/api/plugins/kanban/board"+q,{headers:H})).json();
    const hit = (j.columns||[]).flatMap(c=>c.tasks.map(x=>[c.name,x])).find(([,x])=>x.title===title);
    return `${label}: ${hit ? hit[0] : "NOT ON BOARD"}`;
  };
  const log = [];
  // Open the composer in TODO and type through the real UI.
  document.querySelector('.kb-column[data-status="todo"] .kb-add-card').click();
  await new Promise(r=>setTimeout(r,300));
  const input = document.querySelector('.kb-column[data-status="todo"] .kb-composer-input');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;
  setter.call(input, title); input.dispatchEvent(new Event("input",{bubbles:true}));
  await new Promise(r=>setTimeout(r,200));
  log.push(`submit disabled=${document.querySelector('.kb-column[data-status="todo"] .kb-composer button[type=submit]').disabled}`);
  document.querySelector('.kb-column[data-status="todo"] .kb-composer button[type=submit]').click();
  await new Promise(r=>setTimeout(r,1200));
  log.push(await snap("after UI submit (1.2s)"));
  await new Promise(r=>setTimeout(r,2000));
  log.push(await snap("after 3.2s total"));
  // find id to clean up
  const j = await (await fetch("/api/plugins/kanban/board"+q,{headers:H})).json();
  const hit = (j.columns||[]).flatMap(c=>c.tasks).find(x=>x.title===title);
  const direct = hit ? await (await fetch(`/api/plugins/kanban/tasks/${hit.id}`+q,{headers:H})).json() : null;
  if (hit) {
    await fetch(`/api/plugins/kanban/tasks/${hit.id}`+q,{method:"DELETE",headers:H});
    log.push(`direct GET /tasks/{id} said status=${direct?.task?.status}`);
  }
  return log;
}, T), null, 1));
await b.close();
