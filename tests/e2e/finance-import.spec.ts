import { readFileSync } from "node:fs";
import { expect, type Page, type Route, test } from "@playwright/test";

const settings = Object.fromEntries(
  readFileSync(".env.test.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
  const actorId = (await session.json()).user.id as string;
  expect(actorId).toMatch(uuid);
  return actorId;
}
async function read<T>(page: Page, actorId: string, path: string): Promise<T> {
  const response = await page.request.get(`/api/backend/${path}`, {
    headers: { "x-heima-actor-id": actorId },
  });
  expect(response.status(), path).toBe(200);
  return response.json();
}
async function createAccount(page: Page, name: string) {
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
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/finance\/accounts\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").at(-1);
  expect(id).toMatch(uuid);
  if (!id) throw new Error("Account URL is missing its identity");
  return id;
}
async function mapStatement(page: Page) {
  for (const [label, column] of [
    ["Booking date", "Booked"],
    ["Signed amount", "Amount"],
    ["Description", "Memo"],
    ["Source transaction ID", "Source"],
    ["Transaction date", "Occurred"],
    ["Value date", "Valued"],
    ["Reference", "Reference"],
  ]) {
    if (!label || !column) throw new Error("Missing mapping field");
    await page
      .getByRole("combobox", { name: label, exact: true })
      .selectOption(column);
  }
  await page
    .getByRole("button", { name: "Validate this mapping", exact: true })
    .click();
}
type Transaction = {
  id: string;
  amount: string;
  bookingDate: string;
  transactionDate: string | null;
  valueDate: string | null;
  sourceId: string;
  source: string;
  reference: string;
  reconciliationState: string;
  description: string;
};
type Import = {
  id: string;
  status: string;
  rows: { description: string; explanation: string; status: string }[];
  difference?: string;
};

function statementFile(label: string) {
  const date = new Date().toISOString().slice(0, 10);
  return {
    name: `${label}-${crypto.randomUUID()}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(
      `Booked,Amount,Memo,Source,Occurred,Valued,Reference\n${date},12.34,${label},${crypto.randomUUID()},${date},${date},BANK\n`,
    ),
  };
}

// Hold the real Server Action response at the browser's network boundary.
// No application imports, invented preview body, or custom backend fixture.
async function holdPreview(page: Page, fileName: string, mapped = false) {
  let captured = false;
  let released = false;
  let failed = false;
  let finished = false;
  let resume = () => {};
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const handler = async (route: Route) => {
    const request = route.request();
    const body = request.postData() ?? "";
    if (
      request.method() !== "POST" ||
      !body.includes("/v1/finance/imports/preview") ||
      !body.includes(fileName) ||
      body.includes('"mapping"') !== mapped ||
      captured
    ) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    captured = true;
    await held;
    if (failed) await route.abort("failed");
    else await route.fulfill({ response });
    finished = true;
  };
  await page.route("**/finance/imports**", handler);
  return {
    wait: () => expect.poll(() => captured).toBe(true),
    async release(fail = false) {
      failed = fail;
      released = true;
      resume();
      await expect.poll(() => finished).toBe(true);
    },
    async cleanup() {
      if (!released) {
        resume();
        if (captured) await expect.poll(() => finished).toBe(true);
      }
      await page.unroute("**/finance/imports**", handler);
    },
  };
}

test.describe("statement replacement timing", () => {
  // Playwright cannot route service-worker-owned requests. These six timing
  // tests hold real HTTP responses; the remaining journeys retain the PWA.
  test.use({ serviceWorkers: "block" });

  test("statement replacement immediately removes the previous confirmation while loading", async ({
    page,
  }, info) => {
    await login(page);
    const accountId = await createAccount(
      page,
      `Replacement ${crypto.randomUUID()}`,
    );
    const previous = statementFile("Previous statement");
    const replacement = statementFile("Current statement");
    await page.goto(`/finance/imports?accountId=${accountId}`);
    const upload = page.getByLabel("Choose a statement file");
    await upload.setInputFiles(previous);
    await mapStatement(page);
    await expect(
      page.getByRole("heading", { name: "Ready for your confirmation" }),
    ).toBeVisible();
    const checking = await holdPreview(page, previous.name, true);
    try {
      await mapStatement(page);
      await checking.wait();
      await expect(
        page.getByRole("button", { name: "Confirm import", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByText("Checking your mapping…", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath("mapping-check-pending.png"),
        fullPage: true,
      });
      await checking.release();
      await expect(
        page.getByRole("heading", { name: "Ready for your confirmation" }),
      ).toBeVisible();
    } finally {
      await checking.cleanup();
    }
    const delayed = await holdPreview(page, replacement.name);
    try {
      await upload.setInputFiles(replacement);
      await delayed.wait();
      await expect(
        page.getByRole("button", { name: "Confirm import", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: "Validate this mapping",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        page.getByText("Reading your statement…", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: info.outputPath("replacement-loading.png"),
        fullPage: true,
      });
      await delayed.release();
      await expect(
        page.getByRole("heading", { name: "Map your columns first" }),
      ).toBeVisible();
      await expect(
        page.getByRole("combobox", { name: "Booking date", exact: true }),
      ).toHaveValue("");
      await page.screenshot({
        path: info.outputPath("replacement-needs-mapping.png"),
        fullPage: true,
      });
    } finally {
      await delayed.cleanup();
    }
  });

  for (const pending of ["read", "mapping"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      test(`statement replacement ignores an older ${pending} ${outcome} without ending current loading`, async ({
        page,
      }, info) => {
        const actorId = await login(page);
        const accountId = await createAccount(
          page,
          `Ordered ${crypto.randomUUID()}`,
        );
        const previous = statementFile("Older source");
        const current = statementFile("Current source");
        await page.goto(`/finance/imports?accountId=${accountId}`);
        const upload = page.getByLabel("Choose a statement file");
        if (pending === "mapping") {
          await upload.setInputFiles(previous);
          await expect(
            page.getByRole("combobox", { name: "Booking date", exact: true }),
          ).toBeVisible();
        }
        const older = await holdPreview(
          page,
          previous.name,
          pending === "mapping",
        );
        const newer = await holdPreview(page, current.name);
        try {
          if (pending === "mapping") await mapStatement(page);
          else await upload.setInputFiles(previous);
          await older.wait();
          await upload.setInputFiles(current);
          await expect(
            page.getByText("Reading your statement…", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", {
              name: "Validate this mapping",
              exact: true,
            }),
          ).toHaveCount(0);
          // Server Actions dispatch sequentially: the current intent precedes
          // the older completion, while its request waits in the client queue.
          await older.release(outcome === "failure");
          await newer.wait();
          await expect(
            page.getByText("Reading your statement…", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("button", { name: "Confirm import", exact: true }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("button", {
              name: "Validate this mapping",
              exact: true,
            }),
          ).toHaveCount(0);
          await expect(
            page.locator("#main-content").getByRole("alert"),
          ).toHaveCount(0);
          await page.screenshot({
            path: info.outputPath(`late-${pending}-${outcome}-ignored.png`),
            fullPage: true,
          });
          await newer.release();
          await expect(
            page.getByRole("heading", { name: current.name, exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("cell", { name: "Current source", exact: true }),
          ).toBeVisible();
          await expect(
            page.getByRole("cell", { name: "Older source", exact: true }),
          ).toHaveCount(0);
          await expect(
            page.getByRole("combobox", { name: "Booking date", exact: true }),
          ).toHaveValue("");
          await mapStatement(page);
          await expect(
            page.getByRole("heading", { name: "Ready for your confirmation" }),
          ).toBeVisible();
          expect(
            (
              await read<{ items: Import[] }>(
                page,
                actorId,
                `finance/imports?accountId=${accountId}`,
              )
            ).items,
          ).toHaveLength(0);
          expect(
            (
              await read<{ items: Transaction[] }>(
                page,
                actorId,
                `finance/transactions?accountId=${accountId}`,
              )
            ).items,
          ).toHaveLength(0);
          await page.screenshot({
            path: info.outputPath(`current-after-${pending}-${outcome}.png`),
            fullPage: true,
          });
        } finally {
          await older.cleanup();
          await newer.cleanup();
        }
      });
    }
  }

  test("statement replacement rejects files safely and invalidates pending work on account change", async ({
    page,
  }, info) => {
    const actorId = await login(page);
    const firstAccount = await createAccount(
      page,
      `First account ${crypto.randomUUID()}`,
    );
    const secondAccount = await createAccount(
      page,
      `Second account ${crypto.randomUUID()}`,
    );
    await page.goto(`/finance/imports?accountId=${firstAccount}`);
    const upload = page.getByLabel("Choose a statement file");
    for (const rejected of [
      {
        name: "unsupported.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("not a statement"),
        message: "Choose a CSV, XLS or XLSX statement.",
      },
      {
        name: "oversized.csv",
        mimeType: "text/csv",
        buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
        message: "Choose a statement smaller than 10 MB.",
      },
    ]) {
      await upload.setInputFiles(statementFile("Reviewed source"));
      await mapStatement(page);
      await expect(
        page.getByRole("heading", { name: "Ready for your confirmation" }),
      ).toBeVisible();
      await upload.setInputFiles({
        name: rejected.name,
        mimeType: rejected.mimeType,
        buffer: rejected.buffer,
      });
      await expect(
        page.locator("#main-content").getByRole("alert"),
      ).toContainText(rejected.message);
      await expect(
        page.getByRole("button", { name: "Confirm import", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: "Validate this mapping",
          exact: true,
        }),
      ).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath(`rejected-${rejected.name}.png`),
        fullPage: true,
      });
    }
    for (const pending of ["read", "mapping"] as const) {
      const file = statementFile(`Account ${pending}`);
      if (pending === "mapping") {
        await upload.setInputFiles(file);
        await expect(
          page.getByRole("combobox", { name: "Booking date", exact: true }),
        ).toBeVisible();
      }
      const delayed = await holdPreview(page, file.name, pending === "mapping");
      try {
        if (pending === "mapping") await mapStatement(page);
        else await upload.setInputFiles(file);
        await delayed.wait();
        await page
          .getByRole("combobox", {
            name: "Account for this statement",
            exact: true,
          })
          .selectOption(pending === "read" ? secondAccount : firstAccount);
        await delayed.release();
        await expect(
          page.getByRole("heading", { name: "Your statement has a home here" }),
        ).toBeVisible();
        await expect(
          page.getByText("Reading your statement…", { exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", {
            name: "Validate this mapping",
            exact: true,
          }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Confirm import", exact: true }),
        ).toHaveCount(0);
        await page.screenshot({
          path: info.outputPath(`account-change-${pending}.png`),
          fullPage: true,
        });
      } finally {
        await delayed.cleanup();
      }
    }
    const failedFile = statementFile("Unavailable preview");
    const failed = await holdPreview(page, failedFile.name);
    try {
      await upload.setInputFiles(failedFile);
      await failed.wait();
      await failed.release(true);
      await expect(
        page.locator("#main-content").getByRole("alert"),
      ).toBeVisible();
      await expect(
        page.getByText("Reading your statement…", { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Confirm import", exact: true }),
      ).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath("current-preview-failed.png"),
        fullPage: true,
      });
    } finally {
      await failed.cleanup();
    }
    await upload.setInputFiles(statementFile("Recovered source"));
    await mapStatement(page);
    await expect(
      page.getByRole("heading", { name: "Ready for your confirmation" }),
    ).toBeVisible();
    await expect(page.locator("#main-content").getByRole("alert")).toHaveCount(
      0,
    );
    for (const accountId of [firstAccount, secondAccount]) {
      expect(
        (
          await read<{ items: Import[] }>(
            page,
            actorId,
            `finance/imports?accountId=${accountId}`,
          )
        ).items,
      ).toHaveLength(0);
      expect(
        (
          await read<{ items: Transaction[] }>(
            page,
            actorId,
            `finance/transactions?accountId=${accountId}`,
          )
        ).items,
      ).toHaveLength(0);
    }
    await page.screenshot({
      path: info.outputPath("preview-recovered.png"),
      fullPage: true,
    });
  });
});

test("statement preview writes nothing, invalid mapping stays blocked, and reviewed rows require an exact zero reconciliation", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const actorId = await login(page);
  const accountId = await createAccount(
    page,
    `Statement account ${crypto.randomUUID()}`,
  );
  const date = new Date().toISOString().slice(0, 10);
  const incomeId = crypto.randomUUID();
  const expenseId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const header = "Booked,Amount,Memo,Source,Occurred,Valued,Reference\n";
  const valid =
    header +
    `${date},100.00,Household deposit,${incomeId},${date},${date},BANK-IN\n${date},-12.34,Market receipt,${expenseId},${date},${date},BANK-OUT\n`;
  await page.goto(`/finance/imports?accountId=${accountId}`);
  await page.getByLabel("Choose a statement file").setInputFiles({
    name: `invalid-${fileId}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(valid.replace("-12.34", "uncertain")),
  });
  await expect(
    page.getByRole("heading", { name: "Tell us which column is which" }),
  ).toBeVisible();
  await mapStatement(page);
  await expect(
    page.getByRole("alert").filter({ hasText: /validation/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm import", exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await read<{ items: Transaction[] }>(
        page,
        actorId,
        `finance/transactions?accountId=${accountId}`,
      )
    ).items,
  ).toHaveLength(0);
  await page.screenshot({
    path: info.outputPath("import-invalid-source.png"),
    fullPage: true,
  });
  await page.getByLabel("Choose a statement file").setInputFiles({
    name: `statement-${fileId}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(valid),
  });
  await mapStatement(page);
  await expect(
    page.getByRole("heading", { name: "Ready for your confirmation" }),
  ).toBeVisible();
  expect(
    (
      await read<{ items: Transaction[] }>(
        page,
        actorId,
        `finance/transactions?accountId=${accountId}`,
      )
    ).items,
  ).toHaveLength(0);
  expect(
    (
      await read<{ items: Import[] }>(
        page,
        actorId,
        `finance/imports?accountId=${accountId}`,
      )
    ).items,
  ).toHaveLength(0);
  await page.screenshot({
    path: info.outputPath("import-mapped-preview.png"),
    fullPage: true,
  });
  await page
    .getByRole("textbox", {
      name: "Statement opening balance (optional)",
      exact: true,
    })
    .fill("0.00");
  await page
    .getByRole("textbox", {
      name: "Statement closing balance (optional)",
      exact: true,
    })
    .fill("87.66");
  await page
    .getByRole("button", { name: "Confirm import", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "Make the statement add up",
    exact: true,
  });
  await expect(review).toBeVisible();
  const batches = (
    await read<{ items: Import[] }>(
      page,
      actorId,
      `finance/imports?accountId=${accountId}`,
    )
  ).items;
  expect(batches).toHaveLength(1);
  const batch = batches[0];
  if (!batch) throw new Error("Confirmed import is missing");
  expect(batch.status).toBe("needs-review");
  expect(batch.rows.map((item) => item.description)).toEqual([
    "Household deposit",
    "Market receipt",
  ]);
  expect(
    (
      await read<{ balance: string | null }>(
        page,
        actorId,
        `finance/accounts/${accountId}`,
      )
    ).balance,
  ).toBeNull();
  await review
    .getByRole("row")
    .filter({ hasText: "Market receipt" })
    .getByRole("button", { name: "matched", exact: true })
    .click();
  const row = page.getByRole("dialog", {
    name: "Review this source row",
    exact: true,
  });
  await row
    .getByRole("combobox", { name: "Resolution", exact: true })
    .selectOption("explained");
  await row.getByRole("button", { name: "Apply review", exact: true }).click();
  await expect(row.getByRole("alert")).toContainText(
    "Explain why this source row is accounted for",
  );
  await row
    .getByRole("textbox", { name: "Explanation / evidence", exact: true })
    .fill("Checked against the original bank receipt BANK-OUT");
  await row.getByRole("button", { name: "Apply review", exact: true }).click();
  await expect(row).toBeHidden();
  await expect(
    review.getByRole("row").filter({ hasText: "Market receipt" }),
  ).toContainText("explained");
  await review
    .getByRole("button", { name: "Check & reconcile", exact: true })
    .click();
  await expect(review.getByRole("alert")).toBeVisible();
  expect(
    (await read<Import>(page, actorId, `finance/imports/${batch.id}`)).status,
  ).toBe("needs-review");
  expect(
    (
      await read<{ balance: string | null }>(
        page,
        actorId,
        `finance/accounts/${accountId}`,
      )
    ).balance,
  ).toBeNull();
  await page.screenshot({
    path: info.outputPath("import-nonzero-rejected.png"),
    fullPage: true,
  });
  await review
    .getByRole("row")
    .filter({ hasText: "Market receipt" })
    .getByRole("button")
    .click();
  await row
    .getByRole("combobox", { name: "Resolution", exact: true })
    .selectOption("matched");
  await row.getByRole("button", { name: "Apply review", exact: true }).click();
  await expect(row).toBeHidden();
  await review
    .getByRole("button", { name: "Check & reconcile", exact: true })
    .click();
  await expect(
    review.getByRole("heading", { name: "All accounted for.", exact: true }),
  ).toBeVisible();
  const reconciled = await read<Import>(
    page,
    actorId,
    `finance/imports/${batch.id}`,
  );
  expect(reconciled.status).toBe("reconciled");
  expect(
    reconciled.rows.find((item) => item.description === "Market receipt")
      ?.explanation,
  ).toBe("Checked against the original bank receipt BANK-OUT");
  expect(
    (
      await read<{ balance: string | null }>(
        page,
        actorId,
        `finance/accounts/${accountId}`,
      )
    ).balance,
  ).toBe("87.66");
  const transactions = (
    await read<{ items: Transaction[] }>(
      page,
      actorId,
      `finance/transactions?accountId=${accountId}`,
    )
  ).items;
  expect(transactions).toHaveLength(2);
  expect(
    transactions.find((item) => item.sourceId === expenseId),
  ).toMatchObject({
    amount: "-12.34",
    bookingDate: date,
    transactionDate: date,
    valueDate: date,
    source: "import",
    reference: "BANK-OUT",
    reconciliationState: "reconciled",
  });
  await page.screenshot({
    path: info.outputPath("import-zero-reconciled.png"),
    fullPage: true,
  });
  await review
    .getByRole("button", { name: "Back to statements", exact: true })
    .click();
  await page.reload();
  await expect(
    page.locator(".import-row").filter({ hasText: `statement-${fileId}.csv` }),
  ).toContainText("Reconciled");
});

test("category hierarchy and budget edits preserve exact actuals, deliberate zero, and archive history", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const actorId = await login(page);
  const suffix = crypto.randomUUID();
  const parentName = `Essentials ${suffix}`;
  const childName = `Food ${suffix}`;
  const renamed = `Groceries ${suffix}`;
  const month = new Date().toISOString().slice(0, 7);
  await page.goto(`/finance/budgets?month=${month}`);
  await page
    .getByRole("button", { name: "Manage categories", exact: true })
    .click();
  const manager = page.getByRole("dialog", {
    name: "Your household categories",
    exact: true,
  });
  async function addCategory(name: string, parent?: string) {
    await manager
      .getByRole("button", { name: "Add category", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "A new category",
      exact: true,
    });
    await dialog
      .getByRole("textbox", { name: "Category name", exact: true })
      .fill(name);
    if (parent)
      await dialog
        .getByRole("combobox", { name: "Parent category", exact: true })
        .selectOption({ label: parent });
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(manager.getByText(name, { exact: true })).toBeVisible();
  }
  await addCategory(parentName);
  await addCategory(childName, parentName);
  await manager
    .getByRole("button", { name: `Edit ${childName}`, exact: true })
    .click();
  const rename = page.getByRole("dialog", {
    name: "Update category",
    exact: true,
  });
  await rename
    .getByRole("textbox", { name: "Category name", exact: true })
    .fill(renamed);
  await rename.getByRole("button", { name: "Save", exact: true }).click();
  await expect(rename).toBeHidden();
  await expect(manager.getByText(renamed, { exact: true })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("categories-two-level-renamed.png"),
    fullPage: true,
  });
  const categories = (
    await read<{
      items: { id: string; name: string; parentId: string | null }[];
    }>(page, actorId, "finance/categories")
  ).items;
  const category = categories.find((item) => item.name === renamed);
  const parent = categories.find((item) => item.name === parentName);
  if (!category || !parent) throw new Error("Category hierarchy was not saved");
  expect(category.parentId).toBe(parent.id);
  await manager
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  const accountId = await createAccount(page, `Budget account ${suffix}`);
  await page.goto(`/finance/transactions?accountId=${accountId}&new=true`);
  const manual = page.getByRole("dialog", {
    name: "Add a manual exception",
    exact: true,
  });
  await manual
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Budget grocery receipt");
  await manual
    .getByRole("textbox", { name: "Signed amount", exact: true })
    .fill("-37.65");
  await manual
    .getByRole("combobox", { name: "Transaction role", exact: true })
    .selectOption("spending");
  await manual
    .getByRole("combobox", { name: "Category", exact: true })
    .selectOption(category.id);
  await manual
    .getByRole("textbox", {
      name: "Why is this entered manually?",
      exact: true,
    })
    .fill("Cash receipt checked for the household budget");
  await manual
    .getByRole("button", { name: "Record exception", exact: true })
    .click();
  await expect(manual).toBeHidden();
  await page.goto(`/finance/budgets?month=${month}`);
  await page.getByRole("button", { name: "Set a budget", exact: true }).click();
  const create = page.getByRole("dialog", {
    name: "Make a little plan",
    exact: true,
  });
  await create
    .getByRole("combobox", { name: "Category", exact: true })
    .selectOption(category.id);
  await create
    .getByRole("textbox", { name: "Budget amount", exact: true })
    .fill("150.00");
  await create
    .getByRole("button", { name: "Save budget", exact: true })
    .click();
  await expect(create).toBeHidden();
  const budgetRow = page
    .locator(".budget-row")
    .filter({ has: page.getByRole("heading", { name: renamed, exact: true }) });
  await expect(budgetRow).toContainText("37.65 DKK");
  await expect(budgetRow).toContainText("112.35 DKK left");
  const before = (
    await read<{
      items: {
        id: string;
        categoryId: string;
        version: number;
        amount: string;
      }[];
    }>(page, actorId, `finance/budgets?month=${month}`)
  ).items.find((item) => item.categoryId === category.id);
  if (!before) throw new Error("Budget was not saved");
  await page.screenshot({
    path: info.outputPath("budget-exact-actuals.png"),
    fullPage: true,
  });
  await budgetRow
    .getByRole("button", { name: `Edit ${renamed} budget`, exact: true })
    .click();
  const edit = page.getByRole("dialog", {
    name: "Adjust your budget",
    exact: true,
  });
  await edit
    .getByRole("textbox", { name: "Budget amount", exact: true })
    .fill("0.00");
  await edit.getByRole("button", { name: "Save budget", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(budgetRow).toContainText("-37.65 DKK over budget");
  const after = await read<{ id: string; version: number; amount: string }>(
    page,
    actorId,
    `finance/budgets/${before.id}`,
  );
  expect(after.id).toBe(before.id);
  expect(after.version).toBeGreaterThan(before.version);
  expect(after.amount).toBe("0.00");
  await page.reload();
  await expect(budgetRow).toContainText("-37.65 DKK over budget");
  await page.screenshot({
    path: info.outputPath("budget-deliberate-zero.png"),
    fullPage: true,
  });
  await budgetRow
    .getByRole("link", { name: "See visible transactions", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`categoryId=${category.id}`));
  await expect(
    page.getByRole("button", { name: /Budget grocery receipt/ }),
  ).toBeVisible();
  await page.goto(`/finance/budgets?month=${month}`);
  await budgetRow
    .getByRole("button", { name: `Archive ${renamed} budget`, exact: true })
    .click();
  const archive = page.getByRole("dialog", {
    name: "Archive this budget?",
    exact: true,
  });
  await archive
    .getByRole("button", { name: "Archive budget", exact: true })
    .click();
  await expect(archive).toBeHidden();
  await expect(budgetRow).toHaveCount(0);
  const history = await read<{ items: unknown[] }>(
    page,
    actorId,
    `finance/budgets/${before.id}/history`,
  );
  expect(history.items.length).toBeGreaterThanOrEqual(3);
  await page
    .getByRole("button", { name: "Manage categories", exact: true })
    .click();
  await manager
    .getByRole("button", { name: `Archive ${parentName}`, exact: true })
    .click();
  const categoryArchive = page.getByRole("dialog", {
    name: "Archive this category?",
    exact: true,
  });
  await expect(categoryArchive).toContainText(renamed);
  await categoryArchive
    .getByRole("button", { name: "Archive category", exact: true })
    .click();
  await expect(categoryArchive).toBeHidden();
  await expect(manager.getByText(parentName, { exact: true })).toHaveCount(0);
  await expect(manager.getByText(renamed, { exact: true })).toHaveCount(0);
  const archived = (
    await read<{ items: { id: string; archived: boolean }[] }>(
      page,
      actorId,
      "finance/categories?includeArchived=true",
    )
  ).items;
  expect(archived.find((item) => item.id === parent.id)?.archived).toBe(true);
  expect(archived.find((item) => item.id === category.id)?.archived).toBe(true);
  await page.screenshot({
    path: info.outputPath("categories-archive-confirmed.png"),
    fullPage: true,
  });
});
