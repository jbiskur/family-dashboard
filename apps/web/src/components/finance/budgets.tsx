"use client";
import type { FinanceBudget, FinanceCategory } from "@heima/contracts";
import {
  ArrowRight,
  Layers3,
  Pencil,
  PiggyBank,
  Plus,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useCommand, useHeima } from "@/lib/client";
import { EntityForm } from "../shared/form";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from "../shared/page";
import { useHousehold } from "../shared/providers";
import { Button } from "../ui/button";
import { Badge, Card } from "../ui/card";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { FinanceBoundary, FinanceNav, Money, money } from "./finance-shared";

export function BudgetsPage() {
  const admin = useHousehold().member.role === "admin";
  const params = useSearchParams();
  const router = useRouter();
  const month = params.get("month") ?? new Date().toISOString().slice(0, 7);
  const query = useHeima<{ items: FinanceBudget[] }>(
    `/v1/finance/budgets?month=${month}`,
  );
  const cats = useHeima<{ items: FinanceCategory[] }>("/v1/finance/categories");
  const command = useCommand();
  const [editing, setEditing] = useState<FinanceBudget | "new" | null>(null);
  const [archiving, setArchiving] = useState<FinanceBudget | null>(null);
  const [managing, setManaging] = useState(false);
  const [category, setCategory] = useState<FinanceCategory | "new" | null>(
    null,
  );
  const [archiveCategory, setArchiveCategory] =
    useState<FinanceCategory | null>(null);
  const categories = cats.data?.items ?? [];
  const budgets = query.data?.items ?? [];
  return (
    <>
      <PageHeader
        eyebrow="MAKE SPACE FOR WHAT MATTERS"
        title="Monthly budgets"
        description="Set category budgets and compare them with actual household spending."
        action={
          <Button onClick={() => setEditing("new")}>
            <Plus size={16} />
            Set a budget
          </Button>
        }
      />
      <FinanceNav />
      <FinanceBoundary>
        <div className="toolbar">
          <Input
            type="month"
            className="finance-period"
            aria-label="Budget month"
            value={month}
            onChange={(e) =>
              e.target.value &&
              router.push(`/finance/budgets?month=${e.target.value}`)
            }
          />
          <Button variant="secondary" onClick={() => setManaging(true)}>
            <Layers3 size={16} />
            Manage categories
          </Button>
        </div>
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
          {query.isPending ? (
            <LoadingState />
          ) : query.error ? (
            <ErrorState
              error={query.error}
              retry={() => void query.refetch()}
            />
          ) : budgets.length ? (
            budgets.map((budget) => {
              const name =
                categories.find((c) => c.id === budget.categoryId)?.name ??
                "Archived category";
              const percent =
                budget.actual === undefined
                  ? 0
                  : Number(budget.amount) === 0
                    ? Number(budget.actual) > 0
                      ? 100
                      : 0
                    : Math.max(
                        0,
                        (Number(budget.actual) / Number(budget.amount)) * 100,
                      );
              return (
                <div className="budget-row" key={budget.id}>
                  <div className="row-between">
                    <div className="row">
                      <span
                        className="task-symbol"
                        style={{
                          background: "var(--teal-soft)",
                          color: "var(--teal)",
                        }}
                      >
                        <PiggyBank size={18} />
                      </span>
                      <div>
                        <h3>{name}</h3>
                        <p className="text-tiny muted" style={{ marginTop: 4 }}>
                          {budget.incomplete
                            ? "Some financial facts need review"
                            : "Household spending, less booked refunds"}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${name} budget`}
                      onClick={() => setEditing(budget)}
                    >
                      <Pencil size={16} />
                    </Button>
                  </div>
                  <div className="row-between" style={{ marginTop: 19 }}>
                    <p className="text-small">
                      <strong>
                        <Money
                          value={budget.actual}
                          currency={budget.currency}
                        />
                      </strong>
                      <span className="muted">
                        {" "}
                        of{" "}
                        <Money
                          value={budget.amount}
                          currency={budget.currency}
                        />
                      </span>
                    </p>
                    <Badge className={percent > 100 ? "clay" : "forest"}>
                      {budget.remaining === undefined
                        ? "Actuals unavailable"
                        : `${money(budget.remaining, budget.currency)} ${budget.remaining.startsWith("-") ? "over budget" : "left"}`}
                    </Badge>
                  </div>
                  <div
                    className="budget-track"
                    role="img"
                    aria-label={
                      budget.actual === undefined
                        ? "Actual spending not yet available"
                        : `${Math.round(percent)} percent of budget used`
                    }
                  >
                    <div
                      className={`budget-fill ${percent > 100 ? "over" : ""}`}
                      style={{ width: `${Math.min(percent, 100)}%` }}
                    />
                  </div>
                  <div className="row-between" style={{ marginTop: 8 }}>
                    <Link
                      className="text-link"
                      href={`/finance/transactions?categoryId=${budget.categoryId}&from=${month}-01&to=${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)}`}
                    >
                      See visible transactions
                      <ArrowRight size={13} />
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Archive ${name} budget`}
                      onClick={() => setArchiving(budget)}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              );
            })
          ) : (
            <EmptyState
              icon={<PiggyBank size={28} />}
              title="No budgets yet"
              description="Pick a category, choose a monthly amount, and see how your household spending compares."
            >
              <Button onClick={() => setEditing("new")}>
                Set your first budget
              </Button>
            </EmptyState>
          )}
        </Card>
        <p className="field-hint" style={{ marginTop: 15 }}>
          {admin
            ? "Your budget view counts spending from shared accounts and your own. Other people's private spending is excluded."
            : "Budgets use combined household spending. Private transaction details stay private."}{" "}
          Income, transfers and adjustments are excluded.
        </p>
        <Dialog
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          title={
            editing === "new" ? "Make a little plan" : "Adjust your budget"
          }
          description="One category. One month. An amount that works for you."
        >
          {editing && categories.length ? (
            <EntityForm
              fields={[
                {
                  name: "categoryId",
                  label: "Category",
                  required: true,
                  defaultValue:
                    editing === "new" ? categories[0]?.id : editing.categoryId,
                  options: categories.map((c) => ({
                    value: c.id,
                    label: c.name,
                  })),
                },
                {
                  name: "month",
                  label: "Month",
                  type: "month",
                  required: true,
                  defaultValue: editing === "new" ? month : editing.month,
                },
                {
                  name: "amount",
                  label: "Budget amount",
                  required: true,
                  defaultValue: editing === "new" ? "" : editing.amount,
                  placeholder: "2500.00",
                  hint: "A nonnegative exact amount. Zero is a deliberate zero budget.",
                },
                {
                  name: "currency",
                  label: "Reporting currency",
                  required: true,
                  defaultValue: editing === "new" ? "DKK" : editing.currency,
                },
              ]}
              submitLabel="Save budget"
              onCancel={() => setEditing(null)}
              onSubmit={async (values) => {
                await command.execute(
                  editing === "new"
                    ? "/v1/finance/budgets"
                    : `/v1/finance/budgets/${editing.id}`,
                  {
                    ...values,
                    ...(editing === "new"
                      ? {}
                      : { baseVersion: editing.version }),
                  },
                );
                setEditing(null);
              }}
            />
          ) : (
            <EmptyState
              title="Choose your categories first"
              description="Add a household category to start budgeting."
            >
              <Button
                onClick={() => {
                  setEditing(null);
                  setManaging(true);
                }}
              >
                Manage categories
              </Button>
            </EmptyState>
          )}
        </Dialog>
        <Dialog
          open={archiving !== null}
          onOpenChange={(open) => !open && setArchiving(null)}
          title="Archive this budget?"
          description="Past budget history stays. This budget leaves the active view."
        >
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setArchiving(null)}>
              Keep budget
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (archiving)
                  await command.execute(
                    `/v1/finance/budgets/${archiving.id}/archive`,
                    { baseVersion: archiving.version },
                  );
                setArchiving(null);
              }}
            >
              Archive budget
            </Button>
          </div>
        </Dialog>
        <Dialog
          open={managing}
          onOpenChange={setManaging}
          title="Your household categories"
          description="A shared two-level tree keeps budgets and spending in sync."
          wide
        >
          <div className="row-between" style={{ marginBottom: 13 }}>
            <p className="text-small muted">
              Household members can manage categories.
            </p>
            <Button variant="secondary" onClick={() => setCategory("new")}>
              <Plus size={15} />
              Add category
            </Button>
          </div>
          {cats.isPending ? (
            <LoadingState />
          ) : cats.error ? (
            <ErrorState error={cats.error} />
          ) : (
            categories.map((cat) => (
              <div
                className="member-row"
                key={cat.id}
                style={{ paddingLeft: cat.parentId ? 20 : 0 }}
              >
                <span className="grow">
                  <strong>{cat.name}</strong>
                  {cat.parentId && (
                    <small>
                      Under{" "}
                      {categories.find((c) => c.id === cat.parentId)?.name ??
                        "Archived category"}
                    </small>
                  )}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Edit ${cat.name}`}
                  onClick={() => setCategory(cat)}
                >
                  <Pencil size={14} />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Archive ${cat.name}`}
                  onClick={() => setArchiveCategory(cat)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))
          )}
        </Dialog>
        <Dialog
          open={category !== null}
          onOpenChange={(open) => !open && setCategory(null)}
          title={category === "new" ? "A new category" : "Update category"}
          description="Keep the tree simple: a category and, optionally, one parent."
        >
          {category && (
            <EntityForm
              fields={[
                {
                  name: "name",
                  label: "Category name",
                  required: true,
                  defaultValue: category === "new" ? "" : category.name,
                },
                {
                  name: "parentId",
                  label: "Parent category",
                  defaultValue:
                    category === "new" ? "" : (category.parentId ?? ""),
                  options: [
                    { value: "", label: "Top-level category" },
                    ...categories
                      .filter(
                        (c) =>
                          !c.parentId &&
                          (category === "new" || c.id !== category.id),
                      )
                      .map((c) => ({ value: c.id, label: c.name })),
                  ],
                },
              ]}
              onCancel={() => setCategory(null)}
              onSubmit={async (values) => {
                await command.execute(
                  category === "new"
                    ? "/v1/finance/categories"
                    : `/v1/finance/categories/${category.id}`,
                  {
                    ...values,
                    parentId: values.parentId || null,
                    ...(category === "new"
                      ? {}
                      : { baseVersion: category.version }),
                  },
                );
                setCategory(null);
              }}
            />
          )}
        </Dialog>
        <Dialog
          open={archiveCategory !== null}
          onOpenChange={(open) => !open && setArchiveCategory(null)}
          title="Archive this category?"
          description="Historical transactions and budgets remain understandable."
        >
          <p className="confirm-copy">
            {archiveCategory?.name} will leave new selectors.
            {categories.some((c) => c.parentId === archiveCategory?.id) &&
              ` Its children (${categories
                .filter((c) => c.parentId === archiveCategory?.id)
                .map((c) => c.name)
                .join(", ")}) are archived too.`}
          </p>
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setArchiveCategory(null)}>
              Keep category
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (archiveCategory)
                  await command.execute(
                    `/v1/finance/categories/${archiveCategory.id}/archive`,
                    { baseVersion: archiveCategory.version },
                  );
                setArchiveCategory(null);
              }}
            >
              Archive category
            </Button>
          </div>
        </Dialog>
      </FinanceBoundary>
    </>
  );
}
