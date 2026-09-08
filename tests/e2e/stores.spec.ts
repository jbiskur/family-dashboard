import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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
for (const width of [1440, 320]) {
  test(`Store search, offer, foreground suggestion and archived history at ${width}px`, async ({
    page,
    context,
  }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await context.grantPermissions(["geolocation"]);
    const latitude = -60 + Math.random() * 120;
    const longitude = -150 + Math.random() * 300;
    await context.setGeolocation({ latitude, longitude });
    await page.goto("/");
    await page.getByRole("button", { name: "Continue with Usable" }).click();
    await page.locator("#username").fill("owner@heima.test");
    if (!env.TEST_USER_PASSWORD)
      throw new Error("Missing local fixture password");
    await page.locator("#password").fill(env.TEST_USER_PASSWORD);
    await page.locator("#kc-login").click();
    await expect(page).toHaveURL("http://localhost:3010/");
    const headers = {
      "x-heima-actor-id": "00000000-0000-4000-8000-000000000001",
    };
    const read = async (path: string) => {
      const response = await page.request.get(`/api/backend/${path}`, {
        headers,
      });
      expect(response.status()).toBe(200);
      return response.json();
    };
    const capture = async (name: string) => {
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
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        axe.violations.map(({ id, nodes }) => ({
          id,
          targets: nodes.map((node) => node.target),
        })),
      ).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`${name}-${width}.png`),
        fullPage: false,
      });
    };
    const store = `Corner market ${crypto.randomUUID()}`;
    await page.goto("/shopping/stores");
    await page.getByRole("button", { name: "Add store", exact: true }).click();
    await page.getByRole("textbox", { name: /Store name/ }).fill(store);
    await page
      .getByRole("combobox", { name: "Colour", exact: true })
      .selectOption("#28594B");
    await page
      .getByRole("spinbutton", { name: "Latitude (optional)", exact: true })
      .fill(String(latitude));
    await page
      .getByRole("spinbutton", { name: "Longitude (optional)", exact: true })
      .fill(String(longitude));
    await page
      .getByRole("spinbutton", {
        name: "Detection radius (metres)",
        exact: true,
      })
      .fill("100");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: store, exact: true }),
    ).toBeVisible();
    const savedStore = (await read("shopping/stores")).items.find(
      (row: { name: string }) => row.name === store,
    );
    expect(savedStore.latitude).toBe(latitude);
    expect(savedStore.radius).toBe(100);
    await page
      .getByRole("textbox", { name: "Find a store", exact: true })
      .fill(store);
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page
      .getByRole("spinbutton", {
        name: "Detection radius (metres)",
        exact: true,
      })
      .fill("120");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Edit store", exact: true }),
    ).toBeHidden();
    const editedStore = await read(`shopping/stores/${savedStore.id}`);
    expect(editedStore.id).toBe(savedStore.id);
    expect(editedStore.radius).toBe(120);
    await page.goto("/shopping");
    await page.getByRole("button", { name: "New list", exact: true }).click();
    await page
      .getByRole("textbox", { name: /List name/ })
      .fill(`Weekend shop ${crypto.randomUUID()}`);
    await page
      .getByRole("button", { name: "Create list", exact: true })
      .click();
    await expect(page).toHaveURL(/\/shopping\/[0-9a-f-]{36}$/);
    const listPath = new URL(page.url()).pathname;
    const name = `Fresh bread ${crypto.randomUUID()}`;
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    await page.getByRole("textbox", { name: /^Item/ }).fill(name);
    await page
      .getByRole("searchbox", {
        name: "Search store offer choices",
        exact: true,
      })
      .fill(store);
    await page
      .getByRole("combobox", { name: "Store offer", exact: true })
      .selectOption(savedStore.id);
    await capture("searchable-store-offer");
    await page
      .getByRole("button", { name: "Add to list", exact: true })
      .click();
    await expect(
      page.getByText(`Offer · ${store}`, { exact: true }),
    ).toBeVisible();
    for (const offer of ["", savedStore.id]) {
      await page
        .getByRole("button", { name: `Edit ${name}`, exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "Store offer", exact: true })
        .selectOption(offer);
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Edit item", exact: true }),
      ).toBeHidden();
      const updated = (await read("shopping/items")).items.find(
        (row: { name: string }) => row.name === name,
      );
      expect(updated.offerStoreId).toBe(offer || null);
      expect(updated.completed).toBe(false);
    }
    await page
      .getByRole("button", { name: `Complete ${name}`, exact: true })
      .click();
    const purchase = page.getByRole("dialog", {
      name: "Where did you pick it up?",
    });
    await expect(purchase).toBeVisible();
    let item = (await read("shopping/items")).items.find(
      (row: { name: string }) => row.name === name,
    );
    expect(item.completed).toBe(true);
    expect(item.purchaseStoreId).toBeNull();
    const itemId = item.id;
    const purchaseId = item.purchaseId;
    await purchase
      .getByRole("button", { name: "Suggest a nearby store", exact: true })
      .click();
    await expect(purchase.getByRole("status")).toContainText(
      `Nearby: ${store}. Confirm below`,
    );
    expect((await read(`shopping/items/${itemId}`)).purchaseStoreId).toBeNull();
    await capture("foreground-store-suggestion");
    await purchase
      .getByRole("button", { name: "Save store", exact: true })
      .click();
    await expect(purchase).toBeHidden();
    item = await read(`shopping/items/${itemId}`);
    expect(item.purchaseStoreId).toBe(savedStore.id);
    expect(item.purchaseId).toBe(purchaseId);
    expect(item.latitude).toBeUndefined();
    expect(item.longitude).toBeUndefined();
    await page.getByRole("button", { name: /^Picked up/ }).click();
    await page
      .getByRole("button", { name: `Edit ${name}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Purchase store", exact: true })
      .click();
    await page
      .getByRole("combobox", { name: "Store", exact: true })
      .selectOption("");
    await page.getByRole("button", { name: "Save store", exact: true }).click();
    await expect(purchase).toBeHidden();
    item = await read(`shopping/items/${itemId}`);
    expect(item.purchaseStoreId).toBeNull();
    expect(item.purchaseId).toBe(purchaseId);
    expect(item.completed).toBe(true);
    await context.setGeolocation({ latitude: 89, longitude: 179 });
    await page
      .getByRole("button", { name: `Edit ${name}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: "Purchase store", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Suggest a nearby store", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog", { name: "Where did you pick it up?" })
        .getByRole("status"),
    ).toContainText("No nearby store found");
    await page
      .getByRole("combobox", { name: "Store", exact: true })
      .selectOption(savedStore.id);
    await capture("manual-store-after-no-location-match");
    await page.getByRole("button", { name: "Save store", exact: true }).click();
    await expect(purchase).toBeHidden();
    expect((await read(`shopping/items/${itemId}`)).purchaseId).toBe(
      purchaseId,
    );
    await page.goto("/shopping/stores");
    await page
      .getByRole("textbox", { name: "Find a store", exact: true })
      .fill(store);
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await page
      .getByRole("button", { name: "Archive store", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: store, exact: true }),
    ).toHaveCount(0);
    await page.goto(listPath);
    await page.getByRole("button", { name: /^Picked up/ }).click();
    await expect(
      page.getByText(`Offer · ${store}`, { exact: true }),
    ).toBeVisible();
    const history = await read(`shopping/items/${itemId}/history`);
    expect(
      history.items.some(
        (row: { after?: { purchaseStoreId?: string } }) =>
          row.after?.purchaseStoreId === savedStore.id,
      ),
    ).toBe(true);
    await capture("archived-offer-history-preserved");
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    await expect(
      page
        .getByRole("combobox", { name: "Store offer", exact: true })
        .locator(`option[value="${savedStore.id}"]`),
    ).toHaveCount(0);
  });
}
