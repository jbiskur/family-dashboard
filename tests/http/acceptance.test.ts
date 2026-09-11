import { beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { loadTestEnv, request, tokenFor } from "../fixtures/auth";

const require = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const XLSX = require("xlsx");
const stamp = crypto.randomUUID();
let owner: string;
let spouse: string;
async function read(path: string, token = owner) {
  const response = await request(path, token);
  expect(response.status).toBe(200);
  return response.json();
}
async function command(
  path: string,
  data: Record<string, unknown>,
  token = owner,
) {
  const response = await request(path, token, {
    commandId: crypto.randomUUID(),
    ...data,
  });
  return { status: response.status, body: await response.json() };
}
async function create(
  path: string,
  data: Record<string, unknown>,
  token = owner,
) {
  const result = await command(path, data, token);
  expect(result.status).toBe(201);
  return result.body;
}
async function change(
  path: string,
  row: { id: string; version: number },
  data: Record<string, unknown>,
  token = owner,
  action = "",
) {
  const result = await command(
    `${path}/${row.id}${action ? `/${action}` : ""}`,
    { baseVersion: row.version, ...data },
    token,
  );
  expect(result.status).toBe(200);
  return result.body;
}
beforeAll(async () => {
  await loadTestEnv();
  owner = await tokenFor();
  spouse = await tokenFor("spouse");
  expect((await request("access/admit", owner, {})).status).toBe(200);
  const state = await read("access");
  if (
    !state.members.some(
      (m: { role: string; status: string }) =>
        m.role === "spouse" && m.status === "active",
    )
  ) {
    if (
      state.invitation &&
      ["pending", "requesting", "request-failed"].includes(
        state.invitation.status,
      )
    )
      await command(`access/invitations/${state.invitation.id}/cancel`, {});
    expect(
      (await command("access/invitations", { email: "spouse@heima.test" }))
        .status,
    ).toBe(201);
    expect((await request("access/admit", spouse, {})).status).toBe(200);
  }
});

// fc1b28d5-86d1-45bc-9be4-8011d3e96393 S1,S4,S5: observed queue failures are actor-private.
test("A12 sync failures deduplicate, retain safe area fallbacks and never disclose another person's work", async () => {
  const work = await create("work/items", { title: `Queue failure ${stamp}` });
  const failedCommandId = crypto.randomUUID();
  expect(
    (
      await command(`work/items/${work.id}`, {
        commandId: failedCommandId,
        baseVersion: 0,
        title: "Stale queued title",
      })
    ).status,
  ).toBe(409);
  const report = { failedCommandId, resourceId: work.id, area: "work" };
  const submit = async (body: unknown, token = owner) => {
    const response = await request("activity/sync-failures", token, body);
    return { status: response.status, body: await response.json() };
  };
  const first = await submit(report);
  expect(first.status).toBe(200);
  expect(first.body.recorded).toBe(true);
  expect((await submit(report)).body.id).toBe(first.body.id);
  let entries = (await read("activity")).items;
  expect(
    entries.filter((e: { id: string }) => e.id === first.body.id),
  ).toHaveLength(1);
  const entry = entries.find((e: { id: string }) => e.id === first.body.id);
  expect(entry.category).toBe("syncFailures");
  expect(entry.title).toBe("A queued change needs review");
  expect(entry.href).toBe(`/work?item=${work.id}`);
  expect(JSON.stringify(entry)).not.toContain(stamp);
  expect(
    (await read("activity", spouse)).items.some(
      (e: { id: string }) => e.id === first.body.id,
    ),
  ).toBe(false);
  expect((await submit({ ...report, title: "Arbitrary content" })).status).toBe(
    400,
  );
  expect((await submit({ ...report, area: "finance" })).status).toBe(400);
  expect((await submit(report, spouse)).status).toBe(409);

  const privateWork = await create(
    "work/items",
    { title: `Hidden ${stamp}`, visibility: "personal" },
    spouse,
  );
  const hidden = await submit({
    failedCommandId: crypto.randomUUID(),
    resourceId: privateWork.id,
    area: "work",
  });
  const missing = await submit({
    failedCommandId: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
    area: "work",
  });
  const newShopping = await submit({
    failedCommandId: crypto.randomUUID(),
    area: "shopping",
  });
  entries = (await read("activity")).items;
  for (const response of [hidden, missing]) {
    expect(response.status).toBe(200);
    expect(
      entries.find((e: { id: string }) => e.id === response.body.id).href,
    ).toBe("/work");
  }
  expect(
    entries.find((e: { id: string }) => e.id === newShopping.body.id).href,
  ).toBe("/shopping");
  expect((await command(`activity/${hidden.body.id}/read`, {})).status).toBe(
    200,
  );

  const completeId = crypto.randomUUID();
  expect(
    (
      await command(`work/items/${work.id}`, {
        commandId: completeId,
        baseVersion: work.version,
        note: "Saved",
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await submit({
        failedCommandId: completeId,
        resourceId: work.id,
        area: "work",
      })
    ).body,
  ).toEqual({ id: null, recorded: false });

  let shared = await create(
    "work/items",
    { title: "Scope may change" },
    spouse,
  );
  const scoped = await submit({
    failedCommandId: crypto.randomUUID(),
    resourceId: shared.id,
    area: "work",
  });
  expect(scoped.body.recorded).toBe(true);
  shared = await change(
    "work/items",
    shared,
    { visibility: "personal", confirmScope: true },
    spouse,
  );
  expect(
    (await read("activity")).items.find(
      (e: { id: string }) => e.id === scoped.body.id,
    ).href,
  ).toBe("/work");
});

// 356f3e15-0c04-4aac-a838-55352310e95c S1,S3,S4; no destructive membership reset.
test("A1 occupied household rejects a third slot and spouse owner capabilities", async () => {
  const before = await read("access");
  const callbacks = await Promise.all(
    Array.from({ length: 4 }, () => request("access/admit", spouse, {})),
  );
  expect(callbacks.every((r) => r.status === 200)).toBe(true);
  expect(
    (await command("access/invitations", { email: "third@heima.test" })).status,
  ).toBe(409);
  expect(
    (await command("access/invitations", { email: "third@heima.test" }, spouse))
      .status,
  ).toBe(403);
  const ownerId = before.members.find(
    (m: { role: string }) => m.role === "owner",
  ).userId;
  expect(
    (await command(`access/members/${ownerId}/revoke`, {}, spouse)).status,
  ).toBe(403);
  expect((await command(`access/members/${ownerId}/revoke`, {})).status).toBe(
    409,
  );
  const after = await read("access");
  expect(after.members).toEqual(before.members);
  expect(
    after.members.filter(
      (m: { status: string; role: string }) =>
        m.status === "active" && m.role !== "admin",
    ),
  ).toHaveLength(2);
  expect(JSON.stringify((await read("access", spouse)).members)).not.toContain(
    "@heima.test",
  );
});

// 7f3e4bf3-6659-4010-8c57-b1be2f9f12c9 S1-S4; 4309c82f-f717-4d56-8faa-cc5d492fad75 S1-S3.
test("A2 financial filters intersect and private rows never enter search results", async () => {
  const account = await create("finance/accounts", {
    name: `Filter ${stamp}`,
    currency: "DKK",
  });
  const privateAccount = await create(
    "finance/accounts",
    { name: `Secret ${stamp}`, currency: "DKK", visibility: "personal" },
    spouse,
  );
  const category = await create("finance/categories", {
    name: `Filter category ${stamp}`,
  });
  const common = {
    currency: "DKK",
    bookingDate: "2033-04-15",
    transactionDate: "2033-04-14",
    valueDate: "2033-04-16",
    description: `Needle ${stamp}`,
    reference: "original-reference",
    reason: "Acceptance receipt",
    role: "spending",
    categoryId: category.id,
  };
  const wanted = await create("finance/transactions", {
    ...common,
    accountId: account.id,
    amount: "-10.03",
  });
  await create("finance/transactions", {
    ...common,
    accountId: account.id,
    amount: "99.00",
    role: "income",
  });
  await create("finance/transactions", {
    ...common,
    accountId: account.id,
    amount: "-11.00",
    bookingDate: "2033-05-01",
  });
  await create(
    "finance/transactions",
    { ...common, accountId: privateAccount.id, amount: "-999.99" },
    spouse,
  );
  const query = new URLSearchParams({
    accountId: account.id,
    from: "2033-04-01",
    to: "2033-04-30",
    categoryId: category.id,
    role: "spending",
    reconciliationState: "reconciled",
    q: stamp,
  });
  const result = await read(`finance/transactions?${query}`);
  expect(result.items).toHaveLength(1);
  expect(result.items[0].id).toBe(wanted.id);
  expect(result.items[0]).toMatchObject({
    amount: "-10.03",
    currency: "DKK",
    transactionDate: "2033-04-14",
    valueDate: "2033-04-16",
    source: "manual",
    sourceId: null,
  });
  const search = await read(`finance/transactions?month=2033-04&q=${stamp}`);
  expect(JSON.stringify(search)).not.toContain(privateAccount.id);
  expect(JSON.stringify(search)).not.toContain("999.99");
  expect(
    (
      await request(
        `finance/transactions?accountId=${privateAccount.id}`,
        owner,
      )
    ).status,
  ).toBe(404);
  expect(
    (await request("finance/transactions?accountId=short", owner)).status,
  ).toBe(400);
  expect(
    (await request("finance/transactions?from=2033-05-01&to=2033-04-01", owner))
      .status,
  ).toBe(400);
  expect(
    (
      await read(
        `finance/transactions?accountId=${account.id}&month=2033-04&period=quarter`,
      )
    ).items,
  ).toHaveLength(3);
  expect(
    (
      await read(
        `finance/transactions?accountId=${account.id}&month=2033-04&period=year`,
      )
    ).items,
  ).toHaveLength(3);
});

// 0230cd86-af8c-437a-9a01-afb4839ddb25 S1,S3,S4; 5acb0582-b26c-4d24-9454-883b84e286f5 S2,S4.
test("A3 cross-currency provenance and period comparison remain exact", async () => {
  const account = await create("finance/accounts", {
    name: `FX ${stamp}`,
    currency: "USD",
  });
  const category = await create("finance/categories", {
    name: `FX category ${stamp}`,
  });
  const original = await create("finance/transactions", {
    accountId: account.id,
    amount: "-10.01",
    currency: "USD",
    bookingDate: "2034-02-02",
    description: "Original USD",
    reason: "Published statement rate",
    role: "spending",
    categoryId: category.id,
    reportingRate: "7.123456",
    reportingRateDate: "2034-02-02",
  });
  const summary = await read(
    "finance/spending?month=2034-02&comparison=previous-year",
  );
  expect(
    summary.categories.find(
      (c: { categoryId: string }) => c.categoryId === category.id,
    ).actual,
  ).toBe("71.31");
  expect(summary.comparison.from).toBe("2033-02-01");
  expect(summary.comparison.to).toBe("2033-02-28");
  const provenance = await read(`finance/transactions/${original.id}`);
  expect(provenance.amount).toBe("-10.01");
  expect(provenance.reportingRate).toBe("7.123456");
  expect(provenance.reportingRateDate).toBe("2034-02-02");
  await create("finance/transactions", {
    accountId: account.id,
    amount: "-1.00",
    currency: "USD",
    bookingDate: "2034-02-03",
    description: "Missing rate",
    reason: "Missing conversion evidence",
    role: "spending",
  });
  expect((await read("finance/overview?month=2034-02")).incomplete).toBe(true);
  const leap = await read(
    "finance/overview?month=2036-02&comparison=previous-period",
  );
  expect(leap.from).toBe("2036-02-01");
  expect(leap.to).toBe("2036-02-29");
  expect(leap.comparison.from).toBe("2036-01-03");
  expect(leap.comparison.to).toBe("2036-01-31");
});

// 1ac0abfd-e7f7-4d7f-8b06-c1256f0eb680 S1-S4; f972dec6-6666-4338-b2ec-3e246e3ff2d2 S1-S4.
test("A4 category archive preserves history and budget zero differs from absence", async () => {
  const defaults = await read("finance/categories");
  expect(
    ["Housing", "Groceries", "Health", "Other"].every((name) =>
      defaults.items.some((r: { name: string }) => r.name === name),
    ),
  ).toBe(true);
  let parent = await create("finance/categories", { name: `Archive ${stamp}` });
  const child = await create("finance/categories", {
    name: "Nested",
    parentId: parent.id,
  });
  parent = await change(
    "finance/categories",
    parent,
    { name: `Renamed ${stamp}` },
    spouse,
  );
  const budget = await create("finance/budgets", {
    categoryId: child.id,
    month: "2035-05",
    amount: "0.00",
  });
  expect(budget.actual).toBe("0.00");
  expect(budget.remaining).toBe("0.00");
  const edited = await change(
    "finance/budgets",
    budget,
    { amount: "25.10" },
    spouse,
  );
  expect(edited.id).toBe(budget.id);
  expect(
    (
      await command(`finance/budgets/${budget.id}`, {
        baseVersion: budget.version,
        amount: "999.00",
      })
    ).status,
  ).toBe(409);
  const archived = await change(
    "finance/budgets",
    edited,
    {},
    owner,
    "archive",
  );
  expect(archived.archived).toBe(true);
  expect(
    (await read("finance/budgets?month=2035-05")).items.some(
      (r: { id: string }) => r.id === budget.id,
    ),
  ).toBe(false);
  expect(
    (await read(`finance/budgets/${budget.id}/history`)).items,
  ).toHaveLength(3);
  await change("finance/categories", parent, {}, spouse, "archive");
  expect((await read(`finance/categories/${child.id}`)).archived).toBe(true);
  expect(
    (await read(`finance/categories/${child.id}/history`)).items.some(
      (h: { action: string }) => h.action === "parent-archived",
    ),
  ).toBe(true);
  expect(
    (
      await command("finance/budgets", {
        categoryId: child.id,
        month: "2035-06",
        amount: "1.00",
      })
    ).status,
  ).toBe(409);
});

// d1712d7f-af94-4946-8629-c065fb780a23 S1-S5; e1664e78-0689-48fa-a609-3c7e2d467772 S1-S3.
test("A5 CSV, XLS and XLSX use explicit interpretation without mutating preview", async () => {
  const account = await create("finance/accounts", {
    name: `Formats ${stamp}`,
    currency: "DKK",
  });
  const mapping = {
    bookingDate: "Booked",
    transactionDate: "Transaction",
    valueDate: "Value",
    amount: "Amount",
    description: "Description",
    sourceId: "ID",
    reference: "Reference",
  };
  const rows = [
    [
      "Booked",
      "Transaction",
      "Value",
      "Amount",
      "Description",
      "ID",
      "Reference",
    ],
    [
      "15/04/2035",
      "14/04/2035",
      "16/04/2035",
      "-1.234,56",
      "Market",
      "source-1",
      "bank-ref",
    ],
  ];
  for (const bookType of ["xls", "xlsx"] as const) {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Ignore this worksheet"]]),
      "Cover",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(rows),
      "Statement",
    );
    const content = XLSX.write(workbook, { type: "buffer", bookType });
    const response = await request("finance/imports/preview", owner, {
      accountId: account.id,
      fileName: `statement.${bookType}`,
      contentBase64: Buffer.from(content).toString("base64"),
      sheet: "Statement",
      mapping,
      dateFormat: "dd/MM/yyyy",
      decimalSeparator: ",",
    });
    expect(response.status).toBe(200);
    const parsed = await response.json();
    expect(parsed.valid).toBe(true);
    expect(parsed.rows[0]).toMatchObject({
      amount: "-1234.56",
      bookingDate: "2035-04-15",
      transactionDate: "2035-04-14",
      valueDate: "2035-04-16",
      sourceId: "source-1",
      reference: "bank-ref",
    });
    expect(parsed.rows[0].original.Amount).toBe("-1.234,56");
  }
  const csv =
    "Report header\nBooked;Transaction;Value;Amount;Description;ID;Reference\n15/04/2035;14/04/2035;16/04/2035;-1.234,56;Market;source-1;bank-ref\n";
  const file = {
    accountId: account.id,
    fileName: "statement.csv",
    contentBase64: Buffer.from(csv).toString("base64"),
    headerRow: 2,
    delimiter: ";",
    mapping,
    dateFormat: "dd/MM/yyyy",
    decimalSeparator: ",",
  };
  const response = await request("finance/imports/preview", owner, file);
  expect(response.status).toBe(200);
  const preview = await response.json();
  expect(preview.valid).toBe(true);
  const invalid = await request("finance/imports/preview", owner, {
    ...file,
    decimalSeparator: ".",
  });
  expect(invalid.status).toBe(200);
  expect((await invalid.json()).valid).toBe(false);
  expect(
    (await read(`finance/transactions?accountId=${account.id}&month=2035-04`))
      .items,
  ).toHaveLength(0);
  const batch = await create("finance/imports", preview);
  expect(
    (
      await command(`finance/imports/${batch.id}`, {
        baseVersion: batch.version,
        mapping: { ...mapping, reference: "ID" },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await command(`finance/imports/${batch.id}`, {
        baseVersion: batch.version,
        rows: batch.rows.map((r: Record<string, unknown>) => ({
          ...r,
          reference: "edited",
        })),
      })
    ).status,
  ).toBe(409);
  expect(
    (await read(`finance/imports/${batch.id}/history`)).items,
  ).toHaveLength(1);
});

// 7025de7c-5fb5-4e08-939b-eff542fb1dc3 S1-S4; 2e58d7da-a071-4cb3-9d13-8ac8a8d4af6e S1-S4.
test("A6 profile and removed work history retain identity, actor and prior values", async () => {
  const membership = (await read("access")).members;
  let profile = await create("household/profiles", {
    name: `Before ${stamp}`,
    email: "must-not-store@heima.test",
    birthDate: "2010-01-01",
  });
  expect(profile.email).toBeUndefined();
  expect(profile.birthDate).toBeUndefined();
  const firstVersion = profile.version;
  profile = await change(
    "household/profiles",
    profile,
    { name: `After ${stamp}` },
    spouse,
  );
  expect(
    (
      await command(`household/profiles/${profile.id}`, {
        baseVersion: firstVersion,
        name: "Stale",
      })
    ).status,
  ).toBe(409);
  let work = await create("work/items", {
    title: `Remove ${stamp}`,
    assigneeId: profile.id,
    dueDate: "2035-04-15",
  });
  profile = await change("household/profiles", profile, {}, owner, "archive");
  expect((await read(`work/items/${work.id}`)).assigneeId).toBe(profile.id);
  work = await change("work/items", work, {}, spouse, "archive");
  expect(
    (await read("work/items")).items.some(
      (r: { id: string }) => r.id === work.id,
    ),
  ).toBe(false);
  expect(
    (await read("work/items?includeArchived=true")).items.some(
      (r: { id: string }) => r.id === work.id,
    ),
  ).toBe(true);
  const history = (await read(`work/items/${work.id}/history`)).items;
  expect(history[0].action).toBe("archive");
  expect(history[0].actorId).toBe("00000000-0000-4000-8000-000000000002");
  expect(history[0].before.assigneeId).toBe(profile.id);
  expect(
    (await read(`household/profiles/${profile.id}/history`)).items.some(
      (h: { before?: { name: string }; after?: { name: string } }) =>
        h.before?.name === `Before ${stamp}` &&
        h.after?.name === `After ${stamp}`,
    ),
  ).toBe(true);
  expect((await read("access")).members).toEqual(membership);
});

// 4e2d9ae3-ef97-4a6f-9c8f-dc5c514f7d1f S1-S4; 64e88dcf-cfa7-4882-8863-4ef8dccc7391 S1-S4.
test("A7 scope confirmation, deliberate stale reapply and recurrence rules preserve one identity", async () => {
  let work = await create("work/items", {
    title: `Personal ${stamp}`,
    visibility: "personal",
    assigneeId: "00000000-0000-4000-8000-000000000001",
    dueDate: "2035-01-01",
  });
  const id = work.id;
  expect(
    (
      await command(`work/items/${id}`, {
        baseVersion: work.version,
        visibility: "household",
      })
    ).status,
  ).toBe(409);
  work = await change("work/items", work, {
    visibility: "household",
    confirmScope: true,
  });
  expect(work.assigneeId).toBeNull();
  expect((await read(`work/items/${id}`, spouse)).id).toBe(id);
  const stale = work;
  work = await change(
    "work/items",
    work,
    { title: "Other spouse edit" },
    spouse,
  );
  expect(
    (
      await command(`work/items/${id}`, {
        baseVersion: stale.version,
        note: "My draft",
      })
    ).status,
  ).toBe(409);
  work = await change("work/items", work, { note: "My draft" });
  expect(work.title).toBe("Other spouse edit");
  expect(work.note).toBe("My draft");
  work = await change("work/items", work, {
    recurrence: { unit: "week", interval: 2 },
    confirmSeries: true,
  });
  const completeId = crypto.randomUUID();
  const body = {
    commandId: completeId,
    baseVersion: work.version,
    status: "done",
  };
  const replies = await Promise.all([
    request(`work/items/${id}`, owner, body),
    request(`work/items/${id}`, owner, body),
  ]);
  expect(replies.every((r) => r.status === 200)).toBe(true);
  const completed = await replies[0]?.json();
  const next = await read(`work/items/${completed.nextOccurrenceId}`);
  expect(next.dueDate).toBe("2035-01-15");
  expect(next.previousOccurrenceId).toBe(id);
  expect(
    (
      await command(`work/items/${id}`, {
        baseVersion: completed.version,
        recurrence: null,
        confirmSeries: true,
      })
    ).status,
  ).toBe(409);
  const converted = await change("work/items", next, {
    visibility: "personal",
    confirmScope: true,
  });
  expect(converted.id).toBe(next.id);
  expect((await request(`work/items/${next.id}/history`, spouse)).status).toBe(
    404,
  );
});

// a83f1ed2-d88b-44a1-87b6-119ab2ef8053 S3,S4; Home attention public projection.
test("A8 timed work becomes overdue during its local due day and clearing a due date removes attention", async () => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Atlantic/Faroe",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  let work = await create("work/items", {
    title: `Timed overdue ${stamp}`,
    dueDate: today,
    dueTime: "00:00",
  });
  const home = await read("home");
  expect(home.attention.some((r: { id: string }) => r.id === work.id)).toBe(
    true,
  );
  work = await change("work/items", work, { dueDate: null, dueTime: null });
  expect(work.dueAt).toBeNull();
  expect(
    (await read("home")).attention.some(
      (r: { id: string }) => r.id === work.id,
    ),
  ).toBe(false);
});

// 356f3e15-0c04-4aac-a838-55352310e95c S2-S4, amended plan 2f3b5b6d-b038-43a0-8115-5839d85a59ce.
// Only the isolated local provider's spouse is changed; finally restores claims and explicit admission.
test("A9 invitation cancellation, explicit restoration and signed UUID custody survive claim changes", async () => {
  const issuer = new URL(process.env.USABLE_ISSUER ?? "");
  if (
    !["127.0.0.1", "localhost"].includes(issuer.hostname) ||
    issuer.pathname !== "/realms/heima-test"
  )
    throw new Error(
      "Identity mutation is restricted to the isolated local test provider",
    );
  const login = await fetch(
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
  expect(login.status).toBe(200);
  const admin = await login.json();
  const spouseId = "00000000-0000-4000-8000-000000000002";
  const endpoint = `${issuer.origin}/admin/realms/heima-test/users/${spouseId}`;
  const headers = {
    authorization: `Bearer ${admin.access_token}`,
    "content-type": "application/json",
  };
  const originalResponse = await fetch(endpoint, { headers });
  expect(originalResponse.status).toBe(200);
  const original = await originalResponse.json();
  const restoreFields = {
    username: original.username,
    firstName: original.firstName,
    lastName: original.lastName,
    email: original.email,
    emailVerified: original.emailVerified,
    attributes: original.attributes,
    requiredActions: original.requiredActions,
  };
  async function provider(patch: Record<string, unknown>) {
    const response = await fetch(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...restoreFields, ...patch }),
    });
    expect(response.status).toBe(204);
  }
  async function cancelPending() {
    const state = await read("access");
    if (
      state.invitation &&
      ["pending", "requesting", "request-failed"].includes(
        state.invitation.status,
      )
    )
      expect(
        (await command(`access/invitations/${state.invitation.id}/cancel`, {}))
          .status,
      ).toBe(200);
  }
  try {
    expect(
      (await command(`access/members/${spouseId}/revoke`, {})).status,
    ).toBe(200);
    expect((await request("home", spouse)).status).toBe(403);
    expect((await request("access/admit", spouse, {})).status).toBe(403);
    const wrong = await command("access/invitations", {
      email: "mismatch@heima.test",
    });
    expect(wrong.status).toBe(201);
    expect(wrong.body.invitation.status).toBe("pending");
    expect((await request("access/admit", spouse, {})).status).toBe(403);
    expect(
      (await command("access/invitations", { email: "spouse@heima.test" }))
        .status,
    ).toBe(409);
    const resendId = crypto.randomUUID();
    const resendPath = `access/invitations/${wrong.body.invitation.id}/resend`;
    expect(
      (await request(resendPath, owner, { commandId: resendId })).status,
    ).toBe(200);
    expect(
      (await request(resendPath, owner, { commandId: resendId })).status,
    ).toBe(200);
    const cancelled = await command(
      `access/invitations/${wrong.body.invitation.id}/cancel`,
      {},
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.invitation.status).toBe("cancelled");
    expect(cancelled.body.invitation.email).toBeUndefined();
    expect((await request("access/admit", spouse, {})).status).toBe(403);
    expect(
      (
        await command(
          `access/invitations/${wrong.body.invitation.id}/resend`,
          {},
        )
      ).status,
    ).toBe(409);
    const freshId = crypto.randomUUID();
    const invite = { commandId: freshId, email: " SPOUSE@HEIMA.TEST " };
    expect((await request("access/invitations", owner, invite)).status).toBe(
      201,
    );
    expect((await request("access/invitations", owner, invite)).status).toBe(
      201,
    );
    await provider({ emailVerified: false });
    expect(
      (await request("access/admit", await tokenFor("spouse"), {})).status,
    ).toBe(403);
    await provider({
      attributes: { ...original.attributes, usable_user_id: [] },
    });
    expect(
      (await request("access/admit", await tokenFor("spouse"), {})).status,
    ).toBe(401);
    await provider({
      attributes: { ...original.attributes, usable_user_id: ["malformed"] },
    });
    expect(
      (await request("access/admit", await tokenFor("spouse"), {})).status,
    ).toBe(401);
    await provider({
      attributes: {
        ...original.attributes,
        usable_user_id: ["00000000-0000-4000-8000-000000000001"],
      },
    });
    expect(
      (await request("access/admit", await tokenFor("spouse"), {})).status,
    ).toBe(403);
    await provider({});
    spouse = await tokenFor("spouse");
    const admitted = await Promise.all(
      Array.from({ length: 3 }, () => request("access/admit", spouse, {})),
    );
    expect(admitted.every((r) => r.status === 200)).toBe(true);
    const state = await read("access");
    expect(
      state.members.filter(
        (m: { status: string; role: string }) =>
          m.status === "active" && m.role !== "admin",
      ),
    ).toHaveLength(2);
    expect(
      state.members.find((m: { userId: string }) => m.userId === spouseId).role,
    ).toBe("spouse");
    expect(state.invitation.status).toBe("consumed");
    expect(state.invitation.email).toBeUndefined();
    await provider({ email: `renamed-${stamp}@heima.test` });
    const renamed = await tokenFor("spouse");
    expect((await request("access/admit", renamed, {})).status).toBe(200);
    expect((await read("access", renamed)).member.userId).toBe(spouseId);
  } finally {
    await provider({});
    spouse = await tokenFor("spouse");
    const state = await read("access");
    if (
      !state.members.some(
        (m: { userId: string; status: string }) =>
          m.userId === spouseId && m.status === "active",
      )
    ) {
      await cancelPending();
      expect(
        (await command("access/invitations", { email: "spouse@heima.test" }))
          .status,
      ).toBe(201);
      expect((await request("access/admit", spouse, {})).status).toBe(200);
    }
  }
}, 30_000);

// 0230cd86-af8c-437a-9a01-afb4839ddb25 S4: native smallest-unit precision.
test("A10 original currencies preserve zero and four fractional digit minor units", async () => {
  for (const [currency, amount] of [
    ["JPY", "123"],
    ["USD", "1.23"],
    ["CLF", "1.2345"],
  ]) {
    const account = await create("finance/accounts", {
      name: `Precision ${currency} ${stamp}`,
      currency,
    });
    const transaction = await create("finance/transactions", {
      accountId: account.id,
      currency,
      amount,
      bookingDate: "2035-01-01",
      description: "Native minor units",
      reason: "Currency precision receipt",
      role: "income",
    });
    expect(transaction.amount).toBe(amount);
    const tooPrecise = amount.includes(".") ? `${amount}1` : `${amount}.1`;
    const rejected = await command("finance/transactions", {
      accountId: account.id,
      currency,
      amount: tooPrecise,
      bookingDate: "2035-01-01",
      description: "No rounding permitted",
      reason: "Invalid minor unit",
      role: "income",
    });
    expect([400, 409]).toContain(rejected.status);
    expect((await read(`finance/accounts/${account.id}`)).balance).toBe(amount);
  }
});

// e1664e78-0689-48fa-a609-3c7e2d467772 S2-S3: trust exactly matches the resulting ledger.
test("A11 explained exclusions cannot make unmatched money look reconciled", async () => {
  const account = await create("finance/accounts", {
    name: `Explained ${stamp}`,
    currency: "DKK",
  });
  const previewResponse = await request("finance/imports/preview", owner, {
    accountId: account.id,
    fileName: "explained.csv",
    contentBase64: Buffer.from(
      "Date,Amount,Description\n2035-01-01,-12.34,Market\n2035-01-02,100.00,Deposit\n",
    ).toString("base64"),
    mapping: {
      bookingDate: "Date",
      amount: "Amount",
      description: "Description",
    },
  });
  expect(previewResponse.status).toBe(200);
  let batch = await create("finance/imports", await previewResponse.json());
  batch = await change("finance/imports", batch, {
    openingBalance: "0.00",
    closingBalance: "87.66",
    rows: batch.rows.map((r: { amount: string }) =>
      r.amount === "-12.34"
        ? {
            ...r,
            status: "explained",
            explanation: "Duplicate row excluded from ledger",
          }
        : r,
    ),
  });
  expect(batch.difference).toBe("-12.34");
  expect(
    (
      await command(`finance/imports/${batch.id}/reconcile`, {
        baseVersion: batch.version,
      })
    ).status,
  ).toBe(409);
  expect((await read(`finance/accounts/${account.id}`)).balance).toBeNull();
  batch = await change("finance/imports", batch, {
    rows: batch.rows.map((r: Record<string, unknown>) => ({
      ...r,
      status: "matched",
    })),
  });
  expect(batch.difference).toBe("0.00");
  batch = await change("finance/imports", batch, {}, owner, "reconcile");
  expect(batch.status).toBe("reconciled");
  expect((await read(`finance/accounts/${account.id}`)).balance).toBe("87.66");
});
