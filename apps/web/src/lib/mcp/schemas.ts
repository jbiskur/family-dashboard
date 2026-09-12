import { z } from "zod-mcp";

const uuid = z.uuid();
const name = z.string().trim().min(1).max(160);
const note = z.string().max(4000);
const nullableId = uuid.nullable();
export const pageFields = {
  limit: z.number().int().min(1).max(100).default(50),
  cursor: uuid.optional(),
};
const search = { q: z.string().trim().max(160).optional() };
const visibility = z.enum(["household", "personal"]);
const shoppingFields = {
  name,
  quantity: z.string().max(80).optional(),
  note: note.optional(),
  category: z
    .string()
    .max(80)
    .describe(
      "Use the app's categories for matching colors and suggestions: Fruit & vegetables; Dairy & eggs; Meat & fish; Bakery; Pantry; Frozen; Drinks; Household; Other. Empty means no category. Existing custom categories are supported.",
    )
    .optional(),
  completed: z.boolean().optional(),
  position: z.number().int().min(0).max(1_000_000).optional(),
  offerStoreId: nullableId.optional(),
  purchaseStoreId: nullableId.optional(),
};
const workFields = {
  title: name,
  note: note.optional(),
  status: z.enum(["todo", "doing", "done"]).optional(),
  assigneeId: nullableId.optional(),
  dueDate: z.iso.date().nullable().optional(),
  dueTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
  recurrence: z
    .strictObject({
      unit: z.enum(["day", "week", "month"]),
      interval: z.number().int().min(1).max(365),
      anchorDay: z.number().int().min(1).max(31).optional(),
    })
    .nullable()
    .optional(),
};
const create = {
  commandId: uuid,
  id: uuid.optional(),
  visibility: visibility.optional(),
};
const update = {
  commandId: uuid,
  id: uuid,
  baseVersion: z.number().int().nonnegative(),
};
export const empty = z.strictObject({});
export const shoppingLists = z.strictObject({ ...pageFields, ...search });
export const shoppingItems = z.strictObject({
  ...pageFields,
  ...search,
  listId: uuid,
});
export const addShopping = z.strictObject({
  ...create,
  listId: uuid,
  ...shoppingFields,
});
export const updateShopping = z.strictObject({
  ...update,
  ...z.object(shoppingFields).partial().shape,
});
export const workItems = z.strictObject({ ...pageFields, ...search });
export const addWork = z.strictObject({ ...create, ...workFields });
export const updateWork = z.strictObject({
  ...update,
  ...z.object(workFields).partial().shape,
});
export const command = z.strictObject({ commandId: uuid });
const periodFields = {
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  period: z.enum(["month", "quarter", "year"]).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
};
const pairedDates = (input: { from?: string; to?: string }) =>
  Boolean(input.from) === Boolean(input.to) &&
  (!input.from || !input.to || input.from <= input.to);
export const overview = z
  .strictObject(periodFields)
  .refine(pairedDates, "Supply both dates in order.");
export const accounts = z.strictObject({ ...pageFields, ...search });
export const transactions = z
  .strictObject({
    ...pageFields,
    ...search,
    ...periodFields,
    accountId: uuid.optional(),
    categoryId: z.union([uuid, z.literal("uncategorized")]).optional(),
    role: z
      .enum(["income", "spending", "transfer", "refund", "adjustment"])
      .optional(),
    reconciliationState: z.enum(["needs-review", "reconciled"]).optional(),
  })
  .refine(pairedDates, "Supply both dates in order.");
