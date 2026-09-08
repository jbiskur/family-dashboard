import { beforeAll, expect, test } from "bun:test";
import { loadTestEnv, request, tokenFor } from "../fixtures/auth";

let owner: string;
let spouse: string;
beforeAll(async () => {
  await loadTestEnv();
  owner = await tokenFor();
  spouse = await tokenFor("spouse");
  expect((await request("access/admit", owner, {})).status).toBe(200);
  expect((await request("access/admit", spouse, {})).status).toBe(200);
});
async function create(
  path: string,
  data: Record<string, unknown>,
  token = owner,
) {
  const response = await request(path, token, {
    commandId: crypto.randomUUID(),
    ...data,
  });
  expect(response.status).toBe(201);
  return response.json();
}
async function read(path: string, token = owner) {
  const response = await request(path, token);
  expect(response.status).toBe(200);
  return response.json();
}
const cents = (value: string | null) =>
  BigInt((value ?? "0.00").replace(".", ""));

// 10c22d2d-b275-4042-a5e2-3409a8a006d5 S3: links preserve facts and never grant access.
test("refund and transfer links preserve full identities, exact taxonomy and private boundaries", async () => {
  const stamp = crypto.randomUUID();
  const first = await create("finance/accounts", {
    name: `Everyday ${stamp}`,
    currency: "DKK",
  });
  const second = await create("finance/accounts", {
    name: `Savings ${stamp}`,
    currency: "DKK",
  });
  const privateAccount = await create(
    "finance/accounts",
    { name: `Private ${stamp}`, currency: "DKK", visibility: "personal" },
    spouse,
  );
  const baseline = await read("finance/overview?month=2041-06");
  const common = {
    currency: "DKK",
    bookingDate: "2041-06-12",
    reason: "Independent public-boundary linked-fact verification",
  };
  const spending = await create("finance/transactions", {
    ...common,
    accountId: first.id,
    description: `Groceries ${stamp}`,
    amount: "-40.00",
    role: "spending",
  });
  const refund = await create("finance/transactions", {
    ...common,
    accountId: first.id,
    description: `Returned groceries ${stamp}`,
    amount: "10.00",
    role: "refund",
    linkedTransactionId: spending.id,
  });
  const outgoing = await create("finance/transactions", {
    ...common,
    accountId: first.id,
    description: `Move to savings ${stamp}`,
    amount: "-125.50",
    role: "transfer",
  });
  const incoming = await create("finance/transactions", {
    ...common,
    accountId: second.id,
    description: `Savings receipt ${stamp}`,
    amount: "125.50",
    role: "transfer",
    linkedTransactionId: outgoing.id,
  });
  expect(refund.linkedTransactionId).toBe(spending.id);
  expect(incoming.linkedTransactionId).toBe(outgoing.id);
  expect((await read(`finance/transactions/${spending.id}`)).amount).toBe(
    "-40.00",
  );
  expect((await read(`finance/transactions/${outgoing.id}`)).amount).toBe(
    "-125.50",
  );
  expect((await read(`finance/transactions/${refund.id}`)).amount).toBe(
    "10.00",
  );
  const summary = await read("finance/overview?month=2041-06");
  expect(cents(summary.spending) - cents(baseline.spending)).toBe(3000n);
  expect(cents(summary.income) - cents(baseline.income)).toBe(0n);
  expect(cents(summary.netCashFlow) - cents(baseline.netCashFlow)).toBe(-3000n);
  const privateFact = await create(
    "finance/transactions",
    {
      ...common,
      accountId: privateAccount.id,
      description: `Private fact ${stamp}`,
      amount: "-3.00",
      role: "spending",
    },
    spouse,
  );
  expect(
    (await request(`finance/transactions/${privateFact.id}`, owner)).status,
  ).toBe(404);
  const list = await create("shopping/lists", {
    name: `Wrong resource kind ${stamp}`,
  });
  const before = (await read(`finance/transactions?accountId=${first.id}`))
    .items;
  for (const target of [privateFact.id, list.id, crypto.randomUUID()]) {
    const response = await request("finance/transactions", owner, {
      commandId: crypto.randomUUID(),
      ...common,
      accountId: first.id,
      description: "Rejected invalid link",
      amount: "1.00",
      role: "refund",
      linkedTransactionId: target,
    });
    expect(response.status).toBe(409);
    const error = await response.text();
    expect(error).not.toContain(privateFact.description);
  }
  expect(
    (await read(`finance/transactions?accountId=${first.id}`)).items,
  ).toEqual(before);
  expect(
    (await request(`finance/transactions/${privateFact.id}`, owner)).status,
  ).toBe(404);
});
