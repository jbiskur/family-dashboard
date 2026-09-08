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
async function login(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await expect(page).toHaveURL(/localhost:8187/, { timeout: 20000 });
  await page.locator("#username").fill("owner@heima.test");
  await page.locator("#password").fill(settings.TEST_USER_PASSWORD!);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  await expect(page.getByRole("navigation").first()).toBeVisible();
}

test("account and manual financial fact show exact amount and provenance", async ({
  page,
}, info) => {
  await login(page);
  const name = `Everyday account ${crypto.randomUUID()}`;
  await page.goto("/finance/accounts");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Account name", exact: true })
    .fill(name);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add account", exact: true })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/finance\/accounts\/[0-9a-f-]{36}$/);
  const accountId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(
    page.getByText("Unavailable", { exact: true }).first(),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("finance-account.png"),
    fullPage: true,
  });
  await page.goto(`/finance/transactions?accountId=${accountId}&new=true`);
  const dialog = page.getByRole("dialog", { name: "Add a manual exception" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Market groceries");
  await dialog
    .getByRole("textbox", { name: "Signed amount", exact: true })
    .fill("-125.50");
  await dialog
    .getByRole("combobox", { name: "Transaction role", exact: true })
    .selectOption("spending");
  await dialog
    .getByRole("textbox", {
      name: "Why is this entered manually?",
      exact: true,
    })
    .fill("Cash receipt from the market");
  await dialog
    .getByRole("button", { name: "Record exception", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("-125.50 DKK", { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search transactions", exact: true })
    .fill("Market groceries");
  await expect(page).toHaveURL(/q=Market\+groceries/);
  await expect(page.getByText("-125.50 DKK", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Market groceries/ }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Cash receipt from the market",
  );
  await expect(page.getByRole("dialog")).toContainText("manual");
  await page.screenshot({
    path: info.outputPath("finance-transaction.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Classify or correct", exact: true })
    .click();
  const correction = page.getByRole("dialog", {
    name: "Classify or correct",
    exact: true,
  });
  await correction
    .getByRole("textbox", { name: "Signed amount", exact: true })
    .fill("-120.25");
  await correction
    .getByRole("textbox", { name: "Reason for this correction", exact: true })
    .fill("Corrected receipt total");
  await correction
    .getByRole("button", { name: "Record correction", exact: true })
    .click();
  await expect(correction).toBeHidden();
  await expect(page.getByRole("dialog")).toContainText("-120.25 DKK");
  await page.keyboard.press("Escape");
  await page.goto(`/finance/accounts/${accountId}`);
  await expect(page.locator(".metric-grid")).toContainText("-120.25 DKK");
});
