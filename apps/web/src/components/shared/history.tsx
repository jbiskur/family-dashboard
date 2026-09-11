"use client";
import type { HistoryEntry, HouseholdProfile } from "@heima/contracts";
import { useHeima } from "@/lib/client";
import { memberLabel } from "@/lib/member-label";
import { Dialog } from "../ui/dialog";
import { EmptyState, ErrorState, LoadingState } from "./page";
import { useHousehold } from "./providers";

const labels: Record<string, string> = {
  title: "Title",
  name: "Name",
  note: "Note",
  status: "Status",
  visibility: "Visibility",
  assigneeId: "Assignee",
  dueDate: "Due date",
  dueTime: "Due time",
  recurrence: "Repeating schedule",
  completed: "Picked up",
  quantity: "Quantity",
  category: "Category",
  position: "List order",
  offerStoreId: "Store offer",
  purchaseStoreId: "Purchase store",
  archived: "Removed",
  amount: "Amount",
  currency: "Currency",
  bookingDate: "Booking date",
  transactionDate: "Transaction date",
  valueDate: "Value date",
  description: "Description",
  role: "Role",
  reference: "Reference",
  reason: "Reason",
  reconciliationState: "Review state",
  openingBalance: "Opening balance",
  closingBalance: "Closing balance",
  shared: "Account sharing",
  month: "Budget month",
  color: "Colour",
  latitude: "Latitude",
  longitude: "Longitude",
  radius: "Nearby radius",
  rows: "Statement rows",
};
export function HistoryDialog({
  path,
  open,
  onOpenChange,
}: {
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useHeima<{ items: HistoryEntry[] }>(`${path}/history`, open);
  const access = useHousehold();
  const profiles = useHeima<{ items: HouseholdProfile[] }>(
    "/v1/household/profiles?includeArchived=true",
    open,
  );
  const stores = useHeima<{ items: { id: string; name: string }[] }>(
    "/v1/shopping/stores?includeArchived=true",
    open && path.includes("shopping"),
  );
  function person(id: unknown) {
    const member = access.members.find((m) => m.userId === id);
    return id === access.member.userId
      ? "You"
      : (profiles.data?.items.find((p) => p.id === id)?.name ??
          (member ? memberLabel(member) : "Former household member"));
  }
  function show(key: string, value: unknown): string {
    if (value === null || value === undefined || value === "") return "Not set";
    if (key === "assigneeId") return person(value);
    if (key === "offerStoreId" || key === "purchaseStoreId")
      return (
        stores.data?.items.find((s) => s.id === value)?.name ??
        "Store unavailable"
      );
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (key === "recurrence" && typeof value === "object") {
      const recurrence = value as { unit: string; interval: number };
      return `Every ${recurrence.interval} ${recurrence.unit}${recurrence.interval === 1 ? "" : "s"}`;
    }
    if (Array.isArray(value)) return `${value.length} recorded rows`;
    return String(value)
      .replaceAll("needs-review", "Needs review")
      .replaceAll("todo", "To do")
      .replaceAll("doing", "In progress");
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change history"
      description="Who changed this item, when, and what changed."
    >
      {query.isPending ? (
        <LoadingState label="Loading history…" />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : query.data?.items.length ? (
        query.data.items.map((entry) => (
          <article className="history-row" key={entry.id}>
            <strong>
              {person(entry.actorId)} · {entry.action.replaceAll("-", " ")}
            </strong>
            <small>{new Date(entry.occurredAt).toLocaleString("en-GB")}</small>
            <dl className="history-diff">
              {Object.entries(labels)
                .filter(
                  ([key]) =>
                    (key in (entry.before ?? {}) ||
                      key in (entry.after ?? {})) &&
                    JSON.stringify(entry.before?.[key]) !==
                      JSON.stringify(entry.after?.[key]),
                )
                .map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>
                      {entry.before && (
                        <>
                          <span className="muted">
                            {show(key, entry.before[key])}
                          </span>
                          <span> → </span>
                        </>
                      )}
                      {show(key, entry.after?.[key])}
                    </dd>
                  </div>
                ))}
            </dl>
            <details>
              <summary className="text-link">Attribution reference</summary>
              <p className="text-tiny" style={{ overflowWrap: "anywhere" }}>
                Actor: {entry.actorId}
              </p>
            </details>
          </article>
        ))
      ) : (
        <EmptyState
          title="No changes yet"
          description="Recorded changes will appear here."
        />
      )}
    </Dialog>
  );
}
