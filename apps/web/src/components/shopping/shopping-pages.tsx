"use client";
import type { ShoppingItem, ShoppingList, Store } from "@heima/contracts";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Circle,
  History,
  ListChecks,
  MapPin,
  Pencil,
  Plus,
  Search,
  ShoppingBag,
  Store as StoreIcon,
  Tag,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useCommand, useHeima } from "@/lib/client";
import {
  shoppingCategory,
  shoppingCategoryChoices,
} from "@/lib/shopping-categories";
import { ActionNotice } from "../shared/action-notice";
import { CaptureComposer } from "../shared/capture-composer";
import { shoppingDetails, shoppingTitle } from "../shared/capture-fields";
import { ColourTag } from "../shared/colour-choice";
import { EntityForm } from "../shared/form";
import { HistoryDialog } from "../shared/history";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  ScopeBadge,
} from "../shared/page";
import { SwipeRow } from "../shared/swipe-row";
import { Button } from "../ui/button";
import { Badge, Card } from "../ui/card";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";

export function ShoppingPage() {
  const query = useHeima<{ items: ShoppingList[] }>("/v1/shopping/lists");
  const command = useCommand();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const lists =
    query.data?.items.filter(
      (l) =>
        (filter === "all" || l.visibility === filter) &&
        l.name.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <PageHeader
        eyebrow="THE LITTLE ESSENTIALS"
        title="Shopping lists"
        description="Household lists and private lists, ready for your next shop."
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus size={17} />
            New list
          </Button>
        }
      />
      <div className="toolbar">
        <fieldset className="pill-filter" aria-label="List visibility">
          {[
            { id: "all", label: "All lists" },
            { id: "household", label: "Household" },
            { id: "personal", label: "Just me" },
          ].map((f) => (
            <button
              type="button"
              className={filter === f.id ? "active" : ""}
              key={f.id}
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
            >
              {f.label}
            </button>
          ))}
        </fieldset>
        <Link href="/shopping/stores" className="text-link">
          <StoreIcon size={16} />
          Our stores
          <ArrowRight size={14} />
        </Link>
      </div>
      <div className="search-input" style={{ marginBottom: 22 }}>
        <Search size={16} />
        <Input
          aria-label="Find a shopping list"
          placeholder="Find a list…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : lists.length ? (
        <div className="list-grid">
          {lists.map((list) => (
            <Link
              key={list.id}
              href={`/shopping/${list.id}`}
              className="card list-card"
            >
              <span
                className="list-icon"
                style={{ background: `${list.color}18`, color: list.color }}
              >
                <ShoppingBag size={24} strokeWidth={1.5} />
              </span>
              <h2>{list.name}</h2>
              <p>
                {list.itemCount === undefined
                  ? "Ready for the next shop"
                  : `${Math.max(0, list.itemCount - (list.completedCount ?? 0))} ${list.itemCount - (list.completedCount ?? 0) === 1 ? "thing" : "things"} to pick up`}
              </p>
              <div className="list-card-footer">
                <ScopeBadge scope={list.visibility} />
                <ArrowRight size={17} />
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<ShoppingBag size={28} />}
            title={
              search
                ? "No lists with that name"
                : "Good things start with a list"
            }
            description={
              search
                ? "Try another word, or clear your search."
                : "For the weekly shop, a weekend away, or something just for you."
            }
          >
            <Button onClick={() => setCreating(true)}>
              <Plus size={16} />
              Create a list
            </Button>
          </EmptyState>
        </Card>
      )}
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New shopping list"
        description="Choose a name and who can see it."
      >
        <EntityForm
          submitLabel="Create list"
          onCancel={() => setCreating(false)}
          fields={[
            {
              name: "name",
              label: "List name",
              required: true,
              placeholder: "The weekly shop",
            },
            {
              name: "visibility",
              label: "Who can see it?",
              defaultValue: "household",
              options: [
                {
                  value: "household",
                  label: "Household · shared with your spouse",
                },
                { value: "personal", label: "Just me · only you" },
              ],
            },
            {
              name: "color",
              label: "A little colour",
              defaultValue: "#A3422B",
              options: [
                { value: "#A3422B", label: "Warm clay" },
                { value: "#28594B", label: "Forest green" },
                { value: "#755412", label: "Golden oat" },
                { value: "#236863", label: "Sea glass" },
              ],
            },
          ]}
          onSubmit={async (values) => {
            const result = (await command.execute(
              "/v1/shopping/lists",
              values,
            )) as ShoppingList;
            setCreating(false);
            window.location.assign(`/shopping/${result.id}`);
          }}
        />
      </Dialog>
    </>
  );
}

export function ShoppingDetailPage({ id }: { id: string }) {
  const listQuery = useHeima<ShoppingList>(`/v1/shopping/lists/${id}`);
  const itemsQuery = useHeima<{ items: ShoppingItem[] }>(
    `/v1/shopping/items?listId=${id}`,
  );
  const itemHistory = useHeima<{ items: ShoppingItem[] }>(
    `/v1/shopping/items?listId=${id}&includeArchived=true`,
  );
  const storesQuery = useHeima<{ items: Store[] }>(
    "/v1/shopping/stores?includeArchived=true",
  );
  const command = useCommand();
  const [editing, setEditing] = useState<ShoppingItem | "new" | null>(null);
  const [history, setHistory] = useState<ShoppingItem | null>(null);
  const [tab, setTab] = useState("active");
  const [scope, setScope] = useState(false);
  const [removing, setRemoving] = useState<ShoppingItem | null>(null);
  const [purchase, setPurchase] = useState<ShoppingItem | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [geoStatus, setGeoStatus] = useState("");
  const [notice, setNotice] = useState("");
  const [undoStack, setUndoStack] = useState<ShoppingItem[]>([]);
  const undo = notice.includes("sync queue") ? undefined : undoStack.at(-1);
  const list = listQuery.data;
  const historicalStores = storesQuery.data?.items ?? [];
  const stores = historicalStores.filter((store) => !store.archived);
  const all = itemsQuery.data?.items ?? [];
  const items = all
    .filter((item) => (tab === "completed" ? item.completed : !item.completed))
    .sort((a, b) => a.position - b.position);
  const update = async (item: ShoppingItem, changes: Record<string, unknown>) =>
    command.execute(`/v1/shopping/items/${item.id}`, {
      baseVersion: item.version,
      ...changes,
    }) as Promise<ShoppingItem>;
  async function complete(item: ShoppingItem) {
    const result = await update(item, { completed: !item.completed });
    if ("pending" in result && result.pending) {
      setNotice(`${item.name} added to this device’s sync queue.`);
      return;
    }
    setUndoStack((previous) => [
      ...previous.filter((entry) => entry.id !== item.id),
      result,
    ]);
    setNotice(
      item.completed ? "Back on your list." : "One less thing to pick up.",
    );
  }
  async function move(item: ShoppingItem, target: number) {
    const ordered = all
      .filter((i) => !i.completed)
      .sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((i) => i.id === item.id);
    ordered.splice(index, 1);
    ordered.splice(Math.max(0, Math.min(target, ordered.length)), 0, item);
    for (const [position, current] of ordered.entries())
      if (current.position !== position) await update(current, { position });
  }
  async function locate() {
    setGeoStatus("Finding nearby stores…");
    if (!navigator.geolocation) {
      setGeoStatus("Location isn't available. Choose a store below.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nearby = stores
          .filter((s) => s.latitude !== null && s.longitude !== null)
          .filter((s) => {
            if (s.latitude === null || s.longitude === null) return false;
            const rad = Math.PI / 180;
            const a =
              Math.sin(((s.latitude - position.coords.latitude) * rad) / 2) **
                2 +
              Math.cos(position.coords.latitude * rad) *
                Math.cos(s.latitude * rad) *
                Math.sin(
                  ((s.longitude - position.coords.longitude) * rad) / 2,
                ) **
                  2;
            return (
              6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <=
              s.radius
            );
          });
        if (nearby.length === 1 && nearby[0]) {
          setSuggestion(nearby[0].id);
          setGeoStatus(
            `Nearby: ${nearby[0].name}. Confirm below to record it.`,
          );
        } else {
          setSuggestion(null);
          setGeoStatus(
            nearby.length
              ? "More than one nearby store. Choose the right one below."
              : "No nearby store found. You can choose one below.",
          );
        }
      },
      () =>
        setGeoStatus(
          "Location wasn't available. You can still choose a store or skip.",
        ),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 },
    );
  }
  if (listQuery.isPending) return <LoadingState />;
  if (listQuery.error || !list)
    return (
      <ErrorState
        error={listQuery.error}
        retry={() => void listQuery.refetch()}
      />
    );
  return (
    <>
      <Link className="text-link" href="/shopping">
        <ArrowLeft size={15} />
        All shopping lists
      </Link>
      <PageHeader
        eyebrow="A LITTLE LESS TO REMEMBER"
        title={list.name}
        description="Pick it up. Check it off. Keep the day moving."
      />
      <CaptureComposer
        choices={[
          {
            id: "shopping",
            label: "Shopping",
            icon: ShoppingBag,
            title: {
              ...shoppingTitle,
              history: (values) => ({
                names: (itemHistory.error
                  ? []
                  : (itemHistory.data?.items ?? [])
                )
                  .filter(
                    (item) =>
                      !values.category || item.category === values.category,
                  )
                  .map((item) => item.name),
                loading: itemHistory.isPending,
                unavailable: !!itemHistory.error,
              }),
            },
            destination: (
              <span>
                {list.name} ·{" "}
                {list.visibility === "personal" ? "Just me" : "Household"}
              </span>
            ),
            details: shoppingDetails(
              stores.map((store) => ({ value: store.id, label: store.name })),
            ),
            onSubmit: (values) =>
              command.execute("/v1/shopping/items", {
                ...values,
                listId: id,
                offerStoreId: values.offerStoreId || null,
                position: all.length,
              }),
          },
        ]}
      />
      <div className="toolbar">
        <div className="pill-filter">
          <button
            type="button"
            className={tab === "active" ? "active" : ""}
            aria-pressed={tab === "active"}
            onClick={() => setTab("active")}
          >
            To pick up{" "}
            <span className="count">
              {all.filter((i) => !i.completed).length}
            </span>
          </button>
          <button
            type="button"
            className={tab === "completed" ? "active" : ""}
            aria-pressed={tab === "completed"}
            onClick={() => setTab("completed")}
          >
            Picked up{" "}
            <span className="count">
              {all.filter((i) => i.completed).length}
            </span>
          </button>
        </div>
        <Button
          variant="ghost"
          aria-label={`Change list visibility: ${list.visibility === "personal" ? "Just me" : "Household"}`}
          onClick={() => setScope(true)}
        >
          <ScopeBadge scope={list.visibility} />
          <Pencil size={13} />
        </Button>
      </div>
      <ActionNotice
        key={`${undo?.id}-${undo?.version}-${notice}`}
        message={
          undo
            ? `${undo.name}. ${undo.completed ? "One less thing to pick up." : "Back on your list."}`
            : notice
        }
        busy={command.isPending}
        undoLabel={undo ? `Undo ${undo.name}` : undefined}
        onUndo={
          undo
            ? async () => {
                const result = await update(undo, {
                  completed: !undo.completed,
                });
                setNotice(
                  "pending" in result && result.pending
                    ? "Undo added to this device’s sync queue."
                    : "Undone.",
                );
                if (undo) setUndoStack((previous) => previous.slice(0, -1));
              }
            : undefined
        }
        secondary={
          undo?.completed && stores.length
            ? {
                label: "Add store",
                onClick: () => {
                  setPurchase(all.find((item) => item.id === undo.id) ?? undo);
                  setSuggestion(null);
                  setGeoStatus("");
                },
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
      <Card>
        <div className="list-detail-header">
          <span className="list-icon">
            <ShoppingBag size={23} />
          </span>
          <div>
            <h2>
              {tab === "completed" ? "The things we picked up" : "On the list"}
            </h2>
            <p className="text-small muted">
              {list.visibility === "personal"
                ? "A list just for you"
                : "Both of you can lend a hand"}
            </p>
          </div>
          <span className="count" style={{ marginLeft: "auto" }}>
            {items.length}
          </span>
        </div>
        {itemsQuery.isPending ? (
          <LoadingState />
        ) : itemsQuery.error ? (
          <ErrorState
            error={itemsQuery.error}
            retry={() => void itemsQuery.refetch()}
          />
        ) : items.length ? (
          items.map((item, index) => (
            <SwipeRow
              key={item.id}
              itemName={item.name}
              actionLabel={item.completed ? "Reopen" : "Complete"}
              onAction={() => complete(item)}
              onEdit={() => setEditing(item)}
              disabled={command.isPending}
            >
              <div className="shopping-row">
                <button
                  type="button"
                  className={`check-button ${item.completed ? "completed" : ""}`}
                  aria-label={`${item.completed ? "Reopen" : "Complete"} ${item.name}`}
                  disabled={command.isPending}
                  onClick={() => void complete(item).catch(() => {})}
                >
                  {item.completed ? (
                    <CheckCircle2 size={24} />
                  ) : (
                    <Circle size={24} strokeWidth={1.4} />
                  )}
                </button>
                <div className="shopping-item-main">
                  <h3 className={item.completed ? "completed-text" : ""}>
                    {item.name}
                    {item.quantity && (
                      <span
                        className="muted"
                        style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}
                      >
                        · {item.quantity}
                      </span>
                    )}
                  </h3>
                  {item.note && <p>{item.note}</p>}
                  <div className="item-tags">
                    {item.category && (
                      <ColourTag choice={shoppingCategory(item.category)} />
                    )}
                    {item.offerStoreId && (
                      <Badge className="clay">
                        <Tag size={10} />
                        Offer ·{" "}
                        {historicalStores.find(
                          (s) => s.id === item.offerStoreId,
                        )?.name ?? "Archived store"}
                      </Badge>
                    )}
                    {item.purchaseStoreId && (
                      <Badge className="forest">
                        <MapPin size={10} />
                        {historicalStores.find(
                          (s) => s.id === item.purchaseStoreId,
                        )?.name ?? "Archived store"}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="item-actions">
                  {!item.completed && (
                    <div className="row hide-mobile" style={{ gap: 0 }}>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={index === 0 || command.isPending}
                        aria-label={`Move ${item.name} up`}
                        onClick={() => void move(item, index - 1)}
                      >
                        <ArrowUp size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={
                          index === items.length - 1 || command.isPending
                        }
                        aria-label={`Move ${item.name} down`}
                        onClick={() => void move(item, index + 1)}
                      >
                        <ArrowDown size={15} />
                      </Button>
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`History of ${item.name}`}
                    onClick={() => setHistory(item)}
                  >
                    <History size={16} />
                  </Button>
                </div>
              </div>
            </SwipeRow>
          ))
        ) : (
          <EmptyState
            icon={<ListChecks size={27} />}
            title={
              tab === "completed"
                ? "The good kind of empty"
                : "What do we need?"
            }
            description={
              tab === "completed"
                ? "Completed items keep their story here. You can always reopen them."
                : "Add your first item. Your future self will thank you."
            }
          ></EmptyState>
        )}
      </Card>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing === "new" ? "What do we need?" : "Edit item"}
        description="A name is enough. Add the details that help."
      >
        {editing && (
          <>
            <EntityForm
              key={editing === "new" ? "new" : editing.id}
              fields={[
                {
                  name: "name",
                  label: "Item",
                  required: true,
                  defaultValue: editing === "new" ? "" : editing.name,
                  placeholder: "Fresh bread",
                },
                {
                  name: "quantity",
                  label: "Quantity or amount",
                  defaultValue: editing === "new" ? "" : editing.quantity,
                  placeholder: "2 loaves",
                },
                {
                  name: "category",
                  label: "Category",
                  defaultValue: editing === "new" ? "" : editing.category,
                  colourChoices: shoppingCategoryChoices(
                    editing === "new" ? "" : editing.category,
                  ),
                },
                {
                  name: "note",
                  label: "A note",
                  type: "textarea",
                  defaultValue: editing === "new" ? "" : editing.note,
                  placeholder: "The one everyone likes",
                },
                {
                  name: "offerStoreId",
                  searchable: true,
                  label: "Store offer",
                  defaultValue:
                    editing === "new" ? "" : (editing.offerStoreId ?? ""),
                  options: [
                    { value: "", label: "No store offer" },
                    ...stores.map((s) => ({ value: s.id, label: s.name })),
                  ],
                },
              ]}
              submitLabel={editing === "new" ? "Add to list" : "Save changes"}
              onCancel={() => setEditing(null)}
              onSubmit={async (values) => {
                if (editing === "new")
                  await command.execute("/v1/shopping/items", {
                    ...values,
                    listId: id,
                    offerStoreId: values.offerStoreId || null,
                    position: all.length,
                  });
                else
                  await update(editing, {
                    ...values,
                    offerStoreId: values.offerStoreId || null,
                  });
                setEditing(null);
              }}
            />
            {editing !== "new" && (
              <>
                <hr className="separator" />
                <div className="row wrap">
                  {!editing.completed && (
                    <>
                      <Button
                        variant="secondary"
                        onClick={async () => {
                          await move(editing, 0);
                          setEditing(null);
                        }}
                      >
                        <ArrowUp size={15} />
                        Move to top
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={async () => {
                          await move(editing, all.length);
                          setEditing(null);
                        }}
                      >
                        <ArrowDown size={15} />
                        Move to bottom
                      </Button>
                    </>
                  )}
                  {editing.completed && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setPurchase(editing);
                        setEditing(null);
                      }}
                    >
                      Purchase store
                    </Button>
                  )}
                  <Button
                    variant="destructive"
                    onClick={() => {
                      setRemoving(editing);
                      setEditing(null);
                    }}
                  >
                    <Trash2 size={15} />
                    Remove item
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </Dialog>
      <Dialog
        open={scope}
        onOpenChange={setScope}
        title={
          list.visibility === "personal"
            ? "Share this list?"
            : "Make this list personal?"
        }
        description="A change in scope includes every item and its history."
      >
        <p className="confirm-copy">
          {list.visibility === "personal"
            ? "Your spouse will be able to see and edit all current items and the full list history."
            : "This list will belong to you. Your spouse will lose access to its items and history. Earlier contributions stay attributed to the people who made them."}
        </p>
        <div className="form-actions">
          <Button variant="ghost" onClick={() => setScope(false)}>
            Keep it as it is
          </Button>
          <Button
            onClick={async () => {
              await command.execute(`/v1/shopping/lists/${id}`, {
                baseVersion: list.version,
                visibility:
                  list.visibility === "personal" ? "household" : "personal",
                confirmScope: true,
              });
              setScope(false);
            }}
          >
            Confirm change
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this item?"
        description="The item leaves the list. Its history stays."
      >
        <p className="confirm-copy">{removing?.name}</p>
        <div className="form-actions">
          <Button variant="ghost" onClick={() => setRemoving(null)}>
            Keep item
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (removing)
                await command.execute(
                  `/v1/shopping/items/${removing.id}/archive`,
                  { baseVersion: removing.version },
                );
              setRemoving(null);
            }}
          >
            Remove item
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={purchase !== null}
        onOpenChange={(open) => !open && setPurchase(null)}
        title="Where did you pick it up?"
        description="Your item is already completed. Adding a store is optional."
      >
        <Button variant="secondary" onClick={() => void locate()}>
          <MapPin size={16} />
          Suggest a nearby store
        </Button>
        {geoStatus && (
          <p className="field-hint" role="status">
            {geoStatus}
          </p>
        )}
        {purchase && (
          <div style={{ marginTop: 20 }}>
            <EntityForm
              key={suggestion ?? purchase.id}
              submitLabel="Save store"
              fields={[
                {
                  name: "purchaseStoreId",
                  searchable: true,
                  label: "Store",
                  defaultValue: suggestion ?? purchase.purchaseStoreId ?? "",
                  options: [
                    { value: "", label: "No store / clear attribution" },
                    ...stores.map((s) => ({ value: s.id, label: s.name })),
                  ],
                },
              ]}
              onCancel={() => setPurchase(null)}
              onSubmit={async (values) => {
                await update(purchase, {
                  purchaseStoreId: values.purchaseStoreId || null,
                });
                setPurchase(null);
              }}
            />
          </div>
        )}
        <p className="field-hint">
          Location is used only for this suggestion. Coordinates are never
          saved.
        </p>
      </Dialog>
      {history && (
        <HistoryDialog
          path={`/v1/shopping/items/${history.id}`}
          open={!!history}
          onOpenChange={(open) => !open && setHistory(null)}
        />
      )}
    </>
  );
}

export function StoresPage() {
  const query = useHeima<{ items: Store[] }>("/v1/shopping/stores");
  const command = useCommand();
  const [editing, setEditing] = useState<Store | "new" | null>(null);
  const [archive, setArchive] = useState<Store | null>(null);
  const [search, setSearch] = useState("");
  const stores =
    query.data?.items.filter((s) =>
      s.name.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <Link href="/shopping" className="text-link">
        <ArrowLeft size={15} />
        Back to Shopping
      </Link>
      <PageHeader
        eyebrow="FAMILIAR PLACES"
        title="Stores"
        description="Tag store offers and record where items were purchased."
        action={
          <Button onClick={() => setEditing("new")}>
            <Plus size={16} />
            Add store
          </Button>
        }
      />
      <div className="search-input" style={{ marginBottom: 22 }}>
        <Search size={16} />
        <Input
          aria-label="Find a store"
          placeholder="Find a store…"
          disabled={query.isPending}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : stores.length ? (
        <div className="list-grid">
          {stores.map((store) => (
            <Card key={store.id} className="card-pad">
              <span
                className="list-icon"
                style={{ background: `${store.color}18`, color: store.color }}
              >
                <StoreIcon size={24} />
              </span>
              <h2>{store.name}</h2>
              <p className="text-small muted" style={{ marginTop: 8 }}>
                {store.latitude === null
                  ? "Choose this store manually"
                  : `Nearby suggestions within ${store.radius} metres`}
              </p>
              <div className="form-actions">
                <Button variant="ghost" onClick={() => setEditing(store)}>
                  <Pencil size={15} />
                  Edit
                </Button>
                <Button variant="ghost" onClick={() => setArchive(store)}>
                  Archive
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<StoreIcon size={28} />}
            title="Where do you like to shop?"
            description="Add a store to tag offers and remember where you picked things up."
          >
            <Button onClick={() => setEditing("new")}>
              Add your first store
            </Button>
          </EmptyState>
        </Card>
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing === "new" ? "Add store" : "Edit store"}
        description="Location is optional. A name is a good start."
      >
        {editing && (
          <EntityForm
            fields={[
              {
                name: "name",
                label: "Store name",
                required: true,
                defaultValue: editing === "new" ? "" : editing.name,
              },
              {
                name: "color",
                label: "Colour",
                defaultValue: editing === "new" ? "#A3422B" : editing.color,
                options: [
                  { value: "#A3422B", label: "Warm clay" },
                  { value: "#28594B", label: "Forest green" },
                  { value: "#755412", label: "Golden oat" },
                  { value: "#236863", label: "Sea glass" },
                ],
              },
              {
                name: "latitude",
                label: "Latitude (optional)",
                type: "number",
                step: "any",
                min: "-90",
                max: "90",
                defaultValue:
                  editing === "new" ? "" : String(editing.latitude ?? ""),
              },
              {
                name: "longitude",
                label: "Longitude (optional)",
                type: "number",
                step: "any",
                min: "-180",
                max: "180",
                defaultValue:
                  editing === "new" ? "" : String(editing.longitude ?? ""),
              },
              {
                name: "radius",
                label: "Detection radius (metres)",
                type: "number",
                min: "100",
                max: "1000",
                defaultValue:
                  editing === "new" ? "250" : String(editing.radius),
                hint: "100–1,000 metres. Used only when you ask for a nearby suggestion.",
              },
            ]}
            onCancel={() => setEditing(null)}
            onSubmit={async (values) => {
              await command.execute(
                editing === "new"
                  ? "/v1/shopping/stores"
                  : `/v1/shopping/stores/${editing.id}`,
                {
                  ...values,
                  ...(editing === "new"
                    ? {}
                    : { baseVersion: editing.version }),
                  latitude: values.latitude ? Number(values.latitude) : null,
                  longitude: values.longitude ? Number(values.longitude) : null,
                  radius: Number(values.radius),
                },
              );
              setEditing(null);
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={archive !== null}
        onOpenChange={(open) => !open && setArchive(null)}
        title="Archive this store?"
        description="It leaves active choices. Past offers and purchases keep their history."
      >
        <p className="confirm-copy">{archive?.name}</p>
        <div className="form-actions">
          <Button variant="ghost" onClick={() => setArchive(null)}>
            Keep store
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (archive)
                await command.execute(
                  `/v1/shopping/stores/${archive.id}/archive`,
                  { baseVersion: archive.version },
                );
              setArchive(null);
            }}
          >
            Archive store
          </Button>
        </div>
      </Dialog>
    </>
  );
}
