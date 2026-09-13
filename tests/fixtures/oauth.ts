import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

export const oauthClientId = "ae7d2f6d-5d9d-4d17-8bdf-1c4b0b62e984";
export const oauthResource = "http://localhost:3010/api/mcp";
export const oauthScopes = [
  "heima.read",
  "heima.shopping.write",
  "heima.work.write",
  "heima.finance.read",
];
export type OAuthFlow = {
  requestId: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  state: string;
  resource: string;
  requestOrigin?: string;
};
export type OAuthTokens = {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresIn: number;
};

export async function signInForOAuth(
  page: Page,
  user = "owner",
  origin = "http://localhost:3010",
) {
  const password =
    readFileSync(".env.test.local", "utf8")
      .split("\n")
      .find((line) => line.startsWith("TEST_USER_PASSWORD="))
      ?.slice("TEST_USER_PASSWORD=".length) ?? "";
  await page.goto("/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill(`${user}@heima.test`);
  await page.locator("#password").fill(password);
  await page.locator("#kc-login").click();
  await expect(page).toHaveURL(`${origin}/`, { timeout: 30_000 });
  // WebKit can report the redirect URL before the final document navigation
  // has settled; callers often navigate straight to the feature under test.
  await page.waitForLoadState("load");
}

export async function beginOAuth(
  page: Page,
  scopes: string[] = ["heima.read"],
  requestOrigin = "",
): Promise<OAuthFlow> {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomUUID();
  const redirectUri = "http://127.0.0.1:43215/callback";
  const resource = requestOrigin ? `${requestOrigin}/api/mcp` : oauthResource;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: oauthClientId,
    redirect_uri: redirectUri,
    resource,
    scope: scopes.join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const response = await page.request.get(
    `${requestOrigin}/api/oauth/authorize?${params}`,
    {
      maxRedirects: 0,
    },
  );
  expect(response.status()).toBe(302);
  const location = response.headers().location;
  const requestId = new URL(location).searchParams.get("request");
  if (!requestId)
    throw new Error("Authorization did not provide a consent request");
  await page.goto(location);
  return {
    requestId,
    verifier,
    state,
    clientId: oauthClientId,
    redirectUri,
    resource,
    requestOrigin,
  };
}

// The callback code stays in memory; evidence must be captured before approval.
export async function captureOAuthCallback(
  page: Page,
  flow: OAuthFlow,
  decision: "approve" | "cancel" = "approve",
) {
  let resolveCallback!: (value: { code?: string; error?: string }) => void;
  const callback = new Promise<{ code?: string; error?: string }>((resolve) => {
    resolveCallback = resolve;
  });
  await page.route(`${flow.redirectUri}?**`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(url.searchParams.get("iss")).toBe(new URL(flow.resource).origin);
    resolveCallback({
      code: url.searchParams.get("code") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
    });
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Agent connection</title><p>You can return to Heima.</p>",
    });
  });
  await page
    .getByRole("button", {
      name: decision === "approve" ? "Connect agent" : "Cancel",
      exact: true,
    })
    .click();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    callback,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("OAuth callback did not complete")),
        20_000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  await expect(
    page.getByText("You can return to Heima.", { exact: true }),
  ).toBeVisible();
  await page.goto("/settings/household");
  return result;
}

export async function redeemOAuth(
  page: Page,
  flow: OAuthFlow,
  code: string,
  overrides: Record<string, string> = {},
) {
  return page.request.post(`${flow.requestOrigin ?? ""}/api/oauth/token`, {
    form: {
      grant_type: "authorization_code",
      client_id: flow.clientId,
      resource: flow.resource,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
      code,
      ...overrides,
    },
  });
}

export async function approveOAuth(
  page: Page,
  flow: OAuthFlow,
  scopes: string[] = ["heima.read"],
): Promise<OAuthTokens> {
  for (const scope of oauthScopes.slice(1)) {
    const field = page.locator(`input[name="scope"][value="${scope}"]`);
    if (await field.count()) await field.setChecked(scopes.includes(scope));
  }
  const result = await captureOAuthCallback(page, flow);
  expect(Boolean(result.code)).toBe(true);
  const response = await redeemOAuth(page, flow, result.code ?? "");
  expect(
    response.status(),
    response.ok() ? "" : JSON.stringify(await response.json()),
  ).toBe(200);
  const body = await response.json();
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scope: body.scope,
    expiresIn: body.expires_in,
  };
}
