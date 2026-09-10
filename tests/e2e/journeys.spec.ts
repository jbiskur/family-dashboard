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
test("shopping create, complete, history and undo survive navigation", async ({
  page,
}, info) => {
  await login(page);
  const name = `Weekly shop ${crypto.randomUUID()}`;
  await page.goto("/shopping");
  await page.getByRole("button", { name: "New list", exact: true }).click();
  await page
    .getByRole("textbox", { name: "List name", exact: true })
    .fill(name);
  await page.getByRole("button", { name: "Create list", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page
    .getByRole("combobox", { name: "What do we need?", exact: true })
    .fill("Fresh bread");
  await page.getByLabel("Quantity or amount").fill("2 loaves");
  await page.getByRole("button", { name: "Add shopping", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Complete Fresh bread" }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("shopping-list.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Complete Fresh bread", exact: true })
    .click();
  await expect(page.locator(".notice")).toContainText(
    "One less thing to pick up.",
  );
  if (await page.getByRole("dialog").isVisible())
    await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Picked up/ }).click();
  await expect(
    page.getByRole("button", { name: "Reopen Fresh bread" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "History of Fresh bread" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    /completed|changed|updated/i,
  );
  await page.screenshot({
    path: info.outputPath("shopping-history.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Reopen Fresh bread" }).click();
  await expect(
    page.getByRole("button", { name: "Reopen Fresh bread" }),
  ).toBeHidden();
  await page.getByRole("button", { name: /^To pick up/ }).click();
  await expect(
    page.getByRole("button", { name: "Complete Fresh bread" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Complete Fresh bread" }),
  ).toBeVisible();
});

test("household task goes from creation through progress to done", async ({
  page,
}, info) => {
  await login(page);
  const title = `Water the plants ${crypto.randomUUID()}`;
  await page.goto("/work");
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page
    .getByRole("combobox", { name: "What needs doing?", exact: true })
    .fill(title);
  await page.getByText("More details & options", { exact: true }).click();
  await page
    .getByLabel("A helpful note", { exact: true })
    .fill("Check the kitchen herbs too.");
  await page.getByRole("button", { name: "Add to-do", exact: true }).click();
  await page
    .getByRole("button", { name: `Details ${title}`, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "In progress", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").locator(".detail-value").last(),
  ).toHaveText("In progress");
  await page.screenshot({
    path: info.outputPath("work-detail.png"),
    fullPage: true,
  });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page
      .getByRole("region", { name: "Done", exact: true })
      .getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("work-board.png"),
    fullPage: true,
  });
});
