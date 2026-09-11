"use client";
import type { FinanceOverview } from "@heima/contracts";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  PiggyBank,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useHeima } from "@/lib/client";
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
import { Card } from "../ui/card";
import {
  FinanceBoundary,
  FinanceNav,
  Money,
  money,
  PeriodControls,
  usePeriod,
} from "./finance-shared";

export function FinanceOverviewPage({
  spending = false,
}: {
  spending?: boolean;
}) {
  const admin = useHousehold().member.role === "admin";
  const period = usePeriod();
  const query = useHeima<FinanceOverview>(
    `/v1/finance/${spending ? "spending" : "overview"}${period ? `?${period}` : ""}`,
  );
  const data = query.data;
  return (
    <>
      <PageHeader
        eyebrow="A CLEARER PICTURE"
        title={
          spending
            ? admin
              ? "Spending overview"
              : "Household spending"
            : "Financial overview"
        }
        description={
          admin
            ? "Shared accounts and your own. Other people's private finances are excluded."
            : spending
              ? "Household spending, thoughtfully brought together."
              : "The bigger picture, without losing sight of the everyday."
        }
        action={
          <Button variant="secondary" asChild>
            <Link href="/finance/imports">
              Import a statement
              <ArrowRight size={16} />
            </Link>
          </Button>
        }
      />
      <FinanceNav />
      <FinanceBoundary>
        <PeriodControls />
        {query.isPending ? (
          <LoadingState label="Bringing your finances together…" />
        ) : query.error ? (
          <ErrorState error={query.error} retry={() => void query.refetch()} />
        ) : (
          data && (
            <>
              {data.incomplete && (
                <div className="notice warning" role="status">
                  Some values are incomplete. Review missing currency rates or
                  unreconciled imports before relying on these totals.
                </div>
              )}
              <div className="metric-grid">
                <Metric
                  label={
                    spending
                      ? admin
                        ? "Spending"
                        : "Household spending"
                      : admin
                        ? "Account balance"
                        : "Household balance"
                  }
                  value={
                    <Money
                      value={spending ? data.spending : data.balance}
                      currency={data.currency}
                    />
                  }
                  detail={
                    spending
                      ? "Refunds included · transfers excluded"
                      : admin
                        ? "Shared accounts and your own"
                        : "All household accounts combined"
                  }
                  icon={<Wallet size={18} />}
                />
                <Metric
                  label="Money in"
                  value={<Money value={data.income} currency={data.currency} />}
                  detail="Income in this period"
                  icon={<ArrowDownLeft size={18} />}
                  tone="teal"
                />
                <Metric
                  label={spending ? "Budget remaining" : "Money out"}
                  value={
                    <Money
                      value={spending ? data.budgetRemaining : data.spending}
                      currency={data.currency}
                    />
                  }
                  detail={
                    spending
                      ? "Against your category budgets"
                      : "Spending less booked refunds"
                  }
                  icon={<ArrowUpRight size={18} />}
                  tone="clay"
                />
                <Metric
                  label="Net cash flow"
                  value={
                    <Money value={data.netCashFlow} currency={data.currency} />
                  }
                  detail={
                    data.savingsRate !== null
                      ? `Savings rate · ${data.savingsRate}%`
                      : "Savings rate unavailable without income"
                  }
                  icon={<PiggyBank size={18} />}
                  tone="ochre"
                />
              </div>
              {data.balance === null &&
              data.income === null &&
              data.spending === null ? (
                <Card>
                  <EmptyState
                    icon={<ChartNoAxesCombined size={30} />}
                    title="A clearer picture starts here"
                    description="Add an account, then import and reconcile a statement. Your household totals will grow from real financial facts."
                  >
                    <div
                      className="row wrap"
                      style={{ justifyContent: "center" }}
                    >
                      <Button asChild>
                        <Link href="/finance/accounts">Add an account</Link>
                      </Button>
                      <Button asChild variant="secondary">
                        <Link href="/finance/imports">Import a statement</Link>
                      </Button>
                    </div>
                  </EmptyState>
                </Card>
              ) : (
                <div className="two-columns">
                  <Card className="card-pad">
                    <SectionTitle
                      title="Your spending rhythm"
                      href="/finance/transactions"
                      action="View transactions"
                    />
                    {data.trend.length ? (
                      <>
                        <Trend data={data} />
                        <p className="chart-caption">
                          Spending by booking date · {data.from} to {data.to}.{" "}
                          {money(data.spending, data.currency)} in total.
                        </p>
                        <details style={{ marginTop: 12 }}>
                          <summary className="text-link">
                            View chart as a table
                          </summary>
                          <div className="table-scroll">
                            <table className="data-table">
                              <thead>
                                <tr>
                                  <th>Date</th>
                                  <th>Income</th>
                                  <th>Spending</th>
                                </tr>
                              </thead>
                              <tbody>
                                {data.trend.map((t) => (
                                  <tr key={t.date}>
                                    <td>{t.date}</td>
                                    <td>
                                      <Money
                                        value={t.income}
                                        currency={data.currency}
                                      />
                                    </td>
                                    <td>
                                      <Money
                                        value={t.spending}
                                        currency={data.currency}
                                      />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </details>
                      </>
                    ) : (
                      <EmptyState
                        title="No trend for this period"
                        description="Confirmed financial facts will appear here."
                      />
                    )}
                  </Card>
                  <Card className="card-pad">
                    <SectionTitle
                      title="Spending by category"
                      href={spending ? "/finance/budgets" : "/finance/spending"}
                      action={spending ? "Budgets" : "See spending"}
                    />
                    {data.categories.length ? (
                      data.categories.map((category, index) => (
                        <Link
                          className="spending-row"
                          href={`/finance/transactions?${period}${period ? "&" : ""}categoryId=${category.categoryId ?? "uncategorized"}`}
                          key={category.categoryId ?? "uncategorized"}
                        >
                          <span
                            className="spending-swatch"
                            style={{ opacity: 1 - (index % 5) * 0.12 }}
                          />
                          <div className="grow">
                            <strong className="text-small">
                              {category.name}
                            </strong>
                            {category.budget !== null && (
                              <p className="text-tiny muted">
                                Budget · {money(category.budget, data.currency)}
                              </p>
                            )}
                          </div>
                          <strong className="text-small">
                            <Money
                              value={category.actual}
                              currency={data.currency}
                            />
                          </strong>
                          <ArrowRight size={14} />
                        </Link>
                      ))
                    ) : (
                      <EmptyState
                        title="Room for the whole picture"
                        description="Categorized spending will appear here once statements are reviewed."
                      />
                    )}
                    <p className="field-hint">
                      {admin
                        ? "Includes shared accounts and your own. Other people's private accounts do not contribute to these totals."
                        : "Includes combined household contributions. Private account details remain private."}
                    </p>
                  </Card>
                </div>
              )}
              {data.comparison && (
                <Card className="card-pad section-gap">
                  <SectionTitle title="Period comparison" />
                  <div className="three-columns">
                    <div>
                      <p className="detail-label">Previous income</p>
                      <Money
                        value={data.comparison.income}
                        currency={data.currency}
                      />
                    </div>
                    <div>
                      <p className="detail-label">Previous spending</p>
                      <Money
                        value={data.comparison.spending}
                        currency={data.currency}
                      />
                    </div>
                    <div>
                      <p className="detail-label">Previous net cash flow</p>
                      <Money
                        value={data.comparison.netCashFlow}
                        currency={data.currency}
                      />
                    </div>
                  </div>
                  <p className="field-hint">
                    Comparison period: {data.comparison.from} to{" "}
                    {data.comparison.to}
                  </p>
                </Card>
              )}
            </>
          )
        )}
      </FinanceBoundary>
    </>
  );
}
function Trend({ data }: { data: FinanceOverview }) {
  const maximum = Math.max(
    ...data.trend.map((t) => Math.abs(Number(t.spending))),
    1,
  );
  return (
    <div
      className="chart-bars"
      role="img"
      aria-label={`Spending trend from ${data.from} to ${data.to}. An accessible table follows.`}
    >
      {data.trend.slice(-16).map((t) => (
        <div className="chart-bar-group" key={t.date}>
          <div
            className="chart-bar"
            style={{
              height: `${Math.max(2, (Math.abs(Number(t.spending)) / maximum) * 135)}px`,
            }}
            title={`${t.date}: ${money(t.spending, data.currency)}`}
          />
          <span className="chart-bar-label">{t.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}
