import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const password = Object.fromEntries(
  readFileSync(".env.test.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
).TEST_USER_PASSWORD;
test.use({ trace: "off", video: "off" });
async function read(page: Page, actorId: string, path: string) {
  const response = await page.request.get(`/api/backend/${path}`, {
    headers: { "x-heima-actor-id": actorId },
  });
  expect(response.status(), path).toBe(200);
  return response.json();
}
test("profile create, rename and archive preserve assigned work without granting a login", async ({
  page,
}, info) => {
  if (!password) throw new Error("Missing local fixture password");
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("owner@heima.test");
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  const session = await page.request.get("/api/auth/session");
  expect(session.ok()).toBe(true);
  const actorId = (await session.json()).user.id as string;
  const before = await read(page, actorId, "access");
  const original = `Profile ${crypto.randomUUID()}`;
  const renamed = `Renamed ${crypto.randomUUID()}`;
  const title = `Assigned responsibility ${crypto.randomUUID()}`;
  await page.goto("/settings/household");
  await page
    .getByRole("button", { name: "Add a household profile", exact: true })
    .click();
  let dialog = page.getByRole("dialog", {
    name: "Add a household profile",
    exact: true,
  });
  await expect(dialog).toContainText("No login or data access");
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill(original);
  await dialog
    .getByRole("button", { name: "Add profile", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const created = (await read(page, actorId, "household/profiles")).items.find(
    (item: { name: string }) => item.name === original,
  );
  expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: new RegExp(`^${original}`) }).click();
  dialog = page.getByRole("dialog", {
    name: "Update this profile",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill(renamed);
  await dialog.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const updated = (await read(page, actorId, "household/profiles")).items.find(
    (item: { id: string }) => item.id === created.id,
  );
  expect(updated).toMatchObject({ id: created.id, name: renamed });
  await page.screenshot({
    path: info.outputPath("profile-renamed-no-login.png"),
  });
  await page.goto("/work");
  await page.getByRole("button", { name: "Add a to-do", exact: true }).click();
  await page.getByRole("textbox", { name: /What needs doing/ }).fill(title);
  await page
    .getByRole("combobox", { name: "Who's on it?", exact: true })
    .selectOption(created.id);
  await page.getByRole("button", { name: "Add to-do", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  const work = (await read(page, actorId, "work/items")).items.find(
    (item: { title: string }) => item.title === title,
  );
  expect(work.assigneeId).toBe(created.id);
  await page.goto("/settings/household");
  await page
    .getByRole("button", { name: `Archive ${renamed}`, exact: true })
    .click();
  dialog = page.getByRole("dialog", {
    name: "Archive this profile?",
    exact: true,
  });
  await expect(dialog).toContainText("Past assignments keep their name");
  await dialog
    .getByRole("button", { name: "Archive profile", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect(
    (await read(page, actorId, "household/profiles")).items.some(
      (item: { id: string }) => item.id === created.id,
    ),
  ).toBe(false);
  expect(
    (
      await read(page, actorId, "household/profiles?includeArchived=true")
    ).items.find((item: { id: string }) => item.id === created.id),
  ).toMatchObject({ name: renamed, archived: true });
  await page.goto(`/work?item=${work.id}`);
  dialog = page.getByRole("dialog", { name: title, exact: true });
  await expect(dialog).toContainText(renamed);
  await page.screenshot({
    path: info.outputPath("archived-profile-assignment-retained.png"),
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Add a to-do", exact: true }).click();
  const assignment = page.getByRole("combobox", {
    name: "Who's on it?",
    exact: true,
  });
  await expect(assignment.locator(`option[value="${created.id}"]`)).toHaveCount(
    0,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect((await read(page, actorId, `work/items/${work.id}`)).assigneeId).toBe(
    created.id,
  );
  const history = await read(
    page,
    actorId,
    `household/profiles/${created.id}/history`,
  );
  expect(history.items.length).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(history)).toContain(original);
  expect(JSON.stringify(history)).toContain(renamed);
  expect((await read(page, actorId, "access")).members).toEqual(before.members);
});
