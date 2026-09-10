import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

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
async function login(page: Page, user: string) {
  const password = settings.TEST_USER_PASSWORD;
  if (!password) throw new Error("Missing local fixture password");
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill(`${user}@heima.test`);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  const session = await page.request.get("/api/auth/session");
  expect(session.ok()).toBe(true);
  return (await session.json()).user.id as string;
}
async function read(page: Page, actorId: string, path: string, status = 200) {
  const result = await page.request.get(`/api/backend/${path}`, {
    headers: { "x-heima-actor-id": actorId },
  });
  expect(result.status(), path).toBe(status);
  return result.json();
}

for (const area of ["shopping", "work"] as const) {
  test(`${area} visibility conversion requires deliberate confirmation, preserves the full identity and revokes the other reader`, async ({
    page,
    browser,
  }, info) => {
    test.setTimeout(90000);
    const spouseContext = await browser.newContext({
      baseURL: "http://localhost:3010",
    });
    const spouse = await spouseContext.newPage();
    try {
      const actorId = await login(page, "owner");
      const spouseId = await login(spouse, "spouse");
      const title = `Visibility ${crypto.randomUUID()}`;
      await page.goto(`/${area}`);
      await page
        .getByRole("button", {
          name: area === "shopping" ? "New list" : "Details",
          exact: true,
        })
        .click();
      await page
        .getByRole(area === "shopping" ? "textbox" : "combobox", {
          name: area === "shopping" ? "List name" : "What needs doing?",
          exact: true,
        })
        .fill(title);
      await page
        .getByRole("combobox", { name: "Who can see it?", exact: true })
        .selectOption("personal");
      await page
        .getByRole("button", {
          name: area === "shopping" ? "Create list" : "Add to-do",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: title, exact: true }),
      ).toBeVisible();
      let id: string | null;
      if (area === "shopping") {
        await expect(page).toHaveURL(/\/shopping\/[0-9a-f-]{36}$/);
        id = new URL(page.url()).pathname.split("/").at(-1) ?? null;
      } else {
        await page
          .getByRole("button", { name: `Details ${title}`, exact: true })
          .click();
        await expect(page).toHaveURL(/\/work\?item=[0-9a-f-]{36}$/);
        id = new URL(page.url()).searchParams.get("item");
      }
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      const path = `${area}/${area === "shopping" ? "lists" : "items"}/${id}`;
      const original = await read(page, actorId, path);
      expect(original.visibility).toBe("personal");
      await read(spouse, spouseId, path, 404);
      const openScope = async () => {
        await page
          .getByRole("button", {
            name:
              area === "shopping"
                ? /Change list visibility:/
                : "Change visibility",
            exact: area === "work",
          })
          .click();
      };
      const confirm =
        area === "shopping" ? "Confirm change" : "Confirm visibility";
      const cancel = area === "shopping" ? "Keep it as it is" : "Cancel";
      await openScope();
      let dialog = page.getByRole("dialog", {
        name: area === "shopping" ? "Share this list?" : "Share this to-do?",
        exact: true,
      });
      await expect(dialog).toContainText("Your spouse will be able");
      await expect(dialog).toContainText("history");
      await dialog.getByRole("button", { name: cancel, exact: true }).click();
      expect(await read(page, actorId, path)).toMatchObject({
        id,
        visibility: "personal",
        version: original.version,
      });
      await read(spouse, spouseId, path, 404);
      await openScope();
      dialog = page.getByRole("dialog", {
        name: area === "shopping" ? "Share this list?" : "Share this to-do?",
        exact: true,
      });
      await page.screenshot({
        path: info.outputPath(`${area}-share-consequences.png`),
      });
      await dialog.getByRole("button", { name: confirm, exact: true }).click();
      await expect(dialog).not.toBeVisible();
      const shared = await read(page, actorId, path);
      expect(shared).toMatchObject({ id, visibility: "household" });
      expect(shared.version).toBeGreaterThan(original.version);
      expect(await read(spouse, spouseId, path)).toMatchObject({
        id,
        visibility: "household",
      });
      const uiPath =
        area === "shopping" ? `/shopping/${id}` : `/work?item=${id}`;
      await spouse.goto(uiPath);
      await expect(
        spouse.getByRole("heading", { name: title, exact: true }).first(),
      ).toBeVisible();
      await openScope();
      dialog = page.getByRole("dialog", {
        name:
          area === "shopping"
            ? "Make this list personal?"
            : "Keep this one personal?",
        exact: true,
      });
      await expect(dialog).toContainText(/spouse (will lose|loses) access/);
      await expect(dialog).toContainText(/attribut/);
      await dialog.getByRole("button", { name: cancel, exact: true }).click();
      expect(await read(page, actorId, path)).toMatchObject({
        id,
        visibility: "household",
        version: shared.version,
      });
      await openScope();
      dialog = page.getByRole("dialog", {
        name:
          area === "shopping"
            ? "Make this list personal?"
            : "Keep this one personal?",
        exact: true,
      });
      await page.screenshot({
        path: info.outputPath(`${area}-private-consequences.png`),
      });
      await dialog.getByRole("button", { name: confirm, exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(await read(page, actorId, path)).toMatchObject({
        id,
        visibility: "personal",
        ownerId: actorId,
      });
      await read(spouse, spouseId, path, 404);
      await read(spouse, spouseId, `${path}/history`, 404);
      await spouse.reload();
      await expect(
        spouse.getByRole("heading", { name: title, exact: true }),
      ).toHaveCount(0);
      const history = await read(page, actorId, `${path}/history`);
      expect(history.items.length).toBeGreaterThanOrEqual(3);
      await spouse.screenshot({
        path: info.outputPath(`${area}-reader-access-removed.png`),
      });
    } finally {
      await spouseContext.close();
    }
  });
}
