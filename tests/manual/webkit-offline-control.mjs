// Independent minimal browser capability control: no Heima code, credentials or domain data.

import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
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
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await webkit.launch();
const context = await browser.newContext();
const page = await context.newPage();
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const before = await page.evaluate(() => window.instance);
  const cached = await page.evaluate(async () => !!(await caches.match("/")));
  if (!cached) throw new Error("Independent control failed to cache HTML");
  let reloadError = null;
  await context.setOffline(true);
  try {
    await page.reload({ timeout: 10000 });
  } catch (e) {
    reloadError = e.message.split("\n")[0];
  }
  const documentReplaced =
    (await page.evaluate(() => window.instance)) !== before;
  const unsupported =
    reloadError?.includes("WebKit encountered an internal error") === true &&
    !documentReplaced;
  if (!unsupported && (reloadError || !documentReplaced))
    throw new Error(
      `Unclassified independent control failure: ${reloadError ?? "document was not replaced"}`,
    );
  const report = {
    control: "independent-static-service-worker-v1",
    observedAt: new Date().toISOString(),
    platform: process.platform,
    browser: "webkit",
    browserVersion: browser.version(),
    controlled: true,
    cached,
    reloadError,
    documentReplaced,
    offlineNavigation: unsupported ? "unsupported" : "supported",
  };
  console.log(JSON.stringify(report, null, 2));
  const reportFlag = process.argv.indexOf("--report");
  if (reportFlag !== -1) {
    const destination = process.argv[reportFlag + 1];
    if (!destination) throw new Error("--report requires a file path");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
  }
} finally {
  await context.setOffline(false);
  await browser.close();
  await new Promise((r) => server.close(r));
}
