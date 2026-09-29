
import puppeteer from "puppeteer";
const b = await puppeteer.launch({args:["--no-sandbox","--disable-dev-shm-usage"],
  executablePath:"/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome",headless:true});
const p = await b.newPage();
await p.authenticate({username:"preview",password:"hermes2026"});
await p.setViewport({width:1400,height:1000});
await p.goto("http://127.0.0.1:8090/chat",{waitUntil:"networkidle2",timeout:60000});
await new Promise(r=>setTimeout(r,3000));

const res = await p.evaluate(() => {
  // The label and the button are siblings; anchor on the label, whose text
  // is exactly "model".
  const label = [...document.querySelectorAll("div")].find(
    (d) => d.textContent.trim() === "model" && d.children.length === 0);
  if (!label) return {step: "no model label"};
  const btn = label.parentElement.querySelector("button");
  if (!btn) return {step: "no button sibling", html: label.parentElement.innerHTML.slice(0, 160)};
  btn.scrollIntoView({block: "center"});
  btn.click();
  return {step: "clicked", text: btn.textContent.trim().slice(0, 30)};
});
console.log(JSON.stringify(res));
await new Promise(r=>setTimeout(r,1500));

const after = await p.evaluate(() => {
  const dlg = document.querySelector('[role=dialog], .modal, dialog[open]');
  if (!dlg) return {found: false};
  const r = dlg.getBoundingClientRect();
  return {found: true, w: Math.round(r.width), h: Math.round(r.height),
          text: dlg.textContent.trim().slice(0, 90)};
});
console.log("dialog:", JSON.stringify(after));
await p.screenshot({path: "/home/grokwin/.hermes/cache/scratch/model5.png"});
await b.close();
