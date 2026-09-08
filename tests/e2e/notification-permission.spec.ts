import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const env = Object.fromEntries(
  readFileSync(".env.test.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
);
test.use({ trace: "off", video: "off" });

test("explicit notification opt-in handles actual denied browser permission without registering a device", async ({
  page,
  context,
  browserName,
}, info) => {
  test.skip(
    browserName !== "chromium",
    "Explicit native permission denial uses Chromium CDP; ordinary preference use runs on all engines.",
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("owner@heima.test");
  if (!env.TEST_USER_PASSWORD)
    throw new Error("Missing local fixture password");
  await page.locator("#password").fill(env.TEST_USER_PASSWORD);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/");
  const session = await page.request.get("/api/auth/session");
  const actorId = (await session.json()).user.id;
  const deviceIds = async () => {
    const response = await page.request.get("/api/backend/settings/devices", {
      headers: { "x-heima-actor-id": actorId },
    });
    expect(response.status()).toBe(200);
    return (await response.json()).items
      .map((row: { id: string }) => row.id)
      .sort();
  };
  const before = await deviceIds();
  const permissionBefore = await page.evaluate(() => Notification.permission);
  await page.goto("/settings/notifications");
  await expect(
    page.getByRole("button", { name: "Enable notifications", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => Notification.permission)).toBe(
    permissionBefore,
  );
  expect(await deviceIds()).toEqual(before);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Browser.setPermission", {
    permission: { name: "notifications" },
    setting: "denied",
    origin: "http://localhost:3010",
  });
  await page
    .getByRole("button", { name: "Enable notifications", exact: true })
    .click();
  await expect(
    page.getByText(
      "Notification permission wasn't granted. You can keep using in-app activity.",
      { exact: true },
    ),
  ).toBeVisible();
  expect(await page.evaluate(() => Notification.permission)).toBe("denied");
  expect(await deviceIds()).toEqual(before);
  await expect(
    page.getByRole("button", { name: "Save preferences", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: info.outputPath("notification-permission-denied.png"),
    fullPage: true,
  });
  await page
    .getByRole("navigation", {
      name:
        (page.viewportSize()?.width ?? 1440) >= 768
          ? "Primary navigation"
          : "Mobile primary navigation",
      exact: true,
    })
    .getByRole("link", { name: "Shopping", exact: true })
    .click();
  await expect(page).toHaveURL("http://localhost:3010/shopping");
  await expect(
    page.getByRole("button", { name: "New list", exact: true }),
  ).toBeVisible();
});
