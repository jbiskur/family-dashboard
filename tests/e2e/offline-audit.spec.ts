import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  offlineNavigationLimitation,
  webKitOfflineNavigationUnsupported,
} from "../fixtures/browser-capabilities";

const env = Object.fromEntries(
  readFileSync(".env.test.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
);
test.use({ trace: "off", video: "off", actionTimeout: 15_000 });
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

test("Work survives an offline create, hard reload and idempotent reconnect", async ({
  page,
  context,
  browserName,
}, info) => {
  test.setTimeout(90_000);
  await login(page);
  await warmOffline(page, "/work");
  const title = `Offline task ${crypto.randomUUID()}`;
  try {
    await context.setOffline(true);
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await page.getByRole("combobox", { name: /What needs doing/ }).fill(title);
    await page.getByRole("button", { name: "Add to-do", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Review sync" }).click();
    await expect(page.getByRole("dialog")).toContainText(title);
    await page.screenshot({
      path: info.outputPath("work-offline-queue.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    test.skip(
      webKitOfflineNavigationUnsupported(browserName),
      offlineNavigationLimitation,
    );
    await page.reload();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => queued(page)).toBe(1);
    await page.screenshot({
      path: info.outputPath("work-offline-reloaded.png"),
      fullPage: true,
    });
    await context.setOffline(false);
    await expect.poll(() => queued(page), { timeout: 30_000 }).toBe(0);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: title, exact: true }),
    ).toHaveCount(1);
    const response = await page.request.get("/api/backend/work/items", {
      headers: { "x-heima-actor-id": "00000000-0000-4000-8000-000000000001" },
    });
    expect(response.status()).toBe(200);
    expect(
      (await response.json()).items.filter(
        (item: { title: string }) => item.title === title,
      ),
    ).toHaveLength(1);
  } finally {
    await context.setOffline(false);
  }
});

test("Shopping survives an offline item create, hard reload and reconnect", async ({
  page,
  context,
  browserName,
}, info) => {
  test.setTimeout(90_000);
  await login(page);
  await page.goto("/shopping");
  await page.getByRole("button", { name: "New list", exact: true }).click();
  await page
    .getByRole("textbox", { name: /List name/ })
    .fill(`Offline shopping ${crypto.randomUUID()}`);
  await page.getByRole("button", { name: "Create list", exact: true }).click();
  await expect(page).toHaveURL(/\/shopping\/[0-9a-f-]{36}$/);
  const path = new URL(page.url()).pathname;
  await warmOffline(page, path);
  const item = `Offline bread ${crypto.randomUUID()}`;
  try {
    await context.setOffline(true);
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await page.getByRole("combobox", { name: /What do we need/ }).fill(item);
    await page
      .getByRole("button", { name: "Add shopping", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: `Complete ${item}`, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Review sync" }).click();
    await page.screenshot({
      path: info.outputPath("shopping-offline-queue.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    test.skip(
      webKitOfflineNavigationUnsupported(browserName),
      offlineNavigationLimitation,
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: `Complete ${item}`, exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => queued(page)).toBe(1);
    await page.screenshot({
      path: info.outputPath("shopping-offline-reloaded.png"),
      fullPage: true,
    });
    await context.setOffline(false);
    await expect.poll(() => queued(page), { timeout: 30_000 }).toBe(0);
    await page.reload();
    await expect(
      page.getByRole("button", { name: `Complete ${item}`, exact: true }),
    ).toHaveCount(1);
  } finally {
    await context.setOffline(false);
  }
});

for (const choice of ["discard", "reapply"] as const) {
  test(`Work conflict shows three versions and requires explicit ${choice}`, async ({
    page,
    context,
    browser,
  }, info) => {
    test.setTimeout(120_000);
    const otherContext = await browser.newContext({
      baseURL: "http://localhost:3010",
    });
    const other = await otherContext.newPage();
    try {
      await login(page);
      await login(other);
      await page.goto("/work");
      const original = `Conflict original ${crypto.randomUUID()}`;
      const local = `My offline edit ${crypto.randomUUID()}`;
      const remote = `Changed elsewhere ${crypto.randomUUID()}`;
      await page.getByRole("button", { name: "Details", exact: true }).click();
      await page
        .getByRole("combobox", { name: /What needs doing/ })
        .fill(original);
      await page
        .getByRole("button", { name: "Add to-do", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: original, exact: true }),
      ).toBeVisible();
      await warmOffline(page, "/work");
      await other.goto("/work");
      await expect(
        other.getByRole("heading", { name: original, exact: true }),
      ).toBeVisible();
      await page.bringToFront();
      await context.setOffline(true);
      await page
        .getByRole("button", { name: `Details ${original}`, exact: true })
        .click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByRole("textbox", { name: /What needs doing/ }).fill(local);
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: local, exact: true }),
      ).toBeVisible();
      await other.bringToFront();
      await other
        .getByRole("button", { name: `Details ${original}`, exact: true })
        .click();
      await other.getByRole("button", { name: "Edit", exact: true }).click();
      await other
        .getByRole("textbox", { name: /What needs doing/ })
        .fill(remote);
      await other
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await expect(
        other.getByRole("heading", { name: remote, exact: true }),
      ).toBeVisible();
      await page.bringToFront();
      await context.setOffline(false);
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                JSON.parse(
                  localStorage.getItem("heima-offline-queue") ?? "[]",
                )[0]?.state,
            ),
          { timeout: 30_000 },
        )
        .toBe("conflict");
      await page.getByRole("button", { name: "Review sync" }).click();
      await page
        .getByRole("button", { name: "Compare changes", exact: true })
        .click();
      const comparison = page.getByRole("dialog", { name: "Compare changes" });
      await expect(
        comparison.getByRole("heading", { name: "When you opened it" }),
      ).toBeVisible();
      await expect(
        comparison.getByRole("heading", { name: "Your change" }),
      ).toBeVisible();
      await expect(
        comparison.getByRole("heading", { name: "Current household version" }),
      ).toBeVisible();
      await expect(comparison).toContainText(original);
      await expect(comparison).toContainText(local);
      await expect(comparison).toContainText(remote);
      await page.evaluate(async () => {
        await Promise.race([
          Promise.all(
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.effect?.getTiming().iterations !== Infinity,
              )
              .map((animation) => animation.finished.catch(() => undefined)),
          ),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(new Error("Foreground UI animations did not settle")),
              2_000,
            ),
          ),
        ]);
      });
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        accessibility.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map((node) => node.target),
        })),
      ).toEqual([]);
      await page.screenshot({
        path: info.outputPath(`work-conflict-${choice}.png`),
        fullPage: false,
      });
      await comparison
        .getByRole("button", {
          name:
            choice === "discard"
              ? "Discard my change"
              : "Apply to current version",
        })
        .click();
      await expect.poll(() => queued(page), { timeout: 30_000 }).toBe(0);
      await other.reload();
      await expect(
        other.getByRole("heading", {
          name: choice === "discard" ? remote : local,
          exact: true,
        }),
      ).toBeVisible();
    } finally {
      await context.setOffline(false);
      await otherContext.close();
    }
  });
}

test("Revoked eligibility purges private offline data before disconnected navigation", async ({
  page,
  context,
  browserName,
}, info) => {
  test.setTimeout(90_000);
  // Fixture controls are local only. The suite runs serially after HTTP checks.
  try {
    await login(page);
    await warmOffline(page, "/work");
    const denial = await fetch("http://127.0.0.1:3212/__controls", {
      method: "POST",
      body: JSON.stringify({
        denyUser: "00000000-0000-4000-8000-000000000001",
      }),
    });
    expect(denial.ok).toBe(true);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "An invitation is needed." }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          lease: !!localStorage.getItem("heima-offline-lease"),
          queue: !!localStorage.getItem("heima-offline-queue"),
          privateKeys: Object.keys(localStorage).filter((key) =>
            key.startsWith("heima-offline-data:"),
          ),
        })),
      )
      .toEqual({ lease: false, queue: false, privateKeys: [] });
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await caches.keys()).includes("heima-private-shell-v1"),
        ),
      )
      .toBe(false);
    await context.setOffline(true);
    test.skip(
      webKitOfflineNavigationUnsupported(browserName),
      offlineNavigationLimitation,
    );
    await page.goto("/work");
    await expect(
      page.getByRole("heading", { name: "Household work", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("revoked-offline-private-cache-purged.png"),
      fullPage: true,
    });
  } finally {
    const reset = await fetch("http://127.0.0.1:3212/__controls", {
      method: "POST",
      body: JSON.stringify({ reset: true }),
    });
    expect(reset.ok).toBe(true);
    await context.setOffline(false);
  }
});

test("Changing account in another tab removes old private work and rejects its principal", async ({
  page,
  context,
}, info) => {
  test.setTimeout(90_000);
  await login(page);
  await page.goto("/work");
  const title = `Private owner task ${crypto.randomUUID()}`;
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("combobox", { name: /What needs doing/ }).fill(title);
  await page
    .getByRole("combobox", { name: "Who can see it?", exact: true })
    .selectOption("personal");
  await page.getByRole("button", { name: "Add to-do", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await warmOffline(page, "/work");
  const other = await context.newPage();
  await other.goto("/settings/household");
  await other.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    other.getByRole("button", { name: "Continue with Usable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Reconnect to continue", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toHaveCount(0);
  await login(other, "spouse");
  await other.goto("/work");
  await expect(other.locator(".loading-state")).toHaveCount(0);
  await expect(
    other.getByRole("heading", { name: title, exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Reconnect to continue", exact: true }),
  ).toBeVisible();
  const stalePrincipal = await page.request.get("/api/backend/work/items", {
    headers: { "x-heima-actor-id": "00000000-0000-4000-8000-000000000001" },
  });
  expect(stalePrincipal.status()).toBe(403);
  const session = await (await page.request.get("/api/auth/session")).json();
  expect(session.user.id).toBe("00000000-0000-4000-8000-000000000002");
  await page.screenshot({
    path: info.outputPath("old-tab-private-data-removed.png"),
    fullPage: false,
  });
});

test("Shopping conflict reapply keeps the list and one item identity", async ({
  page,
  context,
  browser,
}, info) => {
  test.setTimeout(90_000);
  const otherContext = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  const other = await otherContext.newPage();
  try {
    await login(page);
    await login(other);
    await page.goto("/shopping");
    await page.getByRole("button", { name: "New list", exact: true }).click();
    await page
      .getByRole("textbox", { name: /List name/ })
      .fill(`Conflict list ${crypto.randomUUID()}`);
    await page
      .getByRole("button", { name: "Create list", exact: true })
      .click();
    await expect(page).toHaveURL(/\/shopping\/[0-9a-f-]{36}$/);
    const path = new URL(page.url()).pathname;
    const original = `Bread ${crypto.randomUUID()}`;
    const local = `Wholegrain bread ${crypto.randomUUID()}`;
    const remote = `Rye bread ${crypto.randomUUID()}`;
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await page
      .getByRole("combobox", { name: /What do we need/ })
      .fill(original);
    await page
      .getByRole("button", { name: "Add shopping", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: `Edit ${original}`, exact: true }),
    ).toBeVisible();
    await warmOffline(page, path);
    await other.goto(path);
    await expect(
      other.getByRole("button", { name: `Edit ${original}`, exact: true }),
    ).toBeVisible();
    const before = await (
      await page.request.get("/api/backend/shopping/items", {
        headers: { "x-heima-actor-id": "00000000-0000-4000-8000-000000000001" },
      })
    ).json();
    const originalItem = before.items.find(
      (item: { name: string }) => item.name === original,
    );
    expect(originalItem).toBeTruthy();
    await context.setOffline(true);
    await page
      .getByRole("button", { name: `Edit ${original}`, exact: true })
      .click();
    await page.getByRole("textbox", { name: /^Item/ }).fill(local);
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await other
      .getByRole("button", { name: `Edit ${original}`, exact: true })
      .click();
    await other.getByRole("textbox", { name: /^Item/ }).fill(remote);
    await other
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(
      other.getByRole("button", { name: `Edit ${remote}`, exact: true }),
    ).toBeVisible();
    await context.setOffline(false);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              JSON.parse(localStorage.getItem("heima-offline-queue") ?? "[]")[0]
                ?.state,
          ),
        { timeout: 30_000 },
      )
      .toBe("conflict");
    await page.getByRole("button", { name: "Review sync" }).click();
    await page
      .getByRole("button", { name: "Compare changes", exact: true })
      .click();
    const comparison = page.getByRole("dialog", { name: "Compare changes" });
    await expect(comparison).toContainText(original);
    await expect(comparison).toContainText(local);
    await expect(comparison).toContainText(remote);
    await page.evaluate(async () =>
      Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished.catch(() => undefined)),
      ),
    );
    await page.screenshot({
      path: info.outputPath("shopping-conflict-comparison.png"),
      fullPage: false,
    });
    await comparison
      .getByRole("button", { name: "Apply to current version", exact: true })
      .click();
    await expect.poll(() => queued(page), { timeout: 30_000 }).toBe(0);
    const after = await (
      await page.request.get("/api/backend/shopping/items", {
        headers: { "x-heima-actor-id": "00000000-0000-4000-8000-000000000001" },
      })
    ).json();
    const saved = after.items.filter(
      (item: { name: string }) => item.name === local,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(originalItem.id);
    expect(saved[0].listId).toBe(originalItem.listId);
  } finally {
    await context.setOffline(false);
    await otherContext.close();
  }
});

test("Observed list permission loss cannot reappear from offline cache", async ({
  page,
  browser,
  browserName,
}, info) => {
  test.setTimeout(90_000);
  const spouseContext = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  const spouse = await spouseContext.newPage();
  try {
    await login(page);
    await login(spouse, "spouse");
    await page.goto("/shopping");
    const title = `Scope cache ${crypto.randomUUID()}`;
    await page.getByRole("button", { name: "New list", exact: true }).click();
    await page.getByRole("textbox", { name: /List name/ }).fill(title);
    await page
      .getByRole("button", { name: "Create list", exact: true })
      .click();
    await expect(page).toHaveURL(/\/shopping\/[0-9a-f-]{36}$/);
    const path = new URL(page.url()).pathname;
    const privateItem = `Private shopping item ${crypto.randomUUID()}`;
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await page
      .getByRole("combobox", { name: /What do we need/ })
      .fill(privateItem);
    await page
      .getByRole("button", { name: "Add shopping", exact: true })
      .click();
    await warmOffline(spouse, path);
    await expect(
      spouse.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^Change list visibility/ }).click();
    await page
      .getByRole("button", { name: "Confirm change", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", {
        name: "Make this list personal?",
        exact: true,
      }),
    ).not.toBeVisible();
    await spouse.reload();
    await expect(
      spouse.getByRole("heading", { name: title, exact: true }),
    ).toHaveCount(0);
    await expect(spouse.locator(".loading-state")).toHaveCount(0);
    await expect(
      spouse.getByRole("button", { name: /Try again/ }),
    ).toBeVisible();
    await expect
      .poll(() =>
        spouse.evaluate(
          ({ title, privateItem }) =>
            Object.keys(localStorage)
              .filter((key) => key.startsWith("heima-offline-data:"))
              .some((key) => {
                const value = localStorage.getItem(key) ?? "";
                return value.includes(title) || value.includes(privateItem);
              }),
          { title, privateItem },
        ),
      )
      .toBe(false);
    await spouseContext.setOffline(true);
    test.skip(
      webKitOfflineNavigationUnsupported(browserName),
      offlineNavigationLimitation,
    );
    await spouse.reload();
    await expect(spouse.locator(".loading-state")).toHaveCount(0);
    await expect(
      spouse.getByRole("heading", { name: title, exact: true }),
    ).toHaveCount(0);
    await spouse.screenshot({
      path: info.outputPath("scope-loss-offline-cache-removed.png"),
      fullPage: false,
    });
  } finally {
    await spouseContext.setOffline(false);
    await spouseContext.close();
  }
});
