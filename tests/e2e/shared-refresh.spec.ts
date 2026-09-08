import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

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
async function login(page: Page, user: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill(`${user}@heima.test`);
  if (!env.TEST_USER_PASSWORD) throw new Error("Missing fixture password");
  await page.locator("#password").fill(env.TEST_USER_PASSWORD);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/");
}
test("Visible Shopping directory refreshes shared lists within five seconds and never includes personal lists", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(90_000);
  const spouseContext = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  const spouse = await spouseContext.newPage();
  try {
    await login(page, "owner");
    await login(spouse, "spouse");
    await spouse.goto("/shopping");
    await expect(spouse.locator(".loading-state")).toHaveCount(0);
    for (const visibility of ["household", "personal"]) {
      await page.goto("/shopping");
      const name = `${visibility} shopping ${crypto.randomUUID()}`;
      await page.getByRole("button", { name: "New list", exact: true }).click();
      await page.getByRole("textbox", { name: /List name/ }).fill(name);
      await page
        .getByRole("combobox", { name: "Who can see it?", exact: true })
        .selectOption(visibility);
      await page
        .getByRole("button", { name: "Create list", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      if (visibility === "household") {
        await expect(
          spouse.getByRole("heading", { name, exact: true }),
        ).toBeVisible({ timeout: 5000 });
        await spouse.getByRole("heading", { name, exact: true }).click();
        await expect(spouse).toHaveURL(/\/shopping\/[0-9a-f-]{36}$/);
        await spouse.goto("/shopping");
      } else {
        await spouse.reload();
        await expect(spouse.locator(".loading-state")).toHaveCount(0);
        await expect(
          spouse.getByRole("heading", { name, exact: true }),
        ).toHaveCount(0);
      }
    }
    await spouse.screenshot({
      path: info.outputPath("spouse-authorized-shopping-directory.png"),
      fullPage: false,
    });
  } finally {
    await spouseContext.close();
  }
});
