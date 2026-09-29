import puppeteer from "puppeteer";
const b = await puppeteer.launch({args:["--no-sandbox","--disable-dev-shm-usage"],
  executablePath:"/home/grokwin/.cache/puppeteer/chrome/linux-153.0.8010.36/chrome-linux64/chrome"});
const p = await b.newPage();
await p.setViewport({width:1500,height:950});
await p.authenticate({username:"preview",password:"hermes2026"});
await p.goto("http://127.0.0.1:8090/kanban",{waitUntil:"networkidle2",timeout:45000});
await new Promise(r=>setTimeout(r,2500));
console.log(JSON.stringify(await p.evaluate(() => {
  const hdr = document.querySelector("header, [class*=page-header], h1") ;
  return {
    firstHeading: document.querySelector("h1")?.textContent?.trim(),
    allHeadings: [...document.querySelectorAll("h1,h2,h3")].slice(0,4).map(e=>e.textContent.trim()),
    pluginTabsSeen: (window.__HERMES_PLUGINS__?.manifests || []).map(m => m.tab?.path),
  };
}), null, 1));
await b.close();
