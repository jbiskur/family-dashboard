import { z } from "zod";

export const uuidSchema = z.string().uuid();
export const commandSchema = z.object({ commandId: uuidSchema }).strict();
export const syncFailureSchema = z
  .object({
    failedCommandId: uuidSchema,
    area: z.enum(["shopping", "work"]),
    resourceId: uuidSchema.optional(),
  })
  .strict();
export const invitationRequestSchema = commandSchema.extend({
  email: z.string().trim().toLowerCase().email().max(254),
});
export type MemberRole = "owner" | "spouse";
export type AccessMember = {
  userId: string;
  role: MemberRole;
  status: "active" | "revoked";
};
export type AccessInvitation = {
  id: string;
  status:
    | "requesting"
    | "pending"
    | "request-failed"
    | "cancelled"
    | "expired"
    | "consumed";
  email?: string;
  expiresAt: string;
  requestedAt: string;
};
export type AccessResponse = {
  household: { id: string; name: string };
  member: AccessMember;
  members: AccessMember[];
  invitation: AccessInvitation | null;
};
export type ApiError = {
  error: { code: string; message: string; commandId?: string };
};

export const accessEventSchema = z.object({
  commandId: uuidSchema,
  householdId: uuidSchema,
  actorId: uuidSchema,
  occurredAt: z.string().datetime(),
  change: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("owner-bootstrapped"), subject: uuidSchema }),
    z.object({
      kind: z.literal("invitation-requested"),
      invitationId: uuidSchema,
      email: z.string().email(),
      expiresAt: z.string().datetime(),
    }),
    z.object({
      kind: z.literal("invitation-result"),
      invitationId: uuidSchema,
      succeeded: z.boolean(),
    }),
    z.object({
      kind: z.literal("invitation-cancelled"),
      invitationId: uuidSchema,
    }),
    z.object({
      kind: z.literal("invitation-expired"),
      invitationId: uuidSchema,
    }),
    z.object({
      kind: z.literal("spouse-admitted"),
      invitationId: uuidSchema,
      subject: uuidSchema,
    }),
    z.object({ kind: z.literal("spouse-revoked"), userId: uuidSchema }),
  ]),
});
export type AccessEvent = z.infer<typeof accessEventSchema>;

export const resourceKinds = [
  "shopping/lists",
  "shopping/items",
  "shopping/stores",
  "work/items",
  "household/profiles",
  "finance/accounts",
  "finance/transactions",
  "finance/categories",
  "finance/budgets",
  "finance/imports",
  "settings/preferences",
  "settings/devices",
] as const;
export type ResourceKind = (typeof resourceKinds)[number];
export type ResourceBase = {
  id: string;
  version: number;
  ownerId: string;
  visibility: "household" | "personal";
  createdAt: string;
  updatedAt: string;
  archived: boolean;
};
export type ShoppingList = ResourceBase & {
  name: string;
  color: string;
  itemCount?: number;
  completedCount?: number;
};
export type ShoppingItem = ResourceBase & {
  listId: string;
  name: string;
  quantity: string;
  note: string;
  category: string;
  completed: boolean;
  position: number;
  offerStoreId: string | null;
  purchaseStoreId: string | null;
  purchaseId?: string;
  completedAt?: string | null;
  completedBy?: string | null;
};
export type Store = ResourceBase & {
  name: string;
  color: string;
  latitude: number | null;
  longitude: number | null;
  radius: number;
};
export type HouseholdProfile = ResourceBase & { name: string };
export type Recurrence = {
  unit: "day" | "week" | "month";
  interval: number;
  anchorDay?: number;
};
export type WorkItem = ResourceBase & {
  title: string;
  note: string;
  status: "todo" | "doing" | "done";
  assigneeId: string | null;
  dueDate: string | null;
  dueTime: string | null;
  dueAt: string | null;
  recurrence: Recurrence | null;
  seriesId: string | null;
  previousOccurrenceId?: string;
  skipped?: boolean;
  completedAt?: string | null;
  completedBy?: string | null;
  nextOccurrenceId?: string | null;
};
export type FinanceAccount = ResourceBase & {
  name: string;
  currency: string;
  shared: boolean;
  balance: string | null;
  reconciliationState?: string;
};
export type TransactionRole =
  | "income"
  | "spending"
  | "transfer"
  | "refund"
  | "adjustment";
export type FinanceTransaction = ResourceBase & {
  accountId: string;
  amount: string;
  currency: string;
  bookingDate: string;
  transactionDate: string | null;
  valueDate: string | null;
  description: string;
  role: TransactionRole;
  categoryId: string | null;
  source: "manual" | "import";
  sourceId: string | null;
  reference: string;
  reason: string;
  reconciliationState: "needs-review" | "reconciled";
  importId: string | null;
  reportingRate: string | null;
  reportingRateDate: string | null;
  supersedesId?: string | null;
  linkedTransactionId?: string | null;
};
export type FinanceCategory = ResourceBase & {
  name: string;
  parentId: string | null;
};
export type FinanceBudget = ResourceBase & {
  categoryId: string;
  month: string;
  amount: string;
  currency: string;
  actual?: string;
  remaining?: string;
  incomplete?: boolean;
};
export type ImportRow = {
  id: string;
  sourceId: string | null;
  bookingDate: string;
  transactionDate: string | null;
  valueDate: string | null;
  amount: string;
  description: string;
  reference: string;
  categoryId: string | null;
  role: TransactionRole;
  status:
    | "matched"
    | "unmatched"
    | "possible-duplicate"
    | "invalid"
    | "explained";
  explanation: string;
  transactionId: string | null;
  original: Record<string, string>;
};
export type FinanceImport = ResourceBase & {
  accountId: string;
  fileName: string;
  sourceHash: string;
  currency: string;
  rows: ImportRow[];
  status: "needs-review" | "reconciled";
  openingBalance: string | null;
  closingBalance: string | null;
  mapping: Record<string, string>;
  importedCount: number;
  duplicateCount: number;
  difference?: string | null;
};
export type Preferences = ResourceBase & {
  shoppingChanges: boolean;
  workAssignment: boolean;
  dueReminders: boolean;
  recurrence: boolean;
  financeReview: boolean;
  syncFailures: boolean;
  quietStart: string;
  quietEnd: string;
  timezone: string;
};
export type HistoryEntry = {
  id: string;
  resourceId: string;
  actorId: string;
  action: string;
  occurredAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};
export type ActivityEntry = {
  id: string;
  title: string;
  href: string;
  occurredAt: string;
  read: boolean;
  category: string;
};
export type FinanceOverview = {
  currency: string;
  from: string;
  to: string;
  balance: string | null;
  income: string | null;
  spending: string | null;
  netCashFlow: string | null;
  savingsRate: string | null;
  budgetRemaining: string | null;
  incomplete: boolean;
  categories: {
    categoryId: string | null;
    name: string;
    actual: string;
    budget: string | null;
    remaining: string | null;
  }[];
  trend: { date: string; income: string; spending: string }[];
  comparison?: {
    from: string;
    to: string;
    income: string | null;
    spending: string | null;
    netCashFlow: string | null;
  };
};
export type HomeResponse = {
  household: { id: string; name: string };
  today: WorkItem[];
  shopping: ShoppingList[];
  work: { todo: number; doing: number; done: number };
  attention: { id: string; title: string; href: string }[];
  activity: ActivityEntry[];
};

export const resourceEventSchema = z.object({
  commandId: uuidSchema,
  householdId: uuidSchema,
  actorId: uuidSchema,
  occurredAt: z.string().datetime(),
  kind: z.enum(resourceKinds),
  resourceId: uuidSchema,
  baseVersion: z.number().int().nonnegative(),
  action: z.enum(["create", "update", "archive", "skip", "reconcile"]),
  data: z.record(z.unknown()),
});
export type ResourceEvent = z.infer<typeof resourceEventSchema>;
export const notificationEventSchema = z.object({
  commandId: uuidSchema,
  householdId: uuidSchema,
  actorId: uuidSchema,
  occurredAt: z.string().datetime(),
  action: z.enum([
    "read",
    "reminder",
    "delivered",
    "device-expired",
    "sync-failure",
  ]),
  targetId: uuidSchema,
  recipientId: uuidSchema,
  syncFailure: syncFailureSchema.optional(),
});
export type NotificationEvent = z.infer<typeof notificationEventSchema>;
