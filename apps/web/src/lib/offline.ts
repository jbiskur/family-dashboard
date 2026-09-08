"use client";

export type OfflineLease = {
  actorId: string;
  householdId: string;
  expiresAt: number;
};
export type QueuedCommand = {
  commandId: string;
  entityId: string;
  actorId: string;
  householdId: string;
  path: string;
  body: Record<string, unknown>;
  baseVersion: number;
  createdAt: string;
  state: "pending" | "error" | "conflict";
  attempts: number;
  nextAttemptAt: number;
  message?: string;
  original: Record<string, unknown> | null;
  current?: Record<string, unknown>;
  failureReport?: {
    commandId: string;
    attempts: number;
    nextAttemptAt: number;
    complete: boolean;
  };
};
const LEASE = "heima-offline-lease";
const QUEUE = "heima-offline-queue";
const PREFIX = "heima-offline-data:";
export function announce() {
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event("heima-offline-change"));
}
export function getLease(): OfflineLease | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(
      localStorage.getItem(LEASE) ?? "null",
    ) as OfflineLease | null;
    if (
      value &&
      value.expiresAt > Date.now() &&
      /^[0-9a-f-]{36}$/i.test(value.actorId) &&
      /^[0-9a-f-]{36}$/i.test(value.householdId)
    )
      return value;
  } catch {}
  return null;
}
export function saveLease(value: OfflineLease) {
  const old = getLease();
  if (
    !old ||
    old.actorId !== value.actorId ||
    old.householdId !== value.householdId
  )
    purgeOffline();
  localStorage.setItem(LEASE, JSON.stringify(value));
  void navigator.serviceWorker?.ready.then((registration) =>
    registration.active?.postMessage({
      type: "HEIMA_LEASE",
      lease: value,
      path: location.pathname,
      staticPaths: performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => {
          const url = new URL(name, location.origin);
          return (
            url.origin === location.origin &&
            url.pathname.startsWith("/_next/static/")
          );
        }),
    }),
  );
  announce();
}
export function purgeOffline(expectedActorId?: string) {
  if (typeof window === "undefined") return;
  const current = getLease();
  if (expectedActorId && current && current.actorId !== expectedActorId) return;
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("heima-offline-")) localStorage.removeItem(key);
  } catch {}
  if ("caches" in window)
    void caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("heima-private"))
            .map((key) => caches.delete(key)),
        ),
      )
      .catch(() => undefined);
  void navigator.serviceWorker?.ready.then((registration) =>
    registration.active?.postMessage({ type: "HEIMA_PURGE" }),
  );
  announce();
}
export function cacheable(path: string) {
  if (path === "/v1/household/profiles?includeArchived=true&context=work")
    return true;
  return (
    /^\/v1\/(shopping\/(lists|items|stores)|work\/items)(\/|\?|$)/.test(path) &&
    !path.includes("/history")
  );
}
export function cached<T>(path: string): T | undefined {
  const lease = getLease();
  if (!lease || !cacheable(path)) return undefined;
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + path) ?? "null");
    return value?.actorId === lease.actorId &&
      value?.householdId === lease.householdId
      ? (value.data as T)
      : undefined;
  } catch {
    return undefined;
  }
}
export function cacheData(path: string, data: unknown) {
  if (path === "/v1/household/profiles?includeArchived=true&context=work") {
    const rows = (
      data as { items?: { id: string; name: string; archived: boolean }[] }
    )?.items;
    data = {
      items: (rows ?? []).map(({ id, name, archived }) => ({
        id,
        name,
        archived,
      })),
    };
  }
  const lease = getLease();
  if (!lease || !cacheable(path)) return;
  localStorage.setItem(
    PREFIX + path,
    JSON.stringify({
      actorId: lease.actorId,
      householdId: lease.householdId,
      savedAt: new Date().toISOString(),
      data,
    }),
  );
}
export function cacheTime(path: string) {
  try {
    return JSON.parse(localStorage.getItem(PREFIX + path) ?? "null")?.savedAt as
      | string
      | undefined;
  } catch {
    return undefined;
  }
}
export function readQueue(): QueuedCommand[] {
  const lease = getLease();
  if (!lease) return [];
  try {
    return (
      JSON.parse(localStorage.getItem(QUEUE) ?? "[]") as QueuedCommand[]
    ).filter(
      (c) => c.actorId === lease.actorId && c.householdId === lease.householdId,
    );
  } catch {
    return [];
  }
}
export function saveQueue(queue: QueuedCommand[]) {
  localStorage.setItem(QUEUE, JSON.stringify(queue));
  announce();
}
export function queueable(path: string, body: Record<string, unknown>) {
  if (
    !/^\/v1\/(shopping|work)\/items(?:\/[0-9a-f-]{36}(?:\/archive)?)?$/i.test(
      path,
    )
  )
    return false;
  const create = /\/items$/.test(path);
  return (
    !body.confirmScope &&
    !body.confirmSeries &&
    (!("visibility" in body) || create) &&
    (!("recurrence" in body) || (create && body.recurrence === null))
  );
}
export function entityPath(path: string) {
  return path.replace(/\/(archive|skip)$/, " ").trim();
}
export function queueCommand(
  path: string,
  body: Record<string, unknown>,
  original: Record<string, unknown> | null = null,
) {
  const lease = getLease();
  if (!lease)
    throw new Error(
      "Your offline session expired. Reconnect and sign in before changing household data.",
    );
  if (!queueable(path, body))
    throw new Error("This change needs an online connection.");
  const commandId = String(body.commandId);
  const create = /\/items$/.test(path);
  const entityId = create
    ? String(body.id)
    : (entityPath(path).split("/").at(-1) ?? "");
  const queue = readQueue();
  if (!queue.some((c) => c.commandId === commandId))
    queue.push({
      commandId,
      entityId,
      actorId: lease.actorId,
      householdId: lease.householdId,
      path,
      body,
      baseVersion: Number(body.baseVersion ?? 0),
      createdAt: new Date().toISOString(),
      state: "pending",
      attempts: 0,
      nextAttemptAt: 0,
      original,
    });
  saveQueue(queue);
  return optimistic(path, body, original, lease);
}
function optimistic(
  path: string,
  body: Record<string, unknown>,
  original: Record<string, unknown> | null,
  lease: OfflineLease,
) {
  const created = /\/items$/.test(path);
  const entityId = created
    ? String(body.id)
    : (entityPath(path).split("/").at(-1) ?? "");
  const data = {
    ...(created
      ? {
          note: "",
          status: "todo",
          completed: false,
          quantity: "1",
          category: "",
          position: 0,
          recurrence: null,
          assigneeId: null,
          dueDate: null,
          dueTime: null,
          offerStoreId: null,
          purchaseStoreId: null,
        }
      : {}),
    ...(original ?? {}),
    ...body,
    id: entityId,
    version: Number(body.baseVersion ?? 0) + 1,
    ownerId: original?.ownerId ?? lease.actorId,
    visibility: original?.visibility ?? body.visibility ?? "household",
    createdAt: original?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: path.endsWith("/archive"),
    pending: true,
  };
  delete (data as Record<string, unknown>).commandId;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(PREFIX)) continue;
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "null");
      if (
        value.actorId !== lease.actorId ||
        value.householdId !== lease.householdId
      )
        continue;
      if (value.data?.id === entityId) value.data = data;
      else if (Array.isArray(value.data?.items)) {
        const index = value.data.items.findIndex(
          (item: { id: string }) => item.id === entityId,
        );
        if (index >= 0) {
          if (data.archived) value.data.items.splice(index, 1);
          else value.data.items[index] = data;
        } else if (
          created &&
          key.includes(path) &&
          (!key.includes("listId=") || key.includes(`listId=${body.listId}`))
        )
          value.data.items.push(data);
      }
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }
  announce();
  return data;
}
export function lastSyncTime(): string | undefined {
  let latest: string | undefined;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(PREFIX)) continue;
    try {
      const time = JSON.parse(localStorage.getItem(key) ?? "null")?.savedAt;
      if (typeof time === "string" && (!latest || time > latest)) latest = time;
    } catch {}
  }
  return latest;
}
export function discardQueued(commandId: string) {
  const lease = getLease();
  if (!lease) return;
  const queue = readQueue();
  const removed = queue.find((item) => item.commandId === commandId);
  if (!removed) return;
  const remaining = queue.filter((item) => item.commandId !== commandId);
  for (const item of remaining)
    if (
      item.entityId === removed.entityId &&
      item.createdAt >= removed.createdAt
    ) {
      item.state = "error";
      item.message =
        "An earlier change was discarded. Review this change before retrying.";
    }
  const original = removed.original;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(PREFIX)) continue;
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "null");
      if (
        value?.actorId !== lease.actorId ||
        value?.householdId !== lease.householdId
      )
        continue;
      if (value.data?.id === removed.entityId) value.data = original;
      else if (Array.isArray(value.data?.items)) {
        const index = value.data.items.findIndex(
          (item: { id: string }) => item.id === removed.entityId,
        );
        if (index >= 0) {
          if (original) value.data.items[index] = original;
          else value.data.items.splice(index, 1);
        } else if (
          original &&
          key.includes(
            entityPath(removed.path).split("/").slice(0, -1).join("/"),
          ) &&
          (!key.includes("listId=") ||
            key.includes(`listId=${original.listId}`))
        )
          value.data.items.push(original);
      }
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }
  saveQueue(remaining);
}

export async function evictDeniedResource(path: string) {
  const clean = path.split("?")[0] ?? path;
  const deniedListId =
    clean === "/v1/shopping/items"
      ? new URLSearchParams(path.split("?")[1]).get("listId")
      : null;
  const id = deniedListId ?? clean.split("/").at(-1);
  if (!id) return;
  const list = !!deniedListId || clean.startsWith("/v1/shopping/lists/");
  const route = list ? `/shopping/${id}` : null;
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(PREFIX)) continue;
    try {
      const savedPath = key.slice(PREFIX.length);
      const value = JSON.parse(localStorage.getItem(key) ?? "null");
      if (
        savedPath === path ||
        savedPath === clean ||
        (list && savedPath.includes(`listId=${id}`)) ||
        value?.data?.id === id ||
        (list && value?.data?.listId === id)
      ) {
        localStorage.removeItem(key);
        continue;
      }
      if (Array.isArray(value?.data?.items)) {
        value.data.items = value.data.items.filter(
          (item: { id: string; listId?: string }) =>
            item.id !== id && (!list || item.listId !== id),
        );
        localStorage.setItem(key, JSON.stringify(value));
      }
    } catch {
      localStorage.removeItem(key);
    }
  }
  saveQueue(
    readQueue().filter(
      (command) =>
        command.entityId !== id &&
        (!list ||
          (command.body.listId !== id && command.original?.listId !== id)),
    ),
  );
  if (route && "caches" in window) {
    for (const name of await caches.keys())
      if (name.startsWith("heima-private"))
        await (await caches.open(name)).delete(new URL(route, location.origin));
    navigator.serviceWorker?.controller?.postMessage({
      type: "HEIMA_EVICT",
      path: route,
    });
  }
  announce();
}
