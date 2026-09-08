"use client";
import {
  AlertCircle,
  ArrowRight,
  CloudOff,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {action && <div className="page-action">{action}</div>}
    </header>
  );
}
export function EmptyState({
  title,
  description,
  children,
  icon,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        {icon ?? <Sparkles size={27} strokeWidth={1.5} />}
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  const message =
    error instanceof Error
      ? error.message
      : "Something interrupted this request. Please try again.";
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={22} />
      <div>
        <strong>We couldn't finish that.</strong>
        <p>{message}</p>
        {retry && (
          <Button variant="secondary" onClick={retry}>
            <RefreshCw size={16} />
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}
export function LoadingState({
  label = "Loading your household…",
}: {
  label?: string;
}) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle className="spin" size={22} />
      <span>{label}</span>
      <div className="skeleton-row" />
      <div className="skeleton-row" />
      <div className="skeleton-row short" />
    </div>
  );
}
export function OfflineState() {
  return (
    <Card>
      <EmptyState
        icon={<CloudOff size={28} />}
        title="Finance needs a connection"
        description="Reconnect to securely load your financial information. It isn't saved on this device for offline use."
      />
    </Card>
  );
}
export function SectionTitle({
  title,
  href,
  action = "View all",
  count,
}: {
  title: string;
  href?: string;
  action?: string;
  count?: number;
}) {
  return (
    <div className="section-title">
      <h2>
        {title}
        {count !== undefined && <span className="count">{count}</span>}
      </h2>
      {href && (
        <Link className="text-link" href={href}>
          {action}
          <ArrowRight size={15} />
        </Link>
      )}
    </div>
  );
}
export function ScopeBadge({ scope }: { scope: string }) {
  return (
    <span className={`scope-badge ${scope === "personal" ? "personal" : ""}`}>
      {scope === "personal" && <LockKeyhole size={12} />}
      {scope === "personal" ? "Just me" : "Household"}
    </span>
  );
}
export function Metric({
  label,
  value,
  detail,
  icon,
  tone = "forest",
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  icon?: ReactNode;
  tone?: string;
}) {
  return (
    <Card className={`metric metric-${tone}`}>
      <div className="metric-top">
        <span>{label}</span>
        {icon}
      </div>
      <div className="metric-value">{value}</div>
      {detail && <p>{detail}</p>}
    </Card>
  );
}
