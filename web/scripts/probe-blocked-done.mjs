import puppeteer from "puppeteer";
const b = await puppeteer.launch({args:["--no-sandbox","--disable-dev-shm-usage"],
  executablePath:"/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome"});
const p = await b.newPage();
await p.authenticate({username:"preview",password:"hermes2026"});
await p.goto("http://127.0.0.1:8090/kanban",{waitUntil:"networkidle2",timeout:45000});
await new Promise(r=>setTimeout(r,1500));
console.log(JSON.stringify(await p.evaluate(async () => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const H = token ? {Authorization:`Bearer ${token}`} : {};
  const q = "?board=default";
  const out = {};
  const mk = async (extra) => {
    const r = await fetch("/api/plugins/kanban/tasks"+q, {method:"POST",
      headers:{...H,"Content-Type":"application/json"},
      body: JSON.stringify({title:"blocked/done probe", ...extra})});
    const j = await r.json().catch(()=>null);
    return {id: j?.task?.id ?? null, status: j?.task?.status ?? null, http: r.status};
  };
  // 1) blocked via initial_status
  out.initialStatus = await mk({initial_status:"blocked"});
  // 2) blocked via the db's own parameter name
  out.initialStatusCamel = await mk({initialStatus:"blocked"});
  const ids = Object.values(out).map(v=>v.id).filter(Boolean);
  // 3) ready -> done, and ready -> done with a result
  const base = await mk({});
  const patchDone = await fetch(`/api/plugins/kanban/tasks/${base.id}`+q, {method:"PATCH",
    headers:{...H,"Content-Type":"application/json"}, body: JSON.stringify({status:"done"})});
  const patchBody = await patchDone.json().catch(()=>null);
  out.doneBare = {http: patchDone.status, detail: patchBody?.detail ?? null};
  const patchDone2 = await fetch(`/api/plugins/kanban/tasks/${base.id}`+q, {method:"PATCH",
    headers:{...H,"Content-Type":"application/json"},
    body: JSON.stringify({status:"done", result:"created straight into done"})});
  const patchBody2 = await patchDone2.json().catch(()=>null);
  out.doneWithResult = {http: patchDone2.status, status: patchBody2?.task?.status ?? null};
  ids.push(base.id);
  for (const id of ids) await fetch(`/api/plugins/kanban/tasks/${id}`+q, {method:"DELETE", headers:H});
  return out;
}), null, 1));
await b.close();
