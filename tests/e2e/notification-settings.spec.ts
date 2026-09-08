import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const settings = Object.fromEntries(
  readFileSync(".env.test.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
);
const fields = [
  "shoppingChanges",
  "workAssignment",
  "dueReminders",
  "recurrence",
  "financeReview",
  "syncFailures",
] as const;
type Preferences = Record<(typeof fields)[number], boolean> & {
  id: string;
  version: number;
  quietStart: string;
  quietEnd: string;
  timezone: string;
};
test.use({ trace: "off", video: "off" });
async function login(page: Page, user: string) {
  const password = settings.TEST_USER_PASSWORD;
  if (!password) throw new Error("Missing local fixture password");
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill(`${user}@heima.test`);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  const session = await page.request.get("/api/auth/session");
  expect(session.ok()).toBe(true);
  return (await session.json()).user.id as string;
}
async function preferences(page: Page, actorId: string) {
  const result = await page.request.get("/api/backend/settings/preferences", {
    headers: { "x-heima-actor-id": actorId },
  });
  expect(result.status()).toBe(200);
  return (await result.json()).items as Preferences[];
}
test("notification choices and Faroe quiet hours persist privately without prompting for push", async ({
  page,
  browser,
}, info) => {
  const spouseContext = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  const spouse = await spouseContext.newPage();
  try {
    const actorId = await login(page, "owner");
    const spouseId = await login(spouse, "spouse");
    const spouseBefore = await preferences(spouse, spouseId);
    await page.goto("/settings/notifications");
    await expect(
      page.getByRole("button", { name: "Save preferences", exact: true }),
    ).toBeVisible();
    const permissionBefore = await page.evaluate(() =>
      "Notification" in window ? Notification.permission : "unavailable",
    );
    const prior: Record<string, boolean> = {};
    for (const field of fields) {
      prior[field] = await page.locator(`#preference-${field}`).isChecked();
      await page.locator(`#preference-${field}`).setChecked(!prior[field]);
    }
    const quietStart = await page
      .getByLabel("From", { exact: true })
      .inputValue();
    const quietEnd = await page
      .getByLabel("Until", { exact: true })
      .inputValue();
    await page.getByLabel("From", { exact: true }).fill("21:15");
    await page.getByLabel("Until", { exact: true }).fill("06:45");
    await page
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Notification preferences saved." }),
    ).toContainText("Notification preferences saved.");
    await page.reload();
    for (const field of fields)
      await expect(page.locator(`#preference-${field}`)).toBeChecked({
        checked: !prior[field],
      });
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("21:15");
    await expect(page.getByLabel("Until", { exact: true })).toHaveValue(
      "06:45",
    );
    const saved = (await preferences(page, actorId))[0];
    expect(saved?.timezone).toBe("Atlantic/Faroe");
    expect(await preferences(spouse, spouseId)).toEqual(spouseBefore);
    expect(
      await page.evaluate(() =>
        "Notification" in window ? Notification.permission : "unavailable",
      ),
    ).toBe(permissionBefore);
    await page.screenshot({
      path: info.outputPath("private-preferences-quiet-hours.png"),
      fullPage: false,
    });
    // Restore the prior delivery choices through the same public UI.
    for (const field of fields)
      await page
        .locator(`#preference-${field}`)
        .setChecked(prior[field] ?? false);
    await page.getByLabel("From", { exact: true }).fill(quietStart);
    await page.getByLabel("Until", { exact: true }).fill(quietEnd);
    await page
      .getByRole("button", { name: "Save preferences", exact: true })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Notification preferences saved." }),
    ).toContainText("Notification preferences saved.");
    expect((await preferences(page, actorId))[0]?.id).toBe(saved?.id);
    expect((await preferences(page, actorId))[0]?.version).toBeGreaterThan(
      saved?.version ?? 0,
    );
  } finally {
    await spouseContext.close();
  }
});
