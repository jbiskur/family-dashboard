"use client";
import type {
  FinanceAccount,
  FinanceImport,
  FinanceTransaction,
  ImportRow,
} from "@heima/contracts";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  FileSpreadsheet,
  FileUp,
  History,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { useCommand, useHeima } from "@/lib/client";
import { EntityForm, type FormField } from "../shared/form";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionTitle,
} from "../shared/page";
import { useHousehold } from "../shared/providers";
import { Button } from "../ui/button";
import { Badge, Card } from "../ui/card";
import { Dialog } from "../ui/dialog";
import { Input, Select } from "../ui/input";
import { FinanceBoundary, FinanceNav, Money } from "./finance-shared";

type Preview = {
  fileName: string;
  sourceHash: string;
  accountId: string;
  currency: string;
  sheets: string[];
  headers: string[];
  preview: Record<string, string>[];
  rows: ImportRow[];
  errors: { row: number; message: string }[];
  mapping: Record<string, string>;
  valid: boolean;
};
type Source = {
  accountId: string;
  fileName: string;
  contentBase64: string;
  delimiter: string;
  sheet?: string;
  decimalSeparator: string;
  dateFormat: string;
};
export function ImportsPage() {
  const params = useSearchParams();
  const access = useHousehold();
  const accounts = useHeima<{ items: FinanceAccount[] }>(
    "/v1/finance/accounts",
  );
  const imports = useHeima<{ items: FinanceImport[] }>("/v1/finance/imports");
  const command = useCommand();
  const [accountId, setAccountId] = useState(params.get("accountId") ?? "");
  const [source, setSource] = useState<Source | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reading, setReading] = useState(false);
  const [validating, setValidating] = useState(false);
  const requestVersion = useRef(0);
  const renderedVersion = requestVersion.current;
  const [selected, setSelected] = useState<FinanceImport | null>(null);
  const [success, setSuccess] = useState("");
  const manageable = (accounts.data?.items ?? []).filter(
    (a) => a.visibility === "household" || a.ownerId === access.member.userId,
  );
  const chosen = accountId || manageable[0]?.id || "";
  function clearStatement() {
    const version = ++requestVersion.current;
    setSource(null);
    setPreview(null);
    setError(null);
    setSuccess("");
    setReading(false);
    setValidating(false);
    return version;
  }
  async function read(file: File) {
    // A replacement is new intent even when the chosen file is rejected.
    const version = clearStatement();
    if (!chosen) {
      setError(new Error("Choose an account before selecting a statement."));
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError(new Error("Choose a statement smaller than 10 MB."));
      return;
    }
    if (!/\.(csv|xls|xlsx)$/i.test(file.name)) {
      setError(new Error("Choose a CSV, XLS or XLSX statement."));
      return;
    }
    setReading(true);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () =>
          reject(new Error("This file could not be read."));
        reader.readAsDataURL(file);
      });
      if (version !== requestVersion.current) return;
      const input = {
        accountId: chosen,
        fileName: file.name,
        contentBase64,
        delimiter: ",",
        decimalSeparator: ".",
        dateFormat: "yyyy-MM-dd",
      };
      setSource(input);
      const result = (await command.execute(
        "/v1/finance/imports/preview",
        input,
      )) as Preview;
      if (version === requestVersion.current) setPreview(result);
    } catch (e) {
      if (version === requestVersion.current) setError(e);
    } finally {
      if (version === requestVersion.current) setReading(false);
    }
  }
  async function map(values: Record<string, string>) {
    if (
      !source ||
      reading ||
      validating ||
      source.accountId !== chosen ||
      renderedVersion !== requestVersion.current
    )
      return;
    const version = ++requestVersion.current;
    setError(null);
    setValidating(true);
    setPreview((current) =>
      current ? { ...current, valid: false, errors: [] } : null,
    );
    const mapping = Object.fromEntries(
      Object.entries(values).filter(
        ([k, v]) =>
          [
            "bookingDate",
            "amount",
            "description",
            "sourceId",
            "transactionDate",
            "valueDate",
            "reference",
          ].includes(k) && v,
      ),
    );
    const next = {
      ...source,
      delimiter: values.delimiter ?? source.delimiter,
      sheet: values.sheet || undefined,
      decimalSeparator: values.decimalSeparator ?? source.decimalSeparator,
      dateFormat: values.dateFormat ?? source.dateFormat,
    };
    setSource(next);
    try {
      const result = (await command.execute("/v1/finance/imports/preview", {
        ...next,
        mapping,
      })) as Preview;
      if (version === requestVersion.current) setPreview(result);
    } catch (e) {
      if (version === requestVersion.current) setError(e);
    } finally {
      if (version === requestVersion.current) setValidating(false);
    }
  }
  const mappingFields: FormField[] = preview
    ? [
        ...(
          [
            "bookingDate",
            "amount",
            "description",
            "sourceId",
            "transactionDate",
            "valueDate",
            "reference",
          ] as const
        ).map((name) => ({
          name,
          label: {
            bookingDate: "Booking date",
            amount: "Signed amount",
            description: "Description",
            sourceId: "Source transaction ID",
            transactionDate: "Transaction date",
            valueDate: "Value date",
            reference: "Reference",
          }[name],
          required: ["bookingDate", "amount", "description"].includes(name),
          defaultValue: preview.mapping[name] ?? "",
          options: [
            { value: "", label: "Not supplied / choose column" },
            ...preview.headers.map((h) => ({ value: h, label: h })),
          ],
        })),
        {
          name: "delimiter",
          label: "CSV separator",
          defaultValue: source?.delimiter ?? ",",
          options: [
            { value: ",", label: "Comma" },
            { value: ";", label: "Semicolon" },
            { value: "\t", label: "Tab" },
          ],
        },
        {
          name: "decimalSeparator",
          label: "Decimal mark",
          defaultValue: source?.decimalSeparator ?? ".",
          options: [
            { value: ".", label: "Dot · 125.50" },
            { value: ",", label: "Comma · 125,50" },
          ],
        },
        {
          name: "dateFormat",
          label: "Date format",
          defaultValue: source?.dateFormat ?? "yyyy-MM-dd",
          options: [
            { value: "yyyy-MM-dd", label: "Year-month-day · 2026-09-08" },
            { value: "dd/MM/yyyy", label: "Day/month/year · 08/09/2026" },
            { value: "MM/dd/yyyy", label: "Month/day/year · 09/08/2026" },
          ],
        },
        ...(preview.sheets.length
          ? [
              {
                name: "sheet",
                label: "Worksheet",
                defaultValue: source?.sheet ?? preview.sheets[0],
                options: preview.sheets.map((s) => ({ value: s, label: s })),
              },
            ]
          : []),
      ]
    : [];
  return (
    <>
      <PageHeader
        eyebrow="FROM STATEMENT TO UNDERSTANDING"
        title="Statement imports"
        description="Import a statement. Check the details. Reconcile with confidence."
      />
      <FinanceNav />
      <FinanceBoundary>
        {success && (
          <div className="notice" role="status">
            <Check size={17} />
            {success}
          </div>
        )}
        <div className="stepper">
          <span className={!source ? "active" : ""}>
            <b>1</b>Choose a statement
          </span>
          <ArrowRight size={13} />
          <span className={source && !preview?.valid ? "active" : ""}>
            <b>2</b>Map & review
          </span>
          <ArrowRight size={13} />
          <span className={preview?.valid ? "active" : ""}>
            <b>3</b>Confirm & reconcile
          </span>
        </div>
        {error ? <ErrorState error={error} /> : null}
        <Card className="card-pad">
          <div className="form-field" style={{ marginBottom: 20 }}>
            <label htmlFor="import-account">Account for this statement</label>
            {manageable.length ? (
              <Select
                id="import-account"
                value={chosen}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  clearStatement();
                }}
              >
                {manageable.map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.name} · {a.currency}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-small muted">
                Add an account before importing.{" "}
                <Link className="text-link" href="/finance/accounts">
                  Go to Accounts
                  <ArrowRight size={13} />
                </Link>
              </p>
            )}
          </div>
          <div className="drop-zone">
            <FileUp size={32} strokeWidth={1.5} />
            <h3>
              {source ? source.fileName : "Your statement has a home here"}
            </h3>
            <p>CSV, XLS or XLSX · up to 10 MB and 1,000 source rows</p>
            <label className="button button-secondary" htmlFor="statement-file">
              <Upload size={16} />
              {source ? "Choose another file" : "Choose a statement"}
            </label>
            <Input
              id="statement-file"
              aria-label="Choose a statement file"
              type="file"
              accept=".csv,.xls,.xlsx"
              style={{ maxWidth: 280, margin: "12px auto 0" }}
              disabled={!chosen}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void read(file);
              }}
            />
            <p className="field-hint">
              Nothing becomes trusted until you review and reconcile it.
            </p>
          </div>
          {reading && <LoadingState label="Reading your statement…" />}
        </Card>
        {preview && (
          <div className="section-gap">
            <SectionTitle title="A quick look at the source" />
            <Card>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      {preview.headers.map((h) => (
                        <th key={h}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.preview.slice(0, 5).map((row, i) => (
                      /* Stable file row identity: preview is an immutable source snapshot, never reordered. */
                      // biome-ignore lint/suspicious/noArrayIndexKey: source row number is the identity of this immutable import preview
                      <tr key={i}>
                        {preview.headers.map((h) => (
                          <td key={h}>{row[h] ?? "—"}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <div className="two-columns section-gap">
              <Card className="card-pad">
                <SectionTitle title="Tell us which column is which" />
                <EntityForm
                  key={`${source?.fileName}-${preview.headers.join(",")}`}
                  fields={mappingFields}
                  submitLabel="Validate this mapping"
                  onSubmit={map}
                />
              </Card>
              <Card className="card-pad">
                <SectionTitle title="The review" />
                {validating ? (
                  <LoadingState label="Checking your mapping…" />
                ) : preview.errors.length ? (
                  <>
                    <div className="notice warning" role="alert">
                      {preview.errors.length} validation{" "}
                      {preview.errors.length === 1 ? "issue" : "issues"} to
                      resolve before confirmation.
                    </div>
                    {preview.errors.map((e) => (
                      <p className="field-error" key={`${e.row}-${e.message}`}>
                        Row {e.row}: {e.message}
                      </p>
                    ))}
                  </>
                ) : preview.valid ? (
                  <>
                    <span className="empty-icon">
                      <CheckCircle2 size={28} />
                    </span>
                    <h3 style={{ textAlign: "center" }}>
                      Ready for your confirmation
                    </h3>
                    <p
                      className="text-small muted"
                      style={{ textAlign: "center", margin: "12px 0 24px" }}
                    >
                      {preview.rows.length} source rows checked. Any uncertain
                      duplicate will still need your review.
                    </p>
                    <EntityForm
                      fields={[
                        {
                          name: "openingBalance",
                          label: "Statement opening balance (optional)",
                          placeholder: "0.00",
                        },
                        {
                          name: "closingBalance",
                          label: "Statement closing balance (optional)",
                          placeholder: "1250.50",
                        },
                      ]}
                      submitLabel="Confirm import"
                      footer="This records validated facts as needing review. Reconciliation is a separate, explicit step."
                      onSubmit={async (values) => {
                        if (
                          !source ||
                          reading ||
                          validating ||
                          !preview.valid ||
                          preview.accountId !== chosen ||
                          renderedVersion !== requestVersion.current
                        )
                          return;
                        const version = requestVersion.current;
                        const result = (await command.execute(
                          "/v1/finance/imports",
                          {
                            accountId: preview.accountId,
                            fileName: preview.fileName,
                            sourceHash: preview.sourceHash,
                            currency: preview.currency,
                            rows: preview.rows,
                            mapping: preview.mapping,
                            openingBalance: values.openingBalance || null,
                            closingBalance: values.closingBalance || null,
                          },
                        )) as FinanceImport;
                        if (version !== requestVersion.current) return;
                        setSelected(result);
                        clearStatement();
                        setSuccess(
                          "Statement imported. Review its rows and balances to finish reconciliation.",
                        );
                      }}
                    />
                  </>
                ) : (
                  <EmptyState
                    title="Map your columns first"
                    description="Map the booking date, signed amount and description, then validate the source."
                  />
                )}
              </Card>
            </div>
          </div>
        )}
        <div className="section-gap">
          <SectionTitle title="Statement history" />
          <Card>
            {imports.isPending ? (
              <LoadingState />
            ) : imports.error ? (
              <ErrorState
                error={imports.error}
                retry={() => void imports.refetch()}
              />
            ) : imports.data?.items.length ? (
              imports.data.items.map((batch) => (
                <div className="home-task import-row" key={batch.id}>
                  <span
                    className="task-symbol"
                    style={{
                      background: "var(--teal-soft)",
                      color: "var(--teal)",
                    }}
                  >
                    <FileSpreadsheet size={18} />
                  </span>
                  <div className="grow">
                    <h3>{batch.fileName}</h3>
                    <p>
                      {accounts.data?.items.find(
                        (a) => a.id === batch.accountId,
                      )?.name ?? "Account"}{" "}
                      · {batch.importedCount} imported · {batch.duplicateCount}{" "}
                      duplicates
                    </p>
                  </div>
                  <Badge
                    className={
                      batch.status === "reconciled" ? "forest" : "ochre"
                    }
                  >
                    {batch.status === "reconciled"
                      ? "Reconciled"
                      : "Needs review"}
                  </Badge>
                  <Button variant="ghost" onClick={() => setSelected(batch)}>
                    Review
                    <ArrowRight size={15} />
                  </Button>
                </div>
              ))
            ) : (
              <EmptyState
                icon={<History size={28} />}
                title="No statements imported"
                description="Your imports and their reconciliation history will appear here."
              />
            )}
          </Card>
        </div>
        {selected && (
          <ReviewImport
            key={selected.id}
            batch={selected}
            close={() => setSelected(null)}
          />
        )}
      </FinanceBoundary>
    </>
  );
}

function ReviewImport({
  batch,
  close,
}: {
  batch: FinanceImport;
  close: () => void;
}) {
  const command = useCommand();
  const transactions = useHeima<{ items: FinanceTransaction[] }>(
    `/v1/finance/transactions?accountId=${batch.accountId}`,
  );
  const [rows, setRows] = useState<ImportRow[]>(batch.rows);
  const [baseVersion] = useState(batch.version);
  const [editRow, setEditRow] = useState<ImportRow | null>(null);
  const [result, setResult] = useState<FinanceImport | null>(null);
  const [balances, setBalances] = useState({
    openingBalance: batch.openingBalance ?? "",
    closingBalance: batch.closingBalance ?? "",
  });
  const digits =
    new Intl.NumberFormat("en", {
      style: "currency",
      currency: batch.currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  const minor = (value: string) => {
    const match = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(value);
    if (!match || (match[3]?.length ?? 0) > digits) return null;
    return (
      (match[1] ? -1n : 1n) *
      (BigInt(match[2] ?? "0") * 10n ** BigInt(digits) +
        BigInt((match[3] ?? "").padEnd(digits, "0") || "0"))
    );
  };
  const decimal = (value: bigint) => {
    const sign = value < 0n ? "-" : "";
    const absolute = value < 0n ? -value : value;
    const text = absolute.toString().padStart(digits + 1, "0");
    return (
      sign +
      (digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text)
    );
  };
  const matched = rows.filter((row) => row.status === "matched");
  const matchedIds = new Set(matched.map((row) => row.transactionId));
  let matchedTotal: bigint | null = 0n;
  for (const id of matchedIds) {
    const transaction = transactions.data?.items.find((item) => item.id === id);
    const amount = transaction ? minor(transaction.amount) : null;
    if (amount === null) {
      matchedTotal = null;
      break;
    }
    matchedTotal += amount;
  }
  const opening = minor(balances.openingBalance);
  const closing = minor(balances.closingBalance);
  const difference =
    matchedTotal !== null && opening !== null && closing !== null
      ? closing - opening - matchedTotal
      : null;
  const unresolved = rows.filter(
    (r) => !["matched", "explained"].includes(r.status),
  ).length;
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => !open && close()}
        title="Make the statement add up"
        description={`${batch.fileName} · ${rows.length} source rows · ${batch.currency}`}
        wide
      >
        {result?.status === "reconciled" ? (
          <EmptyState
            icon={<CheckCircle2 size={30} />}
            title="All accounted for."
            description="Every source row is matched or explained, and the statement difference is exactly zero."
          >
            <Button onClick={close}>Back to statements</Button>
          </EmptyState>
        ) : (
          <>
            <div
              className={`notice ${unresolved ? "warning" : ""}`}
              role="status"
            >
              {unresolved
                ? `${unresolved} source rows still need a match or explanation.`
                : "Every source row is matched or explained. Check the exact balance difference below."}
            </div>
            <div
              className="table-scroll"
              style={{ maxHeight: 340, overflowY: "auto" }}
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Source row</th>
                    <th>Amount</th>
                    <th>Review</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>
                          {row.description || "Unmapped description"}
                        </strong>
                        <small>
                          {row.bookingDate || "Unmapped date"} ·{" "}
                          {row.sourceId ?? "No source ID"}
                        </small>
                        {row.explanation && <small>{row.explanation}</small>}
                      </td>
                      <td>
                        <Money value={row.amount} currency={batch.currency} />
                      </td>
                      <td>
                        <Button variant="ghost" onClick={() => setEditRow(row)}>
                          {row.status === "explained"
                            ? "explained / excluded"
                            : row.status.replaceAll("-", " ")}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <hr className="separator" />
            <div
              className={`notice ${difference !== null && difference !== 0n ? "warning" : ""}`}
              role="status"
            >
              {difference === null ? (
                "Enter valid opening and closing balances to check the difference."
              ) : (
                <span>
                  Matched transactions:{" "}
                  <Money
                    value={decimal(matchedTotal ?? 0n)}
                    currency={batch.currency}
                  />
                  . Difference:{" "}
                  <Money
                    value={decimal(difference)}
                    currency={batch.currency}
                  />
                  .
                </span>
              )}
            </div>
            <p className="field-hint">
              Closing balance − opening balance − distinct matched transactions
              must equal zero. Explained rows are excluded from the total; their
              source facts and reasons are kept.
            </p>
            <EntityForm
              onValuesChange={(values) =>
                setBalances({
                  openingBalance: values.openingBalance ?? "",
                  closingBalance: values.closingBalance ?? "",
                })
              }
              fields={[
                {
                  name: "openingBalance",
                  label: "Statement opening balance",
                  required: true,
                  defaultValue: batch.openingBalance ?? "",
                },
                {
                  name: "closingBalance",
                  label: "Statement closing balance",
                  required: true,
                  defaultValue: batch.closingBalance ?? "",
                },
              ]}
              submitLabel="Check & reconcile"
              footer="Every row needs a match or an explained/excluded disposition. Only matched ledger amounts count toward the exact zero difference. No tolerance is applied."
              onSubmit={async (values) => {
                if (unresolved)
                  throw new Error(
                    "Resolve every source row before reconciling.",
                  );
                setResult(
                  (await command.execute(
                    `/v1/finance/imports/${batch.id}/reconcile`,
                    { ...values, baseVersion, rows },
                  )) as FinanceImport,
                );
              }}
              onCancel={close}
            />
          </>
        )}
      </Dialog>
      <Dialog
        open={editRow !== null}
        onOpenChange={(open) => !open && setEditRow(null)}
        title="Review this source row"
        description="Match using source ID, amount, reference and date evidence. Keep uncertainty explicit."
      >
        {editRow && (
          <>
            <p className="confirm-copy">
              {editRow.bookingDate} · {editRow.description}
              <br />
              <Money value={editRow.amount} currency={batch.currency} />
            </p>
            <EntityForm
              fields={[
                {
                  name: "status",
                  label: "Resolution",
                  defaultValue: ["matched", "explained"].includes(
                    editRow.status,
                  )
                    ? editRow.status
                    : "matched",
                  options: [
                    { value: "matched", label: "Match to a transaction" },
                    {
                      value: "explained",
                      label: "Explain / exclude this row",
                    },
                  ],
                },
                {
                  name: "transactionId",
                  label: "Matching transaction",
                  defaultValue: editRow.transactionId ?? "",
                  options: [
                    { value: "", label: "Choose a matching transaction" },
                    ...(transactions.data?.items ?? []).map((t) => ({
                      value: t.id,
                      label: `${t.bookingDate} · ${t.description} · ${t.amount} ${t.currency}`,
                    })),
                  ],
                },
                {
                  name: "explanation",
                  label: "Explanation / evidence",
                  type: "textarea",
                  defaultValue: editRow.explanation,
                  hint: "Required for explained rows. Do not dismiss an uncertain duplicate without review.",
                },
              ]}
              submitLabel="Apply review"
              onCancel={() => setEditRow(null)}
              onSubmit={async (values) => {
                if (
                  values.status === "explained" &&
                  !values.explanation?.trim()
                )
                  throw new Error(
                    "Explain why this source row is accounted for.",
                  );
                if (values.status === "matched" && !values.transactionId)
                  throw new Error(
                    "Choose the transaction that matches this row.",
                  );
                setRows((current) =>
                  current.map((row) =>
                    row.id === editRow.id
                      ? {
                          ...row,
                          status: values.status as ImportRow["status"],
                          transactionId: values.transactionId || null,
                          explanation: values.explanation ?? "",
                        }
                      : row,
                  ),
                );
                setEditRow(null);
              }}
            />
          </>
        )}
      </Dialog>
    </>
  );
}
