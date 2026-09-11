"use client";
import type { HouseholdProfile, WorkItem } from "@heima/contracts";
import {
  ArrowRight,
  CalendarDays,
  Check,
  History,
  ListTodo,
  Pencil,
  Play,
  Repeat2,
  Search,
  SkipForward,
  Trash2,
  UserRound,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useCommand, useHeima } from "@/lib/client";
import { memberLabel } from "@/lib/member-label";
import { ActionNotice } from "../shared/action-notice";
import { CaptureComposer } from "../shared/capture-composer";
import { workAudience, workDetails, workTitle } from "../shared/capture-fields";
import { EntityForm } from "../shared/form";
import { HistoryDialog } from "../shared/history";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  ScopeBadge,
} from "../shared/page";
import { useHousehold } from "../shared/providers";
import { SwipeRow } from "../shared/swipe-row";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";

const statuses = [
  { value: "todo", label: "To do", icon: ListTodo },
  { value: "doing", label: "In progress", icon: Play },
  { value: "done", label: "Done", icon: Check },
] as const;
export function WorkPage() {
  const query = useHeima<{ items: WorkItem[] }>("/v1/work/items");
  const profiles = useHeima<{ items: HouseholdProfile[] }>(
    "/v1/household/profiles?includeArchived=true&context=work",
  );
  const access = useHousehold();
  const command = useCommand();
  const searchParams = useSearchParams();
  const [editing, setEditing] = useState<WorkItem | "new" | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    searchParams.get("item"),
  );
  const [history, setHistory] = useState(false);
  const [series, setSeries] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [removedItem, setRemovedItem] = useState<WorkItem | null>(null);
  const removedQuery = useHeima<{ items: WorkItem[] }>(
    "/v1/work/items?includeArchived=true",
  );
  const [scope, setScope] = useState(false);
  const [remove, setRemove] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [notice, setNotice] = useState("");
  const [undoStack, setUndoStack] = useState<
    {
      item: WorkItem;
      status: WorkItem["status"];
    }[]
  >([]);
  const undo = notice.includes("sync queue") ? undefined : undoStack.at(-1);
  const items = query.data?.items ?? [];
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const assignees = [
    { value: "", label: "Anyone can help" },
    ...access.members
      .filter((m) => m.status === "active")
      .map((m) => ({
        value: m.userId,
        label: m.userId === access.member.userId ? "Me" : memberLabel(m),
      })),
    ...(profiles.data?.items ?? [])
      .filter((p) => !p.archived)
      .map((p) => ({ value: p.id, label: p.name })),
  ];
  const name = (id: string | null) =>
    assignees.find((a) => a.value === (id ?? ""))?.label ??
    profiles.data?.items.find((p) => p.id === id)?.name ??
    "Assignee unavailable";
  const filtered = items.filter(
    (i) =>
      (filter === "all" ||
        (filter === "mine" && i.assigneeId === access.member.userId) ||
        filter === i.visibility) &&
      `${i.title} ${i.note}`.toLowerCase().includes(search.toLowerCase()),
  );
  async function update(item: WorkItem, changes: Record<string, unknown>) {
    return (await command.execute(`/v1/work/items/${item.id}`, {
      baseVersion: item.version,
      ...changes,
    })) as WorkItem;
  }
  function close() {
    setSelectedId(null);
    setHistory(false);
    setScope(false);
    setRemove(false);
    setSeries(false);
    if (searchParams.has("item"))
      window.history.replaceState(null, "", "/work");
  }
  async function changeStatus(item: WorkItem, status: WorkItem["status"]) {
    const result = await update(item, { status });
    if ("pending" in result && result.pending) {
      setNotice(`${item.title} added to this device’s sync queue.`);
      return;
    }
    setUndoStack((previous) => [
      ...previous.filter((entry) => entry.item.id !== item.id),
      { item: result, status: item.status },
    ]);
    setNotice(
      status === "done"
        ? item.recurrence
          ? "Done. Undo reopens this task; the next occurrence remains."
          : "Done. That's one less thing."
        : "The task is updated.",
    );
  }
  return (
    <>
      <PageHeader
        eyebrow="WORK"
        title="Household work"
        description="Plan tasks, share the work, and keep track of what is done."
      />
      <CaptureComposer
        choices={[
          {
            id: "work",
            label: "To-do",
            icon: ListTodo,
            title: {
              ...workTitle,
              history: (values) => ({
                names: (removedQuery.error
                  ? []
                  : (removedQuery.data?.items ?? [])
                )
                  .filter((item) => item.visibility === values.visibility)
                  .map((item) => item.title),
                loading: removedQuery.isPending,
                unavailable: !!removedQuery.error,
              }),
            },
            context: [workAudience],
            details: workDetails(assignees),
            onSubmit: (values) => {
              const { recurrenceUnit, recurrenceInterval, ...rest } = values;
              return command.execute("/v1/work/items", {
                ...rest,
                assigneeId: rest.assigneeId || null,
                dueDate: rest.dueDate || null,
                dueTime: rest.dueTime || null,
                recurrence: recurrenceUnit
                  ? {
                      unit: recurrenceUnit,
                      interval: Number(recurrenceInterval),
                    }
                  : null,
              });
            },
          },
        ]}
      />
      <div className="toolbar">
        <fieldset className="pill-filter" aria-label="Work scope">
          {[
            { value: "all", label: "Everything" },
            { value: "mine", label: "Assigned to me" },
            { value: "household", label: "Household" },
            { value: "personal", label: "Just me" },
          ].map((f) => (
            <button
              key={f.value}
              type="button"
              className={filter === f.value ? "active" : ""}
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </fieldset>
        <Button variant="ghost" onClick={() => setRemoved(true)}>
          <History size={15} />
          Removed work
        </Button>
        <div className="search-input">
          <Search size={16} />
          <Input
            aria-label="Find a task"
            placeholder="Find a to-do…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <ActionNotice
        key={`${undo?.item.id}-${undo?.item.version}-${notice}`}
        message={
          undo
            ? `${undo.item.title}. ${undo.item.status === "done" && undo.item.recurrence ? "Undo reopens this task; the next occurrence remains." : "The task is updated."}`
            : notice
        }
        busy={command.isPending}
        undoLabel={undo ? `Undo ${undo.item.title}` : undefined}
        onUndo={
          undo
            ? async () => {
                const result = await update(undo.item, { status: undo.status });
                if (undo) setUndoStack((previous) => previous.slice(0, -1));
                setNotice(
                  "pending" in result && result.pending
                    ? "Undo added to this device’s sync queue."
                    : "Undone.",
                );
              }
            : undefined
        }
        onDismiss={() => {
          setNotice("");
          if (undo) setUndoStack((previous) => previous.slice(0, -1));
        }}
      />
      {command.error && (
        <ErrorState
          error={command.error}
          retry={() => {
            command.reset();
            void command.refresh();
          }}
        />
      )}
      {query.isPending ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : !items.length ? (
        <Card>
          <EmptyState
            icon={<ListTodo size={28} />}
            title="No tasks yet"
            description="Add something that needs doing. Assign it, give it a date, or leave room for someone to help."
          />
        </Card>
      ) : (
        <div className="work-board">
          {statuses.map(({ value, label, icon: Icon }) => (
            <section className="work-column" key={value} aria-label={label}>
              <div className="work-column-header">
                <h2 className="row" style={{ gap: 7 }}>
                  <Icon size={15} />
                  {label}
                </h2>
                <span className="count">
                  {filtered.filter((i) => i.status === value).length}
                </span>
              </div>
              {filtered
                .filter((i) => i.status === value)
                .map((item) => (
                  <SwipeRow
                    key={item.id}
                    itemName={item.title}
                    actionLabel={item.status === "done" ? "Reopen" : "Complete"}
                    onAction={() =>
                      changeStatus(
                        item,
                        item.status === "done" ? "todo" : "done",
                      )
                    }
                    onEdit={() => setEditing(item)}
                    disabled={command.isPending}
                    allowFullSwipe={!item.recurrence}
                  >
                    <div className="card work-card">
                      <ScopeBadge scope={item.visibility} />
                      <h3 className={value === "done" ? "completed-text" : ""}>
                        {item.title}
                      </h3>
                      {item.note && (
                        <p>
                          {item.note.length > 90
                            ? `${item.note.slice(0, 90)}…`
                            : item.note}
                        </p>
                      )}
                      <div className="work-card-footer">
                        <span className="avatar">
                          <UserRound size={12} />
                        </span>
                        <span>{name(item.assigneeId)}</span>
                        {item.dueDate && (
                          <span
                            className={`row ${item.dueDate < new Date().toISOString().slice(0, 10) && value !== "done" ? "due-overdue" : ""}`}
                            style={{ gap: 4, marginLeft: "auto" }}
                          >
                            <CalendarDays size={12} />
                            {new Date(
                              `${item.dueDate}T12:00:00`,
                            ).toLocaleDateString("en-GB", {
                              day: "numeric",
                              month: "short",
                            })}
                          </span>
                        )}
                        {item.recurrence && (
                          <Repeat2 size={13} aria-label="Repeats" />
                        )}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="compact"
                        aria-label={`Details ${item.title}`}
                        onClick={() => {
                          setSelectedId(item.id);
                          window.history.replaceState(
                            null,
                            "",
                            `/work?item=${item.id}`,
                          );
                        }}
                      >
                        Details
                      </Button>
                      <Button
                        variant="ghost"
                        size="compact"
                        aria-label={`${item.status === "done" ? "Reopen" : "Complete"} ${item.title}`}
                        disabled={command.isPending}
                        onClick={() =>
                          void changeStatus(
                            item,
                            item.status === "done" ? "todo" : "done",
                          ).catch(() => {})
                        }
                      >
                        <Check size={16} />
                        {item.status === "done" ? "Reopen" : "Complete"}
                      </Button>
                    </div>
                  </SwipeRow>
                ))}
              {!filtered.some((i) => i.status === value) && (
                <p
                  className="text-small muted"
                  style={{ padding: "15px 6px 23px" }}
                >
                  {search
                    ? "No matching to-dos here."
                    : value === "done"
                      ? "Completed tasks appear here."
                      : value === "doing"
                        ? "Ready when you are."
                        : "Nothing to do here."}
                </p>
              )}
            </section>
          ))}
        </div>
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing === "new" ? "New to-do" : "Edit this occurrence"}
        description="Set a task, an assignee, and an optional due date."
      >
        {editing && (
          <EntityForm
            key={editing === "new" ? "new" : editing.id}
            fields={[
              {
                name: "title",
                label: "What needs doing?",
                required: true,
                placeholder: "Water the plants",
                defaultValue: editing === "new" ? "" : editing.title,
              },
              {
                name: "note",
                optional: true,
                label: "A helpful note",
                type: "textarea",
                defaultValue: editing === "new" ? "" : editing.note,
              },
              ...(editing === "new"
                ? [
                    {
                      name: "visibility",
                      label: "Who can see it?",
                      defaultValue: "household",
                      options: [
                        {
                          value: "household",
                          label: "Household · we can all help",
                        },
                        { value: "personal", label: "Just me · private" },
                      ],
                    },
                  ]
                : []),
              {
                name: "assigneeId",
                label: "Who's on it?",
                defaultValue:
                  editing === "new" ? "" : (editing.assigneeId ?? ""),
                options:
                  editing !== "new" &&
                  editing.assigneeId &&
                  !assignees.some((a) => a.value === editing.assigneeId)
                    ? [
                        ...assignees,
                        {
                          value: editing.assigneeId,
                          label: name(editing.assigneeId),
                        },
                      ]
                    : assignees,
                hint: "Personal to-dos can only be assigned to you.",
              },
              {
                name: "dueDate",
                label: "Due date (optional)",
                type: "date",
                defaultValue: editing === "new" ? "" : (editing.dueDate ?? ""),
              },
              {
                name: "dueTime",
                optional: true,
                label: "Time (optional)",
                type: "time",
                defaultValue: editing === "new" ? "" : (editing.dueTime ?? ""),
              },
              ...(editing === "new"
                ? [
                    {
                      name: "recurrenceUnit",
                      optional: true,
                      label: "Repeat",
                      defaultValue: "",
                      options: [
                        { value: "", label: "Just this once" },
                        { value: "day", label: "Every day" },
                        { value: "week", label: "Every week" },
                        { value: "month", label: "Every month" },
                      ],
                      hint: "Repeats follow the original due schedule, even when completed late.",
                    },
                    {
                      name: "recurrenceInterval",
                      optional: true,
                      label: "Repeat interval",
                      type: "number",
                      min: "1",
                      max: "365",
                      defaultValue: "1",
                      hint: "For example: every 2 weeks. Used only when repeating.",
                    },
                  ]
                : []),
            ]}
            onCancel={() => setEditing(null)}
            submitLabel={editing === "new" ? "Add to-do" : "Save changes"}
            onSubmit={async (values) => {
              const { recurrenceUnit, recurrenceInterval, ...rest } = values;
              const body = {
                ...rest,
                assigneeId: rest.assigneeId || null,
                dueDate: rest.dueDate || null,
                dueTime: rest.dueTime || null,
                ...(editing === "new"
                  ? {
                      recurrence: recurrenceUnit
                        ? {
                            unit: recurrenceUnit,
                            interval: Number(recurrenceInterval),
                          }
                        : null,
                    }
                  : {}),
              };
              if (editing === "new")
                await command.execute("/v1/work/items", body);
              else await update(editing, body);
              setEditing(null);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={selectedId !== null}
        onOpenChange={(open) => !open && close()}
        title={selected?.title ?? "This to-do isn't available"}
        description={
          selected
            ? "Task details and progress."
            : "It may have been removed or your access may have changed."
        }
      >
        {selected && (
          <>
            <div className="row-between">
              <ScopeBadge scope={selected.visibility} />
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(selected);
                  close();
                }}
              >
                <Pencil size={15} />
                Edit
              </Button>
            </div>
            {selected.note && (
              <p className="confirm-copy" style={{ marginTop: 14 }}>
                {selected.note}
              </p>
            )}
            <div className="details-grid" style={{ margin: "21px 0" }}>
              <div>
                <p className="detail-label">Who's on it</p>
                <p className="detail-value">{name(selected.assigneeId)}</p>
              </div>
              <div>
                <p className="detail-label">Due</p>
                <p className="detail-value">
                  {selected.dueDate ?? "No due date"}
                  {selected.dueTime ? ` · ${selected.dueTime}` : ""}
                </p>
              </div>
              <div>
                <p className="detail-label">Repeats</p>
                <p className="detail-value">
                  {selected.recurrence
                    ? `Every ${selected.recurrence.interval} ${selected.recurrence.unit}${selected.recurrence.interval === 1 ? "" : "s"}`
                    : "Just this once"}
                </p>
              </div>
              <div>
                <p className="detail-label">Status</p>
                <p className="detail-value">
                  {statuses.find((s) => s.value === selected.status)?.label}
                </p>
              </div>
            </div>
            <div className="pill-filter" style={{ display: "flex" }}>
              {statuses.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  className={selected.status === value ? "active" : ""}
                  aria-pressed={selected.status === value}
                  disabled={command.isPending}
                  onClick={() => void changeStatus(selected, value)}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
            <hr className="separator" />
            <div className="row wrap">
              <Button variant="secondary" onClick={() => setHistory(true)}>
                <History size={15} />
                History
              </Button>
              <Button variant="ghost" onClick={() => setScope(true)}>
                Change visibility
              </Button>
              {selected.status !== "done" && !selected.nextOccurrenceId && (
                <Button variant="secondary" onClick={() => setSeries(true)}>
                  <Repeat2 size={15} />
                  Edit repeating schedule
                </Button>
              )}
              {selected.recurrence && selected.status !== "done" && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    await command.execute(
                      `/v1/work/items/${selected.id}/skip`,
                      { baseVersion: selected.version },
                    );
                    setNotice(
                      "This occurrence was skipped. The schedule stays on track.",
                    );
                    close();
                  }}
                >
                  <SkipForward size={15} />
                  Skip this time
                </Button>
              )}
              <Button variant="ghost" onClick={() => setRemove(true)}>
                <Trash2 size={15} />
                Remove
              </Button>
            </div>
            {command.error && (
              <ErrorState
                error={command.error}
                retry={() => {
                  command.reset();
                  void query.refetch();
                }}
              />
            )}
          </>
        )}
      </Dialog>
      <Dialog
        open={removed}
        onOpenChange={setRemoved}
        title="Removed work"
        description="Review earlier tasks and their history without restoring them."
      >
        {removedQuery.isPending ? (
          <LoadingState />
        ) : removedQuery.error ? (
          <ErrorState
            error={removedQuery.error}
            retry={() => void removedQuery.refetch()}
          />
        ) : removedQuery.data?.items.filter((item) => item.archived).length ? (
          removedQuery.data.items
            .filter((item) => item.archived)
            .map((item) => (
              <button
                type="button"
                className="home-task"
                style={{ width: "100%", textAlign: "left" }}
                key={item.id}
                onClick={() => setRemovedItem(item)}
              >
                <History size={17} />
                <span className="grow">
                  <strong>{item.title}</strong>
                  <span
                    className="text-small muted"
                    style={{ display: "block" }}
                  >
                    {name(item.assigneeId)} · Removed
                  </span>
                </span>
                <ArrowRight size={16} />
              </button>
            ))
        ) : (
          <EmptyState
            title="No removed work"
            description="Removed tasks stay available here for reference."
          />
        )}
      </Dialog>
      {removedItem && (
        <HistoryDialog
          path={`/v1/work/items/${removedItem.id}`}
          open={!!removedItem}
          onOpenChange={(value) => !value && setRemovedItem(null)}
        />
      )}
      {selected && (
        <>
          <Dialog
            open={series}
            onOpenChange={setSeries}
            title="Edit repeating schedule"
            description="This changes the current open task and the schedule of future occurrences. Completed and skipped occurrences keep their original history."
          >
            <EntityForm
              fields={[
                {
                  name: "unit",
                  label: "Repeat",
                  defaultValue: selected.recurrence?.unit ?? "",
                  options: [
                    { value: "", label: "Stop after this occurrence" },
                    { value: "day", label: "Days" },
                    { value: "week", label: "Weeks" },
                    { value: "month", label: "Months" },
                  ],
                },
                {
                  name: "interval",
                  label: "Every",
                  type: "number",
                  min: "1",
                  max: "365",
                  defaultValue: String(selected.recurrence?.interval ?? 1),
                },
              ]}
              submitLabel="Confirm schedule change"
              onCancel={() => setSeries(false)}
              onSubmit={async (values) => {
                await update(selected, {
                  recurrence: values.unit
                    ? { unit: values.unit, interval: Number(values.interval) }
                    : null,
                  confirmSeries: true,
                });
                setSeries(false);
              }}
            />
          </Dialog>
          <HistoryDialog
            path={`/v1/work/items/${selected.id}`}
            open={history}
            onOpenChange={setHistory}
          />
          <Dialog
            open={scope}
            onOpenChange={setScope}
            title={
              selected.visibility === "personal"
                ? "Share this to-do?"
                : "Keep this one personal?"
            }
            description="Visibility changes include the complete task history."
          >
            <p className="confirm-copy">
              {selected.visibility === "personal"
                ? "Household members, including admins, will be able to see this task, its notes and history, and help make changes."
                : "You become this task's owner. Any other assignee is cleared, other household members lose access, and earlier contributions keep their attribution."}
            </p>
            <div className="form-actions">
              <Button variant="ghost" onClick={() => setScope(false)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  await update(selected, {
                    visibility:
                      selected.visibility === "personal"
                        ? "household"
                        : "personal",
                    confirmScope: true,
                  });
                  setScope(false);
                }}
              >
                Confirm visibility
              </Button>
            </div>
          </Dialog>
          <Dialog
            open={remove}
            onOpenChange={setRemove}
            title="Remove this to-do?"
            description="It leaves active work. Recorded history is preserved."
          >
            <p className="confirm-copy">{selected.title}</p>
            <div className="form-actions">
              <Button variant="ghost" onClick={() => setRemove(false)}>
                Keep it
              </Button>
              <Button
                variant="destructive"
                onClick={async () => {
                  await command.execute(
                    `/v1/work/items/${selected.id}/archive`,
                    { baseVersion: selected.version },
                  );
                  close();
                }}
              >
                Remove to-do
              </Button>
            </div>
          </Dialog>
        </>
      )}
    </>
  );
}
