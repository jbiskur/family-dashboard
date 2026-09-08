import { readFileSync } from "node:fs";
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

test("entry and Home keep their optimized illustration at mobile and desktop widths", async ({
  page,
}, info) => {
  await page.goto("/");
  const inspect = async (state: string, alt: string) => {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const illustration = page.getByRole("img", { name: alt, exact: true });
      await expect(illustration).toBeVisible();
      const image = await illustration.evaluate(
        async (element: HTMLImageElement) => {
          await element.decode();
          return {
            src: element.currentSrc,
            width: element.naturalWidth,
            height: element.naturalHeight,
          };
        },
      );
      expect(image.src).toContain("/_next/image?");
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
      const response = await page.request.get(image.src);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-type"]).toMatch(/^image\//);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(width + 1);
      await page.screenshot({
        path: info.outputPath(`image-${state}-${width}.png`),
        fullPage: true,
      });
    }
  };
  await inspect(
    "entry",
    "A welcoming Scandinavian home surrounded by hills and trees",
  );
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("owner@heima.test");
  await page.locator("#password").fill(settings.TEST_USER_PASSWORD ?? "");
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  await expect(
    page.getByRole("heading", { name: "Welcome home.", exact: true }),
  ).toBeVisible();
  await inspect(
    "home",
    "A warm kitchen with groceries and green hills outside",
  );
});

test("Home quick capture connects to the owning list and Work without duplicate entries", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("owner@heima.test");
  await page.locator("#password").fill(settings.TEST_USER_PASSWORD!);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  await page.goto("/shopping");
  const list = `Home groceries ${crypto.randomUUID()}`;
  await page.getByRole("button", { name: "New list", exact: true }).click();
  await page
    .getByRole("textbox", { name: "List name", exact: true })
    .fill(list);
  await page.getByRole("button", { name: "Create list", exact: true }).click();
  await expect(page).toHaveURL(
    /^http:\/\/localhost:3010\/shopping\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  await expect(
    page.getByRole("heading", { name: list, exact: true, level: 1 }),
  ).toBeVisible();
  const listPath = new URL(page.url()).pathname;
  await page.goto("/");
  await page
    .getByRole("button", { name: "Shopping item", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Shopping list", exact: true })
    .selectOption({ label: list });
  await page
    .getByRole("textbox", { name: "What do we need?", exact: true })
    .fill("Apples for lunch");
  await page.getByLabel("Quantity", { exact: true }).fill("6");
  await page.getByRole("button", { name: "Add it", exact: true }).click();
  await expect(page.locator(".notice")).toContainText(
    "Added to your shopping list.",
  );
  await page.goto(listPath);
  await expect(
    page.getByRole("button", {
      name: "Complete Apples for lunch",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("heading", { name: "Apples for lunch· 6", exact: true }),
  ).toBeVisible();
  await page.goto("/");
  const title = `Book family dentist ${crypto.randomUUID()}`;
  await page.getByRole("button", { name: "To-do", exact: true }).click();
  await page
    .getByRole("textbox", { name: "What needs doing?", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "Add it", exact: true }).click();
  await expect(page.locator(".notice")).toContainText("Added to Work.");
  await page.getByRole("link", { name: "See what's on today" }).click();
  await expect(page).toHaveURL(/\/work$/);
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toHaveCount(1);
  await page.goto("/");
  await page.screenshot({
    path: info.outputPath("home-connected-capture.png"),
    fullPage: true,
  });
});
