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
  const c = await (await fetch("/api/kanban/tasks?board=default",{method:"POST",headers:H,
    body:JSON.stringify({title:"Wire the completion summary into the done transition"})})).json();
  return c?.task?.id;
});
await new Promise(r=>setTimeout(r,1500));
await p.reload({waitUntil:"networkidle2"});
await new Promise(r=>setTimeout(r,2000));
await p.evaluate(() => {
  const c = [...document.querySelectorAll(".kb-card")].find(x=>x.textContent?.includes("Wire the completion summary"));
  c?.scrollIntoView?.();
  c?.dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true}));
});
await new Promise(r=>setTimeout(r,600));
await p.evaluate(() => {
  [...document.querySelectorAll(".kb-bulk button")].find(x=>x.textContent?.trim()==="Complete")?.click();
});
await new Promise(r=>setTimeout(r,1200));
// Type something so the screenshot shows the dialog mid-use.
await p.evaluate(() => {
  const ta = document.querySelector('[role="dialog"] textarea');
  const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;
  s.call(ta, "Moved the gate into handleMove and the bulk path, and showed the server's refusal in place instead of window.prompt.");
  ta.dispatchEvent(new Event("input",{bubbles:true}));
});
await new Promise(r=>setTimeout(r,400));
console.log(JSON.stringify({focus: await p.evaluate(()=>({
  active: document.activeElement?.tagName,
  isTextarea: document.activeElement?.tagName === "TEXTAREA",
}))}));
await p.screenshot({path: process.argv[2]});
await p.evaluate(async (tid) => {
  const t = window.__HERMES_SESSION_TOKEN__;
  await fetch(`/api/kanban/tasks/${tid}?board=default`,{method:"DELETE",headers:t?{Authorization:`Bearer ${t}`}:{}});
}, id);
await b.close();
