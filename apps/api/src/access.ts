import {
  type AccessInvitation,
  type AccessResponse,
  commandSchema,
  invitationRequestSchema,
  uuidSchema,
} from "@heima/contracts";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { Hono } from "hono";
import type { Identity } from "./auth";
import { config } from "./config";
import { db } from "./db/client";
import { bootstrapState, invitations, members } from "./db/schema";
import { ApiFailure, denied } from "./errors";
import { emitAccess } from "./pathways";
import { decryptPrivate, semanticId } from "./security";

export type ApiVariables = { identity: Identity };
export async function requireMember(identity: Identity) {
  const member = (
    await db
      .select()
      .from(members)
      .where(
        and(
          eq(members.householdId, config.HOUSEHOLD_ID),
          eq(members.userId, identity.userId),
        ),
      )
      .limit(1)
  )[0];
  if (
    !member ||
    member.status !== "active" ||
    member.subject !== identity.subject
  )
    throw denied();
  return member;
}
async function requireOwner(identity: Identity) {
  const member = await requireMember(identity);
  if (member.role !== "owner") throw denied();
  return member;
}
function base(identity: Identity, commandId: string) {
  return {
    commandId,
    actorId: identity.userId,
    householdId: config.HOUSEHOLD_ID,
    occurredAt: new Date().toISOString(),
  };
}
async function getInvitation(id: string) {
  const invite = (
    await db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.householdId, config.HOUSEHOLD_ID),
          eq(invitations.id, id),
        ),
      )
      .limit(1)
  )[0];
  if (!invite)
    throw new ApiFailure(
      "not-found",
      404,
      "This invitation is no longer available.",
    );
  return invite;
}
export async function accessView(identity: Identity): Promise<AccessResponse> {
  const member = await requireMember(identity);
  const visibleMembers = await db
    .select()
    .from(members)
    .where(eq(members.householdId, config.HOUSEHOLD_ID));
  const latest =
    member.role === "owner"
      ? (
          await db
            .select()
            .from(invitations)
            .where(eq(invitations.householdId, config.HOUSEHOLD_ID))
            .orderBy(desc(invitations.requestedAt))
            .limit(1)
        )[0]
      : undefined;
  let invitation: AccessInvitation | null = null;
  if (latest) {
    const expired =
      ["pending", "requesting", "request-failed"].includes(latest.status) &&
      latest.expiresAt <= new Date();
    const status = (
      expired ? "expired" : latest.status
    ) as AccessInvitation["status"];
    invitation = {
      id: latest.id,
      status,
      expiresAt: latest.expiresAt.toISOString(),
      requestedAt: latest.requestedAt.toISOString(),
      ...(!expired &&
      latest.emailCipher &&
      ["pending", "requesting", "request-failed"].includes(status)
        ? { email: decryptPrivate(latest.emailCipher) }
        : {}),
    };
  }
  const clean = (m: typeof member) => ({
    userId: m.userId,
    role: m.role as "owner" | "spouse",
    status: m.status as "active" | "revoked",
  });
  return {
    household: { id: config.HOUSEHOLD_ID, name: "Our home" },
    member: clean(member),
    members: visibleMembers.map(clean),
    invitation,
  };
}

async function requestUsableAccess(
  identity: Identity,
  invitationId: string,
  email: string,
  commandId: string,
) {
  let succeeded = false;
  try {
    const response = await fetch(
      `${config.USABLE_API_BASE_URL}/api/applications/${config.USABLE_APP_ID}/installations/invite`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${identity.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const result = (await response.json().catch(() => null)) as {
      invited?: unknown;
    } | null;
    succeeded = response.ok && result?.invited === true;
  } catch {
    /* Recorded below without revealing whether an email exists. */
  }
  await emitAccess({
    ...base(identity, semanticId(`${commandId}:result`)),
    change: { kind: "invitation-result", invitationId, succeeded },
  });
}

export const accessRoutes = new Hono<{ Variables: ApiVariables }>();
accessRoutes.post("/admit", async (c) => {
  const identity = c.get("identity");
  const existing = (
    await db
      .select()
      .from(members)
      .where(
        and(
          eq(members.householdId, config.HOUSEHOLD_ID),
          eq(members.userId, identity.userId),
        ),
      )
      .limit(1)
  )[0];
  if (existing) {
    await requireMember(identity);
    return c.json(await accessView(identity));
  }
  const claim = (
    await db
      .select()
      .from(bootstrapState)
      .where(eq(bootstrapState.householdId, config.HOUSEHOLD_ID))
      .limit(1)
  )[0];
  if (!claim && identity.userId === config.APP_OWNER_USER_ID)
    await emitAccess({
      ...base(identity, semanticId(`${config.HOUSEHOLD_ID}:bootstrap`)),
      change: { kind: "owner-bootstrapped", subject: identity.subject },
    });
  else {
    if (!identity.email || !identity.emailVerified) throw denied();
    const pending = (
      await db
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.householdId, config.HOUSEHOLD_ID),
            eq(invitations.status, "pending"),
          ),
        )
        .limit(1)
    )[0];
    if (
      !pending ||
      pending.expiresAt <= new Date() ||
      !pending.emailCipher ||
      decryptPrivate(pending.emailCipher) !== identity.email
    )
      throw denied();
    await emitAccess({
      ...base(identity, semanticId(`${pending.id}:admit:${identity.userId}`)),
      change: {
        kind: "spouse-admitted",
        invitationId: pending.id,
        subject: identity.subject,
      },
    });
  }
  return c.json(await accessView(identity));
});
accessRoutes.get("/", async (c) => c.json(await accessView(c.get("identity"))));
accessRoutes.post("/invitations", async (c) => {
  const identity = c.get("identity");
  await requireOwner(identity);
  const input = invitationRequestSchema.parse(await c.req.json());
  const invitationId = semanticId(`${input.commandId}:invitation`);
  await emitAccess({
    ...base(identity, input.commandId),
    change: {
      kind: "invitation-requested",
      invitationId,
      email: input.email,
      expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
    },
  });
  const invite = await getInvitation(invitationId);
  if (invite.status === "requesting")
    await requestUsableAccess(
      identity,
      invitationId,
      input.email,
      input.commandId,
    );
  return c.json(await accessView(identity), 201);
});
accessRoutes.post("/invitations/:id/resend", async (c) => {
  const identity = c.get("identity");
  await requireOwner(identity);
  const input = commandSchema.parse(await c.req.json());
  const id = uuidSchema.parse(c.req.param("id"));
  const invite = await getInvitation(id);
  if (
    !invite.emailCipher ||
    !["pending", "request-failed"].includes(invite.status) ||
    invite.expiresAt <= new Date()
  )
    throw new ApiFailure(
      "invitation-conflict",
      409,
      "Create a new access invitation.",
    );
  await requestUsableAccess(
    identity,
    id,
    decryptPrivate(invite.emailCipher),
    input.commandId,
  );
  return c.json(await accessView(identity));
});
accessRoutes.post("/invitations/:id/cancel", async (c) => {
  const identity = c.get("identity");
  await requireOwner(identity);
  const input = commandSchema.parse(await c.req.json());
  const id = uuidSchema.parse(c.req.param("id"));
  await emitAccess({
    ...base(identity, input.commandId),
    change: { kind: "invitation-cancelled", invitationId: id },
  });
  return c.json(await accessView(identity));
});
accessRoutes.post("/members/:id/revoke", async (c) => {
  const identity = c.get("identity");
  await requireOwner(identity);
  const input = commandSchema.parse(await c.req.json());
  const id = uuidSchema.parse(c.req.param("id"));
  await emitAccess({
    ...base(identity, input.commandId),
    change: { kind: "spouse-revoked", userId: id },
  });
  return c.json(await accessView(identity));
});

export async function expireInvitations() {
  const expired = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.householdId, config.HOUSEHOLD_ID),
        inArray(invitations.status, [
          "requesting",
          "pending",
          "request-failed",
        ]),
        lte(invitations.expiresAt, new Date()),
      ),
    );
  const owner = (
    await db
      .select()
      .from(members)
      .where(
        and(
          eq(members.householdId, config.HOUSEHOLD_ID),
          eq(members.role, "owner"),
          eq(members.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  if (!owner) return;
  for (const invitation of expired)
    await emitAccess({
      commandId: semanticId(`${invitation.id}:expire`),
      householdId: config.HOUSEHOLD_ID,
      actorId: owner.userId,
      occurredAt: new Date().toISOString(),
      change: { kind: "invitation-expired", invitationId: invitation.id },
    });
}
