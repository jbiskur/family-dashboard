import { readFileSync } from "node:fs";
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
test.use({ trace: "off", video: "off" });
async function login(page: Page) {
  const password = settings.TEST_USER_PASSWORD;
  if (!password) throw new Error("Local test login is not configured");
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("owner@heima.test");
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  await expect(page.locator("#main-content")).toBeVisible();
  const session = await page.request.get("/api/auth/session");
  expect(session.ok()).toBe(true);
  return (await session.json()).user.id as string;
}
async function account(page: Page) {
  const name = `Synthetic import ${crypto.randomUUID()}`;
  await page.goto("/finance/accounts");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Add an account",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Account name", exact: true })
    .fill(name);
  await dialog
    .getByRole("button", { name: "Add account", exact: true })
    .click();
  await expect(page).toHaveURL(/\/finance\/accounts\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").at(-1);
  if (!id) throw new Error("Account URL missing identity");
  await page.goto(`/finance/imports?accountId=${id}`);
  await expect(
    page.getByRole("heading", { name: "Statement imports", exact: true }),
  ).toBeVisible();
  return id;
}
async function facts(page: Page, actorId: string, accountId: string) {
  const response = await page.request.get(
    `/api/backend/finance/transactions?accountId=${accountId}&month=2035-04`,
    { headers: { "x-heima-actor-id": actorId } },
  );
  expect(response.status()).toBe(200);
  return response.json();
}
async function screenshot(page: Page, info: TestInfo, label: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  const path = info.outputPath(`${label}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(label, { path, contentType: "image/png" });
  const focus = label.includes("guidance")
    ? page.locator(".import-guidance")
    : label.includes("header-error")
      ? page.locator(".import-format")
      : label.includes("reconciled") || label.includes("needs-reconciliation")
        ? page.getByRole("dialog", {
            name: "Make the statement add up",
            exact: true,
          })
        : page.getByRole("heading", { name: "The review", exact: true });
  await focus.evaluate((element) =>
    element.scrollIntoView({ block: "start", behavior: "instant" }),
  );
  await page.evaluate(async () => {
    window.scrollBy(0, -100);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const viewportPath = info.outputPath(`${label}-viewport.png`);
  await page.screenshot({
    path: viewportPath,
    fullPage: false,
    animations: "disabled",
  });
  await info.attach(`${label}-viewport`, {
    path: viewportPath,
    contentType: "image/png",
  });
}
const revolutFile = (currency = "DKK") => ({
  name: "synthetic-revolut.csv",
  mimeType: "text/csv",
  buffer: Buffer.from(
    `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\nCARD_PAYMENT,Current,2035-04-15 23:59:59,2035-04-16 00:00:01,Groceries,-12.34,0.50,${currency},COMPLETED,\nCARD_PAYMENT,Current,2035-04-15 23:59:59,,Pending purchase,-20.00,0.00,${currency},PENDING,\nCARD_PAYMENT,Current,2035-04-15 23:59:59,,Reverted purchase,-30.00,0.00,${currency},REVERTED,\n`,
  ),
});

// 393e3d11-a251-45c7-9755-895554451e74 S1/S3/S4/S5. Synthetic fixtures only.
test("Revolut guidance reviews exclusions, currency and explicit fee treatment before importing", async ({
  page,
}, info) => {
  const actorId = await login(page);
  const accountId = await account(page);
  const before = await facts(page, actorId, accountId);
  await page
    .getByLabel("Statement from", { exact: true })
    .selectOption("revolut");
  await expect(
    page.getByRole("link", { name: "Revolut export help" }),
  ).toBeVisible();
  await screenshot(page, info, "revolut-guidance");
  await page.getByLabel("Choose a statement file").setInputFiles(revolutFile());
  await expect(page.getByLabel("Choose a statement file")).toHaveValue(
    /synthetic-revolut\.csv$/,
  );
  await expect(
    page.getByRole("combobox", { name: "Booking date", exact: true }),
  ).toHaveValue("Completed Date");
  await expect(
    page.getByRole("combobox", { name: "Row currency", exact: true }),
  ).toHaveValue("Currency");
  await page
    .getByRole("button", { name: "Validate this mapping", exact: true })
    .click();
  await expect(
    page.getByText("Row 2: Choose how nonzero fees affect the signed amount.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm import", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("2 rows excluded from import", { exact: true }),
  ).toBeVisible();
  await screenshot(page, info, "revolut-fee-review-required");
  await page
    .getByLabel("How fees affect the amount", { exact: true })
    .selectOption("subtract-positive");
  await page
    .getByRole("button", { name: "Validate this mapping", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm import", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "-12.84 DKK", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "2035-04-16", exact: true }),
  ).toBeVisible();
  expect(await facts(page, actorId, accountId)).toEqual(before);
  await screenshot(page, info, "revolut-normalized-confirmation");
  await page
    .getByLabel("How fees affect the amount", { exact: true })
    .selectOption("included");
  await expect(
    page.getByRole("button", { name: "Confirm import", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Validate this mapping", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "-12.34 DKK", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  await expect(
    page.getByText(
      "Statement imported. Review its rows and balances to finish reconciliation.",
      { exact: true },
    ),
  ).toBeVisible();
  await screenshot(page, info, "revolut-confirmed-needs-reconciliation");
  const written = await facts(page, actorId, accountId);
  expect(written.items).toHaveLength(1);
  expect(written.items[0].amount).toBe("-12.34");
  expect(written.items[0].reconciliationState).toBe("needs-review");
  const review = page.getByRole("dialog", {
    name: "Make the statement add up",
    exact: true,
  });
  await review
    .getByRole("textbox", { name: "Statement opening balance", exact: true })
    .fill("0.00");
  await review
    .getByRole("textbox", { name: "Statement closing balance", exact: true })
    .fill("-12.34");
  await review
    .getByRole("button", { name: "Check & reconcile", exact: true })
    .click();
  await expect(
    review.getByRole("heading", { name: "All accounted for.", exact: true }),
  ).toBeVisible();
  expect(
    (await facts(page, actorId, accountId)).items[0].reconciliationState,
  ).toBe("reconciled");
  await screenshot(page, info, "revolut-historical-statement-reconciled");
  await page
    .getByRole("button", { name: "Back to statements", exact: true })
    .click();
  await page
    .getByLabel("Statement from", { exact: true })
    .selectOption("revolut");
  await page
    .getByLabel("Choose a statement file")
    .setInputFiles(revolutFile("EUR"));
  await page
    .getByLabel("How fees affect the amount", { exact: true })
    .selectOption("included");
  await page
    .getByRole("button", { name: "Validate this mapping", exact: true })
    .click();
  await expect(
    page.getByText(/Row 2: Row currency must match the selected DKK account/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm import", exact: true }),
  ).toHaveCount(0);
  await screenshot(page, info, "revolut-currency-mismatch");
});

// S2/S4/S5 includes the PRD minimum 320 CSS pixels and keyboard activation.
test("Faroese-style headers recover without uploading again at 320px", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const actorId = await login(page);
  const accountId = await account(page);
  const before = await facts(page, actorId, accountId);
  await page
    .getByLabel("Statement from", { exact: true })
    .selectOption("faroese");
  await page.getByLabel("Choose a statement file").setInputFiles({
    name: "synthetic-faroese.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      '\nStatement report\n\nDagfesting;Upphædd;Tekstur\n15-04-2035;-1.234,56;"Mjólk, breyð"\n',
    ),
  });
  await expect(
    page.getByText(/Choose a header row with unique, non-empty column names/),
  ).toBeVisible();
  await screenshot(page, info, "faroese-header-error-320");
  await page
    .getByRole("spinbutton", { name: "Header row", exact: true })
    .fill("4");
  const reread = page.getByRole("button", {
    name: "Read with these settings",
    exact: true,
  });
  await reread.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("combobox", { name: "Booking date", exact: true }),
  ).toHaveValue("Dagfesting");
  await page
    .getByRole("button", { name: "Validate this mapping", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm import", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "-1234.56 DKK", exact: true }),
  ).toBeVisible();
  expect(await facts(page, actorId, accountId)).toEqual(before);
  await screenshot(page, info, "faroese-normalized-320");
  await page
    .getByRole("combobox", { name: "Date format", exact: true })
    .selectOption("yyyy-MM-dd");
  await expect(
    page.getByRole("button", { name: "Confirm import", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Validate this mapping", exact: true })
    .click();
  await expect(
    page.getByText("Row 5: Date does not match the selected interpretation", {
      exact: true,
    }),
  ).toBeVisible();
  await screenshot(page, info, "faroese-date-error-320");
  expect(await facts(page, actorId, accountId)).toEqual(before);
});
