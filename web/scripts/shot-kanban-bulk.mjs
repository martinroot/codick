import puppeteer from "puppeteer";
const b = await puppeteer.launch({ args:["--no-sandbox","--disable-dev-shm-usage"],
  executablePath:"/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome" });
const p = await b.newPage();
await p.setViewport({width:1500,height:950});
await p.authenticate({username:"preview",password:"hermes2026"});
await p.goto("http://127.0.0.1:8090/kanban?board=default",{waitUntil:"networkidle2",timeout:45000});
await new Promise(r=>setTimeout(r,2000));
await p.evaluate(() => {
  const cards = [...document.querySelectorAll(".kb-card")];
  cards.forEach(c => c.dispatchEvent(new MouseEvent("click",{bubbles:true,ctrlKey:true})));
});
await new Promise(r=>setTimeout(r,600));
// Scroll the rail to whichever column actually holds the cards; otherwise the
// screenshot shows four empty columns and proves nothing about selection.
const sel = await p.evaluate(() => {
  const rail = document.querySelector(".kb-rail");
  const card = document.querySelector(".kb-card");
  if (rail && card) rail.scrollLeft = card.offsetLeft - 40;
  return document.querySelector(".kb-bulk-count")?.textContent;
});
await new Promise(r=>setTimeout(r,400));
await p.screenshot({path: process.argv[2] || "/tmp/kb-bulk.png"});
console.log(JSON.stringify({sel, out: process.argv[2]}));
await b.close();
