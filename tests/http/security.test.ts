import { beforeAll, expect, test } from "bun:test";
import { loadTestEnv, request, tokenFor } from "../fixtures/auth";

let owner: string;
beforeAll(async () => {
  await loadTestEnv();
  owner = await tokenFor();
  expect((await request("access/admit", owner, {})).status).toBe(200);
});
async function command(path: string, data: Record<string, unknown>) {
  const response = await request(path, owner, {
    commandId: crypto.randomUUID(),
    ...data,
  });
  return { status: response.status, body: await response.json() };
}
async function read(path: string) {
  const response = await request(path, owner);
  expect(response.status).toBe(200);
  return response.json();
}

test("an attributed purchase can reopen without erasing its purchase history", async () => {
  const list = await command("shopping/lists", {
    name: `Purchase reopen ${crypto.randomUUID()}`,
  });
  expect(list.status).toBe(201);
  const store = await command("shopping/stores", {
    name: "Reviewer corner store",
  });
  expect(store.status).toBe(201);
  const item = await command("shopping/items", {
    listId: list.body.id,
    name: "Milk",
  });
  expect(item.status).toBe(201);
  const complete = await command(`shopping/items/${item.body.id}`, {
    baseVersion: item.body.version,
    completed: true,
    purchaseStoreId: store.body.id,
  });
  expect(complete.status).toBe(200);
  const reopen = await command(`shopping/items/${item.body.id}`, {
    baseVersion: complete.body.version,
    completed: false,
  });
  expect(reopen.status).toBe(200);
  expect(reopen.body.completed).toBe(false);
  const timeline = await read(`shopping/items/${item.body.id}/history`);
  expect(
    timeline.items.some(
      (entry: {
        after: {
          completed: boolean;
          purchaseStoreId: string;
          purchaseId: string;
        };
      }) =>
        entry.after.completed &&
        entry.after.purchaseStoreId === store.body.id &&
        entry.after.purchaseId === complete.body.purchaseId,
    ),
  ).toBe(true);
});

test("one ledger transaction cannot reconcile two identical source rows", async () => {
  const account = await command("finance/accounts", {
    name: `Duplicate reconciliation ${crypto.randomUUID()}`,
    currency: "DKK",
  });
  expect(account.status).toBe(201);
  const previewResponse = await request("finance/imports/preview", owner, {
    accountId: account.body.id,
    fileName: "duplicate-source-rows.csv",
    contentBase64: Buffer.from(
      "Date,Amount,Description\n2031-01-01,-10.00,Milk\n2031-01-01,-10.00,Milk\n",
    ).toString("base64"),
    decimalSeparator: ".",
    dateFormat: "yyyy-MM-dd",
    mapping: {
      bookingDate: "Date",
      amount: "Amount",
      description: "Description",
    },
  });
  expect(previewResponse.status).toBe(200);
  const batch = await command("finance/imports", await previewResponse.json());
  expect(batch.status).toBe(201);
  expect(batch.body.rows.map((row: { status: string }) => row.status)).toEqual([
    "matched",
    "possible-duplicate",
  ]);
  const rows = batch.body.rows.map((row: Record<string, unknown>) => ({
    ...row,
    status: "matched",
  }));
  const update = await command(`finance/imports/${batch.body.id}`, {
    baseVersion: batch.body.version,
    rows,
  });
  expect([200, 409]).toContain(update.status);
  if (update.status === 200) {
    const reconcile = await command(
      `finance/imports/${batch.body.id}/reconcile`,
      {
        baseVersion: update.body.version,
        openingBalance: "0.00",
        closingBalance: "-20.00",
      },
    );
    expect(reconcile.status).toBe(409);
  }
  const latest = await read(`finance/imports/${batch.body.id}`);
  expect(latest.status).toBe("needs-review");
  const ledger = await read(
    `finance/transactions?accountId=${account.body.id}&month=2031-01`,
  );
  expect(ledger.items).toHaveLength(1);
  expect(ledger.items[0].amount).toBe("-10.00");
  expect(ledger.items[0].reconciliationState).toBe("needs-review");
});
