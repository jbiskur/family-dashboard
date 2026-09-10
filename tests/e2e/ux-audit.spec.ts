import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo, test } from "@playwright/test";

const settings = Object.fromEntries(
  readFileSync(".env.test.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
);
// Authentication fields must not be retained in traces or video artifacts.
test.use({ trace: "off", video: "off" });

async function assertAccessible(page: Page, info: TestInfo, label: string) {
  await expect(page.locator(".loading-state")).toHaveCount(0);
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  await info.attach(`${label}-accessibility`, {
    body: JSON.stringify(result.violations, null, 2),
    contentType: "application/json",
  });
  expect
    .soft(
      result.violations.map((violation) => ({
        id: violation.id,
        targets: violation.nodes.map((node) => node.target),
      })),
      `${label}: WCAG A/AA findings`,
    )
    .toEqual([]);
  expect
    .soft(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${label}: no horizontal document overflow`,
    )
    .toBe(true);
  await page.screenshot({
    path: info.outputPath(`${label}.png`),
    fullPage: true,
  });
}

for (const width of [1440, 390, 320]) {
  test(`independent UX audit at ${width}px`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await assertAccessible(page, info, `login-${width}`);
    await page.getByRole("button", { name: "Continue with Usable" }).click();
    await page.locator("#username").fill("owner@heima.test");
    const password = settings.TEST_USER_PASSWORD;
    if (!password) throw new Error("Missing local fixture password");
    await page.locator("#password").fill(password);
    await page.locator("#kc-login").click();
    await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30_000 });
    const navigation = page.getByRole("navigation", {
      name: width >= 768 ? "Primary navigation" : "Mobile primary navigation",
      exact: true,
    });
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole("link")).toHaveText([
      "Home",
      "Shopping",
      "Work",
      "Finance",
    ]);
    await expect
      .soft(
        page.getByRole("link", { name: "Household settings", exact: true }),
        "Household settings remains reachable at every width",
      )
      .toBeVisible();
    await assertAccessible(page, info, `home-${width}`);
    for (const [name, path, button] of [
      ["Shopping", "/shopping", "New list"],
      ["Work", "/work", "Details"],
    ]) {
      await navigation.getByRole("link", { name, exact: true }).click();
      await expect(page).toHaveURL(`http://localhost:3010${path}`);
      await expect(
        navigation.getByRole("link", { name, exact: true }),
      ).toHaveAttribute("aria-current", "page");
      const trigger = page.getByRole("button", { name: button, exact: true });
      await expect(trigger).toBeVisible();
      await assertAccessible(page, info, `${name.toLowerCase()}-${width}`);
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await assertAccessible(
        page,
        info,
        `${name.toLowerCase()}-create-${width}`,
      );
      // Keyboard traversal must stay within the modal, then return to its trigger.
      for (let step = 0; step < 20; step++) {
        await page.keyboard.press("Tab");
        expect
          .soft(
            await dialog.evaluate((element) =>
              element.contains(document.activeElement),
            ),
            `${name}: focus remains in dialog`,
          )
          .toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect
        .soft(trigger, `${name}: closing dialog returns focus to opener`)
        .toBeFocused();
    }
  });
}
