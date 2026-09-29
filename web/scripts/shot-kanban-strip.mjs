import puppeteer from "puppeteer";
const b = await puppeteer.launch({ args:["--no-sandbox","--disable-dev-shm-usage"],
  executablePath:"/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome" });
const p = await b.newPage();
await p.setViewport({width:1500,height:950});
await p.authenticate({username:"preview",password:"hermes2026"});
await p.goto("http://127.0.0.1:8090/kanban?board=default",{waitUntil:"networkidle2",timeout:45000});
await new Promise(r=>setTimeout(r,2000));
// Seed the deadlock so the strip has something to photograph, and leave the
// board as we found it afterwards.
const ids = await p.evaluate(async () => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = {...(t?{Authorization:`Bearer ${t}`}:{}),"Content-Type":"application/json"};
  const call = (m,path,bd) => fetch("/api/kanban"+path,{method:m,headers:H,body:bd?JSON.stringify(bd):undefined});
  const parent = (await (await call("POST","/tasks?board=default",
    {title:"Refactor the dispatcher claim path"})).json())?.task?.id;
  const child = (await (await call("POST","/tasks?board=default",
    {title:"Add regression test for reclaim"})).json())?.task?.id;
  await call("POST","/links?board=default",{parent_id:parent,child_id:child});
  await call("PATCH",`/tasks/${parent}?board=default`,
    {status:"blocked",block_reason:"review-required: implementation is complete and needs a reviewer"});
  return {parent, child};
});
await p.reload({waitUntil:"networkidle2"});
await new Promise(r=>setTimeout(r,3000));
await p.screenshot({path: process.argv[2]});
console.log(JSON.stringify({ids, strip: await p.evaluate(()=>
  document.querySelector(".kb-strip-count")?.textContent)}));
// Board back to how we found it.
await p.evaluate(async (i) => {
  const t = window.__HERMES_SESSION_TOKEN__;
  const H = t?{Authorization:`Bearer ${t}`}:{};
  await fetch(`/api/kanban/links?board=default&parent_id=${i.parent}&child_id=${i.child}`,
    {method:"DELETE",headers:H});
  for (const id of [i.child, i.parent]) {
    await fetch(`/api/kanban/tasks/${id}?board=default`,{method:"DELETE",headers:H});
  }
}, ids);
await b.close();
