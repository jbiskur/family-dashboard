import {
  type HomeResponse,
  type ResourceEvent,
  type ResourceKind,
  resourceKinds,
  uuidSchema,
} from "@heima/contracts";
import { Temporal } from "@js-temporal/polyfill";
import { and, desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { type ApiVariables, requireMember } from "./access";
import { activityHref } from "./activity-links";
import { config } from "./config";
import { db } from "./db/client";
import { activity, commands, history, resources } from "./db/schema";
import {
  asResource,
  canManage,
  canRead,
  fields,
  type ResourceRow,
  TIMEZONE,
} from "./domain";
import { ApiFailure } from "./errors";
import { accountBalance, financeOverview, period } from "./finance";
import { emitResource } from "./pathways";
import { semanticId } from "./security";

export async function loadResources() {
  return db
    .select()
    .from(resources)
    .where(eq(resources.householdId, config.HOUSEHOLD_ID));
}
export function visibleResource(
  all: ResourceRow[],
  kind: ResourceKind,
  id: string,
  userId: string,
) {
  const row = all.find((r) => r.id === id && r.kind === kind);
  if (!row || !canRead(row, userId, all))
    throw new ApiFailure("not-found", 404, "This item is not available.");
  return row;
}
function present(row: ResourceRow, all: ResourceRow[]) {
  const value = asResource(row);
  if (row.kind === "finance/accounts")
    return {
      ...value,
      balance: accountBalance(row, all),
      reconciliationState: all.some(
        (r) =>
          r.kind === "finance/imports" &&
          r.data.accountId === row.id &&
          r.data.status !== "reconciled",
      )
        ? "needs-review"
        : all.some(
              (r) =>
                r.kind === "finance/transactions" &&
                r.data.accountId === row.id,
            )
          ? "reconciled"
          : "not-started",
    };
  if (row.kind === "shopping/lists") {
    const items = all.filter(
      (r) =>
        r.kind === "shopping/items" &&
        r.data.listId === row.id &&
        r.archived === "false",
    );
    return {
      ...value,
      itemCount: items.length,
      completedCount: items.filter((r) => r.data.completed === true).length,
    };
  }
  if (row.kind === "finance/imports")
    return {
      ...value,
      difference:
        row.data.openingBalance !== null && row.data.closingBalance !== null
          ? importDifference(row)
          : null,
    };
  if (row.kind === "finance/budgets") {
    const overview = financeOverview(
      all,
      { month: String(row.data.month) },
      true,
    );
    const category = overview.categories.find(
      (r) => r.categoryId === row.data.categoryId,
    );
    return {
      ...value,
      actual: category?.actual ?? "0.00",
      remaining: category?.remaining ?? String(row.data.amount),
      incomplete: overview.incomplete,
    };
  }
  return value;
}

import { decimal, matchedAmount, minor } from "./domain";

function importDifference(row: ResourceRow) {
  const code = String(row.data.currency);
  return decimal(
    minor(String(row.data.closingBalance), code) -
      minor(String(row.data.openingBalance), code) -
      matchedAmount(
        row.data.rows as {
          status: string;
          transactionId: string | null;
          amount: string;
        }[],
        code,
      ),
    code,
  );
}

const mutation = z
  .object({
    commandId: uuidSchema,
    id: uuidSchema.optional(),
    baseVersion: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export const resourceRoutes = new Hono<{ Variables: ApiVariables }>();
resourceRoutes.use("*", async (c, next) => {
  await requireMember(c.get("identity"));
  await next();
});
resourceRoutes.get("/finance/overview", async (c) =>
  c.json(financeOverview(await loadResources(), c.req.query())),
);
resourceRoutes.get("/finance/spending", async (c) =>
  c.json(financeOverview(await loadResources(), c.req.query())),
);
resourceRoutes.get("/home", async (c) => {
  const identity = c.get("identity");
  const all = await loadResources();
  const visible = all.filter(
    (r) => r.archived === "false" && canRead(r, identity.userId, all),
  );
  const work = visible.filter((r) => r.kind === "work/items");
  const today = Temporal.Now.plainDateISO(TIMEZONE).toString();
  const recent = await db
    .select()
    .from(history)
    .where(eq(history.householdId, config.HOUSEHOLD_ID))
    .orderBy(desc(history.occurredAt))
    .limit(100);
  const visibleHistory = recent
    .filter((h) => {
      const row = all.find((r) => r.id === h.resourceId);
      return !!row && canRead(row, identity.userId, all);
    })
    .slice(0, 8);
  const now = Date.now();
  const attention = work
    .filter(
      (r) =>
        r.data.status !== "done" &&
        r.data.dueAt &&
        Date.parse(String(r.data.dueAt)) <= now,
    )
    .map((r) => ({
      id: r.id,
      title: `Overdue: ${r.data.title}`,
      href: `/work?item=${r.id}`,
    }));
  for (const row of visible.filter(
    (r) => r.kind === "finance/imports" && r.data.status !== "reconciled",
  ))
    attention.push({
      id: row.id,
      title: "A statement needs review",
      href: `/finance/imports/${row.id}`,
    });
  const result = {
    household: { id: config.HOUSEHOLD_ID, name: "Our home" },
    today: work
      .filter(
        (r) =>
          r.data.status !== "done" &&
          r.data.dueDate &&
          String(r.data.dueDate) <= today,
      )
      .map(asResource),
    shopping: visible
      .filter((r) => r.kind === "shopping/lists")
      .map((r) => present(r, all)),
    work: {
      todo: work.filter((r) => r.data.status === "todo").length,
      doing: work.filter((r) => r.data.status === "doing").length,
      done: work.filter((r) => r.data.status === "done").length,
    },
    attention,
    activity: visibleHistory.map((h) => {
      const r = all.find((r) => r.id === h.resourceId)!;
      return {
        id: h.id,
        title: r.kind.startsWith("finance/")
          ? "Finance updated"
          : `${r.data.name ?? r.data.title ?? "Household"} · ${h.action}`,
        href: r.kind.startsWith("shopping/")
          ? `/shopping/${r.kind === "shopping/items" ? r.data.listId : r.kind === "shopping/lists" ? r.id : "stores"}`
          : r.kind === "work/items"
            ? `/work?item=${r.id}`
            : r.kind.startsWith("finance/")
              ? `/finance/${r.kind.split("/")[1]}`
              : "/household",
        occurredAt: h.occurredAt.toISOString(),
        read: true,
        category: r.kind,
      };
    }),
  };
  return c.json(result);
});
resourceRoutes.get("/activity", async (c) => {
  const all = await loadResources();
  const userId = c.get("identity").userId;
  const entries = await db
    .select()
    .from(activity)
    .where(
      and(
        eq(activity.householdId, config.HOUSEHOLD_ID),
        eq(activity.recipientId, userId),
      ),
    )
    .orderBy(desc(activity.occurredAt))
    .limit(200);
  return c.json({
    items: entries
      .filter((e) => activityHref(e, userId, all))
      .map((e) => ({
        id: e.id,
        title: e.title,
        href: activityHref(e, userId, all)!,
        occurredAt: e.occurredAt.toISOString(),
        read: e.isRead === "true",
        category: e.category,
      })),
  });
});
resourceRoutes.get("/commands/:id", async (c) => {
  const id = uuidSchema.parse(c.req.param("id"));
  const row = (
    await db
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.id, id),
          eq(commands.householdId, config.HOUSEHOLD_ID),
          eq(commands.actorId, c.get("identity").userId),
        ),
      )
      .limit(1)
  )[0];
  return c.json(
    row
      ? { commandId: row.id, status: row.status, errorCode: row.errorCode }
      : { commandId: id, status: "unconfirmed" },
  );
});

for (const kind of resourceKinds) {
  resourceRoutes.get(`/${kind}`, async (c) => {
    const userId = c.get("identity").userId;
    const all = await loadResources();
    if (kind === "finance/categories" && !all.some((r) => r.kind === kind)) {
      await emitResource({
        commandId: semanticId(`${config.HOUSEHOLD_ID}:finance-defaults`),
        householdId: config.HOUSEHOLD_ID,
        actorId: userId,
        occurredAt: new Date().toISOString(),
        kind,
        resourceId: semanticId(`${config.HOUSEHOLD_ID}:finance-defaults`),
        baseVersion: 0,
        action: "create",
        data: { initializeDefaults: true },
      });
      all.push(...(await loadResources()).filter((r) => r.kind === kind));
    }
    let rows = all.filter(
      (r) =>
        r.kind === kind &&
        (c.req.query("includeArchived") === "true" || r.archived === "false") &&
        canRead(r, userId, all),
    );
    if (c.req.query("listId")) {
      const id = uuidSchema.parse(c.req.query("listId"));
      visibleResource(all, "shopping/lists", id, userId);
      rows = rows.filter((r) => r.data.listId === id);
    }
    if (c.req.query("accountId")) {
      const id = uuidSchema.parse(c.req.query("accountId"));
      visibleResource(all, "finance/accounts", id, userId);
      rows = rows.filter((r) => r.data.accountId === id);
    }
    if (kind === "finance/transactions") {
      const range = period(c.req.query());
      rows = rows.filter(
        (r) =>
          String(r.data.bookingDate) >= range.from &&
          String(r.data.bookingDate) <= range.to,
      );
      for (const key of ["categoryId", "role", "reconciliationState"])
        if (c.req.query(key))
          rows = rows.filter((r) =>
            c.req.query(key) === "uncategorized"
              ? !r.data[key]
              : r.data[key] === c.req.query(key),
          );
    }
    if (kind === "finance/budgets" && c.req.query("month"))
      rows = rows.filter((r) => r.data.month === c.req.query("month"));
    if (c.req.query("q")) {
      const q = c.req.query("q")!.toLowerCase();
      rows = rows.filter((r) =>
        [r.data.name, r.data.title, r.data.description, r.data.reference].some(
          (v) => typeof v === "string" && v.toLowerCase().includes(q),
        ),
      );
    }
    rows.sort((a, b) =>
      kind === "shopping/items"
        ? Number(a.data.position) - Number(b.data.position) ||
          a.createdAt.getTime() - b.createdAt.getTime()
        : b.createdAt.getTime() - a.createdAt.getTime(),
    );
    return c.json({ items: rows.map((r) => present(r, all)) });
  });
  resourceRoutes.get(`/${kind}/:id/history`, async (c) => {
    const all = await loadResources();
    const id = uuidSchema.parse(c.req.param("id"));
    visibleResource(all, kind, id, c.get("identity").userId);
    const entries = await db
      .select()
      .from(history)
      .where(
        and(
          eq(history.householdId, config.HOUSEHOLD_ID),
          eq(history.resourceId, id),
        ),
      )
      .orderBy(desc(history.occurredAt));
    return c.json({
      items: entries.map((h) => ({
        id: h.id,
        resourceId: h.resourceId,
        actorId: h.actorId,
        action: h.action,
        occurredAt: h.occurredAt.toISOString(),
        before: h.before,
        after: h.after,
      })),
    });
  });
  resourceRoutes.get(`/${kind}/:id`, async (c) => {
    const all = await loadResources();
    const row = visibleResource(
      all,
      kind,
      uuidSchema.parse(c.req.param("id")),
      c.get("identity").userId,
    );
    return c.json(present(row, all));
  });
  const handleMutation =
    (action: ResourceEvent["action"]) =>
    async (c: Context<{ Variables: ApiVariables }>) => {
      const identity = c.get("identity");
      const input = mutation.parse(await c.req.json());
      const all = await loadResources();
      const id = c.req.param("id")
        ? uuidSchema.parse(c.req.param("id"))
        : (input.id ?? semanticId(`${input.commandId}:resource`));
      const current =
        action === "create"
          ? undefined
          : visibleResource(all, kind, id, identity.userId);
      if (current && !canManage(current, identity.userId, all))
        throw new ApiFailure("not-found", 404, "This item is not available.");
      if (action !== "create" && input.baseVersion === undefined)
        throw new ApiFailure(
          "version-required",
          400,
          "Refresh this item before changing it.",
        );
      const { commandId, baseVersion, id: _id, ...data } = input;
      fields[kind].parse({ ...(current?.data ?? {}), ...data });
      await emitResource({
        commandId,
        householdId: config.HOUSEHOLD_ID,
        actorId: identity.userId,
        occurredAt: new Date().toISOString(),
        kind,
        resourceId: id,
        baseVersion: action === "create" ? 0 : baseVersion!,
        action,
        data,
      });
      const latest = await loadResources();
      const row = visibleResource(latest, kind, id, identity.userId);
      return c.json(present(row, latest), action === "create" ? 201 : 200);
    };
  resourceRoutes.post(`/${kind}`, handleMutation("create"));
  resourceRoutes.post(`/${kind}/:id`, handleMutation("update"));
  resourceRoutes.patch(`/${kind}/:id`, handleMutation("update"));
  resourceRoutes.post(`/${kind}/:id/archive`, handleMutation("archive"));
  if (kind === "work/items")
    resourceRoutes.post(`/${kind}/:id/skip`, handleMutation("skip"));
  if (kind === "finance/imports")
    resourceRoutes.post(`/${kind}/:id/reconcile`, handleMutation("reconcile"));
}
