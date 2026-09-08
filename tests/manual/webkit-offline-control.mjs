// Independent minimal browser capability control: no Heima code, credentials or domain data.
import http from "node:http";
import { webkit } from "@playwright/test";

const html =
  '<title>Offline control</title><h1>Static cached page</h1><script>window.instance=crypto.randomUUID();navigator.serviceWorker.register("/sw.js")</script>';
const sw =
  'self.addEventListener("install",e=>e.waitUntil(caches.open("control").then(c=>c.add("/"))));self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));self.addEventListener("fetch",e=>{if(e.request.mode==="navigate")e.respondWith(fetch(e.request).catch(()=>caches.match("/")))})';
const server = http.createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/sw.js" ? "text/javascript" : "text/html",
  );
  res.end(req.url === "/sw.js" ? sw : html);
});
await new Promise((r) => server.listen(39127, "127.0.0.1", r));
const browser = await webkit.launch();
const context = await browser.newContext();
const page = await context.newPage();
try {
  await page.goto("http://127.0.0.1:39127/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const before = await page.evaluate(() => window.instance);
  console.log(
    "CONTROL ready/cache",
    await page.evaluate(async () => !!(await caches.match("/"))),
  );
  await context.setOffline(true);
  try {
    await page.reload({ timeout: 10000 });
    console.log("CONTROL reload success");
  } catch (e) {
    console.log("CONTROL reload failed", e.message.split("\n")[0]);
  }
  console.log(
    "CONTROL new document",
    (await page.evaluate(() => window.instance)) !== before,
  );
} finally {
  await context.setOffline(false);
  await browser.close();
  await new Promise((r) => server.close(r));
}
