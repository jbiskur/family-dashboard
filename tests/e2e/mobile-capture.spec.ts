import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { request, tokenFor } from "../fixtures/auth";

type CaptureTimerWindow = Window & {
  captureTimers?: {
    pending: () => number;
    flush: () => void;
    restore: () => void;
  };
};

// Control only browser scheduling; every save still executes on the real server.
// Queue immediate callbacks in batches, without identifying application code or
// calling focus. Preserve cancellation and restore native timers in finally.
async function holdImmediateTimers(page: Page) {
  await page.evaluate(() => {
    const nativeSet = window.setTimeout.bind(window);
    const nativeClear = window.clearTimeout.bind(window);
    const queued = new Map<number, () => void>();
    let nextId = -1;
    const flush = () => {
      for (const id of [...queued.keys()]) {
        const callback = queued.get(id);
        queued.delete(id);
        callback?.();
      }
    };
    window.setTimeout = ((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (!delay && typeof handler === "function") {
        const id = nextId--;
        queued.set(id, () => handler.apply(window, args));
        return id;
      }
      return nativeSet(handler, delay, ...args);
    }) as typeof window.setTimeout;
    window.clearTimeout = (id) => {
      if (id !== undefined && queued.delete(id)) return;
      nativeClear(id);
    };
    (window as CaptureTimerWindow).captureTimers = {
      pending: () => queued.size,
      flush,
      restore: () => {
        window.setTimeout = nativeSet;
        window.clearTimeout = nativeClear;
        flush();
        delete (window as CaptureTimerWindow).captureTimers;
      },
    };
  });
}

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

test("one Home capture preserves separate drafts, destination and expanded fields", async ({
  page,
}, info) => {
  await login(page);
  const list = await create("shopping/lists", {
    name: `Capture groceries ${Date.now()}`,
    visibility: "household",
  });
  await page.reload();
  const capture = page.getByRole("region", { name: "Quick add", exact: true });
  await expect(capture).toHaveCount(1);
  await expect(page.locator(".page-header .button")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add a to-do", exact: true }),
  ).toHaveCount(0);
  await capture
    .getByRole("combobox", { name: "What needs doing?", exact: true })
    .fill("Plan a picnic");
  await capture.getByRole("button", { name: "Shopping", exact: true }).click();
  await capture
    .getByRole("combobox", { name: "Shopping list", exact: true })
    .selectOption(list.id);
  await capture
    .getByRole("combobox", { name: "What do we need?", exact: true })
    .fill("Apples for the picnic");
  await capture.getByRole("button", { name: "Details", exact: true }).click();
  const details = page.getByRole("dialog", {
    name: "Shopping details",
    exact: true,
  });
  await details.getByLabel("Quantity or amount", { exact: true }).fill("6");
  await details
    .getByRole("textbox", { name: "A note", exact: true })
    .fill("A mix of red and green");
  await details
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await capture.getByRole("button", { name: "To-do", exact: true }).click();
  await expect(
    capture.getByRole("combobox", { name: "What needs doing?", exact: true }),
  ).toHaveValue("Plan a picnic");
  await capture.getByRole("button", { name: "Shopping", exact: true }).click();
  await expect(
    capture.getByRole("combobox", { name: "Shopping list", exact: true }),
  ).toHaveValue(list.id);
  await capture.getByRole("button", { name: "Details", exact: true }).click();
  await expect(
    details.getByLabel("Quantity or amount", { exact: true }),
  ).toHaveValue("6");
  await expect(
    details.getByRole("textbox", { name: "A note", exact: true }),
  ).toHaveValue("A mix of red and green");
  await screenshot(page, info.outputPath("shopping-details-draft.png"));
  await details
    .getByRole("button", { name: "Add shopping", exact: true })
    .click();
  await expect(details).toBeHidden();
  const response = await request(`shopping/items?listId=${list.id}`, owner);
  expect((await response.json()).items).toEqual([
    expect.objectContaining({
      name: "Apples for the picnic",
      quantity: "6",
      note: "A mix of red and green",
      listId: list.id,
      completed: false,
    }),
  ]);
  await expect(
    capture.getByRole("combobox", { name: "What do we need?", exact: true }),
  ).toBeFocused();
  await screenshot(page, info.outputPath("home-single-capture-success.png"));
});

test("capture stays reachable after long-list scrolling at narrow and desktop widths", async ({
  page,
}, info) => {
  await login(page);
  const list = await create("shopping/lists", {
    name: `Weekend groceries ${Date.now()}`,
    visibility: "household",
  });
  for (let index = 0; index < 16; index++)
    await create("shopping/items", {
      name: `Picnic item ${index + 1}`,
      listId: list.id,
      position: index,
    });
  await page.goto(`/shopping/${list.id}`);
  const capture = page.getByRole("region", { name: "Quick add", exact: true });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator(".shopping-row")).toHaveCount(16);
    if (width < 768) {
      await page.locator(".shopping-row").last().scrollIntoViewIfNeeded();
      const boxes = await page.evaluate(() => {
        const dock = document
          .querySelector(".capture-dock")
          ?.getBoundingClientRect();
        const nav = document
          .querySelector(".mobile-nav")
          ?.getBoundingClientRect();
        const row = [...document.querySelectorAll(".shopping-row")]
          .at(-1)
          ?.getBoundingClientRect();
        if (!dock || !nav || !row) throw new Error("Capture layout missing");
        return {
          dockTop: dock.top,
          dockBottom: dock.bottom,
          navTop: nav.top,
          rowBottom: row.bottom,
        };
      });
      expect(boxes.dockBottom).toBeLessThanOrEqual(boxes.navTop + 1);
      expect(boxes.rowBottom).toBeLessThanOrEqual(boxes.dockTop);
      await expect(
        capture.getByRole("combobox", {
          name: "What do we need?",
          exact: true,
        }),
      ).toBeInViewport();
    } else await capture.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await screenshot(page, info.outputPath(`capture-reachable-${width}.png`));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const empty = await create("shopping/lists", {
    name: `Fresh list ${Date.now()}`,
    visibility: "personal",
  });
  await page.goto(`/shopping/${empty.id}`);
  await expect(page.locator(".shopping-row")).toHaveCount(0);
  await expect(capture).toContainText("Just me");
  await expect(capture).toHaveCount(1);
  await screenshot(page, info.outputPath("empty-list-capture.png"));
});

test.describe("capture response timing", () => {
  test.use({ serviceWorkers: "block" });
  for (const timing of [
    "during exit",
    "after exit",
    "queued close",
    "reduced motion",
  ] as const) {
    test(`closing details during a save restores the next-entry field: ${timing}`, async ({
      page,
    }, info) => {
      await login(page);
      await page.emulateMedia({
        reducedMotion: timing === "reduced motion" ? "reduce" : "no-preference",
      });
      await page.goto("/work");
      const queueClose =
        timing === "queued close" || timing === "reduced motion";
      // Exercise success during a real exit animation and after unmount. The
      // queued cases also model a busy event loop between close callbacks.
      await page.addStyleTag({
        content: `
        @keyframes capture-test-exit { from { opacity: 1 } to { opacity: 0 } }
        .capture-details[data-state="closed"] {
          animation: capture-test-exit ${timing === "during exit" ? 250 : 0}ms both;
        }
      `,
      });
      const capture = page.getByRole("region", {
        name: "Quick add",
        exact: true,
      });
      const input = capture.getByRole("combobox", {
        name: "What needs doing?",
        exact: true,
      });
      const trigger = capture.getByRole("button", {
        name: "Details",
        exact: true,
      });
      const title = `Prepare the picnic ${crypto.randomUUID()}`;
      await input.fill(title);
      await trigger.click();
      const details = page.getByRole("dialog", {
        name: "To-do details",
        exact: true,
      });
      let captured = false;
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/work", async (route) => {
        if (
          route.request().method() !== "POST" ||
          !route.request().postData()?.includes(title)
        )
          return route.continue();
        const response = await route.fetch();
        captured = true;
        await held;
        await route.fulfill({ response });
      });
      let timersHeld = false;
      try {
        await details
          .getByRole("button", { name: "Add to-do", exact: true })
          .click();
        await expect.poll(() => captured).toBe(true);
        await expect(
          details.getByRole("button", { name: "Saving…", exact: true }),
        ).toBeDisabled();
        await screenshot(page, info.outputPath("capture-details-pending.png"));
        if (queueClose) {
          await holdImmediateTimers(page);
          timersHeld = true;
        }
        await details
          .getByRole("button", { name: "Close dialog", exact: true })
          .click();
        if (timing !== "during exit") {
          await expect(page.locator(".capture-details")).toHaveCount(0);
          if (queueClose) {
            await expect
              .poll(() =>
                page.evaluate(
                  () =>
                    (window as CaptureTimerWindow).captureTimers?.pending() ??
                    0,
                ),
              )
              .toBeGreaterThan(0);
            await page.evaluate(() =>
              (window as CaptureTimerWindow).captureTimers?.flush(),
            );
          } else {
            await page.evaluate(
              () =>
                new Promise<void>((resolve) =>
                  requestAnimationFrame(() =>
                    requestAnimationFrame(() => resolve()),
                  ),
                ),
            );
          }
        }
        release();
        await expect(details).toBeHidden();
        await expect(
          capture.locator(".capture-feedback[role=status]"),
        ).toContainText(`${title} added.`);
        await expect(input).toHaveValue("");
        if (queueClose)
          await page.evaluate(() =>
            (window as CaptureTimerWindow).captureTimers?.restore(),
          );
        // Assert after the queued close work has settled, so a transient focus
        // followed by a late jump to Details cannot satisfy this regression.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        await expect(input).toBeFocused();
        const rows = (await (await request("work/items", owner)).json()).items;
        expect(
          rows.filter((item: { title: string }) => item.title === title),
        ).toHaveLength(1);
        await screenshot(
          page,
          info.outputPath("capture-dismissed-save-focus.png"),
        );
        await trigger.click();
        await page.keyboard.press("Escape");
        await expect(details).toBeHidden();
        await expect(trigger).toBeFocused();
        await screenshot(
          page,
          info.outputPath("capture-cancel-trigger-focus.png"),
        );
        if (queueClose) {
          const nextDraft = `Make sandwiches ${crypto.randomUUID()}`;
          await trigger.click();
          await details
            .getByRole("combobox", { name: "What needs doing?", exact: true })
            .fill(nextDraft);
          await details
            .getByRole("combobox", { name: "Who can see it?", exact: true })
            .selectOption("personal");
          await details
            .getByText("More details & options", { exact: true })
            .click();
          await details
            .getByRole("textbox", { name: "A helpful note", exact: true })
            .fill("Pack a reusable box");
          await details
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await expect(details).toBeHidden();
          await expect(trigger).toBeFocused();
          await expect(input).toHaveValue(nextDraft);
          await expect(
            capture.getByRole("combobox", {
              name: "Who can see it?",
              exact: true,
            }),
          ).toHaveValue("personal");
          await trigger.click();
          await expect(
            details.getByRole("combobox", {
              name: "What needs doing?",
              exact: true,
            }),
          ).toHaveValue(nextDraft);
          await expect(
            details.getByRole("combobox", {
              name: "Who can see it?",
              exact: true,
            }),
          ).toHaveValue("personal");
          await details
            .getByText("More details & options", { exact: true })
            .click();
          await expect(
            details.getByRole("textbox", {
              name: "A helpful note",
              exact: true,
            }),
          ).toHaveValue("Pack a reusable box");
          await details
            .getByRole("textbox", { name: "A helpful note", exact: true })
            .scrollIntoViewIfNeeded();
          await screenshot(
            page,
            info.outputPath("capture-cancel-draft-restored.png"),
          );
          await details
            .getByRole("button", { name: "Close dialog", exact: true })
            .click();
          await expect(details).toBeHidden();
          await expect(trigger).toBeFocused();
          const afterCancel = (
            await (await request("work/items", owner)).json()
          ).items;
          expect(
            afterCancel.filter(
              (item: { title: string }) => item.title === nextDraft,
            ),
          ).toHaveLength(0);
        }
      } finally {
        release();
        if (timersHeld)
          await page.evaluate(() =>
            (window as CaptureTimerWindow).captureTimers?.restore(),
          );
        await page.unroute("**/work");
      }
    });
  }
  test("pending capture preserves next-entry typing and suppresses duplicate submission", async ({
    page,
  }, info) => {
    await login(page);
    await page.goto("/work");
    const first = `Visit the harbour ${Date.now()}`;
    const next = `Pack the picnic ${Date.now()}`;
    const capture = page.getByRole("region", {
      name: "Quick add",
      exact: true,
    });
    const input = capture.getByRole("combobox", {
      name: "What needs doing?",
      exact: true,
    });
    let captured = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/work", async (route) => {
      if (
        route.request().method() !== "POST" ||
        !route.request().postData()?.includes(first)
      )
        return route.continue();
      const response = await route.fetch();
      captured = true;
      await held;
      await route.fulfill({ response });
    });
    try {
      await input.fill(first);
      await capture
        .getByRole("button", { name: "Add to-do", exact: true })
        .click();
      await expect.poll(() => captured).toBe(true);
      await expect(
        capture.getByRole("button", { name: "Add to-do", exact: true }),
      ).toBeDisabled();
      await input.fill(next);
      await input.press("Enter");
      await screenshot(page, info.outputPath("capture-pending-next-draft.png"));
      release();
      await expect(
        capture.locator(".capture-feedback[role=status]"),
      ).toContainText(`${first} added.`);
      await expect(input).toHaveValue(next);
      await expect(input).toBeFocused();
      const rows = (await (await request("work/items", owner)).json()).items;
      expect(
        rows.filter((item: { title: string }) => item.title === first),
      ).toHaveLength(1);
      expect(
        rows.filter((item: { title: string }) => item.title === next),
      ).toHaveLength(0);
      await capture
        .getByRole("button", { name: "Add to-do", exact: true })
        .click();
      await expect(input).toHaveValue("");
      await expect(
        capture.locator(".capture-feedback[role=status]"),
      ).toContainText(`${next} added.`);
      await screenshot(page, info.outputPath("capture-repeat-success.png"));
    } finally {
      release();
      await page.unroute("**/work");
    }
  });
});

test("invalid capture stays editable and reports errors inside expanded details", async ({
  page,
}, info) => {
  await login(page);
  await page.goto("/work");
  const capture = page.getByRole("region", { name: "Quick add", exact: true });
  const input = capture.getByRole("combobox", {
    name: "What needs doing?",
    exact: true,
  });
  await input.fill("   ");
  await input.blur();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(capture.getByRole("alert")).toContainText("required");
  await screenshot(page, info.outputPath("capture-invalid-title.png"));
  const title = `Water the herbs ${Date.now()}`;
  await input.fill(title);
  await capture.getByRole("button", { name: "Details", exact: true }).click();
  const details = page.getByRole("dialog", {
    name: "To-do details",
    exact: true,
  });
  await details.getByText("More details & options", { exact: true }).click();
  await details
    .getByRole("combobox", { name: "Repeat", exact: true })
    .selectOption("week");
  await details.getByRole("button", { name: "Add to-do", exact: true }).click();
  await expect(details.getByRole("alert")).toBeVisible();
  await expect(
    details.getByRole("combobox", { name: "What needs doing?", exact: true }),
  ).toHaveValue(title);
  await details.getByRole("alert").scrollIntoViewIfNeeded();
  await screenshot(page, info.outputPath("capture-server-validation.png"));
  await details
    .getByLabel("Due date (optional)", { exact: true })
    .fill("2030-06-15");
  await details.getByRole("button", { name: "Add to-do", exact: true }).click();
  await expect(details).toBeHidden();
  await expect(input).toHaveValue("");
});

test("capture distinguishes offline queue and preserves accessible keyboard layout", async ({
  page,
  context,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await login(page);
  await page.goto("/work");
  await expect
    .poll(() =>
      page.evaluate(() => !!localStorage.getItem("heima-offline-lease")),
    )
    .toBe(true);
  const capture = page.getByRole("region", { name: "Quick add", exact: true });
  const input = capture.getByRole("combobox", {
    name: "What needs doing?",
    exact: true,
  });
  expect(
    await input.evaluate((element) =>
      parseFloat(getComputedStyle(element).fontSize),
    ),
  ).toBeGreaterThanOrEqual(16);
  await capture.getByRole("button", { name: "Details", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(
    capture.getByRole("button", { name: "Details", exact: true }),
  ).toBeFocused();
  const title = `Bring a raincoat ${Date.now()}`;
  try {
    await context.setOffline(true);
    await input.fill(title);
    await capture
      .getByRole("button", { name: "Add to-do", exact: true })
      .click();
    await expect(
      capture.locator(".capture-feedback[role=status]"),
    ).toContainText("sync queue");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await screenshot(page, info.outputPath("capture-offline-queued.png"));
  } finally {
    await context.setOffline(false);
  }
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("heima-offline-queue") ?? "[]")
              .length,
        ),
      { timeout: 30000 },
    )
    .toBe(0);
  await page.evaluate(() => {
    if (!window.visualViewport)
      throw new Error("Visual viewport is unavailable");
    Object.defineProperty(window.visualViewport, "height", {
      configurable: true,
      value: 450,
    });
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  const bottom = await capture.evaluate(
    (element) => element.getBoundingClientRect().bottom,
  );
  expect(bottom).toBeLessThanOrEqual(451);
  await expect(input).toBeInViewport();
  await screenshot(
    page,
    info.outputPath("capture-synthetic-keyboard-layout.png"),
  );
  await page.evaluate(() => {
    if (!window.visualViewport)
      throw new Error("Visual viewport is unavailable");
    Reflect.deleteProperty(window.visualViewport, "height");
    window.visualViewport.dispatchEvent(new Event("resize"));
  });
  const audit = await new AxeBuilder({ page })
    .include(".capture-dock")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(audit.violations).toEqual([]);
  await info.attach("keyboard-evidence-limits", {
    body: "VisualViewport resize is synthetic; desktop browser automation does not verify physical iPhone keyboard behavior.",
    contentType: "text/plain",
  });
});
