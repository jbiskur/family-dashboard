import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  offlineNavigationLimitation,
  webKitOfflineNavigationUnsupported,
} from "../fixtures/browser-capabilities";

const settings = Object.fromEntries(
  readFileSync(".env.test.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
);
test.use({ trace: "off", video: "off" });
async function login(page: Page, user = "owner") {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  const password = settings.TEST_USER_PASSWORD;
  if (!password) throw new Error("Missing local fixture password");
  await page.locator("#username").fill(`${user}@heima.test`);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  const response = await page.request.get("/api/auth/session");
  expect(response.ok()).toBe(true);
  return (await response.json()).user.id as string;
}
async function read<T>(page: Page, actorId: string, path: string): Promise<T> {
  const response = await page.request.get(`/api/backend/${path}`, {
    headers: { "x-heima-actor-id": actorId },
  });
  expect(response.status(), path).toBe(200);
  return response.json();
}
type Activity = {
  id: string;
  category: string;
  title: string;
  href: string;
  read: boolean;
};

test("a real rejected offline assignment creates one private generic sync activity with a safe area link", async ({
  page,
  context,
  browser,
  browserName,
}, info) => {
  test.setTimeout(120000);
  const otherContext = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  const spouseContext = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  const other = await otherContext.newPage();
  const spouse = await spouseContext.newPage();
  try {
    const actorId = await login(page);
    await login(other);
    const spouseId = await login(spouse, "spouse");
    const before = await read<{ items: Activity[] }>(page, actorId, "activity");
    const previousIds = new Set(before.items.map((item) => item.id));
    const profileName = `Assignment profile ${crypto.randomUUID()}`;
    const title = `Private device draft ${crypto.randomUUID()}`;
    await page.goto("/settings/household");
    await page
      .getByRole("button", { name: "Add a household profile", exact: true })
      .click();
    const profileDialog = page.getByRole("dialog", {
      name: "Add a household profile",
      exact: true,
    });
    await profileDialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill(profileName);
    await profileDialog
      .getByRole("button", { name: "Add profile", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: `Archive ${profileName}`, exact: true }),
    ).toBeVisible();
    await page.goto("/work");
    await expect(page.locator(".loading-state")).toHaveCount(0);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
    });
    await page.reload();
    await expect(page.locator(".loading-state")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
      .toBe(true);
    await context.setOffline(true);
    // Keep the complete producer journey on macOS WebKit; the independent control
    // excludes only its unsupported offline hard navigation. Other engines prove reload.
    if (webKitOfflineNavigationUnsupported(browserName)) {
      info.annotations.push({
        type: "offline-navigation-limitation",
        description: offlineNavigationLimitation,
      });
    } else {
      await page.reload();
    }
    await page
      .getByRole("button", { name: "Add a to-do", exact: true })
      .click();
    await page.getByRole("textbox", { name: /What needs doing/ }).fill(title);
    await page
      .getByRole("combobox", { name: "Who's on it?", exact: true })
      .selectOption({ label: profileName });
    await page.getByRole("button", { name: "Add to-do", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await other.goto("/settings/household");
    await other
      .getByRole("button", { name: `Archive ${profileName}`, exact: true })
      .click();
    await other
      .getByRole("dialog", { name: "Archive this profile?", exact: true })
      .getByRole("button", { name: "Archive profile", exact: true })
      .click();
    await expect(
      other.getByRole("button", {
        name: `Archive ${profileName}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await context.setOffline(false);
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const queue = JSON.parse(
              localStorage.getItem("heima-offline-queue") ?? "[]",
            );
            return queue[0]?.state;
          }),
        { timeout: 30000 },
      )
      .toBe("error");
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const queue = JSON.parse(
              localStorage.getItem("heima-offline-queue") ?? "[]",
            );
            return queue[0]?.failureReport?.complete;
          }),
        { timeout: 30000 },
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "Review sync", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toContainText(title);
    await page.screenshot({
      path: info.outputPath("rejected-assignment-saved.png"),
      fullPage: false,
    });
    await page.keyboard.press("Escape");
    const after = await read<{ items: Activity[] }>(page, actorId, "activity");
    const created = after.items.filter(
      (item) => !previousIds.has(item.id) && item.category === "syncFailures",
    );
    expect(created).toHaveLength(1);
    const activity = created[0];
    if (!activity) throw new Error("Sync activity was not produced");
    expect(activity.href).toBe("/work");
    expect(JSON.stringify(activity)).not.toContain(title);
    expect(JSON.stringify(activity)).not.toContain(profileName);
    expect(
      (
        await read<{ items: Activity[] }>(spouse, spouseId, "activity")
      ).items.some((item) => item.id === activity.id),
    ).toBe(false);
    expect(
      (
        await read<{ items: { title: string }[] }>(page, actorId, "work/items")
      ).items.some((item) => item.title === title),
    ).toBe(false);
    await page.goto("/settings/notifications");
    const row = page
      .locator(".activity-row")
      .filter({
        has: page.getByRole("link", { name: new RegExp(activity.title) }),
      })
      .first();
    await expect(row).toContainText(activity.title);
    await row
      .getByRole("button", {
        name: `Mark ${activity.title} as read`,
        exact: true,
      })
      .click();
    await expect(row.getByRole("button")).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("private-sync-activity.png"),
      fullPage: false,
    });
    await page.reload();
    const repeated = await read<{ items: Activity[] }>(
      page,
      actorId,
      "activity",
    );
    expect(
      repeated.items.filter(
        (item) => !previousIds.has(item.id) && item.category === "syncFailures",
      ),
    ).toHaveLength(1);
    expect(repeated.items.find((item) => item.id === activity.id)?.read).toBe(
      true,
    );
    await page
      .getByRole("link", { name: new RegExp(activity.title) })
      .first()
      .click();
    await expect(page).toHaveURL(/\/work$/);
  } finally {
    await context.setOffline(false);
    await otherContext.close();
    await spouseContext.close();
  }
});
