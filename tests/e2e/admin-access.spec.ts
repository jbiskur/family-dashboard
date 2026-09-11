import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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

test("invited admin reaches household features with accurate role and privacy scope", async ({
  page,
}, info) => {
  test.setTimeout(150000);
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("admin@heima.test");
  await page.locator("#password").fill(settings.TEST_USER_PASSWORD ?? "");
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  await expect(page.locator("#main-content")).toBeVisible();
  for (const [path, state] of [
    ["/", "home"],
    ["/shopping", "shopping"],
    ["/work", "work"],
    ["/finance", "finance"],
    ["/settings/household", "household"],
  ] as const) {
    await page.goto(path);
    await expect(page.locator("#main-content")).toBeVisible();
    await expect(page.locator(".loading-state")).toHaveCount(0);
    await expect(page.locator(".error-state")).toHaveCount(0);
    if (state === "finance")
      await expect(
        page.getByText(
          "Shared accounts and your own. Other people's private finances are excluded.",
          { exact: true },
        ),
      ).toBeVisible();
    if (state === "household") {
      const self = page.locator(".member-row").filter({ hasText: "You" });
      await expect(
        self.getByText("Admin · shared household access"),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Revoke spouse access" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Request invited access" }),
      ).toHaveCount(0);
    }
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        );
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width + 1);
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect
        .soft(axe.violations, `${state} ${width} accessibility`)
        .toEqual([]);
      await page.screenshot({
        path: info.outputPath(`admin-${state}-${width}.png`),
      });
    }
  }
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue with Usable" }),
  ).toBeVisible();
  expect((await page.request.get("/api/offline-lease")).status()).toBe(401);
});

test("an app invitation alone explains missing household access without admitting the account", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("guest@heima.test");
  await page.locator("#password").fill(settings.TEST_USER_PASSWORD ?? "");
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  await expect(
    page.getByRole("heading", { name: "Household access is needed." }),
  ).toBeVisible();
  await expect(page.getByText(/your Usable invitation is valid/)).toBeVisible();
  await expect(page.locator("#main-content")).toHaveCount(0);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width + 1);
    await page.screenshot({
      path: info.outputPath(`invited-unassigned-${width}.png`),
    });
  }
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue with Usable" }),
  ).toBeVisible();
});
