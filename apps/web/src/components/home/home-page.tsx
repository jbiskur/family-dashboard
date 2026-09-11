"use client";
import type {
  HomeResponse,
  HouseholdProfile,
  ShoppingItem,
  ShoppingList,
  Store,
  WorkItem,
} from "@heima/contracts";
import {
  ArrowRight,
  Check,
  Clock3,
  ListTodo,
  ShoppingBag,
  Sprout,
  Wallet,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCommand, useHeima } from "@/lib/client";
import { memberLabel } from "@/lib/member-label";
import { CaptureComposer } from "../shared/capture-composer";
import {
  shoppingDetails,
  shoppingTitle,
  workAudience,
  workDetails,
  workTitle,
} from "../shared/capture-fields";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  ScopeBadge,
  SectionTitle,
} from "../shared/page";
import { useHousehold } from "../shared/providers";
import { Button } from "../ui/button";
import { Card } from "../ui/card";

export function HomePage() {
  const query = useHeima<HomeResponse>("/v1/home");
  const shoppingHistory = useHeima<{ items: ShoppingItem[] }>(
    "/v1/shopping/items?includeArchived=true",
  );
  const workHistory = useHeima<{ items: WorkItem[] }>(
    "/v1/work/items?includeArchived=true",
  );
  const command = useCommand();
  const access = useHousehold();
  const stores = useHeima<{ items: Store[] }>("/v1/shopping/stores");
  const profiles = useHeima<{ items: HouseholdProfile[] }>(
    "/v1/household/profiles?context=work",
  );
  const assignees = [
    { value: "", label: "Anyone can help" },
    ...access.members
      .filter((member) => member.status === "active")
      .map((member) => ({
        value: member.userId,
        label:
          member.userId === access.member.userId ? "Me" : memberLabel(member),
      })),
    ...(profiles.data?.items ?? [])
      .filter((profile) => !profile.archived)
      .map((profile) => ({ value: profile.id, label: profile.name })),
  ];
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
      <CaptureComposer
        choices={[
          {
            id: "work",
            label: "To-do",
            icon: ListTodo,
            title: {
              ...workTitle,
              history: (values) => ({
                names: (workHistory.error
                  ? []
                  : (workHistory.data?.items ?? [])
                )
                  .filter((item) => item.visibility === values.visibility)
                  .map((item) => item.title),
                loading: workHistory.isPending,
                unavailable: !!workHistory.error,
              }),
            },
            context: [workAudience],
            details: workDetails(assignees),
            onSubmit: async (values) => {
              const { recurrenceUnit, recurrenceInterval, ...rest } = values;
              return command.execute("/v1/work/items", {
                ...rest,
                assigneeId: rest.assigneeId || null,
                dueDate: rest.dueDate || null,
                dueTime: rest.dueTime || null,
                recurrence: recurrenceUnit
                  ? {
                      unit: recurrenceUnit,
                      interval: Number(recurrenceInterval),
                    }
                  : null,
              });
            },
          },
          {
            id: "shopping",
            label: "Shopping",
            icon: ShoppingBag,
            title: {
              ...shoppingTitle,
              history: (values) => ({
                names: (shoppingHistory.error
                  ? []
                  : (shoppingHistory.data?.items ?? [])
                )
                  .filter(
                    (item) =>
                      item.listId === values.listId &&
                      (!values.category || item.category === values.category),
                  )
                  .map((item) => item.name),
                loading: shoppingHistory.isPending,
                unavailable: !!shoppingHistory.error,
              }),
            },
            context: [
              {
                name: "listId",
                label: "Shopping list",
                required: true,
                options: (data?.shopping ?? []).map((list) => ({
                  value: list.id,
                  label: `${list.name} · ${list.visibility === "personal" ? "Just me" : "Household"}`,
                })),
              },
            ],
            details: shoppingDetails(
              (stores.data?.items ?? []).map((store) => ({
                value: store.id,
                label: store.name,
              })),
            ),
            unavailable: !data?.shopping.length ? (
              <p className="capture-empty">
                {query.isPending
                  ? "Loading your lists…"
                  : "A shopping list comes first."}{" "}
                <Link className="text-link" href="/shopping">
                  Go to Shopping <ArrowRight size={15} />
                </Link>
              </p>
            ) : undefined,
            onSubmit: (values) =>
              command.execute("/v1/shopping/items", {
                ...values,
                offerStoreId: values.offerStoreId || null,
              }),
          },
        ]}
      />
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
                  />
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
