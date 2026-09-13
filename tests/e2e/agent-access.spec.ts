import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  approveOAuth,
  beginOAuth,
  captureOAuthCallback,
  oauthClientId,
  oauthScopes,
  signInForOAuth,
} from "../fixtures/oauth";

const settings = Object.fromEntries(
  readFileSync(".env.test.local", "utf8")
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
);

async function screenshotPanel(page: Page, panel: Locator, path: string) {
  const skipLink = page.locator(".skip-link");
  if (await skipLink.count()) {
    await skipLink.evaluate((element) => {
      (element as HTMLElement).style.visibility = "hidden";
    });
  }
  await panel.screenshot({ path });
}

test("agent access offers token-free setup inside Household settings", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("admin@heima.test");
  await page.locator("#password").fill(settings.TEST_USER_PASSWORD ?? "");
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL("http://localhost:3010/", { timeout: 30000 });
  await page.goto("/settings/household");
  const panel = page.getByRole("region", { name: "Agent access", exact: true });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByText("http://localhost:3010/api/mcp", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Copy Codex setup", exact: true }),
  ).toBeVisible();
  await expect(panel.locator(".agent-command code").first()).toHaveText(
    "codex mcp add heima --url http://localhost:3010/api/mcp",
  );
  // This suite can be rerun against a database that contains a prior test
  // connection. Reconcile those visible connections through the same UI before
  // capturing the empty state.
  while (
    await panel
      .locator(".agent-connection")
      .filter({ has: page.getByText("Connected", { exact: true }) })
      .count()
  ) {
    const active = panel
      .locator(".agent-connection")
      .filter({ has: page.getByText("Connected", { exact: true }) })
      .first();
    await active.getByRole("button", { name: /Disconnect/ }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Disconnect agent", exact: true })
      .click();
  }
  await expect(
    panel.getByText("No agents connected", { exact: true }),
  ).toBeVisible();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await panel.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width + 1);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    await screenshotPanel(
      page,
      panel,
      info.outputPath(`agent-access-empty-${width}.png`),
    );
  }
  for (const summary of await panel.locator(".agent-setup summary").all())
    await summary.click();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const controls = panel.locator(".agent-setup button, .agent-setup summary");
    for (const control of await controls.all()) {
      await expect(control).toBeVisible();
      const bounds = await control.boundingBox();
      // Browser layout can report 43.9999px for a 44px CSS target at a
      // fractional device scale. Round the measurement, while still rejecting
      // any target below 43.5px.
      expect(Math.round(bounds?.width ?? 0)).toBeGreaterThanOrEqual(44);
      expect(Math.round(bounds?.height ?? 0)).toBeGreaterThanOrEqual(44);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width + 1);
  }
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  await screenshotPanel(
    page,
    panel,
    info.outputPath("agent-setup-expanded-390.png"),
  );
});

test("household connection list notices approval in another agent host", async ({
  browser,
  page,
}, info) => {
  test.setTimeout(120_000);
  await signInForOAuth(page, "admin2");
  await page.waitForLoadState("load");
  await page.goto("/settings/household");
  const panel = page.getByRole("region", {
    name: "Agent access",
    exact: true,
  });
  await expect(panel).toBeVisible();
  const active = () =>
    panel
      .locator(".agent-connection")
      .filter({ has: page.getByText("Connected", { exact: true }) });
  while (await active().count()) {
    await active()
      .first()
      .getByRole("button", { name: /Disconnect/ })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Disconnect agent", exact: true })
      .click();
  }
  const agentContext = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  try {
    const agent = await agentContext.newPage();
    await signInForOAuth(agent, "admin2");
    await agent.waitForLoadState("load");
    const flow = await beginOAuth(agent, ["heima.read"]);
    const tokens = await approveOAuth(agent, flow);
    await expect(active()).toHaveCount(1, { timeout: 15_000 });
    await screenshotPanel(
      page,
      panel,
      info.outputPath("agent-connected-external-refresh-390.png"),
    );
    const revoked = await agent.request.post("/api/oauth/revoke", {
      form: { client_id: oauthClientId, token: tokens.refreshToken },
    });
    expect(revoked.status()).toBe(200);
    await expect(active()).toHaveCount(0, { timeout: 15_000 });
    await expect(panel.getByText(/Previous connections \(\d+\)/)).toBeVisible();
  } finally {
    await agentContext.close();
    await page.goto("/settings/household");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
  }
});

test("an expired consent request provides a safe reconnect path", async ({
  page,
}, info) => {
  await page.goto(
    "/oauth/consent?request=00000000-0000-4000-8000-000000000099",
  );
  await expect(
    page.getByRole("heading", {
      name: "Start the connection again",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect agent", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("agent-consent-expired.png") });
});

test("consent grants only selected permissions, locks while saving and disconnect restores focus", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await signInForOAuth(page, "admin2");
  const flow = await beginOAuth(page, oauthScopes);
  await expect(
    page.getByRole("heading", { name: "Let Codex help?" }),
  ).toBeVisible();
  const optional = page.locator(
    'input[name="scope"]:not([value="heima.read"])',
  );
  await expect(optional).toHaveCount(3);
  for (const checkbox of await optional.all())
    await expect(checkbox).not.toBeChecked();
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width + 1);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.locator(".agent-consent-card").screenshot({
      path: info.outputPath(`agent-consent-choices-${width}.png`),
    });
  }
  let release!: () => void;
  let submitted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  await page.route("**/oauth/consent?request=*", async (route) => {
    if (route.request().method() === "POST") {
      submitted();
      await gate;
    }
    await route.continue();
  });
  const finishing = approveOAuth(page, flow, [
    "heima.read",
    "heima.shopping.write",
  ]);
  await started;
  try {
    await expect(
      page.getByRole("button", { name: "Connecting…", exact: true }),
    ).toBeDisabled();
    for (const checkbox of await optional.all())
      await expect(checkbox).toBeDisabled();
    await page
      .locator(".agent-consent-card")
      .screenshot({ path: info.outputPath("agent-consent-pending.png") });
  } finally {
    release();
  }
  const tokens = await finishing;
  expect(tokens.scope.split(" ").sort()).toEqual(
    ["heima.read", "heima.shopping.write"].sort(),
  );
  await page.unroute("**/oauth/consent?request=*");
  try {
    await page.reload();
    const panel = page.getByRole("region", {
      name: "Agent access",
      exact: true,
    });
    const connected = panel
      .locator(".agent-connection")
      .filter({ has: page.getByText("Connected", { exact: true }) });
    await expect(connected).toHaveCount(1);
    await expect(
      connected.getByText("Update shopping", { exact: true }),
    ).toBeVisible();
    await expect(
      connected.getByText("Read finances", { exact: true }),
    ).toHaveCount(0);
    await screenshotPanel(page, panel, info.outputPath("agent-connected.png"));
    await connected
      .getByRole("button", { name: "Disconnect Codex", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("button", { name: "Keep connected", exact: true })
      .click();
    await expect(
      connected.getByRole("button", { name: "Disconnect Codex", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await page
      .getByRole("button", { name: "Disconnect agent", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(connected).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Agent access", exact: true }),
    ).toBeFocused();
    await screenshotPanel(
      page,
      panel,
      info.outputPath("agent-disconnected.png"),
    );
    const denied = await page.request.post("/api/mcp", {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(denied.status()).toBe(401);
  } finally {
    await page.request.post("/api/oauth/revoke", {
      form: { client_id: oauthClientId, token: tokens.refreshToken },
    });
    await page.goto("/settings/household");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
  }
});

test("consent network failure is recoverable and cancellation grants no code", async ({
  page,
}, info) => {
  await signInForOAuth(page, "admin2");
  const flow = await beginOAuth(page, oauthScopes);
  await page.route("**/oauth/consent?request=*", async (route) => {
    if (route.request().method() === "POST")
      await route.abort("connectionfailed");
    else await route.continue();
  });
  await page
    .getByRole("button", { name: "Connect agent", exact: true })
    .click();
  await expect(
    page.locator(".agent-consent-card").getByRole("alert"),
  ).toContainText("could not be completed");
  await expect(page.locator('input[value="heima.finance.read"]')).toBeEnabled();
  await page
    .locator(".agent-consent-card")
    .screenshot({ path: info.outputPath("agent-consent-network-error.png") });
  await page.unroute("**/oauth/consent?request=*");
  const result = await captureOAuthCallback(page, flow, "cancel");
  expect(result.error).toBe("access_denied");
  expect(result.code).toBeUndefined();
  await page.goto(`/oauth/consent?request=${flow.requestId}`);
  await expect(
    page.getByRole("heading", { name: "Start the connection again" }),
  ).toBeVisible();
  await expect(page.getByText(/No access has been granted/)).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("agent-consent-cancelled.png"),
  });
  await page.goto("/settings/household");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
});
