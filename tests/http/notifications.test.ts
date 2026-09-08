import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Browser, chromium, type Page } from "@playwright/test";
import { controls, loadTestEnv, request, tokenFor } from "../fixtures/auth";

let owner: string, spouse: string, browser: Browser, page: Page;
let preferences: Record<string, unknown> & { id: string; version: number };
let originalPreferences: Record<string, unknown> | undefined;
const spouseId = "00000000-0000-4000-8000-000000000002";
const devices: string[] = [];
const stamp = crypto.randomUUID();
async function read(path: string, token = spouse) {
  const r = await request(path, token);
  expect(r.status).toBe(200);
  return r.json();
}
async function command(
  path: string,
  data: Record<string, unknown>,
  token = spouse,
) {
  const r = await request(path, token, {
    commandId: crypto.randomUUID(),
    ...data,
  });
  return { status: r.status, body: await r.json() };
}
async function create(
  path: string,
  data: Record<string, unknown>,
  token = spouse,
) {
  const r = await command(path, data, token);
  expect(r.status).toBe(201);
  return r.body;
}
async function push(body: unknown) {
  const r = await fetch("http://127.0.0.1:3212/__push-controls", {
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(r.ok).toBe(true);
  return r.json();
}
async function captures(id?: string) {
  return (await push({ action: "captures", id })).items as {
    id: string;
    status: number;
    payload: Record<string, unknown>;
    vapidValid: boolean;
    encryptedBytes: number;
  }[];
}
async function eventually<T>(
  poll: () => Promise<T>,
  matches: (value: T) => boolean,
  timeout = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let value: T;
  do {
    value = await poll();
    if (matches(value)) return value;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  throw new Error("External-boundary outcome was not observed before timeout");
}
async function prefs(patch: Record<string, unknown>) {
  const result = await command(`settings/preferences/${preferences.id}`, {
    baseVersion: preferences.version,
    ...patch,
  });
  expect(result.status).toBe(200);
  preferences = result.body;
}
async function subscribe() {
  const registration = await push({ action: "create" });
  const row = await create("settings/devices", registration.subscription);
  devices.push(row.id);
  return { ...registration, row };
}
async function assigned(title: string) {
  return create("work/items", { title, assigneeId: spouseId }, owner);
}
function localMinutes() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Atlantic/Faroe",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date())
    .split(":");
  return Number(parts[0]) * 60 + Number(parts[1]);
}
function clock(minutes: number) {
  const n = (minutes + 1440) % 1440;
  return `${Math.floor(n / 60)
    .toString()
    .padStart(2, "0")}:${(n % 60).toString().padStart(2, "0")}`;
}

beforeAll(async () => {
  await loadTestEnv();
  owner = await tokenFor();
  spouse = await tokenFor("spouse");
  expect((await request("access/admit", owner, {})).status).toBe(200);
  const access = await read("access", owner);
  if (
    !access.members.some(
      (m: { userId: string; status: string }) =>
        m.userId === spouseId && m.status === "active",
    )
  ) {
    expect(
      (
        await command(
          "access/invitations",
          { email: "spouse@heima.test" },
          owner,
        )
      ).status,
    ).toBe(201);
    expect((await request("access/admit", spouse, {})).status).toBe(200);
  }
  originalPreferences = (await read("settings/preferences")).items[0];
  preferences = originalPreferences
    ? (originalPreferences as typeof preferences)
    : await create("settings/preferences", {});
  const key = await read("settings/push-public-key");
  expect(key.available).toBe(true);
  expect(key.publicKey).toBe(process.env.VAPID_PUBLIC_KEY);
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto("http://localhost:3010/");
  await page.getByRole("button", { name: "Continue with Usable" }).click();
  await page.locator("#username").fill("spouse@heima.test");
  await page.locator("#password").fill(process.env.TEST_USER_PASSWORD ?? "");
  await page.locator("#kc-login").click();
  await page.waitForURL("http://localhost:3010/", { timeout: 30_000 });
  const session = await page.evaluate(async () =>
    (await fetch("/api/auth/session")).json(),
  );
  expect(session.user.id).toBe(spouseId);
  expect(JSON.stringify(session)).not.toMatch(
    /accessToken|refreshToken|idToken|access_token/,
  );
}, 40_000);

afterAll(async () => {
  await controls({ reset: true });
  if (spouse) {
    const registered = await read("settings/devices");
    for (const row of registered.items.filter((r: { id: string }) =>
      devices.includes(r.id),
    ))
      expect(
        (
          await command(`settings/devices/${row.id}/archive`, {
            baseVersion: row.version,
          })
        ).status,
      ).toBe(200);
    if (preferences) {
      const latest = await read(`settings/preferences/${preferences.id}`);
      const path = originalPreferences
        ? `settings/preferences/${preferences.id}`
        : `settings/preferences/${preferences.id}/archive`;
      expect(
        (
          await command(path, {
            ...(originalPreferences ?? {}),
            baseVersion: latest.version,
          })
        ).status,
      ).toBe(200);
    }
  }
  if (page) {
    await page.goto("http://localhost:3010/settings/household");
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
  }
  await browser?.close();
}, 30_000);

test("N5 sync failure activity is immediate while its push preference independently controls generic delivery", async () => {
  await prefs({
    quietStart: "00:00",
    quietEnd: "00:00",
    shoppingChanges: false,
    workAssignment: false,
    dueReminders: false,
    recurrence: false,
    financeReview: false,
    syncFailures: false,
  });
  for (const entry of (await read("activity")).items.filter(
    (e: { category: string; read: boolean }) =>
      e.category === "syncFailures" && !e.read,
  ))
    expect((await command(`activity/${entry.id}/read`, {})).status).toBe(200);
  const registration = await subscribe();
  await push({ action: "clear" });
  const body = {
    failedCommandId: crypto.randomUUID(),
    area: "work",
    resourceId: crypto.randomUUID(),
  };
  const response = await request("activity/sync-failures", spouse, body);
  expect(response.status).toBe(200);
  const report = await response.json();
  expect(
    (await read("activity")).items.find(
      (e: { id: string }) => e.id === report.id,
    ).href,
  ).toBe("/work");
  await Bun.sleep(1200);
  expect(await captures(registration.id)).toHaveLength(0);
  await prefs({ syncFailures: true });
  const delivered = await eventually(
    () => captures(registration.id),
    (items) => items.length > 0,
  );
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.vapidValid).toBe(true);
  expect(delivered[0]?.payload.body).toBe("A queued change needs review");
  expect(delivered[0]?.payload.url).toBe("/work");
  expect(JSON.stringify(delivered)).not.toContain(body.resourceId);
  expect((await request("activity/sync-failures", spouse, body)).status).toBe(
    200,
  );
  await Bun.sleep(1200);
  expect(await captures(registration.id)).toHaveLength(1);
  expect(
    (
      await command(`settings/devices/${registration.row.id}/archive`, {
        baseVersion: registration.row.version,
      })
    ).status,
  ).toBe(200);
}, 30_000);

// eb2cefa6-5a47-481e-b430-89960338ed72 S1,S2,S4; fc1b28d5-86d1-45bc-9be4-8011d3e96393.
test("N6 finance push hides amounts and descriptions and excludes private accounts", async () => {
  await prefs({
    quietStart: "00:00",
    quietEnd: "00:00",
    shoppingChanges: false,
    workAssignment: false,
    dueReminders: false,
    recurrence: false,
    financeReview: false,
    syncFailures: false,
  });
  for (const entry of (await read("activity")).items.filter(
    (e: { category: string; read: boolean }) =>
      e.category === "financeReview" && !e.read,
  ))
    expect((await command(`activity/${entry.id}/read`, {})).status).toBe(200);
  await prefs({ financeReview: true });
  const registration = await subscribe();
  await push({ action: "clear" });
  const imported = async (shared: boolean) => {
    const account = await create(
      "finance/accounts",
      { name: `Secret account ${stamp}`, currency: "DKK", shared },
      owner,
    );
    const preview = await request("finance/imports/preview", owner, {
      accountId: account.id,
      fileName: "private-details.csv",
      contentBase64: Buffer.from(
        `Date,Amount,Description\n2035-01-01,-123.45,Secret transaction ${stamp}\n`,
      ).toString("base64"),
      mapping: {
        bookingDate: "Date",
        amount: "Amount",
        description: "Description",
      },
    });
    expect(preview.status).toBe(200);
    return create("finance/imports", await preview.json(), owner);
  };
  const privateBatch = await imported(false);
  expect(
    (await request(`finance/imports/${privateBatch.id}`, spouse)).status,
  ).toBe(404);
  await Bun.sleep(1200);
  expect(await captures(registration.id)).toHaveLength(0);
  const batch = await imported(true);
  const delivered = await eventually(
    () => captures(registration.id),
    (items) => items.length > 0,
  );
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.vapidValid).toBe(true);
  expect(delivered[0]?.payload.body).toBe("Finance review needs attention");
  expect(delivered[0]?.payload.url).toBe(`/finance/imports/${batch.id}`);
  expect(JSON.stringify(delivered)).not.toMatch(
    new RegExp(
      `${stamp}|123.45|private-details|Secret account|Secret transaction`,
    ),
  );
  expect(
    (
      await command(`settings/devices/${registration.row.id}/archive`, {
        baseVersion: registration.row.version,
      })
    ).status,
  ).toBe(200);
}, 30_000);

test("N1 overnight quiet hours retain in-app activity and release one encrypted privacy-safe digest", async () => {
  const minutes = localMinutes();
  const start = minutes < 720 ? "23:59" : clock(minutes - 60);
  const end = minutes < 720 ? clock(minutes + 60) : "00:00";
  expect(start > end).toBe(true);
  await prefs({
    quietStart: start,
    quietEnd: end,
    shoppingChanges: false,
    workAssignment: true,
    dueReminders: false,
    recurrence: false,
    financeReview: false,
    syncFailures: false,
  });
  const registration = await subscribe();
  await push({ action: "clear" });
  const first = await assigned(`Do not expose private task title ${stamp}`);
  const second = await assigned(`Second private task title ${stamp}`);
  const activity = (await read("activity")).items;
  expect(
    activity.some((e: { href: string }) => e.href.includes(first.id)),
  ).toBe(true);
  expect(
    activity.some((e: { href: string }) => e.href.includes(second.id)),
  ).toBe(true);
  await Bun.sleep(1200);
  expect(await captures(registration.id)).toHaveLength(0);
  await prefs({
    quietStart: clock(minutes + 120),
    quietEnd: clock(minutes + 180),
  });
  const delivered = await eventually(
    () => captures(registration.id),
    (items) => items.some((p) => p.status === 201),
  );
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.vapidValid).toBe(true);
  expect(delivered[0]?.encryptedBytes).toBeGreaterThan(32);
  expect(delivered[0]?.payload.title).toBe("Heima");
  expect(delivered[0]?.payload.body).toMatch(/household updates are ready/);
  expect(delivered[0]?.payload.url).toBe("/settings/notifications");
  expect(delivered[0]?.payload.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(delivered)).not.toContain(stamp);
  await Bun.sleep(1200);
  expect(await captures(registration.id)).toHaveLength(1);
  expect(
    (
      await command(`settings/devices/${registration.row.id}/archive`, {
        baseVersion: registration.row.version,
      })
    ).status,
  ).toBe(200);
}, 30_000);

test("N2 failed push never rolls back work; retry, expired device and disable remain independent", async () => {
  const first = await subscribe();
  const second = await subscribe();
  await push({ action: "clear" });
  await push({ action: "status", id: first.id, status: 503 });
  const work = await assigned(`Best effort ${stamp}`);
  expect((await read(`work/items/${work.id}`, owner)).title).toBe(
    `Best effort ${stamp}`,
  );
  await eventually(
    () => captures(first.id),
    (items) => items.some((r) => r.status === 503),
  );
  await eventually(
    () => captures(second.id),
    (items) => items.some((r) => r.status === 201),
  );
  await push({ action: "status", id: first.id, status: 201 });
  await eventually(
    () => captures(first.id),
    (items) => items.some((r) => r.status === 201),
  );
  expect(
    (
      await command(`settings/devices/${first.row.id}/archive`, {
        baseVersion: first.row.version,
      })
    ).status,
  ).toBe(200);
  const count = (await captures(first.id)).length;
  await push({ action: "status", id: second.id, status: 410 });
  await assigned(`Expire subscription ${stamp}`);
  await eventually(
    () => read("settings/devices"),
    (body) => !body.items.some((r: { id: string }) => r.id === second.row.id),
  );
  expect((await captures(second.id)).some((r) => r.status === 410)).toBe(true);
  expect((await captures(first.id)).length).toBe(count);
  expect(
    (await read(`settings/preferences/${preferences.id}`)).workAssignment,
  ).toBe(true);
}, 30_000);

test("N3 personal work and profiles create no spouse push, and current eligibility blocks delivery", async () => {
  const registration = await subscribe();
  await push({ action: "clear" });
  const profile = await create(
    "household/profiles",
    { name: `No login ${stamp}` },
    owner,
  );
  const personal = await create(
    "work/items",
    { title: `Hidden ${stamp}`, visibility: "personal" },
    owner,
  );
  const assignedProfile = await create(
    "work/items",
    { title: `Profile only ${stamp}`, assigneeId: profile.id },
    owner,
  );
  await Bun.sleep(1200);
  expect(await captures(registration.id)).toHaveLength(0);
  const activity = (await read("activity")).items;
  expect(
    activity.some(
      (e: { href: string }) =>
        e.href.includes(personal.id) || e.href.includes(assignedProfile.id),
    ),
  ).toBe(false);
  try {
    await controls({ denyUser: spouseId });
    const work = await assigned(`Eligibility ${stamp}`);
    expect((await request("activity", spouse)).status).toBe(403);
    expect((await read(`work/items/${work.id}`, owner)).id).toBe(work.id);
    await Bun.sleep(1200);
    expect(await captures(registration.id)).toHaveLength(0);
  } finally {
    await controls({ reset: true });
  }
  const delivered = await eventually(
    () => captures(registration.id),
    (items) => items.some((r) => r.status === 201),
  );
  expect(
    delivered.every(
      (r) =>
        String(r.payload.url).startsWith("/") &&
        !String(r.payload.url).startsWith("//"),
    ),
  ).toBe(true);
  expect(JSON.stringify(delivered)).not.toContain(stamp);
}, 30_000);

test("N4 upstream invitation failure is generic and retry creates no duplicate household admission", async () => {
  try {
    expect(
      (await command(`access/members/${spouseId}/revoke`, {}, owner)).status,
    ).toBe(200);
    for (const status of [404, 503]) {
      await controls({ inviteStatus: status });
      const failed = await command(
        "access/invitations",
        { email: "spouse@heima.test" },
        owner,
      );
      expect(failed.status).toBe(201);
      expect(failed.body.invitation.status).toBe("request-failed");
      expect(JSON.stringify(failed.body)).not.toMatch(
        /User not found|Dependency unavailable|email sent/,
      );
      expect((await request("access/admit", spouse, {})).status).toBe(403);
      if (status === 404)
        expect(
          (
            await command(
              `access/invitations/${failed.body.invitation.id}/cancel`,
              {},
              owner,
            )
          ).status,
        ).toBe(200);
      else {
        await controls({ inviteStatus: 201 });
        const retried = await command(
          `access/invitations/${failed.body.invitation.id}/resend`,
          {},
          owner,
        );
        expect(retried.status).toBe(200);
        expect(retried.body.invitation.id).toBe(failed.body.invitation.id);
        expect(retried.body.invitation.status).toBe("pending");
        expect((await request("access/admit", spouse, {})).status).toBe(200);
      }
    }
  } finally {
    await controls({ reset: true });
    const access = await read("access", owner);
    if (
      !access.members.some(
        (m: { userId: string; status: string }) =>
          m.userId === spouseId && m.status === "active",
      )
    ) {
      if (
        access.invitation &&
        ["pending", "requesting", "request-failed"].includes(
          access.invitation.status,
        )
      )
        await command(
          `access/invitations/${access.invitation.id}/cancel`,
          {},
          owner,
        );
      expect(
        (
          await command(
            "access/invitations",
            { email: "spouse@heima.test" },
            owner,
          )
        ).status,
      ).toBe(201);
      expect((await request("access/admit", spouse, {})).status).toBe(200);
    }
  }
}, 30_000);
