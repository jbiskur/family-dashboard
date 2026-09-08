"use client";
import { useQueryClient } from "@tanstack/react-query";
import { CloudCheck, CloudOff } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { emitEvent } from "@/lib/actions";
import {
  discardQueued,
  entityPath,
  getLease,
  lastSyncTime,
  type OfflineLease,
  purgeOffline,
  type QueuedCommand,
  readQueue,
  saveLease,
  saveQueue,
} from "@/lib/offline";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";

type Conflict = {
  path: string;
  body: Record<string, unknown>;
  original: Record<string, unknown> | null;
  current: Record<string, unknown>;
  commandId?: string;
};
const fields: Record<string, string> = {
  name: "Name",
  title: "Title",
  quantity: "Quantity",
  note: "Note",
  completed: "Picked up",
  status: "Status",
  dueDate: "Due date",
  dueTime: "Due time",
  position: "Order",
  archived: "Removed",
  visibility: "Visibility",
  assigneeId: "Assigned to",
  category: "Category",
  offerStoreId: "Store offer",
  purchaseStoreId: "Purchase store",
  amount: "Amount",
  currency: "Currency",
  bookingDate: "Booking date",
  description: "Description",
  shared: "Account shared",
  categoryId: "Category",
  reason: "Reason",
  month: "Budget month",
};
function Values({
  value,
  keys,
  nameFor,
}: {
  value: Record<string, unknown> | null | undefined;
  keys: string[];
  nameFor: (id: unknown) => string;
}) {
  return (
    <dl className="sync-values">
      {Object.entries(fields)
        .filter(([key]) => keys.includes(key))
        .map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>
              {typeof value?.[key] === "boolean"
                ? value[key]
                  ? "Yes"
                  : "No"
                : key.endsWith("Id") && value?.[key]
                  ? nameFor(value[key])
                  : String(value?.[key] ?? "Not set")}
            </dd>
          </div>
        ))}
    </dl>
  );
}
export function SyncManager({
  lease,
  children,
}: {
  lease: OfflineLease;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const [online, setOnline] = useState(true);
  const [expired, setExpired] = useState(false);
  const [queue, setQueue] = useState<QueuedCommand[]>([]);
  const [open, setOpen] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [lastSync, setLastSync] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    if (!synced) return;
    const timer = setTimeout(() => setSynced(false), 5000);
    return () => clearTimeout(timer);
  }, [synced]);
  const [conflictError, setConflictError] = useState("");
  const processing = useRef(false);
  const reportingFailure = useRef(false);
  const sessionChanged = useRef(false);
  useEffect(() => {
    let expiryTimer: ReturnType<typeof setTimeout>;
    const existing = getLease();
    if (
      !navigator.onLine &&
      existing &&
      (existing.actorId !== lease.actorId ||
        existing.householdId !== lease.householdId)
    ) {
      sessionChanged.current = true;
      client.clear();
      setExpired(true);
      return;
    }
    if (sessionChanged.current) return;
    saveLease(lease);
    const update = () => {
      if (sessionChanged.current) return;
      setOnline(navigator.onLine);
      setQueue(readQueue());
      setLastSync(lastSyncTime());
      setExpired(!getLease());
      clearTimeout(expiryTimer);
      const active = getLease();
      if (active)
        expiryTimer = setTimeout(
          () => {
            purgeOffline(lease.actorId);
            client.clear();
            setExpired(true);
          },
          Math.max(0, active.expiresAt - Date.now()),
        );
    };
    update();
    const onStorage = (event: StorageEvent) => {
      if (!event.key?.startsWith("heima-offline-")) return;
      const current = getLease();
      if (
        !current ||
        current.actorId !== lease.actorId ||
        current.householdId !== lease.householdId
      ) {
        sessionChanged.current = true;
        clearTimeout(expiryTimer);
        client.clear();
        setQueue([]);
        setExpired(true);
      } else update();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    window.addEventListener("heima-offline-change", update);
    const onConflict = (event: Event) =>
      setConflict((event as CustomEvent<Conflict>).detail);
    window.addEventListener("heima-conflict", onConflict);
    let renewing = false;
    const timer = setInterval(async () => {
      if (sessionChanged.current) return;
      if (!getLease()) {
        purgeOffline(lease.actorId);
        client.clear();
        setExpired(true);
      }
      if (!navigator.onLine || renewing) return;
      renewing = true;
      try {
        const response = await fetch("/api/offline-lease", {
          cache: "no-store",
          headers: { "x-heima-actor-id": lease.actorId },
        });
        if (response.ok) {
          const renewed = await response.json();
          if (
            renewed.actorId !== lease.actorId ||
            renewed.householdId !== lease.householdId
          ) {
            sessionChanged.current = true;
            purgeOffline(lease.actorId);
            client.clear();
            setExpired(true);
            return;
          }
          saveLease({
            actorId: renewed.actorId,
            householdId: renewed.householdId,
            expiresAt: renewed.expiresAt,
          });
        } else if (response.status === 401 || response.status === 403) {
          sessionChanged.current = true;
          purgeOffline(lease.actorId);
          client.clear();
          setExpired(true);
        }
      } catch {
      } finally {
        renewing = false;
      }
    }, 15000);
    return () => {
      clearInterval(timer);
      clearTimeout(expiryTimer);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      window.removeEventListener("heima-offline-change", update);
      window.removeEventListener("heima-conflict", onConflict);
    };
  }, [lease, client]);
  useEffect(() => {
    const timer = setInterval(async () => {
      if (
        sessionChanged.current ||
        processing.current ||
        !navigator.onLine ||
        !getLease()
      )
        return;
      const currentLease = getLease();
      if (
        currentLease?.actorId !== lease.actorId ||
        currentLease?.householdId !== lease.householdId
      ) {
        client.clear();
        setExpired(true);
        return;
      }
      const all = readQueue();
      const blocked = new Set<string>();
      const next = all.find((item) => {
        if (blocked.has(item.entityId)) return false;
        blocked.add(item.entityId);
        return item.state === "pending" && item.nextAttemptAt <= Date.now();
      });
      if (!next) return;
      processing.current = true;
      setBusy(true);
      try {
        const result = await emitEvent(next.path, next.body, next.actorId);
        const latest = readQueue();
        const current = latest.find(
          (item) => item.commandId === next.commandId,
        );
        if (!current) return;
        if (result.ok) {
          const remaining = latest.filter(
            (item) => item.commandId !== next.commandId,
          );
          saveQueue(remaining);
          if (!remaining.length) setSynced(true);
          await client.invalidateQueries({ queryKey: ["heima"] });
        } else if (result.error.status === 401 || result.error.status === 403) {
          purgeOffline(lease.actorId);
          client.clear();
        } else {
          current.attempts++;
          current.message = result.error.message;
          if (result.error.code === "version-conflict") {
            const response = await fetch(
              `/api/backend/${entityPath(next.path).replace(/^\/v1\//, "")}`,
              {
                cache: "no-store",
                headers: { "x-heima-actor-id": next.actorId },
              },
            );
            if (response.status === 401 || response.status === 403) {
              purgeOffline(lease.actorId);
              client.clear();
              return;
            }
            current.state = "conflict";
            if (response.ok) current.current = await response.json();
          } else if (result.error.status >= 500) {
            current.state = current.attempts >= 5 ? "error" : "pending";
            current.nextAttemptAt =
              Date.now() + Math.min(30000, 1000 * 2 ** current.attempts);
          } else current.state = "error";
          saveQueue(latest);
        }
      } catch {
        const latest = readQueue();
        const item = latest.find((item) => item.commandId === next.commandId);
        if (item) {
          item.attempts++;
          item.state = item.attempts >= 5 ? "error" : "pending";
          item.message =
            "Connection interrupted. Your change is still saved on this device.";
          item.nextAttemptAt =
            Date.now() + Math.min(30000, 1000 * 2 ** item.attempts);
          saveQueue(latest);
        }
      } finally {
        processing.current = false;
        setBusy(false);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [client, lease.actorId, lease.householdId]);
  useEffect(() => {
    const timer = setInterval(async () => {
      const active = getLease();
      if (
        sessionChanged.current ||
        reportingFailure.current ||
        !navigator.onLine ||
        active?.actorId !== lease.actorId ||
        active?.householdId !== lease.householdId
      )
        return;
      const failed = readQueue().find((item) => {
        if (item.state === "pending") return false;
        const report = item.failureReport;
        return (
          !report ||
          report.commandId !== item.commandId ||
          (!report.complete &&
            report.attempts < 5 &&
            report.nextAttemptAt <= Date.now())
        );
      });
      if (!failed) return;
      const area = failed.path.startsWith("/v1/shopping/")
        ? "shopping"
        : failed.path.startsWith("/v1/work/")
          ? "work"
          : null;
      if (!area) return;
      reportingFailure.current = true;
      let complete = false;
      try {
        const result = await emitEvent(
          "/v1/activity/sync-failures",
          {
            failedCommandId: failed.commandId,
            area,
            resourceId: failed.entityId,
          },
          failed.actorId,
        );
        if (
          !result.ok &&
          (result.error.status === 401 || result.error.status === 403)
        ) {
          purgeOffline(lease.actorId);
          client.clear();
          return;
        }
        complete = result.ok;
        if (complete) void client.invalidateQueries({ queryKey: ["heima"] });
      } catch {
        // Activity is best effort; it never holds up the saved change queue.
      } finally {
        reportingFailure.current = false;
        const currentLease = getLease();
        if (
          currentLease?.actorId === lease.actorId &&
          currentLease?.householdId === lease.householdId
        ) {
          const latest = readQueue();
          const current = latest.find(
            (item) => item.commandId === failed.commandId,
          );
          if (current) {
            const previous = current.failureReport;
            const attempts =
              (previous?.commandId === current.commandId
                ? previous.attempts
                : 0) + 1;
            current.failureReport = {
              commandId: current.commandId,
              attempts,
              nextAttemptAt: Date.now() + Math.min(30000, 1000 * 2 ** attempts),
              complete,
            };
            try {
              saveQueue(latest);
            } catch {
              // Server idempotency also protects a report after storage failure.
            }
          }
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [client, lease.actorId, lease.householdId]);
  async function discard(id: string) {
    discardQueued(id);
    await client.invalidateQueries({ queryKey: ["heima"] });
  }
  async function reapply() {
    if (!conflict || !navigator.onLine) return;
    const body = {
      ...conflict.body,
      commandId: crypto.randomUUID(),
      baseVersion: conflict.current.version,
    };
    if (conflict.commandId) {
      const list = readQueue();
      const item = list.find((i) => i.commandId === conflict.commandId);
      if (item) {
        item.commandId = body.commandId;
        item.body = body;
        item.baseVersion = Number(body.baseVersion);
        item.state = "pending";
        item.attempts = 0;
        item.nextAttemptAt = 0;
        item.original = conflict.current;
        saveQueue(list);
      }
    } else {
      const result = await emitEvent(conflict.path, body, lease.actorId);
      if (!result.ok) throw new Error(result.error.message);
      await client.invalidateQueries({ queryKey: ["heima"] });
    }
    setConflict(null);
  }
  const local = conflict ? { ...conflict.original, ...conflict.body } : null;
  const changedKeys = Object.keys(fields).filter(
    (key) =>
      conflict &&
      (((key === "name" || key === "title") &&
        (key in (conflict.original ?? {}) ||
          key in conflict.body ||
          key in conflict.current)) ||
        JSON.stringify(conflict.original?.[key]) !==
          JSON.stringify(local?.[key]) ||
        JSON.stringify(conflict.original?.[key]) !==
          JSON.stringify(conflict.current[key])),
  );
  const nameFor = (id: unknown) => {
    if (id === lease.actorId) return "You";
    for (const [, data] of client.getQueriesData({ queryKey: ["heima"] })) {
      const row = (
        data as { items?: { id: string; name?: string }[] } | undefined
      )?.items?.find((row) => row.id === id);
      if (row?.name) return row.name;
    }
    return String(id);
  };
  if (expired)
    return (
      <main className="access-page">
        <h1>Reconnect to continue</h1>
        <p>
          Your household session needs to be checked before showing saved
          information.
        </p>
        <Button asChild>
          <a href="/">Reconnect & sign in</a>
        </Button>
      </main>
    );
  return (
    <>
      {children}
      {(!online || queue.length > 0 || synced) && (
        <div className="sync-tray" role="status">
          {online ? <CloudCheck size={16} /> : <CloudOff size={16} />}
          <span>
            {!online
              ? `Offline · saved on this device${lastSync ? ` · Last synced ${new Date(lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`
              : busy
                ? "Syncing changes…"
                : synced && !queue.length
                  ? "All changes synced"
                  : `${queue.length} change${queue.length === 1 ? "" : "s"} waiting`}
          </span>
          <Button
            size="compact"
            variant="secondary"
            onClick={() => setOpen(true)}
          >
            Review sync
          </Button>
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Saved changes"
        description="Shopping and Work changes stay on this device until confirmed by your household."
      >
        {lastSync && (
          <p className="text-small muted">
            Last synced {new Date(lastSync).toLocaleString()}
          </p>
        )}
        {queue.length ? (
          queue.map((item) => (
            <article className="sync-item" key={item.commandId}>
              <strong>
                {String(
                  item.body.title ??
                    item.body.name ??
                    item.original?.title ??
                    item.original?.name ??
                    "Saved change",
                )}
              </strong>
              <p>
                {item.state === "conflict"
                  ? "Changed elsewhere — compare before continuing"
                  : (item.message ?? "Waiting to sync")}
              </p>
              <small>{new Date(item.createdAt).toLocaleString()}</small>
              <div className="form-actions">
                {item.current && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setOpen(false);
                      setTimeout(
                        () =>
                          setConflict({
                            path: item.path,
                            body: item.body,
                            original: item.original,
                            current: item.current ?? {},
                            commandId: item.commandId,
                          }),
                        0,
                      );
                    }}
                  >
                    Compare changes
                  </Button>
                )}
                <Button
                  variant="ghost"
                  onClick={() => void discard(item.commandId)}
                >
                  Discard change
                </Button>
                {item.state === "error" && (
                  <Button
                    onClick={() => {
                      saveQueue(
                        readQueue().map((i) =>
                          i.commandId === item.commandId
                            ? {
                                ...i,
                                state: "pending",
                                attempts: 0,
                                nextAttemptAt: 0,
                              }
                            : i,
                        ),
                      );
                    }}
                  >
                    Retry
                  </Button>
                )}
              </div>
            </article>
          ))
        ) : (
          <p>Everything is synced.</p>
        )}
      </Dialog>
      <Dialog
        open={!!conflict}
        onOpenChange={(value) => !value && setConflict(null)}
        title="Compare changes"
        description="Someone changed this item after you opened it. Choose whether to apply your change to the current version."
      >
        {conflict && (
          <>
            {conflictError && (
              <p className="field-error" role="alert">
                {conflictError}
              </p>
            )}
            <div className="conflict-grid">
              <section>
                <h3>When you opened it</h3>
                <Values
                  value={conflict.original}
                  keys={changedKeys}
                  nameFor={nameFor}
                />
              </section>
              <section>
                <h3>Your change</h3>
                <Values value={local} keys={changedKeys} nameFor={nameFor} />
              </section>
              <section>
                <h3>Current household version</h3>
                <Values
                  value={conflict.current}
                  keys={changedKeys}
                  nameFor={nameFor}
                />
              </section>
            </div>
            <div className="form-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  if (conflict.commandId) void discard(conflict.commandId);
                  setConflict(null);
                }}
              >
                Discard my change
              </Button>
              <Button
                disabled={!online}
                onClick={() => {
                  setConflictError("");
                  void reapply().catch((error) =>
                    setConflictError(
                      error instanceof Error
                        ? error.message
                        : "Could not apply your change. Try again.",
                    ),
                  );
                }}
              >
                Apply to current version
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
