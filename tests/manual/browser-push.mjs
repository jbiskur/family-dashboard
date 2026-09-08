// Explicit opt-in integration probe using installed Google Chrome's actual push service.
// No mocked PushManager/subscription. Disposable profile; device removed via app UI afterward.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const env = Object.fromEntries(
  (await fs.readFile(".env.test.local", "utf8"))
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
);
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "heima-push-proof-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: true,
  viewport: { width: 1000, height: 800 },
});
const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(20000);
let enabled = false;
try {
  await page.goto("http://localhost:3010/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("owner@heima.test");
  assert(env.TEST_USER_PASSWORD, "Local password unavailable");
  await page.locator("#password").fill(env.TEST_USER_PASSWORD);
  await page.locator("#kc-login").click();
  await page.waitForURL("http://localhost:3010/");
  const session = await page.request.get(
    "http://localhost:3010/api/auth/session",
  );
  const actorId = (await session.json()).user.id;
  const devices = async () => {
    const response = await page.request.get(
      "http://localhost:3010/api/backend/settings/devices",
      { headers: { "x-heima-actor-id": actorId } },
    );
    assert.equal(response.status(), 200, "Device read must remain authorized");
    return (await response.json()).items;
  };
  const before = new Set((await devices()).map((row) => row.id));
  await page.goto("http://localhost:3010/settings/notifications");
  await page
    .getByRole("button", { name: "Enable notifications", exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => Notification.permission), "default");
  assert.equal((await devices()).length, before.size);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Browser.setPermission", {
    permission: { name: "notifications" },
    setting: "granted",
    origin: "http://localhost:3010",
  });
  await page
    .getByRole("button", { name: "Enable notifications", exact: true })
    .click();
  await page
    .getByText("This device is ready for your chosen notifications.", {
      exact: true,
    })
    .waitFor({ timeout: 45000 });
  enabled = true;
  const newDevices = (await devices()).filter((row) => !before.has(row.id));
  assert.equal(
    newDevices.length,
    1,
    "Exactly one device registration after explicit action",
  );
  const matches = await page.evaluate(
    async (endpoint) =>
      (
        await (
          await navigator.serviceWorker.ready
        ).pushManager.getSubscription()
      )?.endpoint === endpoint,
    newDevices[0].endpoint,
  );
  assert(
    matches,
    "Persisted subscription must equal the actual browser subscription",
  );
  await page.screenshot({
    path:
      process.env.HEIMA_PUSH_SCREENSHOT ??
      "/tmp/heima-browser-push-enabled.png",
  });
  await page
    .getByRole("button", { name: "Disable on this device", exact: true })
    .click();
  await page
    .getByText(
      "Push disabled on this device. Your preferences are unchanged.",
      { exact: true },
    )
    .waitFor();
  enabled = false;
  assert(
    !(await devices()).some((row) => row.id === newDevices[0].id),
    "Disabled device must be absent",
  );
  assert.equal(
    await page.evaluate(
      async () =>
        !!(await (
          await navigator.serviceWorker.ready
        ).pushManager.getSubscription()),
    ),
    false,
  );
  console.log(
    "PASS real Chrome push opt-in, subscription persistence and device disable",
  );
} finally {
  if (enabled) {
    await page
      .getByRole("button", { name: "Disable on this device", exact: true })
      .click();
    await page
      .getByText(
        "Push disabled on this device. Your preferences are unchanged.",
        { exact: true },
      )
      .waitFor();
  }
  await context.close();
  await fs.rm(profile, { recursive: true, force: true });
}
