import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { request, tokenFor } from "../fixtures/auth";

const settings = Object.fromEntries(
  readFileSync(".env.test.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
);
let owner: string;
test.beforeAll(async () => {
  for (const key of [
    "USABLE_ISSUER",
    "USABLE_CLIENT_ID",
    "USABLE_CLIENT_SECRET",
    "TEST_USER_PASSWORD",
  ])
    process.env[key] = settings[key];
  owner = await tokenFor();
});
async function login(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("owner@heima.test");
  if (!settings.TEST_USER_PASSWORD)
    throw new Error("Local test password missing");
  await page.locator("#password").fill(settings.TEST_USER_PASSWORD);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  await expect(page.locator("#main-content")).toBeVisible();
}
async function create(path: string, data: Record<string, unknown>) {
  const response = await request(path, owner, {
    commandId: crypto.randomUUID(),
    ...data,
  });
  expect(response.status).toBe(201);
  return response.json();
}
async function screenshot(page: Page, path: string) {
  await page.screenshot({ path, animations: "disabled", fullPage: false });
}

test("category presets are optional, persist and preserve legacy categories", async ({
  page,
}, info) => {
  await login(page);
  const list = await create("shopping/lists", {
    name: `Colours ${Date.now()}`,
    visibility: "household",
  });
  const legacy = await create("shopping/items", {
    listId: list.id,
    name: "Specialty tea",
    category: "Local favourites",
  });
  await page.goto(`/shopping/${list.id}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: `Edit ${legacy.name}`, exact: true })
    .click();
  const edit = page.getByRole("dialog");
  await expect(
    edit.getByRole("button", { name: "Local favourites", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await edit.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(edit).toBeHidden();
  const capture = page.getByRole("region", { name: "Quick add", exact: true });
  const categories = [
    "Fruit & vegetables",
    "Dairy & eggs",
    "Meat & fish",
    "Bakery",
    "Pantry",
    "Frozen",
    "Drinks",
    "Household",
    "Other",
    "No category",
  ];
  for (const category of categories) {
    await capture.getByRole("button", { name: "Details", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "Shopping details",
      exact: true,
    });
    await dialog.getByLabel(/What do we need/).fill(`Example ${category}`);
    await dialog.getByRole("button", { name: category, exact: true }).click();
    if (category === "Dairy & eggs")
      await screenshot(
        page,
        info.outputPath("shopping-category-picker-mobile.png"),
      );
    await dialog
      .getByRole("button", { name: "Add shopping", exact: true })
      .click();
    await expect(dialog).toBeHidden();
  }
  await page.reload();
  await expect(page.locator(".shopping-row")).toHaveCount(11);
  await page.locator(".shopping-row").evaluateAll(async (rows) => {
    await Promise.all(
      rows.flatMap((row) =>
        row
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      ),
    );
  });
  const rows = (
    await (await request(`shopping/items?listId=${list.id}`, owner)).json()
  ).items;
  for (const category of categories)
    expect(rows).toContainEqual(
      expect.objectContaining({
        name: `Example ${category}`,
        category: category === "No category" ? "" : category,
      }),
    );
  expect(rows).toContainEqual(
    expect.objectContaining({
      name: legacy.name,
      category: "Local favourites",
    }),
  );
  await screenshot(
    page,
    info.outputPath("shopping-colours-persisted-mobile.png"),
  );
});

test("shopping history deduplicates, limits and filters list and category without copying fields", async ({
  page,
}, info) => {
  await login(page);
  const list = await create("shopping/lists", {
    name: `History ${Date.now()}`,
    visibility: "household",
  });
  const other = await create("shopping/lists", {
    name: "Private treats",
    visibility: "personal",
  });
  for (let index = 0; index < 7; index++)
    await create("shopping/items", {
      listId: list.id,
      name: `Milk example ${index}`,
      category: "Dairy & eggs",
      quantity: "Old quantity",
      note: "Old note",
      completed: index === 0,
      archived: index === 1,
    });
  await create("shopping/items", {
    listId: list.id,
    name: "MILK EXAMPLE 0",
    category: "Dairy & eggs",
  });
  await create("shopping/items", {
    listId: list.id,
    name: "Milk bread",
    category: "Bakery",
  });
  await create("shopping/items", {
    listId: other.id,
    name: "Milk secret",
    category: "Dairy & eggs",
  });
  await page.goto(`/shopping/${list.id}`);
  const capture = page.getByRole("region", { name: "Quick add", exact: true });
  await capture
    .getByRole("combobox", { name: "What do we need?", exact: true })
    .fill("milk");
  await expect(
    page.getByRole("listbox", { name: "Previous entries" }).getByRole("option"),
  ).toHaveCount(5);
  await expect(
    page
      .getByRole("listbox", { name: "Previous entries" })
      .getByRole("option", { name: "Milk secret", exact: true }),
  ).toHaveCount(0);
  await capture
    .getByRole("combobox", { name: "What do we need?", exact: true })
    .press("Escape");
  await capture.getByRole("button", { name: "Details", exact: true }).click();
  const details = page.getByRole("dialog", {
    name: "Shopping details",
    exact: true,
  });
  await details.getByRole("button", { name: "Bakery", exact: true }).click();
  const input = details.getByLabel(/What do we need/);
  await input.focus();
  await expect(
    page.getByRole("listbox", { name: "Previous entries" }).getByRole("option"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("listbox", { name: "Previous entries" }).getByRole("option"),
  ).toHaveText("Milk bread");
  await input.press("Escape");
  await expect(details).toBeVisible();
  await details
    .getByRole("button", { name: "Dairy & eggs", exact: true })
    .click();
  await details
    .getByLabel("Quantity or amount", { exact: true })
    .fill("2 cartons");
  await details.getByLabel("A note", { exact: true }).fill("My new note");
  await input.fill("milk example 1");
  await expect(
    page.getByRole("listbox", { name: "Previous entries" }).getByRole("option"),
  ).toHaveText("Milk example 1");
  await screenshot(
    page,
    info.outputPath("history-inside-shopping-details.png"),
  );
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("Milk example 1");
  await expect(details).toBeVisible();
  await expect(
    details.getByLabel("Quantity or amount", { exact: true }),
  ).toHaveValue("2 cartons");
  await expect(details.getByLabel("A note", { exact: true })).toHaveValue(
    "My new note",
  );
  await expect(
    details.getByRole("button", { name: "Dairy & eggs", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const before = (
    await (
      await request(
        `shopping/items?listId=${list.id}&includeArchived=true`,
        owner,
      )
    ).json()
  ).items.length;
  await details
    .getByRole("button", { name: "Add shopping", exact: true })
    .click();
  await expect(details).toBeHidden();
  const rows = (
    await (
      await request(
        `shopping/items?listId=${list.id}&includeArchived=true`,
        owner,
      )
    ).json()
  ).items;
  expect(rows).toHaveLength(before + 1);
  expect(rows).toContainEqual(
    expect.objectContaining({
      name: "Milk example 1",
      quantity: "2 cartons",
      note: "My new note",
      category: "Dairy & eggs",
      completed: false,
      archived: false,
    }),
  );
});

test("Home and Work history respects audience and touch selection never submits", async ({
  page,
}, info) => {
  await login(page);
  const prefix = `Remember ${Date.now()}`;
  await create("work/items", {
    title: `${prefix} shared`,
    visibility: "household",
    dueDate: "2026-09-11",
    recurrence: { unit: "week", interval: 1 },
  });
  await create("work/items", {
    title: `${prefix} private`,
    visibility: "personal",
    archived: true,
  });
  for (const route of ["/", "/work"]) {
    await page.goto(route);
    const capture = page.getByRole("region", {
      name: "Quick add",
      exact: true,
    });
    const input = capture.getByRole("combobox", {
      name: "What needs doing?",
      exact: true,
    });
    await input.fill(prefix);
    await expect(
      page
        .getByRole("listbox", { name: "Previous entries" })
        .getByRole("option"),
    ).toHaveText(`${prefix} shared`);
    await capture
      .getByLabel("Who can see it?", { exact: true })
      .selectOption("personal");
    await input.focus();
    await expect(
      page
        .getByRole("listbox", { name: "Previous entries" })
        .getByRole("option"),
    ).toHaveText(`${prefix} private`);
    await page
      .getByRole("listbox", { name: "Previous entries" })
      .getByRole("option")
      .click();
    await expect(input).toHaveValue(`${prefix} private`);
    await expect(capture.locator(".capture-feedback")).toHaveCount(0);
    await capture.getByRole("button", { name: "Details", exact: true }).click();
    const details = page.getByRole("dialog", {
      name: "To-do details",
      exact: true,
    });
    await expect(
      details.getByLabel("Due date (optional)", { exact: true }),
    ).toHaveValue("");
    await details.getByText("More details & options", { exact: true }).click();
    await expect(details.getByLabel("Repeat", { exact: true })).toHaveValue("");
    await screenshot(
      page,
      info.outputPath(
        `work-history-${route === "/" ? "home" : "work"}-details.png`,
      ),
    );
    await details
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
  }
});

test.describe("history failure isolation", () => {
  test.use({ serviceWorkers: "block" });
  test("slow or unavailable history leaves manual entry usable", async ({
    page,
  }, info) => {
    await login(page);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      "**/api/backend/work/items?includeArchived=true",
      async (route) => {
        await held;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { message: "History temporarily unavailable" },
          }),
        });
      },
    );
    try {
      await page.goto("/work");
      const capture = page.getByRole("region", {
        name: "Quick add",
        exact: true,
      });
      const input = capture.getByRole("combobox", {
        name: "What needs doing?",
        exact: true,
      });
      const title = `Manual entry ${Date.now()}`;
      await input.fill(title);
      await expect(input).toHaveAttribute("aria-busy", "true");
      await expect(
        capture.getByRole("button", { name: "Add to-do", exact: true }),
      ).toBeEnabled();
      release();
      await expect(capture.getByRole("status")).toContainText(
        "Previous entries are unavailable",
      );
      await expect(input).toHaveValue(title);
      await expect(
        page
          .getByRole("listbox", { name: "Previous entries" })
          .getByRole("option"),
      ).toHaveCount(0);
      await capture
        .getByRole("button", { name: "Add to-do", exact: true })
        .click();
      await expect(input).toHaveValue("");
      await expect(capture.locator(".capture-feedback")).toContainText(
        `${title} added.`,
      );
      await screenshot(
        page,
        info.outputPath("history-failure-manual-success.png"),
      );
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
});

test("suggestions fit narrow and desktop layouts, Escape dismisses and offline entries still queue", async ({
  page,
  context,
}, info) => {
  await login(page);
  const list = await create("shopping/lists", {
    name: `Offline history ${Date.now()}`,
    visibility: "household",
  });
  await create("shopping/items", {
    listId: list.id,
    name: "Apples for a very long picnic with the whole family",
    category: "Fruit & vegetables",
  });
  await page.goto(`/shopping/${list.id}`);
  const capture = page.getByRole("region", { name: "Quick add", exact: true });
  const input = capture.getByRole("combobox", {
    name: "What do we need?",
    exact: true,
  });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await input.fill("Apples");
    await input.click();
    await expect(
      page
        .getByRole("listbox", { name: "Previous entries" })
        .getByRole("option"),
    ).toHaveCount(1);
    const box = await page.getByRole("listbox").boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error("Missing suggestion bounds");
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await screenshot(page, info.outputPath(`shopping-history-${width}.png`));
    await input.press("Escape");
    await expect(
      page
        .getByRole("listbox", { name: "Previous entries" })
        .getByRole("option"),
    ).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Apples");
    await input.press("Escape");
    await expect(input).toHaveValue("Apples");
  }
  await input.fill("A new shopping draft");
  await input.press("Escape");
  await expect(input).toHaveValue("A new shopping draft");
  await capture.getByRole("button", { name: "Details", exact: true }).click();
  const details = page.getByRole("dialog", {
    name: "Shopping details",
    exact: true,
  });
  const draft = details.getByRole("combobox", {
    name: "What do we need?",
    exact: true,
  });
  await expect(draft).toHaveValue("A new shopping draft");
  await draft.focus();
  await draft.press("Escape");
  await expect(details).toBeHidden();
  await expect(input).toHaveValue("A new shopping draft");
  const axe = await new AxeBuilder({ page }).include(".capture-dock").analyze();
  expect(axe.violations).toEqual([]);
  await context.setOffline(true);
  try {
    await input.fill("No history needed");
    await capture
      .getByRole("button", { name: "Add shopping", exact: true })
      .click();
    await expect(capture.locator(".capture-feedback")).toContainText(
      "sync queue",
    );
    await expect(input).toHaveValue("");
    await screenshot(page, info.outputPath("history-offline-manual-queue.png"));
  } finally {
    await context.setOffline(false);
  }
  await expect
    .poll(async () =>
      (
        await (await request(`shopping/items?listId=${list.id}`, owner)).json()
      ).items.some(
        (item: { name: string }) => item.name === "No history needed",
      ),
    )
    .toBe(true);
});
