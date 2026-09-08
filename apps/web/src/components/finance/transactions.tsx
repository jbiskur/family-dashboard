"use client";
import type {
  FinanceAccount,
  FinanceCategory,
  FinanceTransaction,
} from "@heima/contracts";
import { ArrowRight, FileText, History, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useCommand, useHeima } from "@/lib/client";
import { EntityForm } from "../shared/form";
import { HistoryDialog } from "../shared/history";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from "../shared/page";
import { useHousehold } from "../shared/providers";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Dialog } from "../ui/dialog";
import { Input, Select } from "../ui/input";
import {
  FinanceBoundary,
  FinanceNav,
  Money,
  PeriodControls,
} from "./finance-shared";

export function TransactionsPage() {
  const params = useSearchParams();
  const router = useRouter();
  const access = useHousehold();
  const query = useHeima<{ items: FinanceTransaction[] }>(
    `/v1/finance/transactions?${params}`,
  );
  const accounts = useHeima<{ items: FinanceAccount[] }>(
    "/v1/finance/accounts",
  );
  const categories = useHeima<{ items: FinanceCategory[] }>(
    "/v1/finance/categories",
  );
  const command = useCommand();
  const [creating, setCreating] = useState(params.get("new") === "true");
  const [selectedId, setSelectedId] = useState<string | null>(
    params.get("transactionId"),
  );
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const selectedAccount = params.get("accountId") ?? "";
  const items = query.data?.items ?? [];
  const selected = items.find((t) => t.id === selectedId);
  const manageable = (accounts.data?.items ?? []).filter(
    (a) => a.visibility === "household" || a.ownerId === access.member.userId,
  );
  const account = accounts.data?.items.find(
    (a) => a.id === selected?.accountId,
  );
  const mayEdit =
    account &&
    (account.visibility === "household" ||
      account.ownerId === access.member.userId);
  const categoryOptions = [
    { value: "", label: "Uncategorized" },
    ...(categories.data?.items ?? []).map((c) => ({
      value: c.id,
      label: c.name,
    })),
  ];
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("transactionId");
    router.replace(`/finance/transactions?${next}`);
  }
  const fields = (t?: FinanceTransaction) => [
    {
      name: "accountId",
      label: "Account",
      required: true,
      defaultValue: t?.accountId ?? (selectedAccount || manageable[0]?.id),
      options: manageable.map((a) => ({
        value: a.id,
        label: `${a.name} · ${a.currency}`,
      })),
    },
    {
      name: "description",
      label: "Description",
      required: true,
      defaultValue: t?.description ?? "",
    },
    {
      name: "amount",
      label: "Signed amount",
      required: true,
      defaultValue: t?.amount ?? "",
      placeholder: "-125.50",
      hint: "Money out is negative. Money in is positive. Exact decimal values only.",
    },
    {
      name: "currency",
      label: "Original currency",
      required: true,
      defaultValue:
        t?.currency ??
        accounts.data?.items.find((a) => a.id === selectedAccount)?.currency ??
        "DKK",
    },
    {
      name: "bookingDate",
      label: "Booking date",
      type: "date",
      required: true,
      defaultValue: t?.bookingDate ?? new Date().toISOString().slice(0, 10),
    },
    {
      name: "role",
      label: "Transaction role",
      defaultValue: t?.role ?? "adjustment",
      options: [
        { value: "income", label: "Income" },
        { value: "spending", label: "Spending" },
        {
          value: "transfer",
          label: "Transfer · excluded from income/spending",
        },
        { value: "refund", label: "Refund · reduces booked spending" },
        { value: "adjustment", label: "Adjustment / opening balance" },
      ],
    },
    {
      name: "categoryId",
      label: "Category",
      defaultValue: t?.categoryId ?? "",
      options: categoryOptions,
    },
    {
      name: "reference",
      label: "Reference (optional)",
      defaultValue: t?.reference ?? "",
    },
    {
      name: "linkedTransactionId",
      label: "Linked refund or transfer transaction",
      defaultValue: t?.linkedTransactionId ?? "",
      options: [
        { value: "", label: "No linked transaction" },
        ...items
          .filter((i) => i.id !== t?.id)
          .map((i) => ({
            value: i.id,
            label: `${i.bookingDate} · ${i.description} · ${i.amount} ${i.currency}`,
          })),
      ],
    },
    {
      name: "reason",
      label: t ? "Reason for this correction" : "Why is this entered manually?",
      required: true,
      defaultValue: "",
      placeholder: "Opening balance, missing row, or correction",
    },
    {
      name: "reportingRate",
      label: "Rate to household reporting currency (if different)",
      defaultValue: t?.reportingRate ?? "",
      placeholder: "Exact conversion rate, e.g. 7.46",
    },
    {
      name: "reportingRateDate",
      label: "Rate date",
      type: "date",
      defaultValue: t?.reportingRateDate ?? "",
    },
  ];
  return (
    <>
      <PageHeader
        eyebrow="THE DETAIL, WITH CONTEXT"
        title="Transactions"
        description="Search account activity and review original amounts and currencies."
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} />
            Manual exception
          </Button>
        }
      />
      <FinanceNav />
      <FinanceBoundary>
        <PeriodControls />
        <div className="toolbar">
          <div className="search-input">
            <Search size={16} />
            <Input
              aria-label="Search transactions"
              value={params.get("q") ?? ""}
              placeholder="Search transactions…"
              onChange={(e) => filter("q", e.target.value)}
            />
          </div>
          <div className="row wrap">
            <Select
              aria-label="Filter account"
              style={{ width: "auto", maxWidth: 200 }}
              value={params.get("accountId") ?? ""}
              onChange={(e) => filter("accountId", e.target.value)}
            >
              <option value="">All visible accounts</option>
              {accounts.data?.items.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter category"
              style={{ width: "auto", maxWidth: 180 }}
              value={params.get("categoryId") ?? ""}
              onChange={(e) => filter("categoryId", e.target.value)}
            >
              <option value="">All categories</option>
              <option value="uncategorized">Uncategorized</option>
              {categories.data?.items.map((c) => (
                <option value={c.id} key={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter transaction role"
              style={{ width: "auto" }}
              value={params.get("role") ?? ""}
              onChange={(e) => filter("role", e.target.value)}
            >
              <option value="">All roles</option>
              {["income", "spending", "transfer", "refund", "adjustment"].map(
                (r) => (
                  <option key={r}>{r}</option>
                ),
              )}
            </Select>
            <Select
              aria-label="Filter reconciliation"
              style={{ width: "auto" }}
              value={params.get("reconciliationState") ?? ""}
              onChange={(e) => filter("reconciliationState", e.target.value)}
            >
              <option value="">All review states</option>
              <option value="needs-review">Needs review</option>
              <option value="reconciled">Reconciled</option>
            </Select>
          </div>
        </div>
        <Card>
          {query.isPending ? (
            <LoadingState />
          ) : query.error ? (
            <ErrorState
              error={query.error}
              retry={() => void query.refetch()}
            />
          ) : items.length ? (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Transaction</th>
                    <th className="hide-mobile">Account</th>
                    <th className="hide-mobile">Category / role</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <button
                          type="button"
                          className="button button-ghost"
                          style={{
                            padding: 0,
                            minHeight: 44,
                            textAlign: "left",
                            display: "block",
                            whiteSpace: "normal",
                            fontWeight: 400,
                          }}
                          onClick={() => setSelectedId(t.id)}
                        >
                          <strong>{t.description}</strong>
                          <small>
                            {t.bookingDate} · {t.reconciliationState}
                          </small>
                        </button>
                      </td>
                      <td className="hide-mobile">
                        {accounts.data?.items.find((a) => a.id === t.accountId)
                          ?.name ?? "Unavailable"}
                      </td>
                      <td className="hide-mobile">
                        <strong>
                          {categories.data?.items.find(
                            (c) => c.id === t.categoryId,
                          )?.name ?? "Uncategorized"}
                        </strong>
                        <small>
                          {t.role} · {t.source}
                        </small>
                      </td>
                      <td
                        className={
                          t.amount.startsWith("-") ? "negative" : "positive"
                        }
                      >
                        <Money value={t.amount} currency={t.currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<FileText size={28} />}
              title={
                params.size
                  ? "Nothing matches just yet"
                  : "Everyday money starts with a statement"
              }
              description={
                params.size
                  ? "Adjust your filters or choose another period."
                  : "Import and review your account activity to start building the picture."
              }
            >
              <Button variant="secondary" asChild>
                <Link href="/finance/imports">
                  Import a statement
                  <ArrowRight size={15} />
                </Link>
              </Button>
            </EmptyState>
          )}
        </Card>
        <Dialog
          open={creating}
          onOpenChange={setCreating}
          title="Add a manual exception"
          description="For opening balances, cash, missing rows and corrections."
        >
          {manageable.length ? (
            <EntityForm
              fields={fields()}
              onCancel={() => setCreating(false)}
              submitLabel="Record exception"
              onSubmit={async (values) => {
                await command.execute("/v1/finance/transactions", {
                  ...values,
                  categoryId: values.categoryId || null,
                  linkedTransactionId: values.linkedTransactionId || null,
                  reportingRate: values.reportingRate || null,
                  reportingRateDate: values.reportingRateDate || null,
                });
                setCreating(false);
              }}
            />
          ) : (
            <EmptyState
              title="An account comes first"
              description="Add a joint or personal account before recording a financial fact."
            >
              <Button asChild>
                <Link href="/finance/accounts">Add an account</Link>
              </Button>
            </EmptyState>
          )}
        </Dialog>
        <Dialog
          open={selectedId !== null}
          onOpenChange={(open) => !open && setSelectedId(null)}
          title={selected?.description ?? "Transaction unavailable"}
          description="The original facts, with their full provenance."
        >
          {selected ? (
            <>
              <div className="metric-value">
                <Money value={selected.amount} currency={selected.currency} />
              </div>
              <div className="details-grid" style={{ margin: "20px 0" }}>
                {[
                  { label: "Account", value: account?.name ?? "Unavailable" },
                  { label: "Booking date", value: selected.bookingDate },
                  {
                    label: "Transaction date",
                    value: selected.transactionDate ?? "Not supplied",
                  },
                  {
                    label: "Value date",
                    value: selected.valueDate ?? "Not supplied",
                  },
                  { label: "Role", value: selected.role },
                  {
                    label: "Category",
                    value:
                      categories.data?.items.find(
                        (c) => c.id === selected.categoryId,
                      )?.name ?? "Uncategorized",
                  },
                  { label: "Source", value: selected.source },
                  {
                    label: "Review state",
                    value: selected.reconciliationState,
                  },
                  {
                    label: "Reference",
                    value: selected.reference || "Not supplied",
                  },
                  {
                    label: "Rate / rate date",
                    value: selected.reportingRate
                      ? `${selected.reportingRate} · ${selected.reportingRateDate ?? "Date missing"}`
                      : "Not supplied",
                  },
                ].map((f) => (
                  <div key={f.label}>
                    <p className="detail-label">{f.label}</p>
                    <p className="detail-value">{f.value}</p>
                  </div>
                ))}
              </div>
              {selected.reason && (
                <p className="field-hint">Recorded reason: {selected.reason}</p>
              )}
              <p
                className="text-tiny muted"
                style={{ overflowWrap: "anywhere", marginTop: 14 }}
              >
                Transaction {selected.id}
              </p>
              <div className="form-actions">
                <Button variant="secondary" onClick={() => setHistory(true)}>
                  <History size={15} />
                  History
                </Button>
                {mayEdit && (
                  <Button onClick={() => setEditing(true)}>
                    Classify or correct
                  </Button>
                )}
              </div>
            </>
          ) : (
            <EmptyState
              title="This transaction isn't available"
              description="Your access or the current filter may have changed."
            />
          )}
        </Dialog>
        {selected && (
          <>
            <HistoryDialog
              path={`/v1/finance/transactions/${selected.id}`}
              open={history}
              onOpenChange={setHistory}
            />
            <Dialog
              open={editing}
              onOpenChange={setEditing}
              title="Classify or correct"
              description="A reason and new recorded fact preserve the earlier history."
            >
              <EntityForm
                fields={fields(selected)}
                onCancel={() => setEditing(false)}
                submitLabel="Record correction"
                onSubmit={async (values) => {
                  const corrected = [
                    "amount",
                    "currency",
                    "bookingDate",
                    "description",
                    "accountId",
                  ].some(
                    (key) =>
                      String(values[key]) !==
                      String(selected[key as keyof FinanceTransaction]),
                  );
                  const result = (await command.execute(
                    corrected
                      ? "/v1/finance/transactions"
                      : `/v1/finance/transactions/${selected.id}`,
                    {
                      ...values,
                      ...(corrected
                        ? {
                            source: "manual",
                            supersedesId: selected.id,
                            transactionDate: selected.transactionDate,
                            valueDate: selected.valueDate,
                            sourceId: selected.sourceId,
                          }
                        : { baseVersion: selected.version }),
                      categoryId: values.categoryId || null,
                      linkedTransactionId: values.linkedTransactionId || null,
                      reportingRate: values.reportingRate || null,
                      reportingRateDate: values.reportingRateDate || null,
                    },
                  )) as { id?: string };
                  if (corrected && result?.id) setSelectedId(result.id);
                  setEditing(false);
                }}
              />
            </Dialog>
          </>
        )}
      </FinanceBoundary>
    </>
  );
}
