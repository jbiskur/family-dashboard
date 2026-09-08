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
async function login(page: Page, user = "owner") {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  const password = env.TEST_USER_PASSWORD;
  if (!password) throw new Error("Missing local fixture password");
  await page.locator("#username").fill(`${user}@heima.test`);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30_000 });
  await expect(page.locator("#main-content")).toBeVisible();
}
async function warmOffline(page: Page, path: string) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });
  await page.goto(path);
  await expect(page.locator(".loading-state")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".loading-state")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => !!localStorage.getItem("heima-offline-lease")),
    )
    .toBe(true);
}
async function queued(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("heima-offline-queue") ?? "[]").length,
  );
}

test("Shopping offline reorder, complete, reopen and remove preserve the command chain", async ({
  page,
  context,
}, info) => {
  await login(page);
  await page.goto("/shopping");
  await page.getByRole("button", { name: "New list", exact: true }).click();
  await page
    .getByRole("textbox", { name: "List name", exact: true })
    .fill(`Offline chain ${crypto.randomUUID()}`);
  await page.getByRole("button", { name: "Create list", exact: true }).click();
  await expect(page).toHaveURL(/\/shopping\/[0-9a-f-]{36}$/);
  const path = new URL(page.url()).pathname;
  const listId = path.split("/").at(-1);
  for (const name of ["Bread for breakfast", "Milk for coffee"]) {
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    await page.getByRole("textbox", { name: "Item", exact: true }).fill(name);
    await page
      .getByRole("button", { name: "Add to list", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: `Complete ${name}`, exact: true }),
    ).toBeVisible();
  }
  await warmOffline(page, path);
  try {
    await context.setOffline(true);
    await page
      .getByRole("button", { name: "Edit Milk for coffee", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Move to top", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page
      .getByRole("button", { name: "Complete Milk for coffee", exact: true })
      .click();
    await expect(page.locator(".notice")).toContainText(
      "One less thing to pick up.",
    );
    if (await page.getByRole("dialog").isVisible())
      await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Picked up/ }).click();
    await page
      .getByRole("button", { name: "Reopen Milk for coffee", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Reopen Milk for coffee", exact: true }),
    ).toBeHidden();
    await page.getByRole("button", { name: /^To pick up/ }).click();
    await page
      .getByRole("button", { name: "Edit Bread for breakfast", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Remove item", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Remove item", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Complete Bread for breakfast",
        exact: true,
      }),
    ).toBeHidden();
    await expect.poll(() => queued(page)).toBeGreaterThanOrEqual(5);
    await page.reload();
    await expect(
      page.getByRole("button", {
        name: "Complete Milk for coffee",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Complete Bread for breakfast",
        exact: true,
      }),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("shopping-offline-chain.png"),
      fullPage: true,
    });
    await context.setOffline(false);
    await expect.poll(() => queued(page), { timeout: 30000 }).toBe(0);
    const response = await page.request.get(
      `/api/backend/shopping/items?listId=${listId}&includeArchived=true`,
      {
        headers: { "x-heima-actor-id": "00000000-0000-4000-8000-000000000001" },
      },
    );
    expect(response.status()).toBe(200);
    const items = (await response.json()).items;
    expect(items).toHaveLength(2);
    expect(
      items.find((item: { name: string }) => item.name === "Milk for coffee"),
    ).toMatchObject({
      completed: false,
      archived: false,
      position: 0,
      purchaseStoreId: null,
    });
    expect(
      items.find(
        (item: { name: string }) => item.name === "Bread for breakfast",
      ),
    ).toMatchObject({ archived: true, position: 1 });
  } finally {
    await context.setOffline(false);
  }
});

test("Work offline assignment, due date and status chain survives reload and sync", async ({
  page,
  context,
}, info) => {
  await login(page);
  await warmOffline(page, "/work");
  const title = `Offline responsibility ${crypto.randomUUID()}`;
  try {
    await context.setOffline(true);
    await page
      .getByRole("button", { name: "Add a to-do", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "What needs doing?", exact: true })
      .fill(title);
    await page
      .getByRole("combobox", { name: "Who's on it?", exact: true })
      .selectOption({ label: "Me" });
    await page
      .getByLabel("Due date (optional)", { exact: true })
      .fill("2036-09-10");
    await page.getByRole("button", { name: "Add to-do", exact: true }).click();
    await page
      .getByRole("button")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
      .click();
    for (const status of ["In progress", "Done", "To do"]) {
      await page
        .getByRole("dialog")
        .getByRole("button", { name: status, exact: true })
        .click();
      await expect(
        page.getByRole("dialog").locator(".detail-value").last(),
      ).toHaveText(status);
    }
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Edit", exact: true })
      .click();
    await page.getByLabel("Due date (optional)", { exact: true }).fill("");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page
      .getByRole("button")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
      .click();
    await expect(
      page.getByRole("dialog").getByText("No due date", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect.poll(() => queued(page)).toBe(5);
    await page.screenshot({
      path: info.outputPath("work-offline-chain.png"),
      fullPage: true,
    });
    await context.setOffline(false);
    await expect.poll(() => queued(page), { timeout: 30000 }).toBe(0);
    const response = await page.request.get("/api/backend/work/items", {
      headers: { "x-heima-actor-id": "00000000-0000-4000-8000-000000000001" },
    });
    expect(response.status()).toBe(200);
    const rows = (await response.json()).items.filter(
      (item: { title: string }) => item.title === title,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "todo",
      dueDate: null,
      assigneeId: "00000000-0000-4000-8000-000000000001",
      version: 5,
    });
  } finally {
    await context.setOffline(false);
  }
});

test("An expired offline lease removes private work and unsent commands", async ({
  page,
  context,
}, info) => {
  await login(page);
  await warmOffline(page, "/work");
  const lease = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("heima-offline-lease") ?? "null"),
  );
  expect(lease.expiresAt).toBeGreaterThan(Date.now());
  await page.clock.install();
  try {
    await context.setOffline(true);
    const title = `Expired private note ${crypto.randomUUID()}`;
    await page
      .getByRole("button", { name: "Add a to-do", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "What needs doing?", exact: true })
      .fill(title);
    await page
      .getByRole("combobox", { name: "Who can see it?", exact: true })
      .selectOption("personal");
    await page.getByRole("button", { name: "Add to-do", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect.poll(() => queued(page)).toBe(1);
    const remaining = await page.evaluate(
      (expiresAt: number) => expiresAt - Date.now(),
      lease.expiresAt,
    );
    await page.clock.fastForward(Math.max(1, remaining + 1));
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: /Reconnect/ }),
    ).toBeVisible();
    const storage = await page.evaluate(() => ({
      lease: localStorage.getItem("heima-offline-lease"),
      queue: localStorage.getItem("heima-offline-queue"),
      data: localStorage.getItem("heima-offline-data"),
    }));
    expect(storage).toEqual({ lease: null, queue: null, data: null });
    await page.screenshot({
      path: info.outputPath("offline-lease-expired.png"),
      fullPage: true,
    });
  } finally {
    await context.setOffline(false);
  }
});
