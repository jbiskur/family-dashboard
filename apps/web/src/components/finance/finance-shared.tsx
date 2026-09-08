"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { OfflineState } from "../shared/page";
import { Input, Select } from "../ui/input";

export function FinanceNav() {
  const path = usePathname();
  return (
    <nav className="finance-nav" aria-label="Finance navigation">
      {[
        { path: "/finance", label: "Overview" },
        { path: "/finance/accounts", label: "Accounts" },
        { path: "/finance/transactions", label: "Transactions" },
        { path: "/finance/spending", label: "Spending" },
        { path: "/finance/budgets", label: "Budgets" },
        { path: "/finance/imports", label: "Imports" },
      ].map((link) => (
        <Link
          key={link.path}
          href={link.path}
          className={
            (
              link.path === "/finance"
                ? path === link.path
                : path.startsWith(link.path)
            )
              ? "active"
              : ""
          }
          aria-current={
            (
              link.path === "/finance"
                ? path === link.path
                : path.startsWith(link.path)
            )
              ? "page"
              : undefined
          }
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
export function FinanceBoundary({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online ? children : <OfflineState />;
}
export function money(value: string | null | undefined, currency = "DKK") {
  if (value === null || value === undefined) return "Unavailable";
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return "Unavailable";
  const digits =
    new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  const fraction = (match[3] ?? "").padEnd(digits, "0");
  return `${match[1]}${BigInt(match[2] ?? "0").toLocaleString("en-GB")}${fraction ? `.${fraction}` : ""} ${currency}`;
}
export function Money({
  value,
  currency = "DKK",
}: {
  value: string | null | undefined;
  currency?: string;
}) {
  return <span className="money">{money(value, currency)}</span>;
}
export function usePeriod() {
  const params = useSearchParams();
  const query = new URLSearchParams();
  for (const key of ["from", "to", "comparison"]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  return query.toString();
}
export function PeriodControls() {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const current =
    params.get("from")?.slice(0, 7) ??
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      timeZone: "Atlantic/Faroe",
    }).format(new Date());
  const [mode, setMode] = useState("month");
  function range(month: string, unit: string) {
    const [y = new Date().getFullYear(), m = 1] = month.split("-").map(Number);
    const startMonth =
      unit === "year"
        ? 0
        : unit === "quarter"
          ? Math.floor((m - 1) / 3) * 3
          : m - 1;
    const from = new Date(Date.UTC(y, startMonth, 1))
      .toISOString()
      .slice(0, 10);
    const to = new Date(
      Date.UTC(
        y,
        startMonth + (unit === "year" ? 12 : unit === "quarter" ? 3 : 1),
        0,
      ),
    )
      .toISOString()
      .slice(0, 10);
    const next = new URLSearchParams(params);
    next.set("from", from);
    next.set("to", to);
    router.push(`${path}?${next}`);
  }
  function set(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`${path}?${next}`);
  }
  return (
    <div className="toolbar">
      <div className="row wrap">
        <Select
          aria-label="Reporting period"
          value={mode}
          style={{ width: "auto" }}
          onChange={(e) => {
            setMode(e.target.value);
            if (e.target.value !== "custom") range(current, e.target.value);
          }}
        >
          <option value="month">Month</option>
          <option value="quarter">Quarter</option>
          <option value="year">Year</option>
          <option value="custom">Custom dates</option>
        </Select>
        {mode !== "custom" ? (
          <Input
            type="month"
            aria-label="Select month"
            className="finance-period"
            value={current}
            onChange={(e) => e.target.value && range(e.target.value, mode)}
          />
        ) : (
          <>
            <Input
              type="date"
              aria-label="Period start"
              className="finance-period"
              value={params.get("from") ?? ""}
              onChange={(e) => set("from", e.target.value)}
            />
            <span className="muted">to</span>
            <Input
              type="date"
              aria-label="Period end"
              className="finance-period"
              value={params.get("to") ?? ""}
              onChange={(e) => set("to", e.target.value)}
            />
          </>
        )}
      </div>
      <Select
        aria-label="Compare with"
        style={{ width: "auto", maxWidth: "100%" }}
        value={params.get("comparison") ?? ""}
        onChange={(e) => set("comparison", e.target.value)}
      >
        <option value="">No comparison</option>
        <option value="previous-period">Previous period</option>
        <option value="previous-year">Previous year</option>
      </Select>
    </div>
  );
}
