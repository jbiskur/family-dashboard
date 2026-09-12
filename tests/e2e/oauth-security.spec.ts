import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  approveOAuth,
  beginOAuth,
  captureOAuthCallback,
  oauthScopes,
  redeemOAuth,
  signInForOAuth,
} from "../fixtures/oauth";

// Server actions are the protected connection-management boundary. Blocking
// the existing service worker keeps WebKit routing on the real page request so
// the cross-user denial test observes that boundary consistently.
test.use({ serviceWorkers: "block" });

const clientId = "ae7d2f6d-5d9d-4d17-8bdf-1c4b0b62e984";
const resource = "http://localhost:3010/api/mcp";
function authorization(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:43215/callback",
    resource,
    scope: "heima.read",
    state: randomUUID(),
    code_challenge: createHash("sha256")
      .update(randomBytes(32).toString("base64url"))
      .digest("base64url"),
    code_challenge_method: "S256",
    ...overrides,
  });
}
test("OAuth discovery describes bounded secretless delegated access", async ({
  request,
}) => {
  const response = await request.get("/.well-known/oauth-authorization-server");
  expect(response.status()).toBe(200);
  const metadata = await response.json();
  expect(metadata.issuer).toBe("http://localhost:3010");
  expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
  expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
  expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none"]);
  expect(metadata.registration_endpoint).toBeUndefined();
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/api/mcp",
  ]) {
    const protectedResource = await request.get(path);
    expect(protectedResource.status()).toBe(200);
    expect((await protectedResource.json()).resource).toBe(resource);
  }
});
test("authorization rejects unsupported clients, redirects and PKCE before redirect", async ({
  request,
}) => {
  for (const override of [
    { client_id: randomUUID() },
    { redirect_uri: "https://attacker.invalid/callback" },
    { redirect_uri: "http://127.0.0.1:43215/callback/extra" },
    { code_challenge_method: "plain" },
    { code_challenge: "" },
    { resource: "https://attacker.invalid/api/mcp" },
    { scope: "heima.admin" },
  ]) {
    const response = await request.get(
      `/api/oauth/authorize?${authorization(override)}`,
      { maxRedirects: 0 },
    );
    expect(response.status()).toBe(400);
    expect(response.headers().location).toBeUndefined();
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
  const params = authorization();
  params.append("client_id", clientId);
  expect(
    (
      await request.get(`/api/oauth/authorize?${params}`, { maxRedirects: 0 })
    ).status(),
  ).toBe(400);
});
test("token and revocation boundaries reject invalid credentials without leaking storage", async ({
  request,
}) => {
  for (const form of [
    { grant_type: "client_credentials", client_id: clientId, resource },
    {
      grant_type: "authorization_code",
      client_id: clientId,
      resource,
      code: randomBytes(32).toString("base64url"),
      code_verifier: "short",
    },
    {
      grant_type: "refresh_token",
      client_id: clientId,
      resource,
      refresh_token: randomBytes(32).toString("base64url"),
    },
  ]) {
    const response = await request.post("/api/oauth/token", { form });
    expect(response.status()).toBe(400);
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(JSON.stringify(await response.json())).not.toMatch(
      /select |postgres|encrypted|stack|DATABASE_URL/i,
    );
  }
});

test("RFC8707 identical resource repeats normalize while mixed resources fail closed", async ({
  request,
}) => {
  const params = authorization();
  params.append("resource", resource);
  expect(
    (
      await request.get(`/api/oauth/authorize?${params}`, { maxRedirects: 0 })
    ).status(),
  ).toBe(302);
  params.append("resource", "https://attacker.invalid/api/mcp");
  expect(
    (
      await request.get(`/api/oauth/authorize?${params}`, { maxRedirects: 0 })
    ).status(),
  ).toBe(400);
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    resource,
    refresh_token: randomBytes(32).toString("base64url"),
  });
  form.append("resource", resource);
  const normalized = await request.post("/api/oauth/token", {
    data: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect((await normalized.json()).error).toBe("invalid_grant");
  form.append("resource", "https://attacker.invalid/api/mcp");
  const mixed = await request.post("/api/oauth/token", {
    data: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect((await mixed.json()).error).toBe("invalid_request");
  for (const pair of [
    ["", resource],
    [resource, ""],
    ["https://attacker.invalid/api/mcp", resource],
    ["https://attacker.invalid/api/mcp", "https://attacker.invalid/api/mcp"],
  ]) {
    const query = authorization();
    const tokenForm = new URLSearchParams(form);
    for (const target of [query, tokenForm]) {
      target.delete("resource");
      for (const value of pair) target.append("resource", value);
    }
    expect(
      (
        await request.get(`/api/oauth/authorize?${query}`, { maxRedirects: 0 })
      ).status(),
    ).toBe(400);
    const denied = await request.post("/api/oauth/token", {
      data: tokenForm.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect((await denied.json()).error).toBe("invalid_request");
  }
});

test("consented codes require their verifier and redeem only once", async ({
  page,
}) => {
  await signInForOAuth(page);
  const flow = await beginOAuth(page);
  const result = await captureOAuthCallback(page, flow);
  expect(Boolean(result.code)).toBe(true);
  const wrong = await redeemOAuth(page, flow, result.code ?? "", {
    code_verifier: randomBytes(32).toString("base64url"),
  });
  expect(wrong.status()).toBe(400);
  expect((await redeemOAuth(page, flow, result.code ?? "")).status()).toBe(400);
  const freshFlow = await beginOAuth(page);
  const fresh = await captureOAuthCallback(page, freshFlow);
  const valid = await redeemOAuth(page, freshFlow, fresh.code ?? "");
  expect(valid.status()).toBe(200);
  const body = await valid.json();
  expect(Object.keys(body).sort()).toEqual([
    "access_token",
    "expires_in",
    "refresh_token",
    "scope",
    "token_type",
  ]);
  expect(body.scope).toBe("heima.read");
  expect(body.expires_in).toBeGreaterThan(0);
  expect(body.expires_in).toBeLessThanOrEqual(300);
  expect((await redeemOAuth(page, freshFlow, fresh.code ?? "")).status()).toBe(
    400,
  );
});

test("refresh scopes stay narrowed and reuse revokes the connection", async ({
  page,
}) => {
  await signInForOAuth(page);
  const flow = await beginOAuth(page, oauthScopes);
  const tokens = await approveOAuth(page, flow, oauthScopes);
  const refresh = (token: string, scope?: string) =>
    page.request.post("/api/oauth/token", {
      form: {
        grant_type: "refresh_token",
        client_id: clientId,
        resource,
        refresh_token: token,
        ...(scope ? { scope } : {}),
      },
    });
  const narrowed = await refresh(tokens.refreshToken, "heima.read");
  expect(narrowed.status()).toBe(200);
  const next = await narrowed.json();
  expect(next.scope).toBe("heima.read");
  expect(
    (
      await refresh(next.refresh_token, "heima.read heima.finance.read")
    ).status(),
  ).toBe(400);
  const nextValid = await refresh(next.refresh_token);
  expect(nextValid.status()).toBe(200);
  const active = await nextValid.json();
  expect((await refresh(tokens.refreshToken)).status()).toBe(400);
  expect((await refresh(active.refresh_token)).status()).toBe(400);
});

test("parallel code redemption has one winner and refresh reuse ends its family", async ({
  page,
}) => {
  await signInForOAuth(page);
  const flow = await beginOAuth(page);
  const callback = await captureOAuthCallback(page, flow);
  const responses = await Promise.all([
    redeemOAuth(page, flow, callback.code ?? ""),
    redeemOAuth(page, flow, callback.code ?? ""),
  ]);
  expect(responses.map((response) => response.status()).sort()).toEqual([
    200, 400,
  ]);
  const tokens = await responses
    .find((response) => response.status() === 200)
    ?.json();
  const refresh = () =>
    page.request.post("/api/oauth/token", {
      form: {
        grant_type: "refresh_token",
        client_id: clientId,
        resource,
        refresh_token: tokens.refresh_token,
      },
    });
  const rotated = await Promise.all([refresh(), refresh()]);
  expect(rotated.map((response) => response.status()).sort()).toEqual([
    200, 400,
  ]);
  const winner = await rotated
    .find((response) => response.status() === 200)
    ?.json();
  const rejected = await page.request.get("/api/mcp", {
    headers: { authorization: `Bearer ${winner.access_token}` },
  });
  expect(rejected.status()).toBe(401);
  expect(rejected.headers()["www-authenticate"]).toContain(
    "resource_metadata=",
  );
});

test("wrong client or audience cannot revoke a valid token family", async ({
  page,
}) => {
  await signInForOAuth(page);
  const flow = await beginOAuth(page);
  const tokens = await approveOAuth(page, flow);
  for (const overrides of [
    { client_id: "955329f3-8992-4e39-899c-2653f94cbbe6" },
    { resource: "https://attacker.invalid/api/mcp" },
  ]) {
    const denied = await page.request.post("/api/oauth/token", {
      form: {
        grant_type: "refresh_token",
        client_id: clientId,
        resource,
        refresh_token: tokens.refreshToken,
        ...overrides,
      },
    });
    expect(denied.status()).toBe(400);
  }
  const foreignRevoke = await page.request.post("/api/oauth/revoke", {
    form: {
      client_id: "955329f3-8992-4e39-899c-2653f94cbbe6",
      token: tokens.refreshToken,
    },
  });
  expect(foreignRevoke.status()).toBe(200);
  expect(
    (
      await page.request.get("/api/mcp", {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
    ).status(),
  ).toBe(405);
  const revoke = await page.request.post("/api/oauth/revoke", {
    form: { client_id: clientId, token: tokens.refreshToken },
  });
  expect(revoke.status()).toBe(200);
  expect(
    (
      await page.request.get("/api/mcp", {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await page.request.post("/api/oauth/revoke", {
        form: { client_id: clientId, token: tokens.refreshToken },
      })
    ).status(),
  ).toBe(200);
});

test("consent stays bound to its initiating browser and rejects forged actions", async ({
  page,
  browser,
}) => {
  await signInForOAuth(page);
  const flow = await beginOAuth(page);
  const foreignContext = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  try {
    const foreignPage = await foreignContext.newPage();
    await foreignPage.goto(`/oauth/consent?request=${flow.requestId}`);
    await expect(
      foreignPage.getByRole("button", { name: "Connect agent", exact: true }),
    ).toHaveCount(0);
    await expect(
      foreignPage.getByText(
        "Open this request in the browser where you started connecting.",
        { exact: true },
      ),
    ).toBeVisible();
  } finally {
    await foreignContext.close();
  }
  await page.route(
    `**/oauth/consent?request=${flow.requestId}`,
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const data = JSON.parse(route.request().postData() ?? "null");
      data[0].csrfToken = "A".repeat(43);
      await route.continue({ postData: JSON.stringify(data) });
    },
  );
  await page
    .getByRole("button", { name: "Connect agent", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "This request changed" }),
  ).toBeVisible();
  await page.unroute(`**/oauth/consent?request=${flow.requestId}`);
  const tokens = await approveOAuth(page, flow);
  expect(tokens.scope).toBe("heima.read");
});

test("signing out expires connected agents without copying provider credentials", async ({
  page,
}) => {
  await signInForOAuth(page);
  const flow = await beginOAuth(page);
  const tokens = await approveOAuth(page, flow);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue with Usable", exact: true }),
  ).toBeVisible();
  expect(
    (
      await page.request.get("/api/mcp", {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await page.request.post("/api/oauth/token", {
        form: {
          grant_type: "refresh_token",
          client_id: clientId,
          resource,
          refresh_token: tokens.refreshToken,
        },
      })
    ).status(),
  ).toBe(400);
});

test("another household user cannot list or disconnect this agent connection", async ({
  page,
  browser,
}) => {
  await signInForOAuth(page);
  const tokens = await approveOAuth(page, await beginOAuth(page));
  let resolveAction!: (value: {
    id: string;
    body: string;
    grantId: string;
  }) => void;
  const action = new Promise<{ id: string; body: string; grantId: string }>(
    (resolve) => {
      resolveAction = resolve;
    },
  );
  await page.route("**/settings/household", async (route) => {
    const request = route.request();
    const body = request.postData() ?? "";
    let args: unknown;
    try {
      args = JSON.parse(body);
    } catch {
      return route.continue();
    }
    if (
      request.method() === "POST" &&
      Array.isArray(args) &&
      args.length === 1 &&
      typeof args[0] === "string" &&
      /^[0-9a-f-]{36}$/i.test(args[0])
    ) {
      resolveAction({
        id: request.headers()["next-action"],
        body,
        grantId: args[0],
      });
      return route.abort("failed");
    }
    return route.continue();
  });
  await page
    .getByRole("button", { name: "Disconnect Codex", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Disconnect agent", exact: true })
    .click();
  const captured = await action;
  await page.unroute("**/settings/household");
  const foreign = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  try {
    const spouse = await foreign.newPage();
    await signInForOAuth(spouse, "spouse");
    const bodies: Array<Promise<string>> = [];
    spouse.on("response", (response) => {
      if (
        new URL(response.url()).pathname === "/settings/household" &&
        response.request().method() === "POST"
      )
        bodies.push(response.text().catch(() => ""));
    });
    await spouse.goto("/settings/household");
    await expect(
      spouse.getByRole("heading", { name: "Your connections", exact: true }),
    ).toBeVisible();
    const serialized = (await Promise.all(bodies)).join("\n");
    expect(serialized.includes('"connections"')).toBe(true);
    expect(serialized.includes(captured.grantId)).toBe(false);
    const denied = await spouse.request.post("/settings/household", {
      headers: {
        "next-action": captured.id,
        "content-type": "text/plain;charset=UTF-8",
        origin: "http://localhost:3010",
      },
      data: captured.body,
    });
    expect((await denied.text()).includes("NOT_FOUND")).toBe(true);
    expect(
      (
        await page.request.get("/api/mcp", {
          headers: { authorization: `Bearer ${tokens.accessToken}` },
        })
      ).status(),
    ).toBe(405);
  } finally {
    await foreign.close();
    await page.request.post("/api/oauth/revoke", {
      form: { client_id: clientId, token: tokens.refreshToken },
    });
  }
});

test("live invite eligibility removal denies an already-connected agent", async ({
  page,
}) => {
  const control = async (data: Record<string, unknown>) => {
    const response = await fetch("http://127.0.0.1:3212/__controls", {
      method: "POST",
      body: JSON.stringify(data),
    });
    expect(response.status).toBe(200);
  };
  await control({ reset: true });
  try {
    await signInForOAuth(page);
    const tokens = await approveOAuth(page, await beginOAuth(page));
    await control({ denyUser: "00000000-0000-4000-8000-000000000001" });
    expect(
      (
        await page.request.get("/api/mcp", {
          headers: { authorization: `Bearer ${tokens.accessToken}` },
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await page.request.post("/api/oauth/token", {
          form: {
            grant_type: "refresh_token",
            client_id: clientId,
            resource,
            refresh_token: tokens.refreshToken,
          },
        })
      ).status(),
    ).toBe(400);
  } finally {
    await control({ reset: true });
  }
});

test("household membership removal denies an existing agent and can be restored through invitations", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signInForOAuth(page);
  await page.goto("/settings/household");
  const spouseContext = await browser.newContext({
    baseURL: "http://localhost:3010",
  });
  const spouse = await spouseContext.newPage();
  let removed = false;
  try {
    await signInForOAuth(spouse, "spouse");
    const tokens = await approveOAuth(spouse, await beginOAuth(spouse));
    await page
      .getByRole("button", { name: "Revoke spouse access", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Revoke spouse access?", exact: true })
      .getByRole("button", { name: "Revoke access", exact: true })
      .click();
    await expect(
      page.getByText("Spouse access was revoked.", { exact: true }),
    ).toBeVisible();
    removed = true;
    expect(
      (
        await spouse.request.get("/api/mcp", {
          headers: { authorization: `Bearer ${tokens.accessToken}` },
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await spouse.request.post("/api/oauth/token", {
          form: {
            grant_type: "refresh_token",
            client_id: clientId,
            resource,
            refresh_token: tokens.refreshToken,
          },
        })
      ).status(),
    ).toBe(400);
  } finally {
    if (removed) {
      await page
        .getByRole("textbox", { name: "Their Usable email", exact: true })
        .fill("spouse@heima.test");
      await page
        .getByRole("button", { name: "Request invited access", exact: true })
        .click();
      await expect(
        page.getByText("Waiting for their first sign-in", { exact: true }),
      ).toBeVisible();
      await spouse.goto("/");
      await expect(spouse.locator("#main-content")).toBeVisible();
      await page.reload();
      await expect(
        page.getByText("Your two-person household is connected.", {
          exact: true,
        }),
      ).toBeVisible();
    }
    await spouseContext.close();
  }
});
