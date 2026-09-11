"use client";
import type { FinanceAccount, FinanceTransaction } from "@heima/contracts";
import {
  ArrowLeft,
  ArrowRight,
  Landmark,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useCommand, useHeima } from "@/lib/client";
import { EntityForm } from "../shared/form";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Metric,
  PageHeader,
  SectionTitle,
} from "../shared/page";
import { useHousehold } from "../shared/providers";
import { Button } from "../ui/button";
import { Badge, Card } from "../ui/card";
import { Dialog } from "../ui/dialog";
import { FinanceBoundary, FinanceNav, Money } from "./finance-shared";

export function AccountsPage() {
  const query = useHeima<{ items: FinanceAccount[] }>("/v1/finance/accounts");
  const command = useCommand();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        eyebrow="THE PLACES YOUR MONEY LIVES"
        title="Accounts"
        description="Joint accounts together. Personal details on your terms."
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} />
            Add account
          </Button>
        }
      />
      <FinanceNav />
      <FinanceBoundary>
        {query.isPending ? (
          <LoadingState />
        ) : query.error ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : query.data?.items.length ? (
          <div className="list-grid">
            {query.data.items.map((account) => (
              <Link
                className="card list-card"
                href={`/finance/accounts/${account.id}`}
                key={account.id}
              >
                <span
                  className="list-icon"
                  style={{
                    background: "var(--teal-soft)",
                    color: "var(--teal)",
                  }}
                >
                  <Landmark size={23} />
                </span>
                <h2>{account.name}</h2>
                <p
                  className="money"
                  style={{
                    fontSize: 18,
                    marginTop: 13,
                    color: "var(--foreground)",
                  }}
                >
                  <Money value={account.balance} currency={account.currency} />
                </p>
                <div className="list-card-footer">
                  <Badge className="teal">
                    {account.visibility === "household" ? (
                      <Users size={11} />
                    ) : (
                      <LockKeyhole size={11} />
                    )}
                    {account.visibility === "household"
                      ? "Joint account"
                      : account.shared
                        ? "Personal · shared"
                        : "Personal · private"}
                  </Badge>
                  <ArrowRight size={16} />
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState
              icon={<Landmark size={29} />}
              title="Give your money a home"
              description="Add a joint or personal account. Balances come from the financial facts you import or record."
            >
              <Button onClick={() => setCreating(true)}>
                Add your first account
              </Button>
            </EmptyState>
          </Card>
        )}
        <Dialog
          open={creating}
          onOpenChange={setCreating}
          title="Add an account"
          description="Choose what to share. You stay in control of personal details."
        >
          <EntityForm
            fields={[
              {
                name: "name",
                label: "Account name",
                required: true,
                placeholder: "Everyday account",
              },
              {
                name: "currency",
                label: "Original currency",
                required: true,
                defaultValue: "DKK",
                options: [
                  { value: "DKK", label: "DKK · Danish krone" },
                  { value: "EUR", label: "EUR · Euro" },
                  { value: "GBP", label: "GBP · Pound sterling" },
                  { value: "USD", label: "USD · US dollar" },
                  { value: "NOK", label: "NOK · Norwegian krone" },
                  { value: "SEK", label: "SEK · Swedish krona" },
                  { value: "ISK", label: "ISK · Icelandic króna" },
                ],
              },
              {
                name: "visibility",
                label: "Account visibility",
                defaultValue: "household",
                options: [
                  {
                    value: "household",
                    label: "Joint · full detail for household members",
                  },
                  {
                    value: "personal",
                    label: "Personal · private detail for me",
                  },
                ],
              },
            ]}
            submitLabel="Add account"
            onCancel={() => setCreating(false)}
            footer="Personal account details stay private unless you share them. Household owners and spouses can see combined totals; admins see only shared accounts and their own."
            onSubmit={async (values) => {
              const account = (await command.execute(
                "/v1/finance/accounts",
                values,
              )) as FinanceAccount;
              setCreating(false);
              window.location.assign(`/finance/accounts/${account.id}`);
            }}
          />
        </Dialog>
      </FinanceBoundary>
    </>
  );
}
export function AccountDetailPage({ id }: { id: string }) {
  const query = useHeima<FinanceAccount>(`/v1/finance/accounts/${id}`);
  const transactions = useHeima<{ items: FinanceTransaction[] }>(
    `/v1/finance/transactions?accountId=${id}`,
  );
  const access = useHousehold();
  const command = useCommand();
  const [share, setShare] = useState(false);
  const account = query.data;
  return (
    <>
      <Link className="text-link" href="/finance/accounts">
        <ArrowLeft size={15} />
        All accounts
      </Link>
      <PageHeader
        eyebrow="A CLOSER LOOK"
        title={account?.name ?? "Account details"}
        description="Balances, activity and visibility, in one place."
      />
      <FinanceNav />
      <FinanceBoundary>
        {query.isPending ? (
          <LoadingState />
        ) : query.error || !account ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : (
          <>
            <div className="metric-grid">
              <Metric
                label="Account balance"
                value={
                  <Money value={account.balance} currency={account.currency} />
                }
                detail="As represented by recorded financial facts"
                icon={<Wallet size={18} />}
              />
              <Metric
                label="Visibility"
                value={
                  account.visibility === "household"
                    ? "Joint"
                    : account.shared
                      ? "Shared"
                      : "Private"
                }
                detail={
                  account.visibility === "household"
                    ? "Household members can see account detail"
                    : account.shared
                      ? "Explicitly shared with household members"
                      : "Account detail is private to you"
                }
                icon={<ShieldCheck size={18} />}
                tone="teal"
              />
              <Metric
                label="Original currency"
                value={account.currency}
                detail="Amounts preserve their original currency"
                icon={<Landmark size={18} />}
                tone="ochre"
              />
              <Metric
                label="Reconciliation"
                value={account.reconciliationState ?? "Not yet available"}
                detail="Statement review establishes trust"
                icon={<ShieldCheck size={18} />}
                tone="clay"
              />
            </div>
            <div className="toolbar">
              <Link
                className="text-link"
                href={`/finance/imports?accountId=${id}`}
              >
                Import or reconcile a statement
                <ArrowRight size={15} />
              </Link>
              {account.visibility === "personal" &&
                account.ownerId === access.member.userId && (
                  <Button variant="secondary" onClick={() => setShare(true)}>
                    {account.shared ? (
                      <LockKeyhole size={16} />
                    ) : (
                      <Users size={16} />
                    )}{" "}
                    {account.shared
                      ? "Make details private"
                      : "Share account details"}
                  </Button>
                )}
            </div>
            <SectionTitle
              title="Account activity"
              href={`/finance/transactions?accountId=${id}`}
            />
            <Card>
              {transactions.isPending ? (
                <LoadingState />
              ) : transactions.error ? (
                <ErrorState error={transactions.error} />
              ) : transactions.data?.items.length ? (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Transaction</th>
                        <th className="hide-mobile">Booking date</th>
                        <th>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transactions.data.items.slice(0, 10).map((t) => (
                        <tr key={t.id}>
                          <td>
                            <Link
                              href={`/finance/transactions?accountId=${id}&transactionId=${t.id}`}
                            >
                              <strong>{t.description}</strong>
                              <small>
                                {t.role} · {t.reconciliationState}
                              </small>
                            </Link>
                          </td>
                          <td className="hide-mobile">{t.bookingDate}</td>
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
                  title="No activity yet"
                  description="Import a statement or add an opening balance to begin."
                >
                  <Button asChild variant="secondary">
                    <Link
                      href={`/finance/transactions?accountId=${id}&new=true`}
                    >
                      Add a manual exception
                    </Link>
                  </Button>
                </EmptyState>
              )}
            </Card>
            <Dialog
              open={share}
              onOpenChange={setShare}
              title={
                account.shared
                  ? "Make account details private?"
                  : "Share account details?"
              }
              description="This changes access to the whole account and its transactions."
            >
              <p className="confirm-copy">
                {account.shared
                  ? "Other household members will lose access to this account's name, balance and transaction details. Household owners and spouses retain combined totals; admins see only shared accounts and their own."
                  : "Household members, including admins, will be able to see this account's name, balance and all transaction details. You remain the owner."}
              </p>
              {command.error && <ErrorState error={command.error} />}
              <div className="form-actions">
                <Button variant="ghost" onClick={() => setShare(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={async () => {
                    await command.execute(`/v1/finance/accounts/${id}`, {
                      baseVersion: account.version,
                      shared: !account.shared,
                    });
                    setShare(false);
                  }}
                >
                  Confirm {account.shared ? "privacy" : "sharing"}
                </Button>
              </div>
            </Dialog>
          </>
        )}
      </FinanceBoundary>
    </>
  );
}
