import { readFileSync } from "node:fs";
import {
  expect,
  type Locator,
  type Page,
  type TestInfo,
  test,
} from "@playwright/test";

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
  if (
    !settings.TEST_USER_PASSWORD ||
    !settings.USABLE_CLIENT_ID ||
    !settings.USABLE_CLIENT_SECRET
  )
    throw new Error("Local test password missing");
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("owner@heima.test");
  await page.locator("#password").fill(settings.TEST_USER_PASSWORD);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  const token = await page.request.post(
    `${settings.USABLE_ISSUER}/protocol/openid-connect/token`,
    {
      form: {
        grant_type: "password",
        client_id: settings.USABLE_CLIENT_ID,
        client_secret: settings.USABLE_CLIENT_SECRET,
        username: "owner@heima.test",
        password: settings.TEST_USER_PASSWORD,
      },
    },
  );
  expect(token.ok()).toBe(true);
  return (await token.json()).access_token as string;
}
async function api(
  page: Page,
  token: string,
  path: string,
  data?: Record<string, unknown>,
) {
  const response = await page.request.fetch(
    `http://127.0.0.1:3211/v1/${path}`,
    {
      method: data ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}` },
      ...(data ? { data: { commandId: crypto.randomUUID(), ...data } } : {}),
    },
  );
  expect(response.ok(), `Public ${path} response ${response.status()}`).toBe(
    true,
  );
  return response.json();
}
function row(page: Page, title: string) {
  return page
    .locator("[data-swipe-row]")
    .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}
async function drag(
  page: Page,
  target: Locator,
  delta: number,
  release = true,
) {
  await target.evaluate((element) =>
    element.scrollIntoView({ block: "center", behavior: "instant" }),
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const box = await target.boundingBox();
  if (!box) throw new Error("Swipe row missing");
  // Start on the natural title surface, away from the OS edge and action controls.
  const titleBox = await target.getByRole("heading").boundingBox();
  if (!titleBox) throw new Error("Swipe title missing");
  const x =
    delta > 0 ? Math.max(32, titleBox.x + 8) : titleBox.x + titleBox.width - 8;
  const y = titleBox.y + titleBox.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 12 });
  if (release) await page.mouse.up();
}
async function shot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

// 3f23dfd1-918f-4055-a85b-a8957b0260c3 S1/S2/S4/S5. Synthetic records via public API;
// gestures are browser pointer observations, not a claim of physical iOS verification.
test("Shopping swipe edit, full completion and named Undo stay reachable at 320px", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 780 });
  const token = await login(page);
  const list = await api(page, token, "shopping/lists", {
    name: `Swipe shopping ${crypto.randomUUID()}`,
  });
  const title = "Fresh fruit and vegetables for the whole family";
  const item = await api(page, token, "shopping/items", {
    listId: list.id,
    name: title,
  });
  await api(page, token, "shopping/stores", {
    name: `Optional swipe store ${crypto.randomUUID()}`,
    color: "#28594b",
  });
  await page.goto(`/shopping/${list.id}`);
  const target = row(page, title);
  await expect(target).toBeVisible();
  await expect(
    target.getByRole("button", { name: `Edit ${title}`, exact: true }),
  ).toBeVisible();
  await drag(page, target, -75);
  await expect(
    target.getByRole("button", { name: `Swipe edit ${title}`, exact: true }),
  ).toBeVisible();
  expect((await api(page, token, `shopping/items/${item.id}`)).version).toBe(1);
  await shot(page, info, "shopping-swipe-edit-320");
  await target
    .getByRole("button", { name: `Swipe edit ${title}`, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, info, "shopping-swipe-editor-320");
  await page.keyboard.press("Escape");
  await drag(page, target, 200, false);
  await expect(
    target.getByText("Release to complete", { exact: true }),
  ).toBeVisible();
  await shot(page, info, "shopping-swipe-armed-320");
  await page.mouse.up();
  await expect(target).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const notice = page.getByRole("region", { name: "Recent action" });
  await expect(
    notice.getByRole("button", { name: `Undo ${title}`, exact: true }),
  ).toBeVisible();
  await expect(
    notice.getByRole("button", { name: "Add store", exact: true }),
  ).toBeVisible();
  const noticeBox = await notice.boundingBox();
  const dockBox = await page
    .getByRole("region", { name: "Quick add" })
    .boundingBox();
  if (!noticeBox || !dockBox) throw new Error("Notice or capture dock missing");
  expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(dockBox.y);
  await shot(page, info, "shopping-completed-undo-320");
  await notice.getByRole("button", { name: "Add store", exact: true }).click();
  await expect(
    page.getByRole("dialog", {
      name: "Where did you pick it up?",
      exact: true,
    }),
  ).toBeVisible();
  expect((await api(page, token, `shopping/items/${item.id}`)).completed).toBe(
    true,
  );
  await shot(page, info, "shopping-optional-store-320");
  await page.keyboard.press("Escape");
  await notice
    .getByRole("button", { name: `Undo ${title}`, exact: true })
    .click();
  await expect(target).toBeVisible();
  expect((await api(page, token, `shopping/items/${item.id}`)).completed).toBe(
    false,
  );
  await target
    .getByRole("button", { name: `Complete ${title}`, exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(target).toHaveCount(0);
  await page.getByRole("button", { name: /^Picked up/ }).click();
  await expect(target).toBeVisible();
  await drag(page, target, 80);
  await target
    .getByRole("button", { name: `Swipe reopen ${title}`, exact: true })
    .click();
  await expect(target).toHaveCount(0);
  expect((await api(page, token, `shopping/items/${item.id}`)).completed).toBe(
    false,
  );
});

test("Work swipe Undo restores doing; recurring completion preserves its one successor", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const token = await login(page);
  const title = `Swipe work ${crypto.randomUUID()}`;
  const item = await api(page, token, "work/items", {
    title,
    note: "Swipe this task body",
    status: "doing",
  });
  await page.goto("/work");
  await page
    .getByRole("textbox", { name: "Find a task", exact: true })
    .fill(title);
  let target = row(page, title);
  await drag(page, target, 220);
  await expect(
    page
      .getByRole("region", { name: "Done", exact: true })
      .getByRole("heading", { name: title }),
  ).toBeVisible();
  await shot(page, info, "work-complete-undo-390");
  await page
    .getByRole("button", { name: `Undo ${title}`, exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "In progress", exact: true })
      .getByRole("heading", { name: title }),
  ).toBeVisible();
  expect((await api(page, token, `work/items/${item.id}`)).status).toBe(
    "doing",
  );
  await expect(target).toHaveAttribute("aria-busy", "false");
  await drag(page, target, -70);
  await target
    .getByRole("button", { name: `Swipe edit ${title}`, exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Edit this occurrence" }),
  ).toBeVisible();
  await shot(page, info, "work-swipe-edit-390");
  await page.keyboard.press("Escape");

  const recurringTitle = `Swipe recurring ${crypto.randomUUID()}`;
  const recurring = await api(page, token, "work/items", {
    title: recurringTitle,
    dueDate: "2036-01-31",
    recurrence: { unit: "month", interval: 1 },
  });
  await page.reload();
  await page
    .getByRole("textbox", { name: "Find a task", exact: true })
    .fill(recurringTitle);
  target = row(page, recurringTitle);
  await drag(page, target, 220);
  expect((await api(page, token, `work/items/${recurring.id}`)).status).toBe(
    "todo",
  );
  await expect(
    target.getByRole("button", {
      name: `Swipe complete ${recurringTitle}`,
      exact: true,
    }),
  ).toBeVisible();
  await target
    .getByRole("button", {
      name: `Swipe complete ${recurringTitle}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: `Undo ${recurringTitle}`, exact: true }),
  ).toBeVisible();
  const completed = await api(page, token, `work/items/${recurring.id}`);
  expect(completed.nextOccurrenceId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(
    page.getByRole("region", { name: "Recent action" }),
  ).toContainText(/next occurrence remains/i);
  await shot(page, info, "work-recurring-explicit-undo-390");
  await page
    .getByRole("button", { name: `Undo ${recurringTitle}`, exact: true })
    .click();
  await expect
    .poll(
      async () => (await api(page, token, `work/items/${recurring.id}`)).status,
    )
    .toBe("todo");
  const reopened = await api(page, token, `work/items/${recurring.id}`);
  expect(reopened.status).toBe("todo");
  expect(reopened.nextOccurrenceId).toBe(completed.nextOccurrenceId);
  expect(
    (await api(page, token, `work/items/${completed.nextOccurrenceId}`))
      .dueDate,
  ).toBe("2036-02-29");
  await page.goto(`/work?item=${recurring.id}`);
  await page
    .getByRole("dialog", { name: recurringTitle, exact: true })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect
    .poll(
      async () => (await api(page, token, `work/items/${recurring.id}`)).status,
    )
    .toBe("done");
  expect(
    (await api(page, token, `work/items/${recurring.id}`)).nextOccurrenceId,
  ).toBe(completed.nextOccurrenceId);
  const occurrences = await api(page, token, "work/items");
  expect(
    occurrences.items.filter(
      (entry: { previousOccurrenceId?: string }) =>
        entry.previousOccurrenceId === recurring.id,
    ),
  ).toHaveLength(1);
});

test("Swipe cancellations, vertical intent, edges and keyboard alternatives do not mutate", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const token = await login(page);
  const list = await api(page, token, "shopping/lists", {
    name: `Cancel swipe ${crypto.randomUUID()}`,
  });
  const first = await api(page, token, "shopping/items", {
    listId: list.id,
    name: "First swipe target",
  });
  await api(page, token, "shopping/items", {
    listId: list.id,
    name: "Second swipe target",
  });
  await page.goto(`/shopping/${list.id}`);
  const target = row(page, first.name);
  const second = row(page, "Second swipe target");
  await drag(page, target, -75);
  await expect(
    target.getByRole("button", { name: `Swipe edit ${first.name}` }),
  ).toBeVisible();
  await drag(page, second, -75);
  await expect(
    target.getByRole("button", { name: `Swipe edit ${first.name}` }),
  ).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(
    second.getByRole("button", { name: "Swipe edit Second swipe target" }),
  ).toBeHidden();
  await drag(page, target, 230, false);
  await target
    .locator(".swipe-foreground")
    .dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect(target).toHaveAttribute("data-swipe-side", "closed");
  await drag(page, target, 230, false);
  await target.dispatchEvent("pointerdown", {
    pointerId: 99,
    pointerType: "touch",
    isPrimary: false,
  });
  await page.mouse.up();
  await expect(target).toHaveAttribute("data-swipe-side", "closed");
  const foreground = target.locator(".swipe-foreground");
  // Synthetic edge input tests the public PointerEvent boundary; no native OS claim.
  await foreground.dispatchEvent("pointerdown", {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: 10,
    clientY: 250,
  });
  await foreground.dispatchEvent("pointermove", {
    pointerId: 1,
    clientX: 280,
    clientY: 250,
  });
  await foreground.dispatchEvent("pointerup", {
    pointerId: 1,
    clientX: 280,
    clientY: 250,
  });
  await expect(target).toHaveAttribute("data-swipe-side", "closed");
  await foreground.dispatchEvent("pointerdown", {
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: 70,
    clientY: 250,
  });
  await foreground.dispatchEvent("pointermove", {
    pointerId: 1,
    clientX: 75,
    clientY: 285,
  });
  await foreground.dispatchEvent("pointermove", {
    pointerId: 1,
    clientX: 320,
    clientY: 285,
  });
  await foreground.dispatchEvent("pointerup", { pointerId: 1 });
  expect((await api(page, token, `shopping/items/${first.id}`)).version).toBe(
    1,
  );
  await target
    .getByRole("button", { name: `Edit ${first.name}`, exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await shot(page, info, "swipe-keyboard-editor-reduced-motion-430");
  await page.keyboard.press("Escape");
  await drag(page, target, -75);
  await page.getByRole("heading", { name: list.name, exact: true }).click();
  await expect(target).toHaveAttribute("data-swipe-side", "closed");
});

// Playwright request interception excludes service-worker-controlled requests.
// Match the existing capture timing harness; offline journeys retain workers.
test.describe("swipe response timing", () => {
  test.use({ serviceWorkers: "block" });
  test("Busy swipe sends one command and stale versions expose recovery without a status change", async ({
    page,
  }, info) => {
    const token = await login(page);
    const list = await api(page, token, "shopping/lists", {
      name: `Busy swipe ${crypto.randomUUID()}`,
    });
    const item = await api(page, token, "shopping/items", {
      listId: list.id,
      name: "Busy swipe target",
    });
    await page.goto(`/shopping/${list.id}`);
    const target = row(page, item.name);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let commands = 0;
    await page.route(`**/shopping/${list.id}`, async (route) => {
      if (
        route.request().method() === "POST" &&
        route.request().headers()["next-action"]
      ) {
        commands += 1;
        await held;
      }
      await route.continue();
    });
    try {
      await drag(page, target, 80);
      await target
        .getByRole("button", {
          name: `Swipe complete ${item.name}`,
          exact: true,
        })
        .click();
      await expect(target).toHaveAttribute("aria-busy", "true");
      await expect(
        target.getByRole("button", {
          name: `Complete ${item.name}`,
          exact: true,
        }),
      ).toBeDisabled();
      await drag(page, target, 220);
      await expect.poll(() => commands).toBe(1);
      expect(
        (await api(page, token, `shopping/items/${item.id}`)).completed,
      ).toBe(false);
      await shot(page, info, "swipe-busy-no-duplicate-desktop");
    } finally {
      release();
    }
    await expect(target).toHaveCount(0);
    await page.unroute(`**/shopping/${list.id}`);
    expect(commands).toBe(1);
    const completed = await api(page, token, `shopping/items/${item.id}`);
    expect(completed.version).toBe(2);
    await page
      .getByRole("button", { name: `Undo ${item.name}`, exact: true })
      .click();
    await expect(target).toBeVisible();
    const beforeConflict = await api(page, token, `shopping/items/${item.id}`);
    // A second public writer makes this rendered row stale; no internal mocks.
    await api(page, token, `shopping/items/${item.id}`, {
      baseVersion: beforeConflict.version,
      note: "Changed by another session",
    });
    await drag(page, target, 80);
    await target
      .getByRole("button", { name: `Swipe complete ${item.name}`, exact: true })
      .click();
    const conflict = page.getByRole("dialog", {
      name: "Compare changes",
      exact: true,
    });
    await expect(conflict).toBeVisible();
    await shot(page, info, "swipe-existing-conflict-comparison-desktop");
    expect(
      (await api(page, token, `shopping/items/${item.id}`)).completed,
    ).toBe(false);
    await page.keyboard.press("Escape");
    await expect(target.getByRole("alert")).toBeVisible();
    await shot(page, info, "swipe-version-conflict-recovery-desktop");
    await expect(
      target.getByRole("button", { name: "Retry complete", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(target).toContainText("Changed by another session");
    await target
      .getByRole("button", { name: "Retry complete", exact: true })
      .click();
    await expect(target).toHaveCount(0);
    expect(
      (await api(page, token, `shopping/items/${item.id}`)).completed,
    ).toBe(true);
  });
});

test("Consecutive completions keep named Undo history and queued actions tell the truth", async ({
  page,
  context,
}, info) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  const token = await login(page);
  const list = await api(page, token, "shopping/lists", {
    name: "Everyday groceries",
  });
  const first = await api(page, token, "shopping/items", {
    listId: list.id,
    name: "Oat milk",
  });
  const second = await api(page, token, "shopping/items", {
    listId: list.id,
    name: "Apples",
  });
  const third = await api(page, token, "shopping/items", {
    listId: list.id,
    name: "Fresh bread",
  });
  await page.goto(`/shopping/${list.id}`);
  const mark = async (name: string) => {
    const target = row(page, name);
    await target.evaluate((element) =>
      element.scrollIntoView({ block: "center", behavior: "instant" }),
    );
    await target
      .getByRole("button", { name: `Complete ${name}`, exact: true })
      .click();
    await expect(target).toHaveCount(0);
  };
  await mark(first.name);
  await mark(second.name);
  await expect(
    page.getByRole("button", { name: `Undo ${second.name}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `Undo ${second.name}`, exact: true })
    .click();
  await expect(row(page, second.name)).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Undo ${first.name}`, exact: true }),
  ).toBeVisible();
  await shot(page, info, "shopping-consecutive-named-undo-390");
  await page
    .getByRole("button", { name: `Undo ${first.name}`, exact: true })
    .click();
  await expect(row(page, first.name)).toBeVisible();
  expect((await api(page, token, `shopping/items/${first.id}`)).completed).toBe(
    false,
  );
  expect(
    (await api(page, token, `shopping/items/${second.id}`)).completed,
  ).toBe(false);
  await mark(first.name);
  try {
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await mark(second.name);
    const notice = page.getByRole("region", { name: "Recent action" });
    await expect(notice).toContainText(
      `${second.name} added to this device’s sync queue.`,
    );
    await expect(notice.getByRole("button", { name: /^Undo / })).toHaveCount(0);
    expect(
      (await api(page, token, `shopping/items/${second.id}`)).completed,
    ).toBe(false);
    await shot(page, info, "shopping-queued-completion-honest-390");
  } finally {
    await context.setOffline(false);
  }
  await expect
    .poll(
      async () =>
        (await api(page, token, `shopping/items/${second.id}`)).completed,
      { timeout: 30000 },
    )
    .toBe(true);
  await mark(third.name);
  try {
    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page
      .getByRole("button", { name: `Undo ${third.name}`, exact: true })
      .click();
    const notice = page.getByRole("region", { name: "Recent action" });
    await expect(notice).toContainText(
      "Undo added to this device’s sync queue.",
    );
    await expect(notice).not.toContainText("Undone.");
    expect(
      (await api(page, token, `shopping/items/${third.id}`)).completed,
    ).toBe(true);
    await shot(page, info, "shopping-queued-undo-honest-390");
  } finally {
    await context.setOffline(false);
  }
  await expect
    .poll(
      async () =>
        (await api(page, token, `shopping/items/${third.id}`)).completed,
      { timeout: 30000 },
    )
    .toBe(false);
});
