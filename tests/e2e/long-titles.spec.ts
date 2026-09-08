import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const password = Object.fromEntries(
  readFileSync(".env.test.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
).TEST_USER_PASSWORD;
test.use({ trace: "off", video: "off", viewport: { width: 320, height: 812 } });
test("long unbroken titles and full UUIDs wrap within Home and Work at 320px", async ({
  page,
}, info) => {
  if (!password) throw new Error("Missing local fixture password");
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("owner@heima.test");
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  await page.goto("/work");
  const title = `HouseholdReference${"A".repeat(85)}${crypto.randomUUID()}`;
  await page.getByRole("button", { name: "Add a to-do", exact: true }).click();
  await page.getByRole("textbox", { name: /What needs doing/ }).fill(title);
  await page
    .getByLabel("Due date (optional)", { exact: true })
    .fill("2024-01-01");
  await page.getByRole("button", { name: "Add to-do", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New to-do" })).toBeHidden();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  for (const path of ["/work", "/"]) {
    await page.goto(path);
    const heading = page.getByRole("heading", { name: title, exact: true });
    await expect(heading).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(321);
    const bounds = await heading.boundingBox();
    expect(bounds).not.toBeNull();
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(320);
    await heading.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(
        path === "/" ? "home-long-title-320.png" : "work-long-title-320.png",
      ),
      fullPage: false,
    });
  }
});
