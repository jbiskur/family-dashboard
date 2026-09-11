import { expect, test } from "bun:test";
import { createDecipheriv, createHash } from "node:crypto";
import { createServer } from "node:net";
import postgres from "postgres";
import { loadTestEnv, tokenFor } from "../fixtures/auth";
import { WebhookTestFixture } from "../fixtures/webhook.fixture";

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

test("scheduled reminders exclude deconfigured administrators while family reminders still run", async () => {
  await loadTestEnv();
  const ownerId = "00000000-0000-4000-8000-000000000001";
  const adminId = "00000000-0000-4000-8000-000000000004";
  const owner = await tokenFor();
  const admin = await tokenFor("admin");
  const schema = `heima_admin_notify_${Date.now()}`;
  const apiPort = await availablePort();
  const fixturePort = await availablePort();
  const base = `http://127.0.0.1:${apiPort}`;
  const fixture = new WebhookTestFixture({
    port: fixturePort,
    tenant: process.env.FLOWCORE_TENANT ?? "",
    dataCore: process.env.FLOWCORE_DATA_CORE ?? "",
    secret: process.env.TEST_TRANSFORMER_SECRET ?? "",
    transformerUrl: `${base}/__test/transformer`,
  });
  fixture.addEndpoint("heima.access.0", "access.changed.0");
  fixture.addEndpoint("heima.household.0", "resource.changed.0");
  fixture.addEndpoint("heima.notifications.0", "notification.changed.0");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  async function stop() {
    if (!child) return;
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(5000)]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    child = undefined;
  }
  async function start(configured: boolean) {
    child = Bun.spawn(
      [
        "bun",
        ...(configured
          ? []
          : ["--preload", "./tests/fixtures/push-transport-preload.ts"]),
        "apps/api/src/index.ts",
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "test",
          PORT: String(apiPort),
          DATABASE_SCHEMA: schema,
          APP_ADMIN_USER_IDS: configured ? adminId : "",
          FLOWCORE_WEBHOOK_BASE_URL: `http://127.0.0.1:${fixturePort}`,
          VAPID_PUBLIC_KEY: "",
          VAPID_PRIVATE_KEY: "",
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("Reminder test API exited");
      try {
        if ((await fetch(`${base}/health/live`)).ok) return;
      } catch {}
      await Bun.sleep(100);
    }
    throw new Error("Reminder test API did not start");
  }
  async function command(
    path: string,
    data: Record<string, unknown>,
    token = owner,
  ) {
    const response = await fetch(`${base}/v1/${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ commandId: crypto.randomUUID(), ...data }),
    });
    expect(response.ok).toBe(true);
    return response.json();
  }
  const reminders = () =>
    fixture
      .getCalls("heima.notifications.0", "notification.changed.0")
      .map((call) => {
        const payload = call.payload as { encryptedPayload: string };
        const [iv, encrypted, tag] = payload.encryptedPayload.split(".");
        if (!iv || !encrypted || !tag)
          throw new Error("Invalid encrypted fixture receipt");
        const decipher = createDecipheriv(
          "aes-256-gcm",
          createHash("sha256")
            .update(process.env.PATHWAYS_ENCRYPTION_KEY ?? "")
            .digest(),
          Buffer.from(iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(tag, "base64"));
        return JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(encrypted, "base64")),
            decipher.final(),
          ]).toString(),
        );
      })
      .filter((event) => event.action === "reminder");
  await fixture.start();
  try {
    await start(true);
    await command("access/admit", {});
    await command("access/admit", {}, admin);
    const ownerWork = await command("work/items", {
      title: "Family reminder control",
      visibility: "household",
      assigneeId: ownerId,
      dueDate: "2020-01-01",
    });
    const adminWork = await command("work/items", {
      title: "Removed administrator reminder",
      visibility: "household",
      assigneeId: adminId,
      dueDate: "2020-01-01",
    });
    await stop();
    expect(reminders()).toHaveLength(0);
    await start(false);
    expect(
      (
        await fetch(`${base}/v1/access`, {
          headers: { authorization: `Bearer ${admin}` },
        })
      ).status,
    ).toBe(403);
    // Existing test cadence runs every500ms. Observe several complete ticks;
    // the family reminder proves the real background job and event transport ran.
    await Bun.sleep(3000);
    const recorded = reminders();
    expect(
      recorded.some(
        (event) =>
          event.recipientId === ownerId && event.targetId === ownerWork.id,
      ),
    ).toBe(true);
    expect(
      recorded.filter(
        (event) =>
          event.recipientId === adminId || event.targetId === adminWork.id,
      ),
    ).toHaveLength(0);
    const activity = await fetch(`${base}/v1/activity`, {
      headers: { authorization: `Bearer ${owner}` },
    });
    expect(activity.status).toBe(200);
    expect(
      (await activity.json()).items.some(
        (item: { category: string; href: string }) =>
          item.category === "dueReminders" && item.href.includes(ownerWork.id),
      ),
    ).toBe(true);
  } finally {
    await stop();
    await fixture.stop();
    const database = postgres(process.env.DATABASE_URL ?? "", {
      max: 1,
      onnotice: () => {},
    });
    try {
      await database`DROP SCHEMA IF EXISTS ${database(schema)} CASCADE`;
    } finally {
      await database.end();
    }
  }
}, 30000);
