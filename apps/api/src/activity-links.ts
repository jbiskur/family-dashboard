import { canRead, type ResourceRow } from "./domain";

export function syncTarget(
  area: "shopping" | "work",
  resourceId: string | undefined,
  userId: string,
  all: ResourceRow[],
) {
  const row = all.find(
    (r) =>
      r.id === resourceId &&
      r.archived === "false" &&
      r.kind.startsWith(`${area}/`) &&
      canRead(r, userId, all),
  );
  if (!row) return { resourceId: null, href: `/${area}` };
  if (row.kind === "work/items")
    return { resourceId: row.id, href: `/work?item=${row.id}` };
  if (row.kind === "shopping/items") {
    const list = all.find(
      (r) =>
        r.id === row.data.listId &&
        r.kind === "shopping/lists" &&
        r.archived === "false",
    );
    if (list) return { resourceId: row.id, href: `/shopping/${list.id}` };
  }
  if (row.kind === "shopping/lists")
    return { resourceId: row.id, href: `/shopping/${row.id}` };
  return { resourceId: null, href: `/${area}` };
}

// Recalculate links on every read/delivery: a target can disappear or become private.
export function activityHref(
  entry: { resourceId: string | null; category: string; href: string },
  userId: string,
  all: ResourceRow[],
): string | null {
  if (entry.category === "syncFailures")
    return syncTarget(
      entry.href.startsWith("/shopping") ? "shopping" : "work",
      entry.resourceId ?? undefined,
      userId,
      all,
    ).href;
  const row = all.find((r) => r.id === entry.resourceId);
  return row && canRead(row, userId, all) ? entry.href : null;
}
