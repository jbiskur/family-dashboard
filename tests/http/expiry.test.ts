import { expect, test } from "bun:test";
import { decodeJwt } from "jose";
import { loadTestEnv, tokenFor } from "../fixtures/auth";
import { WebhookTestFixture } from "../fixtures/webhook.fixture";

// 356f3e15-0c04-4aac-a838-55352310e95c S4: simulated scheduler time, real JWT time.
test("E1 invitation expires exactly at seven days through the real encrypted maintenance path", async () => {
  await loadTestEnv();
  const tenant = "heima-expiry-test";
  const dataCore = "heima-expiry-test";
  const secret = crypto.randomUUID();
  let clock: string | null = null;
  let clockReads = 0;
  const fixture = new WebhookTestFixture({
    port: 3312,
    tenant,
    dataCore,
    secret,
    transformerUrl: "http://127.0.0.1:3311/__test/transformer",
    async handleExternal(request, response) {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (path === "/__maintenance-clock") {
        clockReads++;
        send(200, { now: clock ?? new Date().toISOString() });
        return true;
      }
      if (!path.startsWith("/api/")) return false;
      const bearer = request.headers.authorization?.replace(/^Bearer /, "");
      if (!bearer) {
        send(401, {});
        return true;
      }
      const claims = decodeJwt(bearer);
      if (path.endsWith("/check-access"))
        send(200, {
          installed:
            Array.isArray(claims.groups) &&
            claims.groups.includes(
              `/app-marketplace-${process.env.USABLE_APP_ID}-users`,
            ),
          accessPolicy: { kind: "invite-only" },
        });
      else if (path.endsWith("/installations/invite"))
        send(201, { invited: true });
      else send(404, {});
      return true;
    },
  }).addEndpoint("heima.access.0", "access.changed.0");
  await fixture.start();
  const runtime = Bun.spawn(
    [
      "bun",
      "--preload",
      "./tests/fixtures/scheduler-cadence-preload.ts",
      "./apps/api/src/index.ts",
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: "3311",
        DATABASE_SCHEMA: `heima_expiry_${Date.now()}`,
        FLOWCORE_TENANT: tenant,
        FLOWCORE_DATA_CORE: dataCore,
        FLOWCORE_WEBHOOK_BASE_URL: "http://127.0.0.1:3312",
        USABLE_API_BASE_URL: "http://127.0.0.1:3312",
        TEST_TRANSFORMER_SECRET: secret,
        TEST_MAINTENANCE_CLOCK_URL: "http://127.0.0.1:3312/__maintenance-clock",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  const until = async (predicate: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 15000;
    while (!(await predicate())) {
      if (Date.now() > deadline)
        throw new Error("Isolated maintenance boundary timed out");
      await Bun.sleep(50);
    }
  };
  const api = async (path: string, token: string, body?: unknown) => {
    // No authenticated API requests while a simulated scheduler instant is selected.
    if (clock)
      throw new Error("Restore scheduler clock before authenticated requests");
    const response = await fetch(`http://127.0.0.1:3311/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    await until(async () =>
      fetch("http://127.0.0.1:3311/health/ready")
        .then((r) => r.ok)
        .catch(() => false),
    );
    const owner = await tokenFor();
    const spouse = await tokenFor("spouse");
    expect((await api("access/admit", owner, {})).status).toBe(200);
    const pending = await api("access/invitations", owner, {
      commandId: crypto.randomUUID(),
      email: "spouse@heima.test",
    });
    expect(pending.status).toBe(201);
    const invitation = pending.body.invitation;
    expect(invitation.status).toBe("pending");
    const expiresAt = Date.parse(invitation.expiresAt);
    expect(
      Math.abs(expiresAt - Date.parse(invitation.requestedAt) - 7 * 86400000),
    ).toBeLessThan(100);
    const baseline = fixture.getEventLog().length;
    clock = new Date(expiresAt - 1).toISOString();
    let reads = clockReads;
    await until(() => clockReads >= reads + 3);
    expect(fixture.getEventLog()).toHaveLength(baseline);
    clock = null;
    expect((await api("access", owner)).body.invitation.status).toBe("pending");

    clock = new Date(expiresAt).toISOString();
    await until(() => fixture.getEventLog().length >= baseline + 1);
    // Canonical fixture records only after the real transformer confirms projection.
    reads = clockReads;
    await until(() => clockReads >= reads + 2);
    // Flowcore delivers at least once: overlapping scheduler ticks may send the
    // same semantic command before its first projection commits.
    const expirations = fixture.getEventLog().slice(baseline);
    expect(expirations.length).toBeGreaterThanOrEqual(1);
    for (const expiration of expirations) {
      expect(expiration.metadata["pathways/encrypted"]).toBe("true");
      expect(JSON.stringify(expiration.payload)).not.toMatch(
        /spouse@heima.test|invitation-expired/,
      );
    }
    clock = null;
    const expired = await api("access", owner);
    expect(expired.body.invitation.id).toBe(invitation.id);
    expect(expired.body.invitation.status).toBe("expired");
    expect(expired.body.invitation.email).toBeUndefined();
    expect(expired.body.invitation.requestedAt).toBe(invitation.requestedAt);
    expect(expired.body.invitation.expiresAt).toBe(invitation.expiresAt);
    expect((await api("access", owner)).body.invitation).toEqual(
      expired.body.invitation,
    );
    expect((await api("access/admit", spouse, {})).status).toBe(403);
    expect(
      (
        await api(`access/invitations/${invitation.id}/resend`, owner, {
          commandId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    const fresh = await api("access/invitations", owner, {
      commandId: crypto.randomUUID(),
      email: "spouse@heima.test",
    });
    expect(fresh.status).toBe(201);
    expect(fresh.body.invitation.id).not.toBe(invitation.id);
    expect((await api("access/admit", spouse, {})).status).toBe(200);
  } finally {
    clock = null;
    runtime.kill("SIGTERM");
    await runtime.exited;
    await fixture.stop();
  }
}, 30000);
