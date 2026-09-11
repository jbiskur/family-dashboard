"use client";
import type {
  ActivityEntry,
  Preferences,
  ResourceBase,
} from "@heima/contracts";
import { useForm } from "@tanstack/react-form";
import {
  Bell,
  BellOff,
  Check,
  Clock3,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { z } from "zod";
import { useCommand, useHeima } from "@/lib/client";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionTitle,
} from "../shared/page";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";

type Device = ResourceBase & { endpoint: string };
const choices = [
  {
    name: "shoppingChanges",
    label: "Household shopping",
    hint: "Updates to shared household lists.",
  },
  {
    name: "workAssignment",
    label: "Work assignments",
    hint: "When a responsibility is assigned to you.",
  },
  {
    name: "dueReminders",
    label: "Due reminders",
    hint: "A gentle nudge for assigned work.",
  },
  {
    name: "recurrence",
    label: "Recurring work",
    hint: "Keep track of the next occurrence.",
  },
  {
    name: "financeReview",
    label: "Finance review",
    hint: "Only that review is needed. No balances or private details.",
  },
  {
    name: "syncFailures",
    label: "Sync needs attention",
    hint: "Know when a queued change needs your help.",
  },
] as const;
export function NotificationSettings() {
  const preferences = useHeima<{ items: Preferences[] }>(
    "/v1/settings/preferences",
  );
  const activity = useHeima<{ items: ActivityEntry[] }>("/v1/activity");
  const pushKey = useHeima<{ publicKey: string | null; available: boolean }>(
    "/v1/settings/push-public-key",
  );
  const devices = useHeima<{ items: Device[] }>("/v1/settings/devices");
  const command = useCommand();
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const available =
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    setSupported(available);
    if (available && Notification.permission === "granted")
      void navigator.serviceWorker.ready
        .then((r) => r.pushManager.getSubscription())
        .then((s) => setSubscribed(!!s))
        .catch(() => undefined);
  }, []);
  async function enable() {
    setError(null);
    setBusy(true);
    try {
      if (!pushKey.data?.publicKey)
        throw new Error(
          "Push notifications aren't available right now. In-app activity still works.",
        );
      if ((await Notification.requestPermission()) !== "granted")
        throw new Error(
          "Notification permission wasn't granted. You can keep using in-app activity.",
        );
      const registration = await navigator.serviceWorker.ready;
      const normalized = pushKey.data.publicKey
        .replaceAll("-", "+")
        .replaceAll("_", "/");
      const bytes = Uint8Array.from(atob(normalized), (c) => c.charCodeAt(0));
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes.buffer,
      });
      await command.execute(
        "/v1/settings/devices",
        subscription.toJSON() as Record<string, unknown>,
      );
      setSubscribed(true);
      setNotice("This device is ready for your chosen notifications.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      const device = devices.data?.items.find(
        (d) => d.endpoint === subscription?.endpoint,
      );
      if (device)
        await command.execute(`/v1/settings/devices/${device.id}/archive`, {
          baseVersion: device.version,
        });
      await subscription?.unsubscribe();
      setSubscribed(false);
      setNotice(
        "Push disabled on this device. Your preferences are unchanged.",
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="ON YOUR TERMS"
        title="Notifications"
        description="Choose what reaches you, and when. Everyone manages their own settings."
      />
      {notice && (
        <div className="notice" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      <div className="settings-grid">
        <Card className="settings-panel">
          <h2>What would you like to hear?</h2>
          <p>
            In-app activity is always available. Push delivery follows your
            choices and quiet hours.
          </p>
          {preferences.isPending ? (
            <LoadingState />
          ) : preferences.error ? (
            <ErrorState
              error={preferences.error}
              retry={() => void preferences.refetch()}
            />
          ) : (
            <PreferencesForm
              key={preferences.data?.items[0]?.id ?? "new"}
              value={preferences.data?.items[0]}
              saved={() => setNotice("Notification preferences saved.")}
            />
          )}
        </Card>
        <div className="stack">
          <Card className="settings-panel">
            <div className="row" style={{ marginBottom: 14 }}>
              <Smartphone size={22} />
              <h2 style={{ margin: 0 }}>This device</h2>
            </div>
            <p>
              Enable push when you're ready. You can turn it off here without
              changing your notification preferences.
            </p>
            {error ? <ErrorState error={error} /> : null}
            {!supported ? (
              <p className="notice warning">
                This browser doesn't support push here. In-app activity remains
                available. On iPhone or iPad, add Heima to your Home Screen
                first.
              </p>
            ) : pushKey.data?.available === false ? (
              <p className="notice warning">
                Push notifications aren't available right now. In-app activity
                still works.
              </p>
            ) : (
              <Button
                variant={subscribed ? "secondary" : "default"}
                disabled={busy || pushKey.isPending}
                onClick={() => void (subscribed ? disable() : enable())}
              >
                {subscribed ? <BellOff size={16} /> : <Bell size={16} />}{" "}
                {busy
                  ? "Updating…"
                  : subscribed
                    ? "Disable on this device"
                    : "Enable notifications"}
              </Button>
            )}
            <p className="field-hint">
              Browser permission is requested only when you choose to enable.
            </p>
          </Card>
          <Card className="settings-panel">
            <div className="row" style={{ marginBottom: 13 }}>
              <ShieldCheck size={22} />
              <h2 style={{ margin: 0 }}>Private stays private</h2>
            </div>
            <p>
              Finance notifications only say that something needs review.
              Account names, balances and transaction details never belong on
              your lock screen.
            </p>
          </Card>
        </div>
      </div>
      <div className="section-gap">
        <SectionTitle title="Your household activity" />
        <Card className="card-pad">
          {activity.isPending ? (
            <LoadingState />
          ) : activity.error ? (
            <ErrorState
              error={activity.error}
              retry={() => void activity.refetch()}
            />
          ) : activity.data?.items.length ? (
            activity.data.items.map((entry) => (
              <div className="activity-row" key={entry.id}>
                <span
                  className="activity-dot"
                  style={{ opacity: entry.read ? 0.45 : 1 }}
                />
                <Link className="grow" href={entry.href}>
                  <p>{entry.title}</p>
                  <time dateTime={entry.occurredAt}>
                    {new Date(entry.occurredAt).toLocaleString("en-GB")}
                  </time>
                </Link>
                {!entry.read && (
                  <Button
                    variant="ghost"
                    aria-label={`Mark ${entry.title} as read`}
                    onClick={() =>
                      void command.execute(`/v1/activity/${entry.id}/read`)
                    }
                  >
                    <Check size={16} />
                  </Button>
                )}
              </div>
            ))
          ) : (
            <EmptyState
              icon={<Bell size={27} />}
              title="No updates yet"
              description="Relevant household updates will appear here."
            />
          )}
        </Card>
      </div>
    </>
  );
}
function PreferencesForm({
  value,
  saved,
}: {
  value?: Preferences;
  saved: () => void;
}) {
  const command = useCommand();
  const [error, setError] = useState<unknown>(null);
  const form = useForm({
    defaultValues: {
      shoppingChanges: value?.shoppingChanges ?? false,
      workAssignment: value?.workAssignment ?? true,
      dueReminders: value?.dueReminders ?? true,
      recurrence: value?.recurrence ?? true,
      financeReview: value?.financeReview ?? true,
      syncFailures: value?.syncFailures ?? true,
      quietStart: value?.quietStart ?? "22:00",
      quietEnd: value?.quietEnd ?? "07:00",
    },
    onSubmit: async ({ value: values }) => {
      setError(null);
      try {
        await command.execute(
          value
            ? `/v1/settings/preferences/${value.id}`
            : "/v1/settings/preferences",
          {
            ...values,
            timezone: "Atlantic/Faroe",
            ...(value ? { baseVersion: value.version } : {}),
          },
        );
        saved();
      } catch (e) {
        setError(e);
      }
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      {choices.map((choice) => (
        <form.Field
          key={choice.name}
          name={choice.name}
          validators={{ onChange: z.boolean() }}
        >
          {(field) => (
            <div className="preference-row">
              <label htmlFor={`preference-${choice.name}`}>
                <strong>{choice.label}</strong>
                <small>{choice.hint}</small>
              </label>
              <span className="toggle-control">
                <input
                  id={`preference-${choice.name}`}
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(e) => field.handleChange(e.target.checked)}
                />
              </span>
            </div>
          )}
        </form.Field>
      ))}
      <div className="row" style={{ margin: "24px 0 15px" }}>
        <Clock3 size={19} />
        <div>
          <h3>Quiet hours</h3>
          <p className="field-hint">
            Atlantic/Faroe · notifications wait, then arrive as a summary.
          </p>
        </div>
      </div>
      <div className="details-grid">
        {(["quietStart", "quietEnd"] as const).map((name, index) => (
          <form.Field
            key={name}
            name={name}
            validators={{
              onChange: z
                .string()
                .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a valid time"),
            }}
          >
            {(field) => (
              <div className="form-field">
                <label htmlFor={name}>{index === 0 ? "From" : "Until"}</label>
                <Input
                  id={name}
                  type="time"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </div>
            )}
          </form.Field>
        ))}
      </div>
      {error ? <ErrorState error={error} /> : null}
      <div className="form-actions">
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Save preferences"}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
