import puppeteer from "puppeteer";
const b = await puppeteer.launch({ args:["--no-sandbox","--disable-dev-shm-usage"],
  executablePath:"/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome" });
const p = await b.newPage();
await p.setViewport({width:1500,height:950});
await p.authenticate({username:"preview",password:"hermes2026"});
await p.goto("http://127.0.0.1:8090/kanban?board=default",{waitUntil:"networkidle2",timeout:45000});
await new Promise(r=>setTimeout(r,2000));
// Seed a blocked card so the Recovery panel has something to show.
const id = await p.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = {...(t?{Authorization:`Bearer ${t}`}:{}),"Content-Type":"application/json"};
  const c = await (await fetch("/api/kanban/tasks?board=default",{method:"POST",headers:H,
    body:JSON.stringify({title:"Ship the release notes draft", initial_status:"blocked"})})).json();
  return c?.task?.id ?? null;
});
await new Promise(r=>setTimeout(r,1500));
await p.reload({waitUntil:"networkidle2"});
await new Promise(r=>setTimeout(r,2000));
await p.evaluate(() => {
  const rail = document.querySelector(".kb-rail");
  const card = [...document.querySelectorAll(".kb-card")].find(c=>c.textContent?.includes("release notes draft"));
  if (rail && card) rail.scrollLeft = Math.max(0, card.offsetLeft - 40);
  card?.click();
});
await new Promise(r=>setTimeout(r,2500));
await p.screenshot({path: process.argv[2]});
console.log(JSON.stringify({id, panel: await p.evaluate(()=>document.querySelector(".kb-drawer")?.textContent?.includes("Recovery"))}));
await b.close();
