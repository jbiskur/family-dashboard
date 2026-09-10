import { readFileSync } from "node:fs";
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
test.use({ trace: "off", video: "off" });
test("Occurrence edit, monthly successor, explicit series stop and removed history connect", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("owner@heima.test");
  if (!env.TEST_USER_PASSWORD)
    throw new Error("Missing local fixture password");
  await page.locator("#password").fill(env.TEST_USER_PASSWORD);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/");
  await page.goto("/work");
  const base = `Monthly recycling ${crypto.randomUUID()}`;
  const once = `This collection only ${crypto.randomUUID()}`;
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByRole("combobox", { name: /What needs doing/ }).fill(base);
  await page.getByText("More details & options", { exact: true }).click();
  await page
    .getByRole("combobox", { name: "Repeat", exact: true })
    .selectOption("month");
  await page.getByRole("button", { name: "Add to-do", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "To-do details" }).getByRole("alert"),
  ).toBeVisible();
  const unanchored = await page.request.get("/api/backend/work/items", {
    headers: { "x-heima-actor-id": "00000000-0000-4000-8000-000000000001" },
  });
  expect(
    (await unanchored.json()).items.some(
      (item: { title: string }) => item.title === base,
    ),
  ).toBe(false);
  await page
    .getByLabel("Due date (optional)", { exact: true })
    .fill("2036-01-31");
  await page.getByRole("button", { name: "Add to-do", exact: true }).click();
  await page
    .getByRole("button", { name: `Details ${base}`, exact: true })
    .click();
  await expect(page).toHaveURL(/\/work\?item=[0-9a-f-]{36}$/);
  const originalId = new URL(page.url()).searchParams.get("item");
  expect(originalId).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Edit this occurrence" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Repeat", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: /What needs doing/ }).fill(once);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("button", { name: `Details ${once}`, exact: true })
    .click();
  await page
    .getByRole("dialog", { name: once })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  const read = async (id: string) => {
    const response = await page.request.get(`/api/backend/work/items/${id}`, {
      headers: { "x-heima-actor-id": "00000000-0000-4000-8000-000000000001" },
    });
    expect(response.status()).toBe(200);
    return response.json();
  };
  await expect.poll(async () => (await read(originalId!)).status).toBe("done");
  const completed = await read(originalId!);
  const next = await read(completed.nextOccurrenceId);
  expect(next.title).toBe(base);
  expect(next.dueDate).toBe("2036-02-29");
  expect(next.previousOccurrenceId).toBe(originalId);
  await page.goto(`/work?item=${next.id}`);
  await page
    .getByRole("button", { name: "Edit repeating schedule", exact: true })
    .click();
  const schedule = page.getByRole("dialog", {
    name: "Edit repeating schedule",
  });
  await expect(schedule).toContainText(
    "Completed and skipped occurrences keep their original history",
  );
  await schedule
    .getByRole("combobox", { name: "Repeat", exact: true })
    .selectOption("");
  await page.screenshot({
    path: info.outputPath("work-explicit-stop-series.png"),
    fullPage: false,
  });
  await schedule
    .getByRole("button", { name: "Confirm schedule change", exact: true })
    .click();
  await expect.poll(async () => (await read(next.id)).recurrence).toBeNull();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByRole("button", { name: "Remove to-do", exact: true }).click();
  await expect.poll(async () => (await read(next.id)).archived).toBe(true);
  await page.getByRole("button", { name: "Removed work", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Removed work" })
    .getByRole("button")
    .filter({ hasText: base })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Change history" }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Change history" }),
  ).toContainText("Removed");
  await page.screenshot({
    path: info.outputPath("work-removed-history.png"),
    fullPage: false,
  });
});
