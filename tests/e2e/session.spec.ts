import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

test("a browser session without a provider grant returns to sign-in", async ({
  page,
}, info) => {
  // Use Auth.js's public encoder to exercise a valid cookie with incomplete
  // session state through the real HTTP and browser boundaries.
  const webRequire = createRequire(
    new URL("../../apps/web/package.json", import.meta.url),
  );
  const { encode } = await import(webRequire.resolve("next-auth/jwt"));
  const cookieName = "authjs.session-token";
  const cookie = await encode({
    token: {
      sub: "00000000-0000-4000-8000-000000000001",
      name: "Incomplete fixture session",
    },
    secret: settings.AUTH_SECRET!,
    salt: cookieName,
    maxAge: 60,
  });
  await page.context().addCookies([
    {
      name: cookieName,
      value: cookie,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const session = await (await page.request.get("/api/auth/session")).json();
  expect(session.sessionId).toBe("");
  expect((await page.request.get("/api/offline-lease")).status()).toBe(401);
  await page.goto("/shopping");
  await expect(page).toHaveURL("http://localhost:3010/");
  await expect(
    page.getByRole("button", { name: "Continue with Usable" }),
  ).toBeVisible();
  await expect(page.locator("#main-content")).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("missing-provider-session.png"),
    fullPage: true,
  });
});

test("opaque browser session is unusable after local and provider logout", async ({
  page,
  browser,
}, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("owner@heima.test");
  await page.locator("#password").fill(settings.TEST_USER_PASSWORD!);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  await expect(page.getByRole("navigation").first()).toBeVisible();
  const session = await (await page.request.get("/api/auth/session")).json();
  expect(session.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(session)).not.toMatch(
    /access_token|refresh_token|id_token|accessToken|refreshToken|eyJ/,
  );
  const lease = await page.request.get("/api/offline-lease");
  expect(lease.status()).toBe(200);
  expect(lease.headers()["cache-control"]).toBe("no-store");
  expect((await lease.json()).expiresAt).toBeGreaterThan(Date.now());
  const copiedCookies = await page.context().cookies();
  await page.goto("/settings/household");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue with Usable" }),
  ).toBeVisible();
  expect((await page.request.get("/api/offline-lease")).status()).toBe(401);
  const replay = await browser.newContext();
  try {
    await replay.addCookies(copiedCookies);
    expect(
      (
        await replay.request.get("http://localhost:3010/api/backend/access", {
          headers: { "x-heima-actor-id": session.user.id },
        })
      ).status(),
    ).toBe(401);
  } finally {
    await replay.close();
  }
  await page.screenshot({
    path: info.outputPath("signed-out.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await expect(page.locator("#username")).toBeVisible();
});
