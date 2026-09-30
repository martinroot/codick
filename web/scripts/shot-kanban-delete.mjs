import puppeteer from "puppeteer";
const b = await puppeteer.launch({ args:["--no-sandbox","--disable-dev-shm-usage"],
  executablePath:"/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome" });
const p = await b.newPage();
await p.setViewport({width:1500,height:950});
await p.authenticate({username:"preview",password:"hermes2026"});
await p.goto("http://127.0.0.1:8090/kanban?board=default",{waitUntil:"networkidle2",timeout:45000});
await new Promise(r=>setTimeout(r,2000));
const ids = await p.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = {...(t?{Authorization:`Bearer ${t}`}:{}),"Content-Type":"application/json"};
  const out=[];
  const names=["Retry the flaky claim endpoint","Rewrite the dispatcher claim path","Drop the claim lease entirely","Remove the unused status column"];
  for (const n of names) out.push((await (await fetch("/api/kanban/tasks?board=default",{method:"POST",headers:H,
    body:JSON.stringify({title:n})})).json())?.task?.id);
  return out;
});
await p.reload({waitUntil:"networkidle2"});
await new Promise(r=>setTimeout(r,2000));
for (const n of ["Retry the flaky","Rewrite the dispatcher","Drop the claim lease","Remove the unused"]) {
  await p.evaluate((t)=>{const c=[...document.querySelectorAll(".kb-card")].find(x=>x.textContent?.includes(t));
    c?.scrollIntoView?.(); c?.dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true}));}, n);
  await new Promise(r=>setTimeout(r,350));
}
await p.evaluate(()=>{[...document.querySelectorAll(".kb-bulk button")].find(x=>x.textContent?.trim()==="Delete")?.click();});
await new Promise(r=>setTimeout(r,1000));
console.log(JSON.stringify(await p.evaluate(()=>({list: [...document.querySelectorAll(".kb-confirm-list li")].map(l=>l.textContent)}))));
await p.screenshot({path: process.argv[2]});
await p.evaluate(async (ids)=>{
  const t = window.__HERMES_SESSION_TOKEN__;
  for (const id of ids) await fetch(`/api/kanban/tasks/${id}?board=default`,{method:"DELETE",headers:t?{Authorization:`Bearer ${t}`}:{}});
}, ids);
await b.close();
