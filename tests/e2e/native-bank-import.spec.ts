import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
  annualRevolut,
  bookingsRows,
  csvText,
  detailsRows,
} from "../fixtures/bank-statements";

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
const observationOrigin =
  process.env.HEIMA_BROWSER_ORIGIN ?? "http://localhost:3010";
async function login(page: Page, waitForWorker = true) {
  const password = settings.TEST_USER_PASSWORD;
  if (!password) throw new Error("Local test login is not configured");
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("owner@heima.test");
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  await expect(page.locator("#main-content")).toBeVisible();
  if (observationOrigin !== "http://localhost:3010") {
    await page.goto(`${observationOrigin}/`);
    await expect(page.locator("#main-content")).toBeVisible();
    if (waitForWorker)
      await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
  }
  const session = await page.request.get(
    `${observationOrigin}/api/auth/session`,
  );
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
async function shot(page: Page, info: TestInfo, label: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  const path = info.outputPath(`${label}.png`);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  await info.attach(label, { path, contentType: "image/png" });
}
async function layout(page: Page, value: string) {
  const format = page.locator(".import-format");
  if (!(await format.evaluate((el) => el.hasAttribute("open"))))
    await format.locator("summary").click();
  await page
    .getByRole("combobox", { name: "Statement layout", exact: true })
    .selectOption(value);
  await page
    .getByRole("button", { name: "Read with these settings", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Booking date", exact: true }),
  ).toHaveValue(value === "faroese-details" ? "Column 9" : "Column 1");
}
async function validate(page: Page) {
  await page
    .getByRole("button", { name: "Validate this mapping", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm import", exact: true }),
  ).toBeVisible();
}
async function upload(page: Page, name: string, text: string) {
  await page
    .getByLabel("Choose a statement file")
    .setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(text) });
}
async function reviewFocus(page: Page) {
  await page
    .getByRole("heading", { name: "The review", exact: true })
    .evaluate((el) =>
      el.scrollIntoView({ block: "start", behavior: "instant" }),
    );
  await page.evaluate(() => window.scrollBy(0, -24));
}

// Issue 25f5be41-3819-4312-a42e-da3f3b044397: fictional values only.
test("405-row Faroese bookings preserve first row through whole-statement confirmation and reconciliation", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const actorId = await login(page);
  const accountId = await account(page);
  await page
    .getByLabel("Statement from", { exact: true })
    .selectOption("faroese");
  await upload(page, "fictional-bookings-405.csv", csvText(bookingsRows()));
  await layout(page, "faroese-bookings");
  await expect(page.locator(".import-guidance")).toContainText(
    "Choose either the bookings export or payment-details export",
  );
  await shot(page, info, "bookings-layout");
  await validate(page);
  await expect(
    page
      .getByRole("cell", {
        name: "Fictional purchase 1 — mjólk, breyð",
        exact: true,
      })
      .last(),
  ).toBeVisible();
  expect((await facts(page, actorId, accountId)).items).toHaveLength(0);
  await reviewFocus(page);
  await shot(page, info, "bookings-405-ready");
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "Make the statement add up",
    exact: true,
  });
  await expect(review).toBeVisible({ timeout: 30000 });
  expect((await facts(page, actorId, accountId)).items).toHaveLength(405);
  await shot(page, info, "bookings-405-confirmed");
  await review
    .getByRole("textbox", { name: "Statement opening balance", exact: true })
    .fill("5000.00");
  await review
    .getByRole("textbox", { name: "Statement closing balance", exact: true })
    .fill("4595.00");
  await review
    .getByRole("button", { name: "Check & reconcile", exact: true })
    .click();
  await expect(
    review.getByRole("heading", { name: "All accounted for.", exact: true }),
  ).toBeVisible({ timeout: 30000 });
  expect(
    (await facts(page, actorId, accountId)).items.every(
      (r: { reconciliationState: string }) =>
        r.reconciliationState === "reconciled",
    ),
  ).toBe(true);
  await shot(page, info, "bookings-405-reconciled");
});

test("payment-details layout recovers all 405 rows at 320px without creating financial facts", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const actorId = await login(page);
  const accountId = await account(page);
  await page
    .getByLabel("Statement from", { exact: true })
    .selectOption("faroese");
  await upload(page, "fictional-details-405.csv", csvText(detailsRows()));
  await expect(page.locator(".import-format [role=alert]")).toBeVisible();
  await page
    .locator(".import-format [role=alert]")
    .evaluate((el) =>
      el.scrollIntoView({ block: "center", behavior: "instant" }),
    );
  await shot(page, info, "details-header-error-320");
  await layout(page, "faroese-details");
  await validate(page);
  await reviewFocus(page);
  await shot(page, info, "details-405-ready-320");
  expect((await facts(page, actorId, accountId)).items).toHaveLength(0);
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
    page.getByText("Row 1: Date does not match the selected interpretation", {
      exact: true,
    }),
  ).toBeVisible();
  await reviewFocus(page);
  await shot(page, info, "details-date-error-320");
  expect((await facts(page, actorId, accountId)).items).toHaveLength(0);
});

test("annual Revolut reviews 1198 records and six exclusions before confirming 1192 transactions", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const actorId = await login(page);
  const accountId = await account(page);
  await page
    .getByLabel("Statement from", { exact: true })
    .selectOption("revolut");
  await upload(page, "fictional-revolut-1198.csv", annualRevolut());
  await expect(
    page.getByRole("combobox", { name: "Booking date", exact: true }),
  ).toHaveValue("Completed Date");
  await page
    .getByRole("button", { name: "Validate this mapping", exact: true })
    .click();
  await expect(
    page.getByText("Row 2: Choose how nonzero fees affect the signed amount.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("6 rows excluded from import", { exact: true }),
  ).toBeVisible();
  await reviewFocus(page);
  await expect(page.getByText(/1,198 source rows checked/)).toBeVisible();
  await shot(page, info, "annual-revolut-fee-required");
  await page
    .getByLabel("How fees affect the amount", { exact: true })
    .selectOption("subtract-positive");
  await validate(page);
  await expect(
    page.getByText("1,198 source rows checked · 1,192 eligible · 6 excluded", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "-1.50 DKK", exact: true }),
  ).toBeVisible();
  const next = page.getByRole("button", {
    name: "Next included rows page",
    exact: true,
  });
  await page
    .getByRole("button", { name: "Last included rows page", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "Fictional purchase 1192", exact: true }),
  ).toBeVisible();
  await expect(next).toBeDisabled();
  expect((await facts(page, actorId, accountId)).items).toHaveLength(0);
  await reviewFocus(page);
  await shot(page, info, "annual-revolut-1192-ready");
  await page
    .getByRole("cell", { name: "Fictional purchase 1192", exact: true })
    .scrollIntoViewIfNeeded();
  await page
    .getByRole("navigation", { name: "Included rows pages", exact: true })
    .scrollIntoViewIfNeeded();
  await shot(page, info, "annual-revolut-last-row");
  const paginationAudit = await new AxeBuilder({ page })
    .include(".statement-pagination")
    .withRules(["color-contrast"])
    .analyze();
  expect(paginationAudit.violations).toEqual([]);
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "Make the statement add up",
    exact: true,
  });
  await expect(review).toBeVisible({ timeout: 30000 });
  const written = (await facts(page, actorId, accountId)).items;
  expect(written).toHaveLength(1192);
  expect(
    written.filter((r: { amount: string }) => r.amount === "-1.50"),
  ).toHaveLength(1);
  await shot(page, info, "annual-revolut-1192-confirmed");
});

// Playwright page.route cannot intercept service-worker-owned requests. This
// test blocks SW only to lose a real server-action response after it commits;
// normal import journeys above retain the application service worker.
test.describe("uncertain statement responses", () => {
  test.use({ serviceWorkers: "block" });
  test("lost confirm and reconcile responses retry the same whole statement", async ({
    page,
  }, info) => {
    test.setTimeout(180000);
    const actorId = await login(page, false);
    const accountId = await account(page);
    await page
      .getByLabel("Statement from", { exact: true })
      .selectOption("faroese");
    await upload(page, "fictional-retry-bookings.csv", csvText(bookingsRows()));
    await layout(page, "faroese-bookings");
    await validate(page);
    let dropNext = true;
    let deliveredResponses = 0;
    await page.route(/\/finance\/imports(?:\?.*)?$/, async (route) => {
      if (
        dropNext &&
        route.request().method() === "POST" &&
        route.request().headers()["next-action"]
      ) {
        dropNext = false;
        const response = await route.fetch();
        if (!response.ok())
          throw new Error(
            `Expected successful real action before losing response, got ${response.status()}`,
          );
        deliveredResponses++;
        await route.abort("failed");
      } else await route.continue();
    });
    await page
      .getByRole("button", { name: "Confirm import", exact: true })
      .click();
    await expect(
      page.getByText(/Confirmation has not been verified yet/),
    ).toBeVisible({ timeout: 30000 });
    expect(deliveredResponses).toBe(1);
    expect((await facts(page, actorId, accountId)).items).toHaveLength(405);
    await expect(
      page.getByLabel("Statement from", { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Confirm import", exact: true }),
    ).toBeDisabled();
    await page
      .locator(".import-recovery")
      .evaluate((el) =>
        el.scrollIntoView({ block: "center", behavior: "instant" }),
      );
    await shot(page, info, "confirm-response-lost");
    await page.context().setOffline(true);
    await expect(
      page.getByRole("heading", {
        name: "Finance needs a connection",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry confirmation", exact: true }),
    ).toHaveCount(0);
    await page.context().setOffline(false);
    await expect(
      page.getByText(/Confirmation has not been verified yet/),
    ).toBeVisible();
    await expect(
      page.getByLabel("Statement from", { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Confirm import", exact: true }),
    ).toBeDisabled();
    await page.route("**/api/backend/commands/*", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "rate-limited", message: "Please try again shortly." },
        }),
      }),
    );
    await page
      .getByRole("button", { name: "Retry confirmation", exact: true })
      .click();
    await expect(
      page.getByText("Please try again shortly.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Statement from", { exact: true }),
    ).toBeDisabled();
    await page.unroute("**/api/backend/commands/*");
    await page
      .getByRole("button", { name: "Retry confirmation", exact: true })
      .click();
    const review = page.getByRole("dialog", {
      name: "Make the statement add up",
      exact: true,
    });
    await expect(review).toBeVisible({ timeout: 30000 });
    const importsResponse = await page.request.get(
      "/api/backend/finance/imports",
      { headers: { "x-heima-actor-id": actorId } },
    );
    const statements = (await importsResponse.json()).items.filter(
      (s: { accountId: string }) => s.accountId === accountId,
    );
    expect(statements).toHaveLength(1);
    const statementId = statements[0].id;
    const history = async () =>
      (
        await (
          await page.request.get(
            `/api/backend/finance/imports/${statementId}/history`,
            { headers: { "x-heima-actor-id": actorId } },
          )
        ).json()
      ).items;
    expect(await history()).toHaveLength(1);
    expect((await facts(page, actorId, accountId)).items).toHaveLength(405);
    await review
      .getByRole("textbox", { name: "Statement opening balance", exact: true })
      .fill("5000.00");
    await review
      .getByRole("textbox", { name: "Statement closing balance", exact: true })
      .fill("4595.00");
    dropNext = true;
    await review
      .getByRole("button", { name: "Check & reconcile", exact: true })
      .click();
    await expect(
      review.getByText(/Confirmation has not been verified yet/),
    ).toBeVisible({ timeout: 30000 });
    expect(deliveredResponses).toBe(2);
    expect(
      (await facts(page, actorId, accountId)).items.every(
        (r: { reconciliationState: string }) =>
          r.reconciliationState === "reconciled",
      ),
    ).toBe(true);
    await expect(
      review.getByRole("textbox", {
        name: "Statement closing balance",
        exact: true,
      }),
    ).toHaveValue("4595.00");
    await expect(
      review.getByRole("textbox", {
        name: "Statement closing balance",
        exact: true,
      }),
    ).toBeDisabled();
    await page
      .locator(".import-recovery")
      .evaluate((el) =>
        el.scrollIntoView({ block: "center", behavior: "instant" }),
      );
    await shot(page, info, "reconcile-response-lost");
    await review
      .getByRole("button", { name: "Retry confirmation", exact: true })
      .click();
    await expect(
      review.getByRole("heading", { name: "All accounted for.", exact: true }),
    ).toBeVisible({ timeout: 30000 });
    expect(await history()).toHaveLength(2);
    expect((await facts(page, actorId, accountId)).items).toHaveLength(405);
    await shot(page, info, "same-statement-recovered");
  });
});
