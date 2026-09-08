import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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

type Receipt = {
  feature: string;
  path: string;
  screenshot: string;
  state: string;
};
const ids = {
  login: "356f3e15-0c04-4aac-a838-55352310e95c",
  shell: "1795cf35-a5ca-4290-a526-5bcbecad9a27",
  home: "075fefa3-1232-4a15-80d3-a6520e500fd1",
  activity: "fc1b28d5-86d1-45bc-9be4-8011d3e96393",
  lists: "a0c751ca-1dbe-4d54-905e-c741ad852345",
  items: "95e4fc63-efc0-4496-b9f9-c575eae1fd15",
  listScope: "1154e9d2-f333-41fb-a6f6-a93653fbefc8",
  stores: "748622b5-4c53-4f89-a62e-c6ffdcf81509",
  offers: "85e60f20-ca21-4fa1-95cb-ec507c56e3c2",
  purchases: "06485852-13f5-474a-b30f-e75fe82cf7d0",
  work: "91af72df-8407-49ea-ab25-738aa02b6bc4",
  assignment: "a83f1ed2-d88b-44a1-87b6-119ab2ef8053",
  recurrence: "64e88dcf-cfa7-4882-8863-4ef8dccc7391",
  workScope: "4e2d9ae3-ef97-4a6f-9c8f-dc5c514f7d1f",
  workHistory: "2e58d7da-a071-4cb3-9d13-8ac8a8d4af6e",
  finance: "5acb0582-b26c-4d24-9454-883b84e286f5",
  spending: "0230cd86-af8c-437a-9a01-afb4839ddb25",
  accounts: "69595cdd-68c2-4884-9ae9-ff929df200ce",
  account: "4309c82f-f717-4d56-8faa-cc5d492fad75",
  transactions: "7f3e4bf3-6659-4010-8c57-b1be2f9f12c9",
  exception: "10c22d2d-b275-4042-a5e2-3409a8a006d5",
  categories: "1ac0abfd-e7f7-4d7f-8b06-c1256f0eb680",
  budgets: "f972dec6-6666-4338-b2ec-3e246e3ff2d2",
  imports: "d1712d7f-af94-4946-8629-c065fb780a23",
  reconciliation: "e1664e78-0689-48fa-a609-3c7e2d467772",
  profiles: "7025de7c-5fb5-4e08-939b-eff542fb1dc3",
  notifications: "eb2cefa6-5a47-481e-b430-89960338ed72",
};

for (const width of [1440, 320]) {
  test(`feature UI path evidence at ${width}px`, async ({ page }, info) => {
    test.setTimeout(180_000);
    const receipts: Receipt[] = [];
    async function capture(state: string, ...features: string[]) {
      await expect(page.locator(".loading-state")).toHaveCount(0);
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        );
      });
      expect
        .soft(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${state} fits viewport`,
        )
        .toBe(true);
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      await info.attach(`${state}-accessibility`, {
        body: JSON.stringify(accessibility.violations, null, 2),
        contentType: "application/json",
      });
      expect
        .soft(
          accessibility.violations.map((v) => ({
            id: v.id,
            targets: v.nodes.map((n) => n.target),
          })),
          `${state}: WCAG A/AA`,
        )
        .toEqual([]);
      const screenshot = `${state}-${width}.png`;
      await page.screenshot({
        path: info.outputPath(screenshot),
        fullPage: true,
      });
      receipts.push(
        ...features.map((feature) => ({
          feature,
          path: new URL(page.url()).pathname + new URL(page.url()).search,
          screenshot,
          state,
        })),
      );
    }
    async function visit(path: string, state: string, ...features: string[]) {
      await page.goto(path);
      await expect(page.locator("#main-content")).toBeVisible();
      await expect(
        page.getByText("This page could not be found.", { exact: true }),
      ).toHaveCount(0);
      await capture(state, ...features);
    }
    async function dialog(
      button: string,
      state: string,
      ...features: string[]
    ) {
      await page.getByRole("button", { name: button, exact: true }).click();
      await expect(page.getByRole("dialog").last()).toBeVisible();
      await capture(state, ...features);
      await page.keyboard.press("Escape");
    }
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await capture("login", ids.login);
      await page.getByRole("button", { name: "Continue with Usable" }).click();
      const password = settings.TEST_USER_PASSWORD;
      if (!password) throw new Error("Missing local fixture password");
      await page.locator("#username").fill("owner@heima.test");
      await page.locator("#password").fill(password);
      await page.locator("#kc-login").click();
      await expect(page).toHaveURL("http://localhost:3010/", {
        timeout: 30_000,
      });
      await capture("home", ids.home, ids.shell, ids.activity);
      await dialog("Quick add", "home-quick-add", ids.home);
      await visit("/shopping", "shopping-directory", ids.lists);
      await dialog("New list", "shopping-create-list", ids.lists);
      const list = page.locator('a.list-card[href^="/shopping/"]').first();
      await expect(
        list,
        "Fixture has an existing shopping list for detail evidence",
      ).toBeVisible();
      await list.click();
      await capture(
        "shopping-list-detail",
        ids.items,
        ids.offers,
        ids.purchases,
      );
      await dialog(
        "Add item",
        "shopping-add-item-offer",
        ids.items,
        ids.offers,
      );
      await page
        .getByRole("button", { name: /^Change list visibility/ })
        .click();
      await capture("shopping-list-visibility-confirmation", ids.listScope);
      await page.keyboard.press("Escape");
      const itemEdit = page.getByRole("button", { name: /^Edit / }).first();
      if (await itemEdit.count()) {
        await itemEdit.click();
        await capture(
          "shopping-item-edit",
          ids.items,
          ids.offers,
          ids.purchases,
        );
        await page.keyboard.press("Escape");
      }
      const allItemsResponse = await page.request.get(
        "/api/backend/shopping/items",
        {
          headers: {
            "x-heima-actor-id": "00000000-0000-4000-8000-000000000001",
          },
        },
      );
      const allItems = await allItemsResponse.json();
      const completed = allItems.items?.find(
        (item: { completed: boolean }) => item.completed,
      );
      if (completed) {
        await page.goto(`/shopping/${completed.listId}`);
        await page.getByRole("button", { name: /^Picked up/ }).click();
        await page
          .getByRole("button", { name: `Edit ${completed.name}`, exact: true })
          .click();
        await page
          .getByRole("button", { name: "Purchase store", exact: true })
          .click();
        await capture("shopping-purchase-store", ids.purchases);
        await page.keyboard.press("Escape");
      }
      await visit("/shopping/stores", "stores", ids.stores);
      await dialog("Add store", "store-create-location", ids.stores);
      await visit("/work", "work-board", ids.work);
      await page
        .getByRole("button", { name: "Add a to-do", exact: true })
        .click();
      await page.getByText("More details & options", { exact: true }).click();
      await page.getByLabel("Repeat", { exact: true }).selectOption("week");
      await capture(
        "work-create-assignment-recurrence",
        ids.work,
        ids.assignment,
        ids.recurrence,
      );
      await page.keyboard.press("Escape");
      const task = page.locator(".work-card").first();
      await expect(
        task,
        "Fixture has a work item for detail evidence",
      ).toBeVisible();
      await task.click();
      await capture("work-detail", ids.work, ids.assignment, ids.recurrence);
      await dialog("History", "work-history", ids.workHistory);
      await dialog(
        "Change visibility",
        "work-scope-confirmation",
        ids.workScope,
      );
      await page.keyboard.press("Escape");
      await visit("/finance", "finance-overview", ids.finance);
      await visit("/finance/spending", "finance-spending", ids.spending);
      await visit("/finance/accounts", "finance-accounts", ids.accounts);
      await dialog("Add account", "finance-account-create", ids.accounts);
      const account = page
        .locator('a.list-card[href^="/finance/accounts/"]')
        .first();
      await expect(
        account,
        "Fixture has account detail evidence",
      ).toBeVisible();
      await account.click();
      await capture("finance-account-detail", ids.account);
      await visit(
        "/finance/transactions",
        "finance-transactions",
        ids.transactions,
      );
      await dialog(
        "Manual exception",
        "finance-manual-exception",
        ids.exception,
      );
      await visit("/finance/budgets", "finance-budgets", ids.budgets);
      await dialog("Set a budget", "finance-budget-create", ids.budgets);
      await dialog(
        "Manage categories",
        "finance-category-tree",
        ids.categories,
      );
      await visit(
        "/finance/imports",
        "finance-imports",
        ids.imports,
        ids.reconciliation,
      );
      await visit(
        "/settings/household",
        "household-members-profiles",
        ids.login,
        ids.profiles,
      );
      await visit(
        "/settings/notifications",
        "notification-preferences",
        ids.notifications,
      );
    } finally {
      await info.attach("feature-ui-paths", {
        body: JSON.stringify(receipts, null, 2),
        contentType: "application/json",
      });
    }
  });
}
