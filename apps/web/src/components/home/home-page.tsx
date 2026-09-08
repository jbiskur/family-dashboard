"use client";
import type { HomeResponse, ShoppingList } from "@heima/contracts";
import {
  ArrowRight,
  Check,
  Clock3,
  ListTodo,
  Plus,
  ShoppingBag,
  Sprout,
  Wallet,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { useCommand, useHeima } from "@/lib/client";
import { EntityForm } from "../shared/form";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  ScopeBadge,
  SectionTitle,
} from "../shared/page";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Dialog } from "../ui/dialog";

export function HomePage() {
  const query = useHeima<HomeResponse>("/v1/home");
  const command = useCommand();
  const [quick, setQuick] = useState<"work" | "shopping" | null>(null);
  const [notice, setNotice] = useState("");
  const data = query.data;
  const day = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
  return (
    <>
      <PageHeader
        eyebrow={day.toUpperCase()}
        title="Welcome home."
        description="The everyday, a little more in hand."
        action={
          <Button onClick={() => setQuick("work")}>
            <Plus size={17} />
            Quick add
          </Button>
        }
      />
      <section className="hero-card">
        <div className="hero-copy">
          <p className="eyebrow">LITTLE THINGS. SHARED.</p>
          <h2>
            More time for
            <br />
            the good stuff.
          </h2>
          <p>A list remembered. A helping hand. Your household starts here.</p>
          <Button variant="secondary" asChild>
            <Link href="/work">
              See what's on today
              <ArrowRight size={15} />
            </Link>
          </Button>
        </div>
        <Image
          width={1536}
          height={1024}
          sizes="(max-width: 767px) 100vw, 40vw"
          priority
          className="hero-art"
          src="/images/home-still-life.png"
          alt="A warm kitchen with groceries and green hills outside"
        />
      </section>
      {notice && (
        <div className="notice" role="status">
          <Check size={16} />
          {notice}
          <Button variant="ghost" onClick={() => setNotice("")}>
            Dismiss
          </Button>
        </div>
      )}
      <div className="toolbar">
        <div>
          <h2>One less thing to remember</h2>
          <p className="text-small muted" style={{ marginTop: 5 }}>
            Capture it now. Come back to it together.
          </p>
        </div>
        <div className="row">
          <Button variant="secondary" onClick={() => setQuick("shopping")}>
            <ShoppingBag size={16} />
            Shopping item
          </Button>
          <Button variant="secondary" onClick={() => setQuick("work")}>
            <ListTodo size={16} />
            To-do
          </Button>
        </div>
      </div>
      {query.isPending ? (
        <LoadingState />
      ) : query.error ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        data && (
          <div className="two-columns">
            <div>
              <SectionTitle
                title="Today, together"
                href="/work"
                count={data.today.length}
              />
              <Card>
                {data.today.length ? (
                  data.today.map((item) => (
                    <Link
                      className="home-task"
                      href={`/work?item=${item.id}`}
                      key={item.id}
                    >
                      <span className="task-symbol">
                        <ListTodo size={17} />
                      </span>
                      <div className="grow">
                        <h3>{item.title}</h3>
                        <p>
                          {item.dueDate
                            ? new Intl.DateTimeFormat("en-GB", {
                                day: "numeric",
                                month: "short",
                              }).format(new Date(`${item.dueDate}T12:00:00`))
                            : "No due date"}
                          {item.status === "doing" ? " · In progress" : ""}
                        </p>
                      </div>
                      <ScopeBadge scope={item.visibility} />
                      <ArrowRight size={15} className="muted" />
                    </Link>
                  ))
                ) : (
                  <EmptyState
                    icon={<Sprout size={27} />}
                    title="A little breathing room"
                    description="Nothing due today. Add a task or enjoy the space."
                  >
                    <Button
                      variant="secondary"
                      onClick={() => setQuick("work")}
                    >
                      <Plus size={15} />
                      Add a to-do
                    </Button>
                  </EmptyState>
                )}
              </Card>
              <div className="section-gap">
                <SectionTitle title="For the next shop" href="/shopping" />
                <div className="stack">
                  {data.shopping.length ? (
                    data.shopping
                      .slice(0, 3)
                      .map((list) => <HomeList key={list.id} list={list} />)
                  ) : (
                    <Card>
                      <EmptyState
                        icon={<ShoppingBag size={27} />}
                        title="Your first shopping list"
                        description="Start a list for the essentials, the weekend, or just you."
                      >
                        <Button asChild variant="secondary">
                          <Link href="/shopping">
                            Create a list
                            <ArrowRight size={15} />
                          </Link>
                        </Button>
                      </EmptyState>
                    </Card>
                  )}
                </div>
              </div>
            </div>
            <div>
              <SectionTitle title="Needs a little attention" />
              <div className="stack">
                {data.attention.length ? (
                  data.attention.map((item) => (
                    <Link
                      key={item.id}
                      href={item.href}
                      className="attention-card"
                    >
                      <span
                        className="task-symbol"
                        style={{
                          background: "var(--teal-soft)",
                          color: "var(--teal)",
                        }}
                      >
                        <Wallet size={17} />
                      </span>
                      <div className="grow">
                        <h3>{item.title}</h3>
                        <p>Take a look when you have a moment.</p>
                      </div>
                      <ArrowRight size={16} />
                    </Link>
                  ))
                ) : (
                  <Card className="card-pad">
                    <div className="row">
                      <span
                        className="empty-icon"
                        style={{ width: 38, height: 38, margin: 0 }}
                      >
                        <Check size={19} />
                      </span>
                      <div>
                        <h3 className="text-small">You're all caught up.</h3>
                        <p className="text-tiny muted" style={{ marginTop: 4 }}>
                          We'll show things that need you here.
                        </p>
                      </div>
                    </div>
                  </Card>
                )}
              </div>
              <div className="section-gap">
                <SectionTitle title="Around the household" />
                <Card className="card-pad">
                  {data.activity.length ? (
                    data.activity.slice(0, 5).map((item) => (
                      <Link
                        className="activity-row"
                        href={item.href}
                        key={item.id}
                      >
                        <span className="activity-dot" />
                        <div className="grow">
                          <p>{item.title}</p>
                          <time dateTime={item.occurredAt}>
                            {new Intl.DateTimeFormat("en-GB", {
                              day: "numeric",
                              month: "short",
                              hour: "2-digit",
                              minute: "2-digit",
                            }).format(new Date(item.occurredAt))}
                          </time>
                        </div>
                        <ArrowRight size={14} className="muted" />
                      </Link>
                    ))
                  ) : (
                    <div className="row">
                      <Clock3 size={20} className="muted" />
                      <p className="text-small muted">
                        Shared activity will appear as you go.
                      </p>
                    </div>
                  )}
                </Card>
              </div>
              <div className="section-gap">
                <div className="row">
                  <Sprout size={21} className="muted" />
                  <p className="text-small muted">
                    Small things add up.
                    <br />
                    You've got a place for them now.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )
      )}
      <Dialog
        open={quick !== null}
        onOpenChange={(open) => !open && setQuick(null)}
        title={quick === "shopping" ? "Add to the shopping" : "One thing to do"}
        description="Get it out of your head and into Heima."
      >
        {quick === "shopping" && !data?.shopping.length ? (
          <EmptyState
            title="A list comes first"
            description="Create a shopping list, then you can add to it from Home."
          >
            <Button asChild>
              <Link href="/shopping">
                Go to Shopping
                <ArrowRight size={16} />
              </Link>
            </Button>
          </EmptyState>
        ) : (
          <EntityForm
            key={quick}
            submitLabel="Add it"
            fields={
              quick === "shopping"
                ? [
                    {
                      name: "listId",
                      label: "Shopping list",
                      required: true,
                      defaultValue: data?.shopping[0]?.id,
                      options: (data?.shopping ?? []).map((l) => ({
                        value: l.id,
                        label: l.name,
                      })),
                    },
                    {
                      name: "name",
                      label: "What do we need?",
                      required: true,
                      placeholder: "Milk, bread, something nice…",
                    },
                    {
                      name: "quantity",
                      label: "Quantity",
                      placeholder: "2 cartons",
                    },
                  ]
                : [
                    {
                      name: "title",
                      label: "What needs doing?",
                      required: true,
                      placeholder: "Book the dentist, water the plants…",
                    },
                    {
                      name: "visibility",
                      label: "Who is it for?",
                      defaultValue: "household",
                      options: [
                        {
                          value: "household",
                          label: "Household · we can both help",
                        },
                        { value: "personal", label: "Just me · private" },
                      ],
                    },
                  ]
            }
            onCancel={() => setQuick(null)}
            onSubmit={async (values) => {
              await command.execute(
                quick === "shopping" ? "/v1/shopping/items" : "/v1/work/items",
                values,
              );
              setNotice(
                quick === "shopping"
                  ? "Added to your shopping list."
                  : "Added to Work.",
              );
              setQuick(null);
            }}
          />
        )}
      </Dialog>
    </>
  );
}
function HomeList({ list }: { list: ShoppingList }) {
  return (
    <Link className="attention-card" href={`/shopping/${list.id}`}>
      <span
        className="task-symbol"
        style={{ background: "var(--clay-soft)", color: "var(--clay)" }}
      >
        <ShoppingBag size={19} />
      </span>
      <div className="grow">
        <h3>{list.name}</h3>
        <p>
          {list.itemCount === undefined
            ? "Open your list"
            : `${list.itemCount} things on the list`}
        </p>
      </div>
      <ScopeBadge scope={list.visibility} />
      <ArrowRight size={16} />
    </Link>
  );
}
