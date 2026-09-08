import { decodeJwt } from "jose";
import { PushServiceFixture } from "../tests/fixtures/push.fixture";
import { WebhookTestFixture } from "../tests/fixtures/webhook.fixture";

for (const line of (
  await Bun.file(process.env.HEIMA_TEST_ENV_FILE ?? ".env.test.local").text()
).split("\n")) {
  const at = line.indexOf("=");
  if (at > 0) process.env[line.slice(0, at)] = line.slice(at + 1);
}
const denied = new Set<string>();
let upstreamFailure = false;
let inviteStatus = 201;
let maintenanceClock: string | null = null;
const pushFixture = new PushServiceFixture();
const fixture = new WebhookTestFixture({
  port: 3212,
  tenant: process.env.FLOWCORE_TENANT!,
  dataCore: process.env.FLOWCORE_DATA_CORE!,
  secret: process.env.TEST_TRANSFORMER_SECRET!,
  transformerUrl: "http://127.0.0.1:3211/__test/transformer",
  async handleExternal(request, response) {
    if (await pushFixture.handle(request, response)) return true;
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/__maintenance-clock") {
      send(process.env.NODE_ENV === "test" ? 200 : 404, {
        now: maintenanceClock ?? new Date().toISOString(),
      });
      return true;
    }
    if (url.pathname === "/__controls") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (body.reset) {
        denied.clear();
        upstreamFailure = false;
        inviteStatus = 201;
        maintenanceClock = null;
        fixture.setInboundStatus(200);
        fixture.releaseWrites();
      }
      if ("maintenanceClock" in body) {
        if (
          process.env.NODE_ENV !== "test" ||
          (body.maintenanceClock !== null &&
            (typeof body.maintenanceClock !== "string" ||
              !Number.isFinite(Date.parse(body.maintenanceClock))))
        ) {
          send(400, { error: "Invalid test scheduler instant" });
          return true;
        }
        maintenanceClock = body.maintenanceClock;
      }
      if (typeof body.inviteStatus === "number")
        inviteStatus = body.inviteStatus;
      if (typeof body.denyUser === "string") denied.add(body.denyUser);
      if (typeof body.upstreamFailure === "boolean")
        upstreamFailure = body.upstreamFailure;
      if (typeof body.webhookStatus === "number")
        fixture.setInboundStatus(body.webhookStatus);
      send(200, { ok: true });
      return true;
    }
    if (url.pathname === "/__events") {
      send(200, fixture.getEventLog());
      return true;
    }
    if (!url.pathname.startsWith("/api/")) return false;
    if (upstreamFailure) {
      send(503, { error: "Dependency unavailable" });
      return true;
    }
    const bearer = request.headers.authorization?.replace(/^Bearer /, "");
    if (!bearer) {
      send(401, {});
      return true;
    }
    const token = decodeJwt(bearer);
    if (url.pathname.endsWith("/check-access")) {
      send(200, {
        installed:
          !denied.has(String(token.usable_user_id)) &&
          Array.isArray(token.groups) &&
          token.groups.includes(
            `/app-marketplace-${process.env.USABLE_APP_ID}-users`,
          ),
        pending: false,
        accessPolicy: { kind: "invite-only" },
      });
      return true;
    }
    if (url.pathname.endsWith("/installations/invite")) {
      send(
        inviteStatus,
        inviteStatus === 201
          ? { invited: true }
          : { error: "External invitation service unavailable" },
      );
      return true;
    }
    send(404, {});
    return true;
  },
});
for (const scope of [
  "access",
  "household",
  "shopping",
  "work",
  "finance",
  "notifications",
  "domain",
])
  fixture.addEndpoint(`heima.${scope}.0`, `${scope}.changed.0`);
fixture.addEndpoint("heima.household.0", "resource.changed.0");
fixture.addEndpoint("heima.notifications.0", "notification.changed.0");
await fixture.start();
const api = Bun.spawn(
  [
    "bun",
    "--preload",
    "./tests/fixtures/push-transport-preload.ts",
    "./apps/api/src/index.ts",
  ],
  {
    env: {
      ...process.env,
      ...(process.env.NODE_ENV === "test"
        ? {
            TEST_MAINTENANCE_CLOCK_URL:
              "http://127.0.0.1:3212/__maintenance-clock",
          }
        : {}),
    },
    stdout: "inherit",
    stderr: "inherit",
  },
);
for (let i = 0; ; i++) {
  try {
    if ((await fetch("http://127.0.0.1:3211/health/ready")).ok) break;
  } catch {}
  if (i > 90) throw new Error("API not ready");
  await Bun.sleep(500);
}
const web =
  process.env.HEIMA_API_ONLY === "1"
    ? null
    : Bun.spawn(
        [
          "bun",
          "run",
          "--cwd",
          "apps/web",
          process.env.HEIMA_WEB_MODE === "production" ? "start" : "dev",
        ],
        {
          env: process.env,
          stdout: "inherit",
          stderr: "inherit",
        },
      );
console.log(
  "Heima test runtime: http://localhost:3010; local Keycloak; real encrypted Pathways delivery fixture.",
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, async () => {
    api.kill();
    web?.kill();
    await fixture.stop();
    process.exit(0);
  });
await Promise.race([api.exited, ...(web ? [web.exited] : [])]);
api.kill();
web?.kill();
await fixture.stop();
