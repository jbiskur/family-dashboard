import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
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
async function controls(body: Record<string, unknown>) {
  const response = await fetch("http://127.0.0.1:3212/__controls", {
    signal: AbortSignal.timeout(10000),
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}
async function bearer(user: string) {
  const response = await fetch(
    `${settings.USABLE_ISSUER}/protocol/openid-connect/token`,
    {
      signal: AbortSignal.timeout(10000),
      method: "POST",
      body: new URLSearchParams({
        grant_type: "password",
        client_id: settings.USABLE_CLIENT_ID ?? "",
        client_secret: settings.USABLE_CLIENT_SECRET ?? "",
        username: `${user}@heima.test`,
        password: settings.TEST_USER_PASSWORD ?? "",
      }),
    },
  );
  expect(response.status).toBe(200);
  return (await response.json()).access_token as string;
}
async function api(path: string, token: string, body?: unknown) {
  const response = await fetch(`http://127.0.0.1:3211/v1/${path}`, {
    signal: AbortSignal.timeout(10000),
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
async function signIn(page: Page, user: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill(`${user}@heima.test`);
  await page.locator("#password").fill(settings.TEST_USER_PASSWORD ?? "");
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL(/^http:\/\/localhost:3010\//, {
    timeout: 30000,
  });
}
test.afterEach(async () => {
  // A timed-out browser body still gets an independent cleanup budget and fresh real JWTs.
  test.setTimeout(45000);
  await controls({ reset: true });
  const ownerToken = await bearer("owner");
  const spouseToken = await bearer("spouse");
  const current = await api("access", ownerToken);
  expect(current.status).toBe(200);
  if (
    !current.data.members.some(
      (member: { role: string; status: string }) =>
        member.role === "spouse" && member.status === "active",
    )
  ) {
    const invitation = current.data.invitation;
    if (
      invitation &&
      ["pending", "requesting", "request-failed"].includes(invitation.status)
    ) {
      expect(
        (
          await api(`access/invitations/${invitation.id}/cancel`, ownerToken, {
            commandId: crypto.randomUUID(),
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await api("access/invitations", ownerToken, {
          commandId: crypto.randomUUID(),
          email: "spouse@heima.test",
        })
      ).status,
    ).toBe(201);
    expect((await api("access/admit", spouseToken, {})).status).toBe(200);
  }
  const restored = await api("access", spouseToken);
  expect(restored.status).toBe(200);
  expect(restored.data.member.status).toBe("active");
});
test("access lifecycle states show safe next actions at 320px and desktop without exposing identity secrets", async ({
  page,
  browser,
}, info) => {
  test.setTimeout(180000);
  // Exclusive fixture-control window: no other browser/HTTP suite may mutate eligibility or scheduler time.
  const spouseContext = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  const outsiderContext = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  const conflictContext = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  const spouse = await spouseContext.newPage();
  const outsider = await outsiderContext.newPage();
  const secondOwner = await conflictContext.newPage();
  const ownerToken = await bearer("owner");
  let releaseConflictAccess: () => void = () => {};
  const inspect = async (target: Page, state: string) => {
    for (const width of [320, 1440]) {
      await target.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => target.evaluate(() => window.innerWidth))
        .toBe(width);
      await target.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      });
      await target.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.getTiming().iterations !== Infinity,
            )
            .map((animation) => animation.finished.catch(() => undefined)),
        );
      });
      const main = target.locator("main").first();
      await expect(main).toBeVisible();
      await expect
        .poll(
          () => target.evaluate(() => document.documentElement.scrollWidth),
          { message: `${state} at ${width}: document width` },
        )
        .toBeLessThanOrEqual(width + 1);
      const text = await main.innerText();
      expect
        .soft(text, `${state}: no token or internal exception`)
        .not.toMatch(
          /access_token|refresh_token|id_token|eyJ[A-Za-z0-9_-]{20}|Error:|TypeError|ECONNREFUSED/,
        );
      const targets = await main
        .locator('button, a[href], input:not([type="hidden"])')
        .evaluateAll((elements) =>
          elements
            .map((element) => ({
              name:
                element.getAttribute("aria-label") ??
                element.textContent?.trim() ??
                "input",
              rect: element.getBoundingClientRect(),
              visible: element.getClientRects().length > 0,
            }))
            .filter((item) => item.visible)
            .map((item) => ({
              name: item.name,
              width: item.rect.width,
              height: item.rect.height,
            })),
        );
      for (const control of targets) {
        expect
          .soft(
            control.height,
            `${state} ${width}: ${control.name} touch height`,
          )
          .toBeGreaterThanOrEqual(44);
        expect
          .soft(control.width, `${state} ${width}: ${control.name} touch width`)
          .toBeGreaterThanOrEqual(44);
      }
      const result = await new AxeBuilder({ page: target })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      expect
        .soft(
          result.violations.map((violation) => ({
            id: violation.id,
            targets: violation.nodes.map((node) => node.target),
          })),
          `${state} ${width} accessibility`,
        )
        .toEqual([]);
      await target.screenshot({
        path: info.outputPath(`access-${state}-${width}.png`),
      });
    }
  };
  try {
    await controls({ reset: true });
    await page.goto("/");
    await inspect(page, "unauthenticated");
    await signIn(outsider, "outsider");
    await expect(
      outsider.getByText(/sign-in could not be completed/i),
    ).toBeVisible();
    await expect(
      outsider.getByRole("link", { name: "Back to sign in", exact: true }),
    ).toBeVisible();
    await inspect(outsider, "ineligible");
    await signIn(page, "owner");
    await signIn(secondOwner, "owner");
    let releaseAccess: () => void = () => {};
    const accessGate = new Promise<void>((resolve) => {
      releaseAccess = resolve;
    });
    await page.route("**/api/backend/access", async (route) => {
      await accessGate;
      await route.continue();
    });
    try {
      await page.goto("/settings/household");
      await expect(page.locator(".loading-state").first()).toBeVisible();
      await inspect(page, "loading");
    } finally {
      releaseAccess();
      await page.unrouteAll({ behavior: "wait" });
    }
    await expect(
      page.getByText("Your two-person household is connected."),
    ).toBeVisible();
    await inspect(page, "success-consumed");
    await page
      .getByRole("button", { name: "Revoke spouse access", exact: true })
      .click();
    const revoke = page.getByRole("dialog", {
      name: "Revoke spouse access?",
      exact: true,
    });
    await revoke
      .getByRole("button", { name: "Keep access", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Revoke spouse access", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Revoke spouse access", exact: true })
      .click();
    await revoke
      .getByRole("button", { name: "Revoke access", exact: true })
      .click();
    await expect(page.getByText("Spouse access was revoked.")).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Their Usable email", exact: true }),
    ).toBeVisible();
    await inspect(page, "revoked-empty");
    await signIn(spouse, "spouse");
    await expect(
      spouse.getByRole("heading", { name: /check.*invitation/i }),
    ).toBeVisible();
    await inspect(spouse, "revoked-denied");
    await secondOwner.goto("/settings/household");
    await secondOwner
      .getByRole("textbox", { name: "Their Usable email", exact: true })
      .fill("spouse@heima.test");
    // Hold this already-rendered owner's subsequent access reads while the other owner
    // changes the real backend. Commands and responses remain completely unmodified.
    const conflictAccessGate = new Promise<void>((resolve) => {
      releaseConflictAccess = resolve;
    });
    await secondOwner.route("**/api/backend/access", async (route) => {
      if (route.request().method() === "GET") await conflictAccessGate;
      await route.continue();
    });
    const email = page.getByRole("textbox", {
      name: "Their Usable email",
      exact: true,
    });
    await email.fill("not-an-email");
    await page
      .getByRole("button", { name: "Request invited access", exact: true })
      .click();
    expect(
      await email.evaluate(
        (element: HTMLInputElement) => element.validity.valid,
      ),
    ).toBe(false);
    await expect(email).toBeFocused();
    await inspect(page, "validating");
    await email.fill("outsider@heima.test");
    await controls({ inviteStatus: 404 });
    await page
      .getByRole("button", { name: "Request invited access", exact: true })
      .click();
    await expect(
      page.getByText("Access request needs attention", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry access request", exact: true }),
    ).toBeVisible();
    await inspect(page, "request-failed");
    await controls({ inviteStatus: 201 });
    await page
      .getByRole("button", { name: "Retry access request", exact: true })
      .click();
    await expect(
      page.getByText("Waiting for their first sign-in", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Copy sign-in link", exact: true }),
    ).toBeVisible();
    await inspect(page, "access-requested-pending");
    const conflictResponse = secondOwner.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        Boolean(response.request().headers()["next-action"]),
    );
    await secondOwner
      .getByRole("button", { name: "Request invited access", exact: true })
      .click();
    expect(await (await conflictResponse).text()).toContain('"status":409');
    await expect(secondOwner.getByRole("alert").first()).toBeVisible();
    await inspect(secondOwner, "conflict");
    releaseConflictAccess();
    await secondOwner.unrouteAll({ behavior: "wait" });
    await spouse.reload();
    await expect(
      spouse.getByRole("heading", { name: /check.*invitation/i }),
    ).toBeVisible();
    await inspect(spouse, "mismatched");
    await page
      .getByRole("button", { name: "Cancel invitation", exact: true })
      .click();
    await expect(
      page.getByText("The pending invitation was cancelled."),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Request invited access", exact: true }),
    ).toBeVisible();
    expect
      .soft(
        await page.locator("main").innerText(),
        "cancelled state persists after reload",
      )
      .toMatch(/invitation.*cancelled/i);
    await expect(
      page.getByRole("button", { name: "Request invited access", exact: true }),
    ).toBeVisible();
    await inspect(page, "cancelled");
    await page
      .getByRole("textbox", { name: "Their Usable email", exact: true })
      .fill("spouse@heima.test");
    await page
      .getByRole("button", { name: "Request invited access", exact: true })
      .click();
    await expect(
      page.getByText("Waiting for their first sign-in", { exact: true }),
    ).toBeVisible();
    const pending = (await api("access", ownerToken)).data.invitation;
    const accessEvents = async () =>
      (await (await fetch("http://127.0.0.1:3212/__events")).json()).filter(
        (event: { flowType: string }) => event.flowType === "heima.access.0",
      ).length;
    const baseline = await accessEvents();
    // Simulate only maintenance time. Restore it before browser/API state observation; JWT wall time stays real.
    await controls({ maintenanceClock: pending.expiresAt });
    try {
      await expect
        .poll(accessEvents, { timeout: 15000 })
        .toBeGreaterThan(baseline);
    } finally {
      await controls({ maintenanceClock: null });
    }
    expect((await api("access", ownerToken)).data.invitation.status).toBe(
      "expired",
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Request invited access", exact: true }),
    ).toBeVisible();
    expect
      .soft(
        await page.locator("main").innerText(),
        "expired state has a visible next action",
      )
      .toMatch(/invitation.*expired/i);
    await expect(
      page.getByRole("button", { name: "Request invited access", exact: true }),
    ).toBeVisible();
    await inspect(page, "expired");
    await page
      .getByRole("textbox", { name: "Their Usable email", exact: true })
      .fill("spouse@heima.test");
    await page
      .getByRole("button", { name: "Request invited access", exact: true })
      .click();
    await expect(
      page.getByText("Waiting for their first sign-in", { exact: true }),
    ).toBeVisible();
    await spouse.reload();
    await expect(spouse.locator("#main-content")).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("Your two-person household is connected."),
    ).toBeVisible();
    await inspect(page, "restored-consumed");
    await controls({ upstreamFailure: true });
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /check.*invitation/i }),
    ).toBeVisible();
    await inspect(page, "unavailable");
    await controls({ reset: true });
    await page.getByRole("link", { name: "Try again", exact: true }).click();
    await expect(page.locator("#main-content")).toBeVisible();
    await page.goto("/settings/household");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Continue with Usable", exact: true }),
    ).toBeVisible();
    await inspect(page, "logout");
  } finally {
    releaseConflictAccess();
    await spouseContext.close();
    await outsiderContext.close();
    await conflictContext.close();
  }
});
