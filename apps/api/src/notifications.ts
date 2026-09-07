import {
  commandSchema,
  type NotificationEvent,
  uuidSchema,
} from "@heima/contracts";
import { Temporal } from "@js-temporal/polyfill";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import webpush from "web-push";
import { type ApiVariables, requireMember } from "./access";
import { config } from "./config";
import { db } from "./db/client";
import { activity, members, resources } from "./db/schema";
import { canRead, fields, TIMEZONE } from "./domain";
import { ApiFailure } from "./errors";
import { emitNotification } from "./pathways";
import { confirmRecipient } from "./recipient-session";
import { semanticId } from "./security";

export const notificationRoutes = new Hono<{ Variables: ApiVariables }>();
notificationRoutes.use("*", async (c, next) => {
  await requireMember(c.get("identity"));
  await next();
});
const pushAvailable = !!(
  config.VAPID_PUBLIC_KEY &&
  config.VAPID_PRIVATE_KEY &&
  config.AUTH_SECRET &&
  config.USABLE_CLIENT_SECRET
);
notificationRoutes.get("/settings/push-public-key", (c) =>
  c.json({
    publicKey: pushAvailable ? config.VAPID_PUBLIC_KEY : null,
    available: pushAvailable,
  }),
);
notificationRoutes.post("/activity/:id/read", async (c) => {
  const id = uuidSchema.parse(c.req.param("id"));
  const { commandId } = commandSchema.parse(await c.req.json());
  const userId = c.get("identity").userId;
  const all = await db
    .select()
    .from(resources)
    .where(eq(resources.householdId, config.HOUSEHOLD_ID));
  const entry = (
    await db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.id, id),
          eq(activity.recipientId, userId),
          eq(activity.householdId, config.HOUSEHOLD_ID),
        ),
      )
      .limit(1)
  )[0];
  const row = all.find((r) => r.id === entry?.resourceId);
  if (!entry || !row || !canRead(row, userId, all))
    throw new ApiFailure(
      "not-found",
      404,
      "This notification is not available.",
    );
  await emitNotification({
    commandId,
    householdId: config.HOUSEHOLD_ID,
    actorId: userId,
    recipientId: userId,
    occurredAt: new Date().toISOString(),
    action: "read",
    targetId: id,
  });
  return c.json({ id, read: true });
});

export function inQuietHours(start: string, end: string, now: string) {
  return start === end
    ? false
    : start < end
      ? now >= start && now < end
      : now >= start || now < end;
}
let running = false;
export async function processNotifications() {
  if (running) return;
  running = true;
  try {
    const active = await db
      .select()
      .from(members)
      .where(
        and(
          eq(members.householdId, config.HOUSEHOLD_ID),
          eq(members.status, "active"),
        ),
      );
    const owner = active.find((m) => m.role === "owner");
    if (!owner) return;
    const all = await db
      .select()
      .from(resources)
      .where(eq(resources.householdId, config.HOUSEHOLD_ID));
    const now = new Date().toISOString();
    const emit = (
      action: NotificationEvent["action"],
      targetId: string,
      recipientId: string,
      discriminator = "",
    ) =>
      emitNotification({
        commandId: semanticId(
          `${action}:${targetId}:${recipientId}:${discriminator}`,
        ),
        householdId: config.HOUSEHOLD_ID,
        actorId: owner.userId,
        recipientId,
        occurredAt: now,
        action,
        targetId,
      });
    for (const work of all.filter(
      (r) =>
        r.kind === "work/items" &&
        r.archived === "false" &&
        r.data.status !== "done" &&
        r.data.dueAt &&
        String(r.data.dueAt) <= now &&
        active.some((m) => m.userId === r.data.assigneeId),
    ))
      await emit(
        "reminder",
        work.id,
        String(work.data.assigneeId),
        String(work.data.dueAt),
      );
    if (!pushAvailable) return;
    webpush.setVapidDetails(
      config.VAPID_SUBJECT,
      config.VAPID_PUBLIC_KEY!,
      config.VAPID_PRIVATE_KEY!,
    );
    const pending = await db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.householdId, config.HOUSEHOLD_ID),
          eq(activity.pushState, "pending"),
        ),
      );
    for (const recipient of active) {
      const preferences = fields["settings/preferences"].parse(
        all.find(
          (r) =>
            r.kind === "settings/preferences" &&
            r.ownerId === recipient.userId &&
            r.archived === "false",
        )?.data ?? {},
      ) as Record<string, unknown>;
      const entries = pending.filter((e) => {
        const row = all.find((r) => r.id === e.resourceId);
        return (
          e.recipientId === recipient.userId &&
          e.isRead === "false" &&
          row &&
          canRead(row, recipient.userId, all) &&
          preferences[e.category] === true &&
          !(e.category === "dueReminders" && row.data.status === "done")
        );
      });
      if (
        !entries.length ||
        inQuietHours(
          String(preferences.quietStart),
          String(preferences.quietEnd),
          Temporal.Now.zonedDateTimeISO(TIMEZONE)
            .toPlainTime()
            .toString()
            .slice(0, 5),
        )
      )
        continue;
      const devices = all.filter(
        (r) =>
          r.kind === "settings/devices" &&
          r.ownerId === recipient.userId &&
          r.archived === "false",
      );
      if (!devices.length || !(await confirmRecipient(recipient.userId)))
        continue;
      const first = entries[0]!;
      const tag = semanticId(
        `digest:${recipient.userId}:${entries
          .map((e) => e.id)
          .sort()
          .join(":")}`,
      );
      let complete = true;
      for (const device of devices) {
        // Revalidate destinations before outbound HTTP, including persisted subscriptions.
        const subscription = fields["settings/devices"].safeParse(device.data);
        if (!subscription.success) {
          await emit("device-expired", device.id, recipient.userId);
          continue;
        }
        try {
          await webpush.sendNotification(
            subscription.data as webpush.PushSubscription,
            JSON.stringify({
              title: "Heima",
              body:
                entries.length > 1
                  ? `${entries.length} household updates are ready`
                  : first.title,
              url: entries.length > 1 ? "/settings/notifications" : first.href,
              id: tag,
            }),
            { TTL: 3600, topic: tag.replaceAll("-", ""), timeout: 10_000 },
          );
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410)
            await emit("device-expired", device.id, recipient.userId);
          else complete = false;
        }
      }
      if (complete)
        for (const entry of entries)
          await emit("delivered", entry.id, recipient.userId);
    }
  } finally {
    running = false;
  }
}
