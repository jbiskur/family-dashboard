import type { FlowcoreEvent } from "@flowcore/pathways";
import type { ImportRow, Recurrence, ResourceEvent } from "@heima/contracts";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db/client";
import { activity, commands, history, members, resources } from "./db/schema";
import {
  asResource,
  canManage,
  canRead,
  dueInstant,
  fields,
  matchedAmount,
  minor,
  nextDate,
  type ResourceRow,
} from "./domain";
import { ApiFailure } from "./errors";
import { semanticId } from "./security";

function fail(code: string): never {
  throw new ApiFailure(
    code,
    409,
    "This change conflicts with the current state.",
  );
}
export const defaultCategories = [
  "Housing",
  "Utilities",
  "Groceries",
  "Transport",
  "Health",
  "Insurance",
  "Family",
  "Personal",
  "Dining",
  "Shopping",
  "Entertainment",
  "Travel",
  "Education",
  "Gifts/charity",
  "Taxes",
  "Fees",
  "Other",
];

export type ResourceProjectionTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

export async function projectResource(event: FlowcoreEvent<ResourceEvent>) {
  await db.transaction((tx) => projectResourceInTransaction(event, tx));
}

// Used by import finalization inside its existing staging transaction. Never
// create another connection/transaction while holding the household lock.
export async function projectResourceInTransaction(
  event: FlowcoreEvent<ResourceEvent>,
  tx: ResourceProjectionTransaction,
) {
  const p = event.payload;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${p.householdId}, 0))`,
  );
  if (
    (
      await tx
        .select()
        .from(commands)
        .where(eq(commands.id, p.commandId))
        .limit(1)
    )[0]
  )
    return;
  const all = await tx
    .select()
    .from(resources)
    .where(eq(resources.householdId, p.householdId));
  const activeMembers = await tx
    .select()
    .from(members)
    .where(
      and(eq(members.householdId, p.householdId), eq(members.status, "active")),
    );
  const now = new Date(p.occurredAt);
  let errorCode: string | null = null;
  let result: Record<string, unknown> = {};
  try {
    await tx.transaction(async (tx) => {
      if (!activeMembers.some((m) => m.userId === p.actorId))
        fail("access-denied");
      if (
        p.kind === "finance/categories" &&
        p.data.initializeDefaults === true
      ) {
        for (const name of defaultCategories) {
          await tx
            .insert(resources)
            .values({
              id: semanticId(`${p.householdId}:category:${name}`),
              householdId: p.householdId,
              kind: p.kind,
              ownerId: p.actorId,
              visibility: "household",
              version: 1,
              data: { name, parentId: null },
              sourceEventId: event.eventId,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoNothing();
        }
      } else {
        const current = all.find((r) => r.id === p.resourceId);
        if (
          p.action === "create"
            ? !!current
            : !current ||
              current.kind !== p.kind ||
              !canManage(current, p.actorId, all)
        )
          fail("not-found");
        if ((current?.version ?? 0) !== p.baseVersion) fail("version-conflict");
        if (current?.archived === "true") fail("archived-resource");
        let visibility = (p.data.visibility ??
          current?.visibility ??
          "household") as string;
        if (!["personal", "household"].includes(visibility))
          fail("invalid-scope");
        let ownerId = current?.ownerId ?? p.actorId;
        const scopeChanged = !!current && current.visibility !== visibility;
        if (scopeChanged) {
          if (
            !["shopping/lists", "work/items"].includes(p.kind) ||
            p.data.confirmScope !== true
          )
            fail("scope-confirmation-required");
          if (visibility === "personal") ownerId = p.actorId;
        }
        if (
          [
            "shopping/stores",
            "household/profiles",
            "finance/categories",
            "finance/budgets",
          ].includes(p.kind)
        )
          visibility = "household";
        if (p.kind.startsWith("settings/")) visibility = "personal";
        const data: Record<string, unknown> = {
          ...(current?.data ?? {}),
          ...fields[p.kind].parse({ ...(current?.data ?? {}), ...p.data }),
        };
        if (
          !current &&
          p.kind === "settings/preferences" &&
          all.some(
            (r) =>
              r.kind === p.kind &&
              r.ownerId === p.actorId &&
              r.archived === "false",
          )
        )
          fail("preferences-exist");
        if (
          !current &&
          p.kind === "settings/devices" &&
          all.some(
            (r) =>
              r.kind === p.kind &&
              r.ownerId === p.actorId &&
              r.archived === "false" &&
              r.data.endpoint === data.endpoint,
          )
        )
          fail("device-exists");
        let archived = p.action === "archive" ? "true" : "false";
        if (p.kind === "shopping/items") {
          const parent = all.find(
            (r) =>
              r.id === data.listId &&
              r.kind === "shopping/lists" &&
              r.archived === "false",
          );
          if (
            !parent ||
            !canManage(parent, p.actorId, all) ||
            (current && current.data.listId !== data.listId)
          )
            fail("not-found");
          visibility = parent.visibility;
          ownerId = parent.ownerId;
          for (const key of ["offerStoreId", "purchaseStoreId"])
            if (
              data[key] &&
              data[key] !== current?.data[key] &&
              !all.some(
                (r) =>
                  r.id === data[key] &&
                  r.kind === "shopping/stores" &&
                  r.archived === "false",
              )
            )
              fail("invalid-store");
          if (current?.data.completed === true && data.completed === false)
            data.purchaseStoreId = null;
          if (data.purchaseStoreId && data.completed !== true)
            fail("complete-before-attribution");
          if (data.completed === true && current?.data.completed !== true) {
            data.completedAt = p.occurredAt;
            data.completedBy = p.actorId;
            data.purchaseId =
              current?.data.purchaseId ??
              semanticId(`${p.resourceId}:purchase`);
          }
          if (data.completed !== true) {
            data.completedAt = null;
            data.completedBy = null;
          }
        }
        if (
          p.kind === "shopping/stores" &&
          (data.latitude === null) !== (data.longitude === null)
        )
          fail("invalid-location");
        if (p.kind === "work/items") {
          if (
            current &&
            Object.hasOwn(p.data, "recurrence") &&
            JSON.stringify(data.recurrence) !==
              JSON.stringify(current.data.recurrence)
          ) {
            if (p.data.confirmSeries !== true)
              fail("series-confirmation-required");
            if (
              current.data.status === "done" ||
              current.data.nextOccurrenceId ||
              current.data.skipped
            )
              fail("historical-series-immutable");
          }
          if (scopeChanged) data.assigneeId = null;
          if (data.assigneeId && data.assigneeId !== current?.data.assigneeId) {
            if (visibility === "personal" && data.assigneeId !== ownerId)
              fail("personal-assignment");
            if (
              !activeMembers.some((m) => m.userId === data.assigneeId) &&
              !all.some(
                (r) =>
                  r.kind === "household/profiles" &&
                  r.id === data.assigneeId &&
                  r.archived === "false",
              )
            )
              fail("invalid-assignee");
          }
          if (data.dueTime && !data.dueDate) fail("due-date-required");
          if (
            data.recurrence &&
            (!data.dueDate ||
              (data.status === "done" && !current?.data.recurrence))
          )
            fail("recurrence-anchor-required");
          data.dueAt = dueInstant(
            data.dueDate as string | null,
            data.dueTime as string | null,
          );
          if (data.recurrence) {
            const rule = data.recurrence as Recurrence;
            data.recurrence = {
              ...rule,
              anchorDay:
                rule.anchorDay ?? Number(String(data.dueDate).slice(8, 10)),
            };
            data.seriesId =
              current?.data.seriesId ?? semanticId(`${p.resourceId}:series`);
            if (
              !current?.data.seriesTemplate ||
              p.data.confirmSeries === true
            ) {
              data.seriesTemplate = {
                title: data.title,
                note: data.note,
                assigneeId: data.assigneeId,
                dueTime: data.dueTime,
              };
              data.seriesScheduledDate = data.dueDate;
            } else if (scopeChanged)
              data.seriesTemplate = {
                ...(data.seriesTemplate as Record<string, unknown>),
                assigneeId: null,
              };
          }
          if (data.status === "done" && current?.data.status !== "done") {
            data.completedAt = p.occurredAt;
            data.completedBy = p.actorId;
          }
          if (data.status !== "done") {
            data.completedAt = null;
            data.completedBy = null;
          }
          if (p.action === "skip") {
            if (!data.recurrence || data.status === "done")
              fail("invalid-skip");
            data.skipped = true;
            archived = "true";
          }
        }
        if (p.kind === "finance/accounts") {
          if (
            current &&
            (data.currency !== current.data.currency || scopeChanged)
          )
            fail("account-currency-immutable");
          if (
            current &&
            data.shared !== current.data.shared &&
            current.ownerId !== p.actorId
          )
            fail("owner-required");
          if (visibility === "household") data.shared = false;
        }
        if (p.kind === "finance/categories") {
          const parent = data.parentId
            ? all.find(
                (r) =>
                  r.id === data.parentId &&
                  r.kind === p.kind &&
                  r.archived === "false",
              )
            : null;
          if (
            data.parentId &&
            (!parent ||
              parent.data.parentId ||
              data.parentId === p.resourceId ||
              all.some(
                (r) => r.kind === p.kind && r.data.parentId === p.resourceId,
              ))
          )
            fail("invalid-category-parent");
          if (
            all.some(
              (r) =>
                r.kind === p.kind &&
                r.archived === "false" &&
                r.id !== p.resourceId &&
                r.data.parentId === data.parentId &&
                String(r.data.name).toLowerCase() ===
                  String(data.name).toLowerCase(),
            )
          )
            fail("category-name-exists");
        }
        if (
          ["finance/budgets", "finance/transactions"].includes(p.kind) &&
          data.categoryId &&
          data.categoryId !== current?.data.categoryId &&
          !all.some(
            (r) =>
              r.id === data.categoryId &&
              r.kind === "finance/categories" &&
              r.archived === "false",
          )
        )
          fail("invalid-category");
        if (p.kind === "finance/budgets") {
          minor(String(data.amount), String(data.currency));
          if (data.currency !== "DKK") fail("reporting-currency-required");
          if (
            all.some(
              (r) =>
                r.kind === p.kind &&
                r.archived === "false" &&
                r.id !== p.resourceId &&
                r.data.categoryId === data.categoryId &&
                r.data.month === data.month,
            )
          )
            fail("budget-already-exists");
        }
        if (p.kind === "finance/transactions" || p.kind === "finance/imports") {
          const account = all.find(
            (r) =>
              r.id === data.accountId &&
              r.kind === "finance/accounts" &&
              r.archived === "false",
          );
          if (
            !account ||
            !canManage(account, p.actorId, all) ||
            (current && current.data.accountId !== data.accountId)
          )
            fail("not-found");
          if (data.currency !== account.data.currency)
            fail("currency-mismatch");
          visibility = account.visibility;
          ownerId = account.ownerId;
          if (p.action === "archive") fail("financial-fact-immutable");
        }
        if (p.kind === "finance/transactions") {
          minor(String(data.amount), String(data.currency));
          if (
            current &&
            ["amount", "currency", "bookingDate", "description"].some(
              (k) => data[k] !== current.data[k],
            )
          )
            fail("correction-required");
          if (
            !current &&
            (data.source !== "manual" ||
              data.importId ||
              data.reconciliationState !== "reconciled")
          )
            fail("invalid-manual-source");
          if (
            current &&
            [
              "source",
              "sourceId",
              "importId",
              "reconciliationState",
              "supersedesId",
            ].some((k) => data[k] !== current.data[k])
          )
            fail("provenance-immutable");
          if (
            data.linkedTransactionId &&
            !all.some(
              (r) =>
                r.id === data.linkedTransactionId &&
                r.kind === p.kind &&
                canRead(r, p.actorId, all),
            )
          )
            fail("invalid-linked-transaction");
          if (
            data.supersedesId &&
            !all.some(
              (r) =>
                r.id === data.supersedesId &&
                r.kind === p.kind &&
                canManage(r, p.actorId, all) &&
                r.data.accountId === data.accountId,
            )
          )
            fail("invalid-correction");
        }
        if (
          p.kind === "finance/transactions" &&
          !current &&
          data.supersedesId &&
          all.some(
            (r) =>
              r.kind === p.kind && r.data.supersedesId === data.supersedesId,
          )
        )
          fail("correction-already-exists");
        if (p.kind === "finance/imports") {
          const sourceRows = data.rows as ImportRow[];
          if (!sourceRows.length) fail("empty-import");
          if (
            !current &&
            all.some(
              (r) =>
                r.kind === p.kind &&
                r.data.accountId === data.accountId &&
                r.data.sourceHash === data.sourceHash,
            )
          )
            fail("duplicate-import");
          if (
            current &&
            ["fileName", "sourceHash", "currency", "mapping"].some(
              (k) =>
                JSON.stringify(data[k]) !== JSON.stringify(current.data[k]),
            )
          )
            fail("import-source-immutable");
          if (!current) {
            data.status = "needs-review";
            let duplicateCount = 0;
            let importedCount = 0;
            const seen = new Set<string>();
            for (const row of sourceRows) {
              minor(row.amount, String(data.currency));
              const transactionId = semanticId(
                `${data.accountId}:${row.sourceId ? `source:${row.sourceId}` : `fact:${row.bookingDate}:${row.amount}:${row.description.trim().toLowerCase()}:${row.reference}`}`,
              );
              const existing =
                all.find((r) => r.id === transactionId) ??
                all.find(
                  (r) =>
                    r.kind === "finance/transactions" &&
                    r.data.accountId === data.accountId &&
                    r.data.amount === row.amount &&
                    ((row.reference && r.data.reference === row.reference) ||
                      (r.data.description === row.description &&
                        (r.data.bookingDate === row.transactionDate ||
                          r.data.bookingDate === row.valueDate ||
                          r.data.transactionDate === row.bookingDate ||
                          r.data.valueDate === row.bookingDate))),
                );
              if (existing || seen.has(transactionId)) {
                row.status = "possible-duplicate";
                row.transactionId = existing?.id ?? transactionId;
                duplicateCount++;
              } else {
                row.status = "matched";
                row.transactionId = transactionId;
                importedCount++;
                seen.add(transactionId);
                const transactionData = {
                  accountId: data.accountId,
                  amount: row.amount,
                  currency: data.currency,
                  bookingDate: row.bookingDate,
                  transactionDate: row.transactionDate,
                  valueDate: row.valueDate,
                  description: row.description,
                  role: row.role,
                  categoryId: row.categoryId,
                  source: "import",
                  sourceId: row.sourceId,
                  reference: row.reference,
                  reason: "Imported statement",
                  reconciliationState: "needs-review",
                  importId: p.resourceId,
                  reportingRate: null,
                  reportingRateDate: null,
                  supersedesId: null,
                  linkedTransactionId: null,
                };
                await tx
                  .insert(resources)
                  .values({
                    id: transactionId,
                    householdId: p.householdId,
                    kind: "finance/transactions",
                    ownerId,
                    visibility,
                    version: 1,
                    data: transactionData,
                    sourceEventId: event.eventId,
                    createdAt: now,
                    updatedAt: now,
                  })
                  .onConflictDoNothing();
              }
            }
            data.importedCount = importedCount;
            data.duplicateCount = duplicateCount;
          } else {
            const oldRows = current.data.rows as ImportRow[];
            if (
              oldRows.length !== sourceRows.length ||
              oldRows.some((r, i) =>
                [
                  "id",
                  "sourceId",
                  "bookingDate",
                  "amount",
                  "description",
                  "transactionDate",
                  "valueDate",
                  "reference",
                  "original",
                ].some(
                  (key) =>
                    JSON.stringify(r[key as keyof ImportRow]) !==
                    JSON.stringify(sourceRows[i]?.[key as keyof ImportRow]),
                ),
              )
            )
              fail("import-source-immutable");
            for (const row of sourceRows) {
              if (row.status === "explained" && !row.explanation.trim())
                fail("explanation-required");
              if (row.status === "matched") {
                const target = all.find(
                  (r) =>
                    r.id === row.transactionId &&
                    r.kind === "finance/transactions",
                );
                if (
                  !target ||
                  target.data.accountId !== data.accountId ||
                  target.data.amount !== row.amount ||
                  target.data.currency !== data.currency
                )
                  fail("invalid-match");
              }
            }
          }
          if (p.action === "reconcile") {
            if (
              !data.openingBalance ||
              !data.closingBalance ||
              sourceRows.some(
                (r) => !["matched", "explained"].includes(r.status),
              )
            )
              fail("reconciliation-unresolved");
            const matchIds = sourceRows
              .filter((r) => r.status === "matched")
              .map((r) => r.transactionId);
            if (new Set(matchIds).size !== matchIds.length)
              fail("duplicate-match");
            const difference =
              minor(String(data.closingBalance), String(data.currency)) -
              minor(String(data.openingBalance), String(data.currency)) -
              matchedAmount(sourceRows, String(data.currency));
            if (difference !== 0n) fail("reconciliation-difference");
            data.status = "reconciled";
            for (const row of sourceRows)
              if (row.status === "matched" && row.transactionId) {
                const target = all.find((r) => r.id === row.transactionId);
                if (target)
                  await tx
                    .update(resources)
                    .set({
                      data: {
                        ...target.data,
                        reconciliationState: "reconciled",
                      },
                      version: target.version + 1,
                      sourceEventId: event.eventId,
                      updatedAt: now,
                    })
                    .where(eq(resources.id, target.id));
              }
          } else {
            const reviewChanged =
              !!current &&
              ["rows", "openingBalance", "closingBalance"].some(
                (key) =>
                  JSON.stringify(data[key]) !==
                  JSON.stringify(current.data[key]),
              );
            data.status = reviewChanged
              ? "needs-review"
              : (current?.data.status ?? "needs-review");
            if (reviewChanged && current?.data.status === "reconciled")
              for (const target of all.filter(
                (r) =>
                  r.kind === "finance/transactions" &&
                  r.data.importId === current.id,
              ))
                await tx
                  .update(resources)
                  .set({
                    data: {
                      ...target.data,
                      reconciliationState: "needs-review",
                    },
                    version: target.version + 1,
                    sourceEventId: event.eventId,
                    updatedAt: now,
                  })
                  .where(eq(resources.id, target.id));
          }
        }
        const row: ResourceRow = {
          id: p.resourceId,
          householdId: p.householdId,
          kind: p.kind,
          ownerId,
          visibility,
          version: p.baseVersion + 1,
          data,
          archived,
          sourceEventId: event.eventId,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        };
        await tx
          .insert(resources)
          .values(row)
          .onConflictDoUpdate({ target: resources.id, set: row });
        await tx.insert(history).values({
          id: semanticId(`${p.commandId}:history`),
          householdId: p.householdId,
          resourceId: row.id,
          actorId: p.actorId,
          action: scopeChanged ? "scope-changed" : p.action,
          before: current ? asResource(current) : null,
          after: asResource(row),
          occurredAt: now,
        });
        if (p.kind === "finance/categories" && archived === "true")
          for (const child of all.filter(
            (r) =>
              r.kind === p.kind &&
              r.data.parentId === row.id &&
              r.archived === "false",
          )) {
            await tx
              .update(resources)
              .set({
                archived: "true",
                version: child.version + 1,
                updatedAt: now,
                sourceEventId: event.eventId,
              })
              .where(eq(resources.id, child.id));
            await tx.insert(history).values({
              id: semanticId(`${p.commandId}:history:${child.id}`),
              householdId: p.householdId,
              resourceId: child.id,
              actorId: p.actorId,
              action: "parent-archived",
              before: asResource(child),
              after: { ...asResource(child), archived: true },
              occurredAt: now,
            });
          }
        if (
          p.kind === "work/items" &&
          data.recurrence &&
          data.dueDate &&
          !current?.data.nextOccurrenceId &&
          (p.action === "skip" ||
            (data.status === "done" && current?.data.status !== "done"))
        ) {
          const nextId = semanticId(`${row.id}:next`);
          const dueDate = nextDate(
            String(data.seriesScheduledDate ?? data.dueDate),
            data.recurrence as Recurrence,
          );
          const template = data.seriesTemplate as Record<string, unknown>;
          const nextData = {
            ...data,
            ...template,
            status: "todo",
            dueDate,
            seriesScheduledDate: dueDate,
            dueAt: dueInstant(dueDate, template.dueTime as string | null),
            completedAt: null,
            completedBy: null,
            previousOccurrenceId: row.id,
            nextOccurrenceId: null,
            skipped: false,
          };
          await tx
            .insert(resources)
            .values({
              ...row,
              id: nextId,
              version: 1,
              data: nextData,
              archived: "false",
              createdAt: now,
            })
            .onConflictDoNothing();
          await tx
            .insert(history)
            .values({
              id: semanticId(`${p.commandId}:next-history`),
              householdId: p.householdId,
              resourceId: nextId,
              actorId: p.actorId,
              action: "recurrence-created",
              before: null,
              after: nextData,
              occurredAt: now,
            })
            .onConflictDoNothing();
          data.nextOccurrenceId = nextId;
          await tx
            .update(resources)
            .set({ data })
            .where(eq(resources.id, row.id));
        }
        const recipientRows = [...all.filter((r) => r.id !== row.id), row];
        for (const recipient of activeMembers.filter(
          (m) =>
            m.userId !== p.actorId && canRead(row, m.userId, recipientRows),
        )) {
          const category = p.kind.startsWith("shopping/")
            ? "shoppingChanges"
            : p.kind === "work/items"
              ? data.assigneeId === recipient.userId &&
                data.assigneeId !== current?.data.assigneeId
                ? "workAssignment"
                : data.nextOccurrenceId && !current?.data.nextOccurrenceId
                  ? "recurrence"
                  : null
              : p.kind === "finance/imports"
                ? "financeReview"
                : null;
          if (!category) continue;
          const title =
            category === "financeReview"
              ? "Finance review needs attention"
              : p.kind === "work/items"
                ? category === "workAssignment"
                  ? "Work was assigned to you"
                  : "Household work updated"
                : "Shopping list updated";
          const href = p.kind.startsWith("shopping/")
            ? `/shopping/${p.kind === "shopping/items" ? data.listId : p.kind === "shopping/lists" ? row.id : "stores"}`
            : p.kind === "work/items"
              ? `/work?item=${row.id}`
              : `/finance/imports/${row.id}`;
          await tx
            .insert(activity)
            .values({
              id: semanticId(`${p.commandId}:activity:${recipient.userId}`),
              householdId: p.householdId,
              recipientId: recipient.userId,
              resourceId: row.id,
              category,
              title,
              href,
              occurredAt: now,
            })
            .onConflictDoNothing();
        }
        result = { resourceId: row.id };
      }
    });
  } catch (error) {
    if (error instanceof ApiFailure) errorCode = error.code;
    else if (error instanceof Error && error.name === "ZodError")
      errorCode = "invalid-input";
    else throw error;
  }
  await tx.insert(commands).values({
    id: p.commandId,
    householdId: p.householdId,
    actorId: p.actorId,
    status: errorCode ? "rejected" : "completed",
    errorCode,
    result,
    sourceEventId: event.eventId,
    createdAt: now,
  });
}
