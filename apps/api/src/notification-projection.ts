import type { FlowcoreEvent } from "@flowcore/pathways";
import type { NotificationEvent } from "@heima/contracts";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db/client";
import { activity, commands, members, resources } from "./db/schema";
import { canRead } from "./domain";
import { semanticId } from "./security";

export async function projectNotification(
  event: FlowcoreEvent<NotificationEvent>,
) {
  const p = event.payload;
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${p.householdId}, 0))`,
    );
    if (
      (
        await tx
          .select()
          .from(commands)
          .where(eq(commands.id, p.commandId))
          .limit(1)
      )[0]
    )
      return;
    const active = await tx
      .select()
      .from(members)
      .where(
        and(
          eq(members.householdId, p.householdId),
          eq(members.status, "active"),
        ),
      );
    if (
      !active.some((m) => m.userId === p.actorId) ||
      !active.some((m) => m.userId === p.recipientId)
    )
      return;
    const now = new Date(p.occurredAt);
    if (p.action === "read" || p.action === "delivered") {
      if (p.action === "read" && p.actorId !== p.recipientId) return;
      await tx
        .update(activity)
        .set(p.action === "read" ? { isRead: "true" } : { pushState: "sent" })
        .where(
          and(
            eq(activity.id, p.targetId),
            eq(activity.householdId, p.householdId),
            eq(activity.recipientId, p.recipientId),
          ),
        );
    } else if (p.action === "device-expired") {
      await tx
        .update(resources)
        .set({ archived: "true", updatedAt: now, sourceEventId: event.eventId })
        .where(
          and(
            eq(resources.id, p.targetId),
            eq(resources.householdId, p.householdId),
            eq(resources.ownerId, p.recipientId),
            eq(resources.kind, "settings/devices"),
          ),
        );
    } else {
      const all = await tx
        .select()
        .from(resources)
        .where(eq(resources.householdId, p.householdId));
      const work = all.find(
        (r) =>
          r.id === p.targetId &&
          r.kind === "work/items" &&
          r.archived === "false",
      );
      if (
        work &&
        work.data.status !== "done" &&
        work.data.assigneeId === p.recipientId &&
        work.data.dueAt &&
        String(work.data.dueAt) <= p.occurredAt &&
        canRead(work, p.recipientId, all)
      )
        await tx
          .insert(activity)
          .values({
            id: semanticId(`${p.commandId}:activity`),
            householdId: p.householdId,
            recipientId: p.recipientId,
            resourceId: work.id,
            category: "dueReminders",
            title: "Assigned work is due",
            href: `/work?item=${work.id}`,
            occurredAt: now,
          })
          .onConflictDoNothing();
    }
    await tx.insert(commands).values({
      id: p.commandId,
      householdId: p.householdId,
      actorId: p.actorId,
      status: "completed",
      result: {},
      sourceEventId: event.eventId,
      createdAt: now,
    });
  });
}
