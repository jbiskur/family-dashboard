import { beforeAll, expect, test } from "bun:test";
import { createDecipheriv, createHash } from "node:crypto";
import { createServer } from "node:net";
import postgres from "postgres";
import { controls, loadTestEnv, request, tokenFor } from "../fixtures/auth";

let owner: string;
let admin: string;
const adminId = "00000000-0000-4000-8000-000000000004";
async function read(path: string, token = admin) {
  const response = await request(path, token);
  expect(response.status).toBe(200);
  return response.json();
}
async function create(
  path: string,
  data: Record<string, unknown>,
  token = admin,
) {
  const response = await request(path, token, {
    commandId: crypto.randomUUID(),
    ...data,
  });
  expect(response.status).toBe(201);
  return response.json();
}
beforeAll(async () => {
  await loadTestEnv();
  await controls({ reset: true });
  owner = await tokenFor();
  admin = await tokenFor("admin");
  expect((await request("access/admit", owner, {})).status).toBe(200);
});

test("configured administrators admit once without changing family membership", async () => {
  const previous = await read("access", owner);
  const before = previous.members.filter(
    (m: { role: string }) => m.role !== "admin",
  );
  for (const response of await Promise.all([
    request("access/admit", admin, {}),
    request("access/admit", admin, {}),
  ]))
    expect(response.status).toBe(200);
  const second = await tokenFor("admin2");
  expect((await request("access/admit", second, {})).status).toBe(200);
  const access = await read("access");
  expect(access.member).toEqual({
    userId: adminId,
    role: "admin",
    status: "active",
  });
  expect(
    access.members.filter((m: { role: string }) => m.role !== "admin"),
  ).toEqual(before);
  expect(
    access.members.filter((m: { userId: string }) => m.userId === adminId),
  ).toHaveLength(1);
  expect(access.invitation).toBeNull();
  // Fresh admission must produce an encrypted event that remains idempotent on replay.
  const events = await (await fetch("http://127.0.0.1:3212/__events")).json();
  const adminEvent = events.find(
    (event: { eventType: string; payload: { encryptedPayload: string } }) => {
      if (event.eventType !== "access.changed.0") return false;
      const [iv, data, tag] = event.payload.encryptedPayload.split(".");
      if (!iv || !data || !tag) return false;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        createHash("sha256")
          .update(process.env.PATHWAYS_ENCRYPTION_KEY ?? "")
          .digest(),
        Buffer.from(iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      const payload = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(data, "base64")),
          decipher.final(),
        ]).toString(),
      );
      return (
        payload.actorId === adminId && payload.change.kind === "admin-admitted"
      );
    },
  );
  if (!previous.members.some((m: { userId: string }) => m.userId === adminId))
    expect(adminEvent).toBeDefined();
  if (adminEvent) {
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        (
          await fetch("http://127.0.0.1:3212/__deliver-event", {
            method: "POST",
            body: JSON.stringify(adminEvent),
          })
        ).status,
      ).toBe(200);
    expect((await read("access")).members).toEqual(access.members);
  }
});

test("installation alone and administrator tokens for another app cannot admit", async () => {
  expect(
    (await request("access/admit", await tokenFor("guest"), {})).status,
  ).toBe(403);
  expect(
    (
      await request(
        "access/admit",
        await tokenFor("admin", "other-heima-app"),
        {},
      )
    ).status,
  ).toBe(401);
  expect(
    (await request("access/admit", await tokenFor("admin-alias"), {})).status,
  ).toBe(403);
});

test("administrators cannot manage owner-only household access", async () => {
  for (const path of [
    "access/invitations",
    `access/members/${adminId}/revoke`,
  ]) {
    expect(
      (
        await request(path, admin, {
          commandId: crypto.randomUUID(),
          email: "guest@heima.test",
        })
      ).status,
    ).toBe(403);
  }
});

test("administrator reads and writes fail when exact-app eligibility is revoked or unavailable", async () => {
  try {
    await controls({ denyUser: adminId });
    expect((await request("home", admin)).status).toBe(403);
    expect(
      (
        await request("work/items", admin, {
          commandId: crypto.randomUUID(),
          title: "Must not be written",
        })
      ).status,
    ).toBe(403);
    await controls({ reset: true, upstreamFailure: true });
    expect((await request("access/admit", admin, {})).status).toBe(503);
  } finally {
    await controls({ reset: true });
  }
  expect((await request("home", admin)).status).toBe(200);
});

test("administrators use shared and own resources without reading another member's private data", async () => {
  const stamp = crypto.randomUUID();
  const privateList = await create(
    "shopping/lists",
    { name: `Owner private ${stamp}`, visibility: "personal" },
    owner,
  );
  const privateWork = await create(
    "work/items",
    { title: `Owner private ${stamp}`, visibility: "personal" },
    owner,
  );
  const sharedList = await create(
    "shopping/lists",
    { name: `Shared ${stamp}`, visibility: "household" },
    owner,
  );
  const ownList = await create("shopping/lists", {
    name: `Admin private ${stamp}`,
    visibility: "personal",
  });
  await create("shopping/items", { name: "Milk", listId: sharedList.id });
  const ownWork = await create("work/items", {
    title: `Admin task ${stamp}`,
    visibility: "personal",
  });
  expect((await read(`work/items/${ownWork.id}`)).ownerId).toBe(adminId);
  for (const path of [
    `shopping/lists/${privateList.id}`,
    `shopping/lists/${privateList.id}/history`,
    `work/items/${privateWork.id}`,
    `work/items/${privateWork.id}/history`,
  ])
    expect((await request(path, admin)).status).toBe(404);
  expect((await request(`shopping/lists/${ownList.id}`, owner)).status).toBe(
    404,
  );
  const lists = await read(`shopping/lists?q=${stamp}`);
  expect(lists.items.map((r: { id: string }) => r.id)).toContain(sharedList.id);
  expect(lists.items.map((r: { id: string }) => r.id)).not.toContain(
    privateList.id,
  );
  for (const path of ["home", "activity"])
    expect(JSON.stringify(await read(path))).not.toContain(
      `Owner private ${stamp}`,
    );
});

test("administrator financial summaries and budget responses exclude other people's private aggregates", async () => {
  // Opening Finance initializes its default taxonomy before custom categories.
  const defaults = await read("finance/categories");
  expect(defaults.items.map((row: { name: string }) => row.name)).toEqual(
    expect.arrayContaining(["Housing", "Groceries", "Health", "Other"]),
  );
  const stamp = crypto.randomUUID();
  const category = await create(
    "finance/categories",
    { name: `Admin privacy ${stamp}` },
    owner,
  );
  const month = "2041-05";
  const budget = await create(
    "finance/budgets",
    { categoryId: category.id, month, amount: "1000.00" },
    owner,
  );
  const privateAccount = await create(
    "finance/accounts",
    {
      name: `Owner secret ${stamp}`,
      currency: "DKK",
      shared: false,
      visibility: "personal",
    },
    owner,
  );
  const sharedAccount = await create(
    "finance/accounts",
    { name: `Joint ${stamp}`, currency: "DKK", shared: true },
    owner,
  );
  const ownAccount = await create("finance/accounts", {
    name: `Admin account ${stamp}`,
    currency: "DKK",
    visibility: "personal",
  });
  const add = (accountId: string, amount: string, token: string) =>
    create(
      "finance/transactions",
      {
        accountId,
        amount,
        currency: "DKK",
        bookingDate: `${month}-17`,
        description: `Privacy proof ${stamp}`,
        categoryId: category.id,
        role: "spending",
        reason: "Synthetic verification",
      },
      token,
    );
  await add(sharedAccount.id, "-17.00", admin);
  await add(ownAccount.id, "-23.00", admin);
  const paths = [
    `finance/overview?month=${month}&comparison=previous-period`,
    `finance/spending?month=${month}`,
    `finance/budgets/${budget.id}`,
    `finance/budgets?month=${month}`,
  ];
  const before = await Promise.all(paths.map((path) => read(path)));
  const privateTransaction = await add(privateAccount.id, "-9876.00", owner);
  for (const [index, path] of paths.entries())
    expect(await read(path)).toEqual(before[index]);
  expect(
    before[0].categories.find(
      (c: { categoryId: string }) => c.categoryId === category.id,
    ).actual,
  ).toBe("40.00");
  expect((await read(`finance/budgets/${budget.id}`, owner)).actual).toBe(
    "9916.00",
  );
  for (const path of [
    `finance/accounts/${privateAccount.id}`,
    `finance/transactions/${privateTransaction.id}`,
    `finance/transactions/${privateTransaction.id}/history`,
  ])
    expect((await request(path, admin)).status).toBe(404);
  const changed = await request(`finance/budgets/${budget.id}`, admin, {
    commandId: crypto.randomUUID(),
    baseVersion: budget.version,
    amount: "2000.00",
  });
  expect(changed.status).toBe(200);
  expect((await changed.json()).actual).toBe("40.00");
});

test("removing and restoring configured admin UUIDs takes effect across process restarts", async () => {
  const original = (await read("access")).member;
  const portReservation = createServer();
  await new Promise<void>((resolve) =>
    portReservation.listen(0, "127.0.0.1", resolve),
  );
  const address = portReservation.address();
  if (!address || typeof address === "string")
    throw new Error("No local test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    portReservation.close((error) => (error ? reject(error) : resolve())),
  );
  const emptySchema = `heima_admin_${Date.now()}`;
  for (const mode of [
    { configured: "", schema: process.env.DATABASE_SCHEMA },
    { configured: adminId, schema: process.env.DATABASE_SCHEMA },
    { configured: adminId, schema: emptySchema },
  ]) {
    const { configured, schema } = mode;
    const admitted = !!configured && schema !== emptySchema;
    const api = Bun.spawn(["bun", "apps/api/src/index.ts"], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        PORT: String(port),
        APP_ADMIN_USER_IDS: configured,
        DATABASE_SCHEMA: schema,
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (api.exitCode !== null)
          throw new Error("Isolated admission API exited before readiness");
        try {
          ready = (await fetch(`http://127.0.0.1:${port}/health/live`)).ok;
        } catch {}
        if (ready) break;
        await Bun.sleep(100);
      }
      expect(ready).toBe(true);
      const call = (path: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${port}/v1/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${admin}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const access = await call("access/admit", {});
      expect(access.status).toBe(admitted ? 200 : 403);
      if (admitted) expect((await access.json()).member).toEqual(original);
      for (const path of [
        "home",
        "shopping/lists",
        "work/items",
        "finance/overview",
        "activity",
      ])
        expect((await call(path)).status).toBe(admitted ? 200 : 403);
      if (!admitted)
        expect(
          (
            await call("work/items", {
              commandId: crypto.randomUUID(),
              title: "Denied after removal",
            })
          ).status,
        ).toBe(403);
    } finally {
      api.kill("SIGTERM");
      await Promise.race([api.exited, Bun.sleep(5000)]);
      if (api.exitCode === null) {
        api.kill("SIGKILL");
        await api.exited;
      }
      if (schema === emptySchema) {
        // Remove only this process's freshly migrated disposable test schema.
        const database = postgres(process.env.DATABASE_URL ?? "", {
          max: 1,
          onnotice: () => {},
        });
        try {
          await database`DROP SCHEMA ${database(emptySchema)} CASCADE`;
        } finally {
          await database.end();
        }
      }
    }
  }
}, 30000);
