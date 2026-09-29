import puppeteer from "puppeteer";
const b = await puppeteer.launch({args:["--no-sandbox","--disable-dev-shm-usage"],
  executablePath:"/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome"});
const p = await b.newPage();
await p.authenticate({username:"preview",password:"hermes2026"});
await p.goto("http://127.0.0.1:8090/kanban",{waitUntil:"networkidle2",timeout:45000});
await new Promise(r=>setTimeout(r,1500));
console.log(JSON.stringify(await p.evaluate(async () => {
  const token = window.__HERMES_SESSION_TOKEN__;
  const q = "?board=default";
  const H = token ? {Authorization:`Bearer ${token}`} : {};
  const created = await (await fetch("/api/plugins/kanban/tasks"+q, {
    method:"POST", headers:{...H,"Content-Type":"application/json"},
    body: JSON.stringify({title:"shape diff probe", status:"triage"})})).json();
  const id = created?.task?.id;
  const board = await (await fetch("/api/plugins/kanban/board"+q, {headers:H})).json();
  const card = (board.columns??[]).flatMap(c=>c.tasks??[]).find(t=>t.id===id);
  await fetch(`/api/plugins/kanban/tasks/${id}`+q, {method:"DELETE", headers:H});
  const pk = Object.keys(created?.task ?? {}).sort();
  const bk = Object.keys(card ?? {}).sort();
  return {
    createKeys: pk.length, boardKeys: bk.length,
    onlyInBoard: bk.filter(k=>!pk.includes(k)),
    onlyInCreate: pk.filter(k=>!bk.includes(k)),
  };
}), null, 1));
await b.close();
