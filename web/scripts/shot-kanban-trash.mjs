import puppeteer from "puppeteer";
const b = await puppeteer.launch({ args:["--no-sandbox","--disable-dev-shm-usage"],
  executablePath:"/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome" });
const p = await b.newPage();
await p.setViewport({width:1500,height:950});
await p.authenticate({username:"preview",password:"hermes2026"});
await p.goto("http://127.0.0.1:8090/kanban?board=default",{waitUntil:"networkidle2",timeout:45000});
await new Promise(r=>setTimeout(r,2000));
const id = await p.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = {...(t?{Authorization:`Bearer ${t}`}:{}),"Content-Type":"application/json"};
  return (await (await fetch("/api/kanban/tasks?board=default",{method:"POST",headers:H,
    body:JSON.stringify({title:"Retire the claim-lease migration script"})})).json())?.task?.id;
});
await p.reload({waitUntil:"networkidle2"});
await new Promise(r=>setTimeout(r,2200));
await p.evaluate((t)=>{const c=[...document.querySelectorAll(".kb-card")].find(x=>x.textContent?.includes(t));
  c?.scrollIntoView?.(); c?.dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true}));}, "Retire the claim-lease");
await new Promise(r=>setTimeout(r,700));
await p.screenshot({path: process.argv[2]});
console.log(JSON.stringify(await p.evaluate(()=>document.querySelector(".kb-trash")?.className)));
await p.evaluate(async (tid)=>{const t=window.__HERMES_SESSION_TOKEN__;
  await fetch(`/api/kanban/tasks/${tid}/?board=default`,{method:"DELETE",headers:t?{Authorization:`Bearer ${t}`}:{}});}, id);
await b.close();
