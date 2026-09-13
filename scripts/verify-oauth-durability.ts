import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import postgres from "postgres";
import {
  approveOAuth,
  beginOAuth,
  captureOAuthCallback,
  oauthClientId,
  redeemOAuth,
  signInForOAuth,
} from "../tests/fixtures/oauth.ts";

// node --experimental-strip-types scripts/verify-oauth-durability.ts
// Run after the production build. This uses public browser/HTTP surfaces and
// disposable database fault fixtures; it never imports application internals.
for (const line of readFileSync(".env.test.local", "utf8").split("\n")) {
  const at = line.indexOf("=");
  if (at > 0) process.env[line.slice(0, at)] = line.slice(at + 1);
}
const schema = `heima_oauthproof_${Date.now()}`;
const PROVIDER_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const address = reserve.address();
if (!address || typeof address === "string")
  throw new Error("No isolated port");
const port = address.port;
await new Promise<void>((resolve, reject) =>
  reserve.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://localhost:${port}`;
const resource = `${origin}/api/mcp`;
const root = process.cwd();
const sql = postgres(process.env.DATABASE_URL ?? "", {
  max: 1,
  connection: { search_path: schema },
  onnotice: () => {},
});
const receipt: Record<string, unknown> = {
  schema,
  isolated: true,
  protocol: "public HTTP/browser; isolated operational DB fixtures",
};
let child: ChildProcess | undefined;
let exited: Promise<unknown> | undefined;
const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: origin,
  serviceWorkers: "block",
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);
let removeCallback: (() => Promise<void>) | undefined;
async function stop() {
  if (!child) return;
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
  child = undefined;
}
async function start(offset = 0) {
  await stop();
  child = spawn(
    "node",
    ["node_modules/next/dist/bin/next", "start", "-p", String(port)],
    {
      cwd: resolve(root, "apps/web"),
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_SCHEMA: schema,
        AUTH_URL: origin,
        NODE_OPTIONS: `--require ${resolve(root, "tests/fixtures/oauth-clock.cjs")}`,
        HEIMA_OAUTH_TEST_CLOCK_OFFSET: String(offset),
      },
      stdio: "ignore",
    },
  );
  exited = once(child, "exit");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null)
      throw new Error("Isolated verification web process exited");
    try {
      if (
        (
          await fetch(`${origin}/api/oauth/metadata`, {
            headers: { host: new URL(origin).host },
          })
        ).ok
      )
        return;
    } catch {}
    await delay(100);
  }
  throw new Error("Isolated verification web process did not become ready");
}
const bearer = (token: string) => ({
  host: new URL(origin).host,
  authorization: `Bearer ${token}`,
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const refresh = (token: string) =>
  page.request.post(`${origin}/api/oauth/token`, {
    headers: { host: new URL(origin).host },
    form: {
      grant_type: "refresh_token",
      client_id: oauthClientId,
      resource,
      refresh_token: token,
    },
  });
try {
  // Add one exact ephemeral callback to the local test client, preserving all
  // existing callbacks. No production identity configuration is reachable.
  const issuer = new URL(process.env.USABLE_ISSUER ?? "");
  if (
    issuer.origin !== "http://localhost:8187" ||
    issuer.pathname !== "/realms/heima-test"
  )
    throw new Error(
      "Durability proof requires the local test identity provider",
    );
  const adminLogin = await fetch(
    `${issuer.origin}/realms/master/protocol/openid-connect/token`,
    {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: "admin",
        password: process.env.TEST_KEYCLOAK_PASSWORD ?? "",
      }),
    },
  );
  expect(adminLogin.status).toBe(200);
  const adminToken = (await adminLogin.json()).access_token;
  const adminHeaders = {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  };
  const clientsResponse = await fetch(
    `${issuer.origin}/admin/realms/heima-test/clients?clientId=${process.env.USABLE_CLIENT_ID}`,
    { headers: adminHeaders },
  );
  const localClients = await clientsResponse.json();
  expect(localClients.length).toBe(1);
  const localClient = localClients[0];
  const clientUrl = `${issuer.origin}/admin/realms/heima-test/clients/${localClient.id}`;
  const callback = `${origin}/api/auth/callback/usable`;
  const addCallback = await fetch(clientUrl, {
    method: "PUT",
    headers: adminHeaders,
    body: JSON.stringify({
      ...localClient,
      redirectUris: [...localClient.redirectUris, callback],
      webOrigins: [...localClient.webOrigins, origin],
    }),
  });
  expect(addCallback.status).toBe(204);
  removeCallback = async () => {
    const current = await (
      await fetch(clientUrl, { headers: adminHeaders })
    ).json();
    const removed = await fetch(clientUrl, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        ...current,
        redirectUris: current.redirectUris.filter(
          (uri: string) => uri !== callback,
        ),
        webOrigins: current.webOrigins.filter(
          (value: string) => value !== origin,
        ),
      }),
    });
    expect(removed.status).toBe(204);
  };
  const migration = spawn("bun", ["apps/api/src/db/migrate.ts"], {
    env: { ...process.env, NODE_ENV: "test", DATABASE_SCHEMA: schema },
    stdio: "ignore",
  });
  expect((await once(migration, "exit"))[0]).toBe(0);
  await start();
  await signInForOAuth(page, "owner", origin);
  const initial = await approveOAuth(
    page,
    await beginOAuth(page, ["heima.read"], origin),
  );
  expect(
    (
      await page.request.get(`${origin}/api/mcp`, {
        headers: bearer(initial.accessToken),
      })
    ).status(),
  ).toBe(405);
  await start();
  expect(
    (
      await page.request.get(`${origin}/api/mcp`, {
        headers: bearer(initial.accessToken),
      })
    ).status(),
  ).toBe(405);
  receipt.activeGrantSurvivesRestart = true;

  const [before] =
    await sql`select id,grant_id,refresh_used_at from oauth_tokens where refresh_hash=${hash(initial.refreshToken)}`;
  const [tokenCount] =
    await sql`select count(*)::int as count from oauth_tokens`;
  await sql.unsafe(
    "create function oauth_test_insert_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic OAuth database failure'; end; $$",
  );
  await sql.unsafe(
    "create trigger oauth_test_insert_failure before insert on oauth_tokens for each row execute function oauth_test_insert_failure()",
  );
  const failed = await refresh(initial.refreshToken);
  expect(failed.status()).toBe(503);
  expect(JSON.stringify(await failed.json())).not.toMatch(
    /synthetic|postgres|trigger|stack|select/i,
  );
  expect(
    (
      await sql`select refresh_used_at from oauth_tokens where id=${before.id}`
    )[0]?.refresh_used_at,
  ).toBeNull();
  expect(
    (await sql`select count(*)::int as count from oauth_tokens`)[0]?.count,
  ).toBe(tokenCount.count);
  const failedCodeFlow = await beginOAuth(page, ["heima.read"], origin);
  const failedCode = await captureOAuthCallback(page, failedCodeFlow);
  const codeFailure = await redeemOAuth(
    page,
    failedCodeFlow,
    failedCode.code ?? "",
  );
  expect(codeFailure.status()).toBe(503);
  expect(
    (
      await sql`select code_consumed_at from oauth_requests where id=${failedCodeFlow.requestId}`
    )[0]?.code_consumed_at,
  ).toBeNull();
  expect(
    (await sql`select count(*)::int as count from oauth_grants`)[0]?.count,
  ).toBe(1);
  await sql.unsafe("drop trigger oauth_test_insert_failure on oauth_tokens");
  await sql.unsafe("drop function oauth_test_insert_failure()");
  const retried = await refresh(initial.refreshToken);
  expect(retried.status()).toBe(200);
  const rotated = await retried.json();
  expect(
    (await redeemOAuth(page, failedCodeFlow, failedCode.code ?? "")).status(),
  ).toBe(200);
  receipt.unexpectedDatabaseFailureRollsBack = true;
  receipt.sameRefreshCanRetryAfterRollback = true;
  receipt.sameCodeCanRetryAfterRollback = true;

  const [grant] =
    await sql`select * from oauth_grants where id=${before.grant_id}`;
  const syntheticIds: string[] = [];
  const [liveGrants] =
    await sql`select count(*)::int as count from oauth_grants where revoked_at is null`;
  for (let index = 0; index < 99 - liveGrants.count; index++) {
    const id = randomUUID();
    syntheticIds.push(id);
    await sql`insert into oauth_grants (id,request_id,user_id,session_id,client_id,resource,scopes,expires_at) values (${id},${randomUUID()},${grant.user_id},${grant.session_id},${grant.client_id},${grant.resource},${sql.json(["heima.read"])},${grant.expires_at})`;
  }
  const firstFlow = await beginOAuth(page, ["heima.read"], origin);
  const first = await captureOAuthCallback(page, firstFlow);
  const secondFlow = await beginOAuth(page, ["heima.read"], origin);
  const second = await captureOAuthCallback(page, secondFlow);
  const results = await Promise.all([
    redeemOAuth(page, firstFlow, first.code ?? ""),
    redeemOAuth(page, secondFlow, second.code ?? ""),
  ]);
  expect(results.map((response) => response.status()).sort()).toEqual([
    200, 400,
  ]);
  const winner = await results
    .find((response) => response.status() === 200)
    ?.json();
  const denied = await results
    .find((response) => response.status() === 400)
    ?.json();
  expect(denied.error_description).toContain("Disconnect an existing agent");
  expect(
    (
      await sql`select count(*)::int as count from oauth_grants where revoked_at is null`
    )[0]?.count,
  ).toBe(100);
  await page.goto("/settings/household");
  await expect(page.getByRole("button", { name: /^Disconnect / })).toHaveCount(
    100,
  );
  receipt.concurrentConnectionCap = {
    before: 99,
    after: 100,
    successfulExchanges: 1,
    visibleDisconnectControls: 100,
  };
  await sql`delete from oauth_grants where id in ${sql(syntheticIds)}`;

  expect(
    (
      await page.request.post(`${origin}/api/oauth/revoke`, {
        headers: { host: new URL(origin).host },
        form: { client_id: oauthClientId, token: rotated.refresh_token },
      })
    ).status(),
  ).toBe(200);
  await start();
  expect(
    (
      await page.request.get(`${origin}/api/mcp`, {
        headers: bearer(rotated.access_token),
      })
    ).status(),
  ).toBe(401);
  expect((await refresh(rotated.refresh_token)).status()).toBe(400);
  expect(
    (
      await page.request.get(`${origin}/api/mcp`, {
        headers: bearer(winner.access_token),
      })
    ).status(),
  ).toBe(405);
  receipt.revocationSurvivesRestart = true;

  await start(PROVIDER_SESSION_MAX_AGE_MS + 60_000);
  expect(
    (
      await page.request.get(`${origin}/api/mcp`, {
        headers: bearer(winner.access_token),
      })
    ).status(),
  ).toBe(401);
  expect((await refresh(winner.refresh_token)).status()).toBe(400);
  receipt.absoluteSessionExpiry = {
    advancedClockSeconds: Math.floor(PROVIDER_SESSION_MAX_AGE_MS / 1000) + 60,
    accessStatus: 401,
    refreshStatus: 400,
  };
  await start();
  await page.goto("/settings/household");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue with Usable", exact: true }),
  ).toBeVisible();
  receipt.providerSessionSignedOut = true;
  console.log(JSON.stringify(receipt));
} catch (error) {
  console.error(
    JSON.stringify({
      failure: error instanceof Error ? error.name : "Failure",
      completed: receipt,
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    await browser.close();
  } finally {
    try {
      await stop();
    } finally {
      try {
        await removeCallback?.();
      } finally {
        try {
          await sql`drop schema if exists ${sql(schema)} cascade`;
        } finally {
          await sql.end();
        }
      }
    }
  }
}
