import { beforeAll, describe, expect, test } from "bun:test";
import { controls, loadTestEnv, request, tokenFor } from "../fixtures/auth";

let owner: string, spouse: string;
const stamp = crypto.randomUUID();
async function read(path: string, token = owner) {
  const response = await request(path, token);
  const body = await response.json();
  expect(response.status).toBe(200);
  return body;
}
async function create(
  path: string,
  data: Record<string, unknown>,
  token = owner,
) {
  const response = await request(path, token, {
    commandId: crypto.randomUUID(),
    ...data,
  });
  const body = await response.json();
  if (response.status !== 201)
    throw new Error(
      `${path} create ${response.status}: ${JSON.stringify(body)}`,
    );
  return body;
}
async function change(
  path: string,
  row: { id: string; version: number },
  data: Record<string, unknown>,
  token = owner,
  action = "",
) {
  const response = await request(
    `${path}/${row.id}${action ? `/${action}` : ""}`,
    token,
    { commandId: crypto.randomUUID(), baseVersion: row.version, ...data },
  );
  const body = await response.json();
  if (response.status !== 200)
    throw new Error(
      `${path} change ${response.status}: ${JSON.stringify(body)}`,
    );
  return body;
}
beforeAll(async () => {
  await loadTestEnv();
  await controls({ reset: true });
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
      await request(`access/invitations/${state.invitation.id}/cancel`, owner, {
        commandId: crypto.randomUUID(),
      });
    await create("access/invitations", { email: "spouse@heima.test" });
    expect((await request("access/admit", spouse, {})).status).toBe(200);
  }
}, 30_000);

describe("Household public resource boundaries", () => {
  test("shopping privacy follows list conversion; retries and stale edits cannot overwrite", async () => {
    let list = await create("shopping/lists", {
      name: `Private ${stamp}`,
      visibility: "personal",
    });
    expect((await request(`shopping/lists/${list.id}`, spouse)).status).toBe(
      404,
    );
    const commandId = crypto.randomUUID();
    const body = {
      commandId,
      listId: list.id,
      name: "Milk",
      quantity: "2 cartons",
    };
    const first = await (await request("shopping/items", owner, body)).json();
    const again = await (await request("shopping/items", owner, body)).json();
    expect(first.id).toBe(again.id);
    expect(again.version).toBe(1);
    expect((await request(`shopping/items/${first.id}`, spouse)).status).toBe(
      404,
    );
    const changed = await change("shopping/items", first, { name: "Oat milk" });
    expect(
      (
        await request(`shopping/items/${first.id}`, owner, {
          commandId: crypto.randomUUID(),
          baseVersion: first.version,
          name: "Stale",
        })
      ).status,
    ).toBe(409);
    expect((await read(`shopping/items/${first.id}`)).name).toBe("Oat milk");
    list = await change("shopping/lists", list, {
      visibility: "household",
      confirmScope: true,
    });
    expect((await read(`shopping/items/${first.id}`, spouse)).name).toBe(
      "Oat milk",
    );
    list = await change(
      "shopping/lists",
      list,
      { visibility: "personal", confirmScope: true },
      spouse,
    );
    expect(list.ownerId).toBe("00000000-0000-4000-8000-000000000002");
    expect((await request(`shopping/items/${first.id}`, owner)).status).toBe(
      404,
    );
    expect(
      (await read(`shopping/items/${first.id}/history`, spouse)).items,
    ).toHaveLength(2);
    expect(changed.version).toBe(2);
  });
  test("offers and purchase attribution preserve identities; archived stores reject new tags", async () => {
    const list = await create("shopping/lists", { name: `Groceries ${stamp}` });
    const store = await create("shopping/stores", {
      name: "Corner shop",
      color: "#487568",
      latitude: 62.01,
      longitude: -6.77,
      radius: 300,
    });
    let item = await create("shopping/items", {
      listId: list.id,
      name: "Bread",
      offerStoreId: store.id,
    });
    item = await change("shopping/items", item, {
      completed: true,
      purchaseStoreId: store.id,
    });
    const purchaseId = item.purchaseId;
    expect(purchaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.completedBy).toBe("00000000-0000-4000-8000-000000000001");
    item = await change("shopping/items", item, { completed: false });
    expect(item.completed).toBe(false);
    expect(item.purchaseStoreId).toBeNull();
    expect(
      (await read(`shopping/items/${item.id}/history`)).items.some(
        (h: { before?: { purchaseStoreId?: string } }) =>
          h.before?.purchaseStoreId === store.id,
      ),
    ).toBe(true);
    expect(item.purchaseId).toBe(purchaseId);
    await change("shopping/stores", store, {}, owner, "archive");
    expect(
      (
        await request("shopping/items", owner, {
          commandId: crypto.randomUUID(),
          listId: list.id,
          name: "New offer",
          offerStoreId: store.id,
        })
      ).status,
    ).toBe(409);
    expect((await read(`shopping/items/${item.id}`)).offerStoreId).toBe(
      store.id,
    );
  });
  test("work assignment, monthly recurrence and scope changes preserve responsibility boundaries", async () => {
    const profile = await create("household/profiles", {
      name: `Child ${stamp}`,
    });
    let work = await create("work/items", {
      title: "Water plants",
      assigneeId: profile.id,
      dueDate: "2028-01-31",
      recurrence: { unit: "month", interval: 1 },
    });
    work = await change("work/items", work, {
      title: "One occurrence only",
      dueDate: "2028-02-03",
    });
    const completed = await change(
      "work/items",
      work,
      { status: "done" },
      spouse,
    );
    expect(completed.completedBy).toBe("00000000-0000-4000-8000-000000000002");
    const next = await read(`work/items/${completed.nextOccurrenceId}`);
    expect(next.dueDate).toBe("2028-02-29");
    expect(next.title).toBe("Water plants");
    const second = await change("work/items", next, {}, owner, "skip");
    expect((await read(`work/items/${second.nextOccurrenceId}`)).dueDate).toBe(
      "2028-03-31",
    );
    const before = (await read("work/items")).items.length;
    expect(
      (
        await request(`work/items/${work.id}`, owner, {
          commandId: crypto.randomUUID(),
          baseVersion: work.version,
          status: "done",
        })
      ).status,
    ).toBe(409);
    expect((await read("work/items")).items.length).toBe(before);
    await change("household/profiles", profile, {}, owner, "archive");
    expect(
      (
        await request("work/items", owner, {
          commandId: crypto.randomUUID(),
          title: "New assignment",
          assigneeId: profile.id,
        })
      ).status,
    ).toBe(409);
    work = await change("work/items", completed, {
      visibility: "personal",
      confirmScope: true,
    });
    expect(work.assigneeId).toBeNull();
    expect((await request(`work/items/${work.id}`, spouse)).status).toBe(404);
    const members = await read("access");
    expect(
      members.members.filter((m: { role: string }) => m.role !== "admin"),
    ).toHaveLength(2);
  });
  test("account details stay private while exact household aggregates include private facts", async () => {
    const baseline = await read("finance/overview?month=2029-05");
    const joint = await create("finance/accounts", {
      name: `Joint ${stamp}`,
      currency: "DKK",
    });
    const personal = await create(
      "finance/accounts",
      {
        name: `Private account ${stamp}`,
        currency: "DKK",
        visibility: "personal",
      },
      spouse,
    );
    expect(joint.balance).toBeNull();
    expect(
      (await request(`finance/accounts/${personal.id}`, owner)).status,
    ).toBe(404);
    expect(
      (await read("finance/accounts")).items.some(
        (a: { id: string }) => a.id === personal.id,
      ),
    ).toBe(false);
    const category = (await read("finance/categories")).items.find(
      (r: { name: string }) => r.name === "Groceries",
    );
    for (const [amount, role, accountId, token] of [
      ["1000.10", "income", joint.id, owner],
      ["-100.03", "spending", personal.id, spouse],
      ["10.02", "refund", personal.id, spouse],
      ["-500.00", "transfer", joint.id, owner],
    ] as const)
      await create(
        "finance/transactions",
        {
          accountId,
          amount,
          currency: "DKK",
          bookingDate: "2029-05-06",
          description: "Test fact",
          reason: "Public boundary verification",
          role,
          categoryId:
            role === "spending" || role === "refund" ? category.id : null,
        },
        token,
      );
    const summary = await read("finance/overview?month=2029-05");
    const cents = (value: string | null) =>
      BigInt((value ?? "0.00").replace(".", ""));
    expect(cents(summary.income) - cents(baseline.income)).toBe(100010n);
    expect(cents(summary.spending) - cents(baseline.spending)).toBe(9001n);
    expect(cents(summary.netCashFlow) - cents(baseline.netCashFlow)).toBe(
      91009n,
    );
    const details = await read("finance/transactions?month=2029-05");
    expect(
      details.items.every(
        (r: { accountId: string }) => r.accountId !== personal.id,
      ),
    ).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(personal.id);
    expect(JSON.stringify(summary)).not.toContain(personal.name);
    const shared = await change(
      "finance/accounts",
      personal,
      { shared: true },
      spouse,
    );
    expect((await read(`finance/accounts/${shared.id}`)).name).toBe(
      personal.name,
    );
    expect(
      (
        await request(`finance/accounts/${shared.id}`, owner, {
          commandId: crypto.randomUUID(),
          baseVersion: shared.version,
          name: "Changed",
        })
      ).status,
    ).toBe(404);
    await change("finance/accounts", shared, { shared: false }, spouse);
    expect((await request(`finance/accounts/${shared.id}`, owner)).status).toBe(
      404,
    );
    expect(
      (
        await request("finance/transactions", owner, {
          commandId: crypto.randomUUID(),
          accountId: joint.id,
          amount: "1.001",
          currency: "DKK",
          bookingDate: "2029-05-06",
          description: "Bad precision",
          reason: "Test",
        })
      ).status,
    ).toBe(409);
  });
  test("reviewed CSV imports validate interpretation and reconcile only at zero difference", async () => {
    const account = await create("finance/accounts", {
      name: `Import ${stamp}`,
      currency: "DKK",
    });
    const file = {
      accountId: account.id,
      fileName: "statement.csv",
      contentBase64: Buffer.from(
        "Date,Amount,Description,Reference\n2030-02-01,-12.34,Groceries,abc\n2030-02-02,100.00,Deposit,def\n",
      ).toString("base64"),
      decimalSeparator: ".",
      dateFormat: "yyyy-MM-dd",
    };
    const first = await request("finance/imports/preview", owner, file);
    expect(first.status).toBe(200);
    expect((await first.json()).valid).toBe(false);
    const previewResponse = await request("finance/imports/preview", owner, {
      ...file,
      mapping: {
        bookingDate: "Date",
        amount: "Amount",
        description: "Description",
        reference: "Reference",
      },
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview.valid).toBe(true);
    expect(preview.rows).toHaveLength(2);
    let batch = await create("finance/imports", preview);
    expect(batch.status).toBe("needs-review");
    expect((await read("finance/overview?month=2030-02")).incomplete).toBe(
      true,
    );
    expect(batch.importedCount).toBe(2);
    expect((await read(`finance/accounts/${account.id}`)).balance).toBeNull();
    expect(
      (
        await request(`finance/imports/${batch.id}/reconcile`, owner, {
          commandId: crypto.randomUUID(),
          baseVersion: batch.version,
          openingBalance: "0.00",
          closingBalance: "99.00",
        })
      ).status,
    ).toBe(409);
    batch = await change(
      "finance/imports",
      batch,
      { openingBalance: "0.00", closingBalance: "87.66" },
      owner,
      "reconcile",
    );
    expect(batch.status).toBe("reconciled");
    expect(batch.difference).toBe("0.00");
    expect((await read(`finance/accounts/${account.id}`)).balance).toBe(
      "87.66",
    );
    expect(
      (
        await request("finance/imports", owner, {
          ...preview,
          commandId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    const txs = (
      await read(`finance/transactions?accountId=${account.id}&month=2030-02`)
    ).items;
    expect(txs).toHaveLength(2);
  });
  test("preferences, device destinations and recipient activity stay private", async () => {
    const existing = (await read("settings/preferences")).items;
    const pref = existing[0]
      ? await change("settings/preferences", existing[0], {
          shoppingChanges: false,
        })
      : await create("settings/preferences", {});
    expect(pref.visibility).toBe("personal");
    expect(
      (await request(`settings/preferences/${pref.id}`, spouse)).status,
    ).toBe(404);
    expect(
      (
        await request("settings/preferences", owner, {
          commandId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("settings/devices", owner, {
          commandId: crypto.randomUUID(),
          endpoint: "https://127.0.0.1/internal",
          keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
        })
      ).status,
    ).toBe(400);
    const availability = await read("settings/push-public-key");
    expect(typeof availability.available).toBe("boolean");
    const work = await create("work/items", {
      title: `Assignment ${stamp}`,
      assigneeId: "00000000-0000-4000-8000-000000000002",
      dueDate: "2026-01-01",
    });
    let entries = (await read("activity", spouse)).items;
    const entry = entries.find(
      (e: { href: string; category: string }) =>
        e.href.includes(work.id) && e.category === "workAssignment",
    );
    expect(entry).toBeDefined();
    expect(
      (
        await request(`activity/${entry.id}/read`, owner, {
          commandId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`activity/${entry.id}/read`, spouse, {
          commandId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(200);
    entries = (await read("activity", spouse)).items;
    expect(entries.find((e: { id: string }) => e.id === entry.id).read).toBe(
      true,
    );
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      entries = (await read("activity", spouse)).items;
      if (
        entries.some(
          (e: { href: string; category: string }) =>
            e.href.includes(work.id) && e.category === "dueReminders",
        )
      )
        break;
      await Bun.sleep(1000);
    }
    expect(
      entries.filter(
        (e: { href: string; category: string }) =>
          e.href.includes(work.id) && e.category === "dueReminders",
      ),
    ).toHaveLength(1);
  }, 90_000);
  test("calendar gaps, category depth and duplicate statement rows have explicit outcomes", async () => {
    const gap = await create("work/items", {
      title: "Spring clock gap",
      dueDate: "2028-03-26",
      dueTime: "01:30",
    });
    expect(gap.dueAt).toBe("2028-03-26T01:00:00Z");
    const repeated = await create("work/items", {
      title: "Autumn repeated clock",
      dueDate: "2028-10-29",
      dueTime: "01:30",
    });
    expect(repeated.dueAt).toBe("2028-10-29T00:30:00Z");
    const root = await create("finance/categories", { name: `Depth ${stamp}` });
    const child = await create("finance/categories", {
      name: "Child",
      parentId: root.id,
    });
    expect(
      (
        await request("finance/categories", owner, {
          commandId: crypto.randomUUID(),
          name: "Grandchild",
          parentId: child.id,
        })
      ).status,
    ).toBe(409);
    await create("finance/budgets", {
      categoryId: child.id,
      month: "2030-02",
      amount: "100.00",
    });
    expect(
      (
        await request("finance/budgets", owner, {
          commandId: crypto.randomUUID(),
          categoryId: child.id,
          month: "2030-02",
          amount: "101.00",
        })
      ).status,
    ).toBe(409);
    const account = await create("finance/accounts", {
      name: `Duplicates ${stamp}`,
      currency: "DKK",
    });
    const response = await request("finance/imports/preview", owner, {
      accountId: account.id,
      fileName: "duplicate.csv",
      contentBase64: Buffer.from(
        "Date,Amount,Description\n2030-02-01,-12.34,Same\n2030-02-01,-12.34,Same\n",
      ).toString("base64"),
      mapping: {
        bookingDate: "Date",
        amount: "Amount",
        description: "Description",
      },
    });
    const preview = await response.json();
    expect(response.status).toBe(200);
    const batch = await create("finance/imports", preview);
    expect(batch.importedCount).toBe(1);
    expect(batch.duplicateCount).toBe(1);
    expect(batch.rows[1].status).toBe("possible-duplicate");
    const forceMatched = await change("finance/imports", batch, {
      rows: batch.rows.map((row: Record<string, unknown>) => ({
        ...row,
        status: "matched",
      })),
    });
    expect(
      (
        await request(`finance/imports/${batch.id}/reconcile`, owner, {
          commandId: crypto.randomUUID(),
          baseVersion: forceMatched.version,
          openingBalance: "0.00",
          closingBalance: "-24.68",
        })
      ).status,
    ).toBe(409);
    expect((await read(`finance/accounts/${account.id}`)).balance).toBeNull();

    expect(
      (
        await request(`finance/imports/${batch.id}/reconcile`, owner, {
          commandId: crypto.randomUUID(),
          baseVersion: batch.version,
          openingBalance: "0.00",
          closingBalance: "-24.68",
        })
      ).status,
    ).toBe(409);
  });

  test("corrections replace totals once, retain history and reject competing forks", async () => {
    const account = await create("finance/accounts", {
      name: `Corrections ${stamp}`,
      currency: "DKK",
    });
    const original = await create("finance/transactions", {
      accountId: account.id,
      amount: "-25.01",
      currency: "DKK",
      bookingDate: "2031-04-01",
      description: "Original",
      reason: "Entered receipt",
      role: "spending",
    });
    const corrected = await create("finance/transactions", {
      accountId: account.id,
      amount: "-20.01",
      currency: "DKK",
      bookingDate: "2031-04-01",
      description: "Corrected",
      reason: "Receipt discount",
      role: "spending",
      supersedesId: original.id,
    });
    expect((await read(`finance/accounts/${account.id}`)).balance).toBe(
      "-20.01",
    );
    expect((await read(`finance/transactions/${original.id}`)).amount).toBe(
      "-25.01",
    );
    expect(
      (
        await request("finance/transactions", owner, {
          commandId: crypto.randomUUID(),
          accountId: account.id,
          amount: "-19.00",
          currency: "DKK",
          bookingDate: "2031-04-01",
          description: "Competing correction",
          reason: "Stale original",
          supersedesId: original.id,
        })
      ).status,
    ).toBe(409);
    const final = await create("finance/transactions", {
      accountId: account.id,
      amount: "-18.00",
      currency: "DKK",
      bookingDate: "2031-04-01",
      description: "Final",
      reason: "Second receipt correction",
      role: "spending",
      supersedesId: corrected.id,
    });
    expect(final.supersedesId).toBe(corrected.id);
    expect((await read(`finance/accounts/${account.id}`)).balance).toBe(
      "-18.00",
    );
    const pending = await create("work/items", {
      title: "Rule confirmation",
      dueDate: "2031-01-31",
      recurrence: { unit: "month", interval: 1 },
    });
    expect(
      (
        await request(`work/items/${pending.id}`, owner, {
          commandId: crypto.randomUUID(),
          baseVersion: pending.version,
          recurrence: null,
        })
      ).status,
    ).toBe(409);
    const ended = await change("work/items", pending, {
      recurrence: null,
      confirmSeries: true,
    });
    const done = await change("work/items", ended, { status: "done" });
    expect(done.nextOccurrenceId ?? null).toBeNull();
  });
  test("budget taxonomy, review reopening and rejected imports preserve truthful totals", async () => {
    const category = await create("finance/categories", {
      name: `Budget actual ${stamp}`,
    });
    const budget = await create("finance/budgets", {
      categoryId: category.id,
      month: "2032-04",
      amount: "100.00",
    });
    const account = await create("finance/accounts", {
      name: `Budget facts ${stamp}`,
      currency: "DKK",
    });
    for (const [amount, role] of [
      ["-20.00", "spending"],
      ["5.00", "refund"],
      ["-10.00", "adjustment"],
    ])
      await create("finance/transactions", {
        accountId: account.id,
        amount,
        currency: "DKK",
        bookingDate: "2032-04-01",
        description: role,
        reason: "Budget taxonomy evidence",
        role,
        categoryId: category.id,
      });
    const actual = await read(`finance/budgets/${budget.id}`);
    expect(actual.actual).toBe("15.00");
    expect(actual.remaining).toBe("85.00");
    const statementAccount = await create("finance/accounts", {
      name: `Reopen ${stamp}`,
      currency: "DKK",
    });
    const response = await request("finance/imports/preview", owner, {
      accountId: statementAccount.id,
      fileName: "safe.csv",
      contentBase64: Buffer.from(
        "Date,Amount,Description\n2032-04-01,10.00,First\n2032-04-02,1.00,Second\n",
      ).toString("base64"),
      mapping: {
        bookingDate: "Date",
        amount: "Amount",
        description: "Description",
      },
    });
    const preview = await response.json();
    expect(response.status).toBe(200);
    const bad = structuredClone(preview);
    bad.rows[1].amount = "1.001";
    expect(
      (
        await request("finance/imports", owner, {
          ...bad,
          commandId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await read(
          `finance/transactions?accountId=${statementAccount.id}&month=2032-04`,
        )
      ).items,
    ).toHaveLength(0);
    let batch = await create("finance/imports", preview);
    batch = await change(
      "finance/imports",
      batch,
      { openingBalance: "100.00", closingBalance: "111.00" },
      owner,
      "reconcile",
    );
    expect(
      (await read(`finance/accounts/${statementAccount.id}`)).balance,
    ).toBe("111.00");
    batch = await change("finance/imports", batch, {
      openingBalance: "101.00",
    });
    expect(batch.status).toBe("needs-review");
    expect(
      (await read(`finance/accounts/${statementAccount.id}`)).balance,
    ).toBeNull();
    const final = await change(
      "finance/imports",
      batch,
      { closingBalance: "112.00" },
      owner,
      "reconcile",
    );
    expect(final.status).toBe("reconciled");
    expect(
      (await read(`finance/accounts/${statementAccount.id}`)).balance,
    ).toBe("112.00");
  });
});
