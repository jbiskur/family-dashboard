import { loadTestEnv, request, tokenFor } from "../tests/fixtures/auth";

// Local public-API fixture only. Start the runtime with a separate
// heima_screenshots schema first; an occupied household is never modified.
await loadTestEnv();
if (process.env.USABLE_ISSUER !== "http://localhost:8187/realms/heima-test")
  throw new Error("Screenshot fixture requires the isolated local realm");
const owner = await tokenFor();
const admitted = await request("access/admit", owner, {});
if (!admitted.ok) throw new Error("Local owner admission failed");
const lists = await (await request("shopping/lists", owner)).json();
const work = await (await request("work/items", owner)).json();
const accounts = await (await request("finance/accounts", owner)).json();
if (lists.items.length || work.items.length || accounts.items.length)
  throw new Error("Screenshot fixture requires an empty household");
async function create(path: string, data: Record<string, unknown>) {
  const response = await request(path, owner, {
    commandId: crypto.randomUUID(),
    ...data,
  });
  if (!response.ok) throw new Error(`Fixture ${path}: ${response.status}`);
  return response.json();
}
await create("access/invitations", { email: "spouse@heima.test" });
const spouse = await tokenFor("spouse");
if (!(await request("access/admit", spouse, {})).ok)
  throw new Error("Local spouse admission failed");
const profile = await create("household/profiles", { name: "Liv" });
const store = await create("shopping/stores", {
  name: "Bónus",
  color: "#b45439",
  latitude: 62.01,
  longitude: -6.77,
  radius: 250,
});
await create("shopping/stores", { name: "The bakery", color: "#2e736b" });
const weekly = await create("shopping/lists", {
  name: "The weekly shop",
  visibility: "household",
  color: "#b45439",
});
const weekend = await create("shopping/lists", {
  name: "Sunday lunch",
  visibility: "household",
  color: "#2e736b",
});
await create("shopping/lists", {
  name: "A birthday surprise",
  visibility: "personal",
  color: "#a67720",
});
for (const [index, item] of [
  {
    name: "Sourdough bread",
    quantity: "1 loaf",
    category: "Bakery",
    note: "The seeded one everyone likes",
  },
  {
    name: "Oat milk",
    quantity: "2 cartons",
    category: "Essentials",
    offerStoreId: store.id,
  },
  { name: "Apples", quantity: "6", category: "Fruit & vegetables" },
  { name: "Fresh flowers", quantity: "1 bunch", category: "For the table" },
].entries())
  await create("shopping/items", {
    ...item,
    listId: weekly.id,
    position: index,
  });
await create("shopping/items", {
  name: "Potatoes",
  quantity: "1 kg",
  listId: weekend.id,
});
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Atlantic/Faroe",
}).format(new Date());
for (const item of [
  {
    title: "Water the kitchen herbs",
    note: "The basil is looking thirsty.",
    assigneeId: profile.id,
    dueDate: today,
  },
  {
    title: "Book the dentist",
    note: "Find a time after school.",
    assigneeId: "00000000-0000-4000-8000-000000000001",
    dueDate: today,
  },
  {
    title: "Plan Sunday lunch",
    note: "Something warm for a rainy day.",
    status: "doing",
    assigneeId: "00000000-0000-4000-8000-000000000002",
    dueDate: today,
  },
  { title: "Put the recycling out", status: "done", dueDate: today },
])
  await create("work/items", { ...item, visibility: "household" });
const account = await create("finance/accounts", {
  name: "Household account",
  currency: "DKK",
  visibility: "household",
});
const categories = (await (await request("finance/categories", owner)).json())
  .items;
const categoryId = (name: string) =>
  categories.find((row: { name: string }) => row.name === name)?.id;
for (const item of [
  { description: "Monthly income", amount: "28000.00", role: "income" },
  {
    description: "Our home",
    amount: "-9200.00",
    role: "spending",
    categoryId: categoryId("Housing"),
  },
  {
    description: "The weekly groceries",
    amount: "-684.50",
    role: "spending",
    categoryId: categoryId("Groceries"),
  },
  {
    description: "Electricity",
    amount: "-742.00",
    role: "spending",
    categoryId: categoryId("Utilities"),
  },
  {
    description: "Coffee together",
    amount: "-95.00",
    role: "spending",
    categoryId: categoryId("Dining"),
  },
])
  await create("finance/transactions", {
    ...item,
    accountId: account.id,
    currency: "DKK",
    bookingDate: today,
    source: "manual",
    reason: "Fictional screenshot sample",
  });
for (const [category, amount] of [
  ["Groceries", "2400.00"],
  ["Dining", "800.00"],
  ["Transport", "1200.00"],
])
  await create("finance/budgets", {
    categoryId: categoryId(category!),
    month: today.slice(0, 7),
    amount,
    currency: "DKK",
  });
console.log(
  JSON.stringify({
    household: "Fictional local screenshot household",
    shoppingPath: `/shopping/${weekly.id}`,
    accountPath: `/finance/accounts/${account.id}`,
  }),
);
