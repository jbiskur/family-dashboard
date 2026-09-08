// Independent minimal browser capability control: no Heima code, credentials or domain data.

import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { webkit } from "@playwright/test";

if (!process.argv.includes("--worker")) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--worker"],
    { detached: process.platform !== "win32", stdio: "inherit" },
  );
  await new Promise((resolve) => {
    const deadline = setTimeout(() => {
      console.log("CONTROL bounded cleanup after native WebKit IPC stall");
      if (process.platform === "win32") child.kill("SIGKILL");
      else if (child.pid) process.kill(-child.pid, "SIGKILL");
    }, 10000);
    child.once("exit", () => {
      clearTimeout(deadline);
      resolve();
    });
  });
} else {
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
  page.on("console", (m) => console.log("CONSOLE", m.text()));
  try {
    await page.goto("http://127.0.0.1:39127/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    console.log(
      "PUSH before",
      await page.evaluate(() => ({
        notification: typeof Notification,
        push: typeof PushManager,
        permission: Notification.permission,
      })),
    );
    await page.evaluate(() => {
      console.log("before native subscription");
      navigator.serviceWorker.ready
        .then((r) => r.pushManager.getSubscription())
        .then(() => console.log("subscription resolved"))
        .catch(() => console.log("subscription rejected"));
      console.log("scheduled native subscription");
    });
    console.log("PUSH dispatched");
    await new Promise((r) => setTimeout(r, 2000));
    const result = await Promise.race([
      page.evaluate(() => document.title).then(() => true),
      new Promise((r) => setTimeout(() => r(false), 3000)),
    ]);
    console.log("PUSH evaluate responsive", result);
  } finally {
    await context.setOffline(false);
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}
