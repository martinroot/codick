import puppeteer from "puppeteer";
const b = await puppeteer.launch({args:["--no-sandbox","--disable-dev-shm-usage"],
  executablePath:"/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome"});
const p = await b.newPage();
await p.authenticate({username:"preview",password:"hermes2026"});
await p.goto("http://127.0.0.1:8090/kanban",{waitUntil:"networkidle2",timeout:45000});
await new Promise(r=>setTimeout(r,1500));
console.log(JSON.stringify(await p.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = {Authorization:`Bearer ${t}`};
  const q = "?board=default";
  const mk = async () => (await (await fetch("/api/plugins/kanban/tasks"+q, {method:"POST",
    headers:{...H,"Content-Type":"application/json"},
    body: JSON.stringify({title:"transition probe"})})).json()).task.id;
  const out = {};
  for (const target of ["todo","scheduled","review","triage","done"]) {
    const id = await mk();
    const r = await fetch(`/api/plugins/kanban/tasks/${id}`+q, {method:"PATCH",
      headers:{...H,"Content-Type":"application/json"},
      body: JSON.stringify(target==="done" ? {status:target, result:"probe"} : {status:target})});
    const j = await r.json().catch(()=>null);
    out["ready->"+target] = {http: r.status, got: j?.task?.status ?? null, detail: j?.detail ?? null};
    await fetch(`/api/plugins/kanban/tasks/${id}`+q, {method:"DELETE", headers:H});
  }
  return out;
}), null, 1));
await b.close();
