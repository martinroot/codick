import puppeteer from "puppeteer";
const b = await puppeteer.launch({ args:["--no-sandbox","--disable-dev-shm-usage"],
  executablePath:"/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome" });
const p = await b.newPage();
await p.setViewport({width:1500,height:1050});
await p.authenticate({username:"preview",password:"hermes2026"});
await p.goto("http://127.0.0.1:8090/kanban?board=default",{waitUntil:"networkidle2",timeout:45000});
await new Promise(r=>setTimeout(r,2000));
const parent = await p.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = {...(t?{Authorization:`Bearer ${t}`}:{}),"Content-Type":"application/json"};
  return (await (await fetch("/api/kanban/tasks?board=default",{method:"POST",headers:H,
    body:JSON.stringify({title:"Land the dispatcher claim fix"})})).json())?.task?.id;
});
await p.reload({waitUntil:"networkidle2"});
await new Promise(r=>setTimeout(r,2000));
await p.evaluate(()=>{[...document.querySelectorAll("button")].find(b=>b.textContent?.trim()==="New task")?.click();});
await new Promise(r=>setTimeout(r,900));
const set = async (sel,val)=>p.evaluate(([s,v])=>{
  const el=document.querySelector(s); if(!el) return;
  const proto = el.tagName==="TEXTAREA"?window.HTMLTextAreaElement.prototype
    : el.tagName==="SELECT"?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto,"value").set.call(el,v);
  el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true}));
},[sel,val]);
await set("#kb-create-title","Make the claim lease survive a worker restart");
await set("#kb-create-body","The lease is written to the same txn as the status change, so a crash between the two loses the claim but not the transition.\n\nNeeds a regression test that kills the worker mid-claim.");
await set("#kb-create-assignee","martin");
await set("#kb-create-priority","1");
await set("#kb-create-skills","python, sqlite");
await set("#kb-create-parents",parent);
await set("#kb-create-workspace","worktree");
await p.evaluate(()=>{const c=document.querySelector("#kb-create-goal"); if(c&&!c.checked) c.click();});
await new Promise(r=>setTimeout(r,500));
await set("#kb-create-turns","5");
await p.evaluate(()=>{[...document.querySelectorAll(".kb-create button")].find(b=>b.textContent?.includes("model overrides"))?.click();});
await new Promise(r=>setTimeout(r,400));
await set("#kb-create-effort","high");
await new Promise(r=>setTimeout(r,400));
await p.screenshot({path: process.argv[2]});
await p.evaluate(async (id)=>{const t=window.__HERMES_SESSION_TOKEN__;
  await fetch(`/api/kanban/tasks/${id}/?board=default`,{method:"DELETE",headers:t?{Authorization:`Bearer ${t}`}:{}});},parent);
await b.close();
