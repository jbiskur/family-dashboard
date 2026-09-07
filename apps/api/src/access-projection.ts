import type { FlowcoreEvent } from "@flowcore/pathways";
import type { AccessEvent } from "@heima/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "./db/client";
import {
  bootstrapState,
  commands,
  households,
  invitations,
  members,
} from "./db/schema";
import { encryptPrivate } from "./security";

/** One serialized, replay-safe household projection. Only event handlers mutate access state. */
export async function projectAccess(event: FlowcoreEvent<AccessEvent>) {
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
    const now = new Date(p.occurredAt);
    const memberWhere = and(
      eq(members.householdId, p.householdId),
      eq(members.userId, p.actorId),
    );
    const actor = (
      await tx.select().from(members).where(memberWhere).limit(1)
    )[0];
    const active = await tx
      .select()
      .from(members)
      .where(
        and(
          eq(members.householdId, p.householdId),
          eq(members.status, "active"),
        ),
      );
    let errorCode: string | null = null;
    const change = p.change;
    if (change.kind === "owner-bootstrapped") {
      const claimed = await tx
        .insert(bootstrapState)
        .values({
          householdId: p.householdId,
          ownerId: p.actorId,
          sourceEventId: event.eventId,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (claimed.length) {
        await tx
          .insert(households)
          .values({ id: p.householdId, name: "Our home", createdAt: now })
          .onConflictDoNothing();
        await tx.insert(members).values({
          householdId: p.householdId,
          userId: p.actorId,
          subject: change.subject,
          role: "owner",
          status: "active",
          sourceEventId: event.eventId,
          updatedAt: now,
        });
      }
    } else if (change.kind === "spouse-admitted") {
      const invite = (
        await tx
          .select()
          .from(invitations)
          .where(
            and(
              eq(invitations.id, change.invitationId),
              eq(invitations.householdId, p.householdId),
            ),
          )
          .limit(1)
      )[0];
      if (actor?.status === "active" && actor.subject === change.subject) {
        /* repeated callback */
      } else if (
        !invite ||
        invite.status !== "pending" ||
        invite.expiresAt <= now ||
        active.some((m) => m.role === "spouse") ||
        actor ||
        active.length !== 1
      )
        errorCode = "admission-conflict";
      else {
        await tx.insert(members).values({
          householdId: p.householdId,
          userId: p.actorId,
          subject: change.subject,
          role: "spouse",
          status: "active",
          sourceEventId: event.eventId,
          updatedAt: now,
        });
        await tx
          .update(invitations)
          .set({
            status: "consumed",
            emailCipher: null,
            sourceEventId: event.eventId,
            updatedAt: now,
          })
          .where(eq(invitations.id, invite.id));
      }
    } else if (actor?.role !== "owner" || actor.status !== "active")
      errorCode = "access-denied";
    else if (change.kind === "invitation-requested") {
      const open = await tx
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.householdId, p.householdId),
            inArray(invitations.status, ["requesting", "pending"]),
          ),
        );
      if (open.length || active.some((m) => m.role === "spouse"))
        errorCode = "invitation-conflict";
      else
        await tx.insert(invitations).values({
          id: change.invitationId,
          householdId: p.householdId,
          emailCipher: encryptPrivate(change.email),
          status: "requesting",
          expiresAt: new Date(change.expiresAt),
          requestedAt: now,
          sourceEventId: event.eventId,
          updatedAt: now,
        });
    } else if (change.kind === "spouse-revoked") {
      const target = (
        await tx
          .select()
          .from(members)
          .where(
            and(
              eq(members.householdId, p.householdId),
              eq(members.userId, change.userId),
            ),
          )
          .limit(1)
      )[0];
      if (!target || target.role !== "spouse") errorCode = "access-denied";
      else
        await tx
          .update(members)
          .set({
            status: "revoked",
            sourceEventId: event.eventId,
            updatedAt: now,
          })
          .where(
            and(
              eq(members.householdId, p.householdId),
              eq(members.userId, change.userId),
            ),
          );
    } else {
      const invite = (
        await tx
          .select()
          .from(invitations)
          .where(
            and(
              eq(invitations.householdId, p.householdId),
              eq(invitations.id, change.invitationId),
            ),
          )
          .limit(1)
      )[0];
      if (!invite) errorCode = "invitation-not-found";
      else if (change.kind === "invitation-result") {
        if (
          invite.status === "requesting" ||
          invite.status === "request-failed"
        )
          await tx
            .update(invitations)
            .set({
              status: change.succeeded ? "pending" : "request-failed",
              sourceEventId: event.eventId,
              updatedAt: now,
            })
            .where(eq(invitations.id, invite.id));
      } else if (
        ["requesting", "pending", "request-failed"].includes(invite.status)
      ) {
        if (change.kind === "invitation-expired" && invite.expiresAt > now)
          errorCode = "invitation-not-expired";
        else
          await tx
            .update(invitations)
            .set({
              status:
                change.kind === "invitation-cancelled"
                  ? "cancelled"
                  : "expired",
              emailCipher: null,
              sourceEventId: event.eventId,
              updatedAt: now,
            })
            .where(eq(invitations.id, invite.id));
      }
    }
    await tx.insert(commands).values({
      id: p.commandId,
      householdId: p.householdId,
      actorId: p.actorId,
      status: errorCode ? "rejected" : "completed",
      errorCode,
      result: {},
      sourceEventId: event.eventId,
      createdAt: now,
    });
  });
}
