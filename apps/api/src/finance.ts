import type { FinanceOverview, ImportRow } from "@heima/contracts";
import { Temporal } from "@js-temporal/polyfill";
import {
  decimal,
  minor,
  type ResourceRow,
  TIMEZONE,
  toReporting,
} from "./domain";
import { ApiFailure } from "./errors";

export function period(query: Record<string, string>) {
  const today = Temporal.Now.plainDateISO(TIMEZONE);
  try {
    let from = today.with({ day: 1 });
    let to = from.add({ months: 1 }).subtract({ days: 1 });
    if (query.month) {
      from = Temporal.PlainDate.from(`${query.month}-01`);
      to = from.add({ months: 1 }).subtract({ days: 1 });
    }
    if (query.period === "year") {
      from = from.with({ month: 1, day: 1 });
      to = from.add({ years: 1 }).subtract({ days: 1 });
    }
    if (query.period === "quarter") {
      from = from.with({
        month: Math.floor((from.month - 1) / 3) * 3 + 1,
        day: 1,
      });
      to = from.add({ months: 3 }).subtract({ days: 1 });
    }
    if (query.from || query.to) {
      if (!query.from || !query.to) throw new Error();
      from = Temporal.PlainDate.from(query.from);
      to = Temporal.PlainDate.from(query.to);
    }
    if (Temporal.PlainDate.compare(from, to) > 0 || from.until(to).days > 3660)
      throw new Error();
    return { from: from.toString(), to: to.toString() };
  } catch {
    throw new ApiFailure("invalid-period", 400, "Choose a valid date range.");
  }
}
export function trustedTransactions(all: ResourceRow[]) {
  const superseded = new Set(
    all
      .filter((r) => r.kind === "finance/transactions" && r.data.supersedesId)
      .map((r) => r.data.supersedesId),
  );
  return all.filter(
    (r) =>
      r.kind === "finance/transactions" &&
      r.archived === "false" &&
      r.data.reconciliationState === "reconciled" &&
      !superseded.has(r.id),
  );
}
export function accountBalance(account: ResourceRow, all: ResourceRow[]) {
  const txs = trustedTransactions(all).filter(
    (r) => r.data.accountId === account.id,
  );
  const statements = all
    .filter(
      (r) =>
        r.kind === "finance/imports" &&
        r.data.accountId === account.id &&
        r.data.status === "reconciled" &&
        r.data.openingBalance !== null,
    )
    .sort((a, b) =>
      String((a.data.rows as ImportRow[])[0]?.bookingDate).localeCompare(
        String((b.data.rows as ImportRow[])[0]?.bookingDate),
      ),
    );
  if (!txs.length && !statements.length) return null;
  const opening = statements[0]
    ? minor(
        String(statements[0].data.openingBalance),
        String(account.data.currency),
      )
    : 0n;
  return decimal(
    txs.reduce(
      (sum, r) => sum + minor(String(r.data.amount), String(r.data.currency)),
      opening,
    ),
    String(account.data.currency),
  );
}
function financialRole(
  row: ResourceRow,
  value: bigint,
): { income: bigint; spending: bigint } {
  const absolute = value < 0n ? -value : value;
  if (row.data.role === "income") return { income: absolute, spending: 0n };
  if (row.data.role === "spending") return { income: 0n, spending: absolute };
  if (row.data.role === "refund") return { income: 0n, spending: -absolute };
  if (row.data.role === "adjustment" && row.data.categoryId)
    return { income: 0n, spending: -value };
  return { income: 0n, spending: 0n };
}
export function financeOverview(
  all: ResourceRow[],
  query: Record<string, string>,
  budgetMode = false,
): FinanceOverview {
  const range = period(query);
  const allTrusted = trustedTransactions(all);
  const selected = allTrusted.filter(
    (r) =>
      String(r.data.bookingDate) >= range.from &&
      String(r.data.bookingDate) <= range.to,
  );
  let income = 0n,
    spending = 0n,
    balance = 0n;
  let incomplete = all.some(
    (r) =>
      r.kind === "finance/imports" &&
      r.archived === "false" &&
      r.data.status !== "reconciled",
  );
  const categories = new Map<string | null, bigint>();
  const budgetActuals = new Map<string | null, bigint>();
  const trend = new Map<string, { income: bigint; spending: bigint }>();
  for (const row of allTrusted) {
    const value = toReporting(
      String(row.data.amount),
      String(row.data.currency),
      row.data.reportingRate as string | null,
      row.data.reportingRateDate as string | null,
    );
    if (value === null) {
      incomplete = true;
      continue;
    }
    balance += value;
    if (!selected.includes(row)) continue;
    const budgetAmounts =
      row.data.role === "adjustment"
        ? { income: 0n, spending: 0n }
        : financialRole(row, value);
    budgetActuals.set(
      row.data.categoryId as string | null,
      (budgetActuals.get(row.data.categoryId as string | null) ?? 0n) +
        budgetAmounts.spending,
    );
    const amounts = budgetMode ? budgetAmounts : financialRole(row, value);
    income += amounts.income;
    spending += amounts.spending;
    if (amounts.spending !== 0n)
      categories.set(
        row.data.categoryId as string | null,
        (categories.get(row.data.categoryId as string | null) ?? 0n) +
          amounts.spending,
      );
    const day = String(row.data.bookingDate);
    const current = trend.get(day) ?? { income: 0n, spending: 0n };
    trend.set(day, {
      income: current.income + amounts.income,
      spending: current.spending + amounts.spending,
    });
  }
  let hasOpening = false;
  for (const account of all.filter((r) => r.kind === "finance/accounts")) {
    const statements = all
      .filter(
        (r) =>
          r.kind === "finance/imports" &&
          r.data.accountId === account.id &&
          r.data.status === "reconciled" &&
          r.data.openingBalance !== null,
      )
      .sort((a, b) =>
        String((a.data.rows as ImportRow[])[0]?.bookingDate).localeCompare(
          String((b.data.rows as ImportRow[])[0]?.bookingDate),
        ),
      );
    const statement = statements[0];
    if (!statement) continue;
    hasOpening = true;
    const first = allTrusted.find(
      (r) =>
        r.data.accountId === account.id &&
        r.data.reportingRate &&
        r.data.reportingRateDate,
    );
    const opening = toReporting(
      String(statement.data.openingBalance),
      String(account.data.currency),
      first?.data.reportingRate as string | null,
      first?.data.reportingRateDate as string | null,
    );
    if (opening === null) {
      if (
        minor(
          String(statement.data.openingBalance),
          String(account.data.currency),
        ) !== 0n
      )
        incomplete = true;
    } else balance += opening;
  }
  const month = range.from.slice(0, 7);
  const monthlyRange =
    range.from.endsWith("-01") &&
    Temporal.PlainDate.from(range.from)
      .add({ months: 1 })
      .subtract({ days: 1 })
      .toString() === range.to;
  const budgets = monthlyRange
    ? all.filter(
        (r) =>
          r.kind === "finance/budgets" &&
          r.archived === "false" &&
          r.data.month === month,
      )
    : [];
  const categoryRows = all.filter((r) => r.kind === "finance/categories");
  for (const budget of budgets)
    if (!categories.has(String(budget.data.categoryId)))
      categories.set(String(budget.data.categoryId), 0n);
  const totals = [...categories].map(([categoryId, actual]) => {
    const budget = budgets.find((r) => r.data.categoryId === categoryId);
    const planned = budget ? minor(String(budget.data.amount), "DKK") : null;
    return {
      categoryId,
      name:
        (categoryRows.find((r) => r.id === categoryId)?.data.name as string) ??
        "Uncategorized",
      actual: decimal(actual, "DKK"),
      budget: planned === null ? null : decimal(planned, "DKK"),
      remaining: planned === null ? null : decimal(planned - actual, "DKK"),
    };
  });
  const result: FinanceOverview = {
    currency: "DKK",
    ...range,
    balance: allTrusted.length || hasOpening ? decimal(balance, "DKK") : null,
    income: selected.length ? decimal(income, "DKK") : null,
    spending: selected.length ? decimal(spending, "DKK") : null,
    netCashFlow: selected.length ? decimal(income - spending, "DKK") : null,
    savingsRate:
      income === 0n
        ? null
        : decimal(((income - spending) * 10000n) / income, "DKK"),
    budgetRemaining: budgets.length
      ? decimal(
          budgets.reduce(
            (sum, r) => sum + minor(String(r.data.amount), "DKK"),
            0n,
          ) -
            budgets.reduce(
              (sum, r) =>
                sum + (budgetActuals.get(String(r.data.categoryId)) ?? 0n),
              0n,
            ),
          "DKK",
        )
      : null,
    incomplete,
    categories: totals,
    trend: [...trend]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({
        date,
        income: decimal(value.income, "DKK"),
        spending: decimal(value.spending, "DKK"),
      })),
  };
  if (
    query.comparison === "previous-period" ||
    query.comparison === "previous-year"
  ) {
    const start = Temporal.PlainDate.from(range.from);
    const end = Temporal.PlainDate.from(range.to);
    const days = start.until(end).days + 1;
    const comparison = financeOverview(all, {
      from:
        query.comparison === "previous-year"
          ? start.subtract({ years: 1 }).toString()
          : start.subtract({ days }).toString(),
      to:
        query.comparison === "previous-year"
          ? end.subtract({ years: 1 }).toString()
          : start.subtract({ days: 1 }).toString(),
    });
    result.comparison = {
      from: comparison.from,
      to: comparison.to,
      income: comparison.income,
      spending: comparison.spending,
      netCashFlow: comparison.netCashFlow,
    };
  }
  return result;
}
