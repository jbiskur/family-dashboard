import {
  IMPORT_MAX_ROWS,
  type Recurrence,
  type ResourceKind,
} from "@heima/contracts";
import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import type { resources } from "./db/schema";
import { ApiFailure } from "./errors";

export const TIMEZONE = "Atlantic/Faroe";
export type ResourceRow = typeof resources.$inferSelect;
const name = z.string().trim().min(1).max(160);
const nullableId = z.string().uuid().nullable().default(null);
const note = z.string().max(4000).default("");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    try {
      Temporal.PlainDate.from(v);
      return true;
    } catch {
      return false;
    }
  }, "Use a valid date");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const amount = z.string().regex(/^-?\d{1,16}(\.\d{1,4})?$/);
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .refine((v) => Intl.supportedValuesOf("currency").includes(v));
const recurrence = z
  .object({
    unit: z.enum(["day", "week", "month"]),
    interval: z.number().int().min(1).max(365),
    anchorDay: z.number().int().min(1).max(31).optional(),
  })
  .nullable()
  .default(null);
export const fields: Record<ResourceKind, z.AnyZodObject> = {
  "shopping/lists": z.object({
    name,
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#487568"),
  }),
  "shopping/items": z.object({
    listId: z.string().uuid(),
    name,
    quantity: z.string().max(80).default(""),
    note,
    category: z.string().max(80).default(""),
    completed: z.boolean().default(false),
    position: z.number().int().min(0).max(1_000_000).default(0),
    offerStoreId: nullableId,
    purchaseStoreId: nullableId,
  }),
  "shopping/stores": z.object({
    name,
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#487568"),
    latitude: z.number().min(-90).max(90).nullable().default(null),
    longitude: z.number().min(-180).max(180).nullable().default(null),
    radius: z.number().int().min(100).max(1000).default(300),
  }),
  "household/profiles": z.object({ name }),
  "work/items": z.object({
    title: name,
    note,
    status: z.enum(["todo", "doing", "done"]).default("todo"),
    assigneeId: nullableId,
    dueDate: date.nullable().default(null),
    dueTime: time.nullable().default(null),
    recurrence,
  }),
  "finance/accounts": z.object({
    name,
    currency,
    shared: z.boolean().default(false),
  }),
  "finance/categories": z.object({ name, parentId: nullableId }),
  "finance/budgets": z.object({
    categoryId: z.string().uuid(),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    amount: amount.refine((v) => !v.startsWith("-")),
    currency: currency.default("DKK"),
  }),
  "finance/transactions": z.object({
    accountId: z.string().uuid(),
    amount,
    currency,
    bookingDate: date,
    transactionDate: date.nullable().default(null),
    valueDate: date.nullable().default(null),
    description: name,
    role: z
      .enum(["income", "spending", "transfer", "refund", "adjustment"])
      .default("adjustment"),
    categoryId: nullableId,
    source: z.enum(["manual", "import"]).default("manual"),
    sourceId: z.string().max(200).nullable().default(null),
    reference: z.string().max(500).default(""),
    reason: z.string().trim().min(1).max(1000),
    reconciliationState: z
      .enum(["needs-review", "reconciled"])
      .default("reconciled"),
    importId: nullableId,
    reportingRate: z
      .string()
      .regex(/^\d+(\.\d{1,12})?$/)
      .nullable()
      .default(null),
    reportingRateDate: date.nullable().default(null),
    supersedesId: nullableId,
    linkedTransactionId: nullableId,
  }),
  "finance/imports": z.object({
    accountId: z.string().uuid(),
    fileName: z.string().min(1).max(240),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    currency,
    rows: z
      .array(
        z.object({
          id: z.string().uuid(),
          sourceId: z.string().max(200).nullable(),
          bookingDate: date,
          transactionDate: date.nullable(),
          valueDate: date.nullable(),
          amount,
          description: z.string().max(4000),
          reference: z.string().max(500),
          categoryId: nullableId,
          role: z.enum([
            "income",
            "spending",
            "transfer",
            "refund",
            "adjustment",
          ]),
          status: z.enum([
            "matched",
            "unmatched",
            "possible-duplicate",
            "invalid",
            "explained",
          ]),
          explanation: z.string().max(1000),
          transactionId: z.string().uuid().nullable(),
          original: z.record(z.string()),
        }),
      )
      .max(IMPORT_MAX_ROWS),
    status: z.enum(["needs-review", "reconciled"]).default("needs-review"),
    openingBalance: amount.nullable().default(null),
    closingBalance: amount.nullable().default(null),
    mapping: z.record(z.string()),
    importedCount: z.number().int().nonnegative().default(0),
    duplicateCount: z.number().int().nonnegative().default(0),
  }),
  "settings/preferences": z.object({
    shoppingChanges: z.boolean().default(false),
    workAssignment: z.boolean().default(true),
    dueReminders: z.boolean().default(true),
    recurrence: z.boolean().default(true),
    financeReview: z.boolean().default(true),
    syncFailures: z.boolean().default(true),
    quietStart: time.default("22:00"),
    quietEnd: time.default("07:00"),
    timezone: z.literal(TIMEZONE).default(TIMEZONE),
  }),
  "settings/devices": z.object({
    endpoint: z
      .string()
      .url()
      .max(2048)
      .refine((v) => {
        const url = new URL(v);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          (!url.port || url.port === "443") &&
          (url.hostname === "fcm.googleapis.com" ||
            url.hostname === "updates.push.services.mozilla.com" ||
            url.hostname.endsWith(".push.services.mozilla.com") ||
            url.hostname === "web.push.apple.com" ||
            url.hostname.endsWith(".notify.windows.com"))
        );
      }, "Use a valid browser push subscription"),
    expirationTime: z.number().nullable().default(null),
    keys: z.object({
      p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}={0,2}$/),
      auth: z.string().regex(/^[A-Za-z0-9_-]{20,30}={0,2}$/),
    }),
  }),
};

export function canRead(
  row: ResourceRow,
  userId: string,
  all: ResourceRow[],
): boolean {
  if (row.kind === "shopping/items") {
    const list = all.find(
      (r) => r.id === row.data.listId && r.kind === "shopping/lists",
    );
    return !!list && canRead(list, userId, all);
  }
  if (row.kind === "finance/transactions" || row.kind === "finance/imports") {
    const account = all.find(
      (r) => r.id === row.data.accountId && r.kind === "finance/accounts",
    );
    return !!account && canRead(account, userId, all);
  }
  return (
    row.visibility === "household" ||
    row.ownerId === userId ||
    (row.kind === "finance/accounts" && row.data.shared === true)
  );
}
export function canManage(
  row: ResourceRow,
  userId: string,
  all: ResourceRow[],
): boolean {
  if (!canRead(row, userId, all)) return false;
  if (row.kind === "finance/transactions" || row.kind === "finance/imports") {
    const account = all.find((r) => r.id === row.data.accountId);
    return !!account && canManage(account, userId, all);
  }
  return (
    row.kind !== "finance/accounts" ||
    row.visibility === "household" ||
    row.ownerId === userId
  );
}
export function asResource(row: ResourceRow) {
  return {
    ...row.data,
    id: row.id,
    version: row.version,
    ownerId: row.ownerId,
    visibility: row.visibility,
    archived: row.archived === "true",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export function dueInstant(dueDate: string | null, dueTime: string | null) {
  if (!dueDate) return null;
  const intended = Temporal.PlainDateTime.from(
    `${dueDate}T${dueTime ?? "23:59:59.999"}`,
  );
  let resolved = intended.toZonedDateTime(TIMEZONE, {
    disambiguation: "compatible",
  });
  if (!resolved.toPlainDateTime().equals(intended))
    resolved = resolved.getTimeZoneTransition("previous") ?? resolved;
  return resolved.toInstant().toString();
}
export function nextDate(dueDate: string, rule: Recurrence) {
  const start = Temporal.PlainDate.from(dueDate);
  const next =
    rule.unit === "month"
      ? start.with({ day: 1 }).add({ months: rule.interval })
      : start.add(
          rule.unit === "week"
            ? { weeks: rule.interval }
            : { days: rule.interval },
        );
  return (
    rule.unit === "month"
      ? next.with({
          day: Math.min(rule.anchorDay ?? start.day, next.daysInMonth),
        })
      : next
  ).toString();
}
export function currencyDigits(code: string) {
  return (
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
    }).resolvedOptions().maximumFractionDigits ?? 2
  );
}
export function minor(value: string, code: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match)
    throw new ApiFailure("invalid-amount", 400, "Enter an exact amount.");
  const digits = currencyDigits(code);
  const fraction = match[3] ?? "";
  if (fraction.length > digits)
    throw new ApiFailure(
      "invalid-precision",
      400,
      `This currency allows ${digits} decimal places.`,
    );
  return (
    BigInt(`${match[2]}${fraction.padEnd(digits, "0")}`) * (match[1] ? -1n : 1n)
  );
}
export function decimal(value: bigint, code: string): string {
  const digits = currencyDigits(code);
  const absolute = (value < 0n ? -value : value)
    .toString()
    .padStart(digits + 1, "0");
  return `${value < 0n ? "-" : ""}${digits ? `${absolute.slice(0, -digits)}.${absolute.slice(-digits)}` : absolute}`;
}
export function toReporting(
  amount: string,
  currency: string,
  rate: string | null,
  rateDate: string | null,
): bigint | null {
  const value = minor(amount, currency);
  if (currency === "DKK") return value;
  if (!rate || !rateDate || !/^\d+(\.\d{1,12})?$/.test(rate)) return null;
  const parts = rate.split(".");
  const scale = parts[1]?.length ?? 0;
  const factor = BigInt(parts.join(""));
  if (factor <= 0n) return null;
  const numerator = value * factor * 100n;
  const denominator = 10n ** BigInt(scale + currencyDigits(currency));
  const absolute = numerator < 0n ? -numerator : numerator;
  return (
    ((absolute + denominator / 2n) / denominator) * (numerator < 0n ? -1n : 1n)
  );
}

/** Explained source rows are exclusions; only distinct matched ledger facts reconcile. */
export function matchedAmount(
  rows: { status: string; transactionId: string | null; amount: string }[],
  currency: string,
) {
  const matched = new Set<string>();
  return rows.reduce((sum, row) => {
    if (
      row.status !== "matched" ||
      !row.transactionId ||
      matched.has(row.transactionId)
    )
      return sum;
    matched.add(row.transactionId);
    return sum + minor(row.amount, currency);
  }, 0n);
}
