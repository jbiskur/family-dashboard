import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { AccessResponse } from "@heima/contracts";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { auth } from "@/auth";
import { BackendError, backendFetchForSession } from "../backend";
import { providerSessionMetadata } from "../session-store";
import { clients, issuer, mcpResource, registeredClient } from "./clients";
import {
  browserCookie,
  csrf,
  hash,
  oauthSql,
  type PendingRequest,
} from "./store";
import type {
  AgentAccessView,
  ConsentView,
  McpContext,
  McpScope,
} from "./types";

export async function sessionBackendJson<T>(
  sessionId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await backendFetchForSession(sessionId, path, init);
  const body = await response.json();
  if (!response.ok)
    throw new BackendError(
      response.status,
      body.error?.code ?? "ACCESS_UNAVAILABLE",
      body.error?.message ?? "Access could not be checked.",
    );
  return body as T;
}
export async function verifiedMember(
  sessionId: string,
  expectedUserId?: string,
) {
  const metadata = await providerSessionMetadata(sessionId);
  if (!metadata || (expectedUserId && metadata.userId !== expectedUserId))
    throw new BackendError(
      401,
      "SESSION_EXPIRED",
      "Sign in again to connect your agent.",
    );
  const access = await sessionBackendJson<AccessResponse>(
    sessionId,
    "/v1/access",
  );
  if (
    access.member.userId !== metadata.userId ||
    access.member.status !== "active"
  )
    throw new BackendError(
      403,
      "ACCESS_DENIED",
      "Household access is required.",
    );
  return {
    sessionId,
    userId: metadata.userId,
    expiresAt: metadata.expiresAt,
    access,
  };
}
export async function currentMember() {
  const session = await auth();
  if (!session?.sessionId || !session.user?.id)
    throw new BackendError(401, "SIGN_IN_REQUIRED", "Sign in to continue.");
  return verifiedMember(session.sessionId, session.user.id);
}
export async function getConsentView(requestId: string): Promise<ConsentView> {
  try {
    if (!z.string().uuid().safeParse(requestId).success)
      return {
        status: "expired",
        message:
          "This connection request has expired. Start again from your agent.",
      };
    const [row] = await oauthSql()<
      PendingRequest[]
    >`select * from oauth_requests where id=${requestId}`;
    if (row?.status !== "pending" || row.expires_at.getTime() <= Date.now())
      return {
        status: "expired",
        message:
          "This connection request has expired. Start again from your agent.",
      };
    const browser = (await cookies()).get(browserCookie)?.value;
    if (!browser || hash(browser) !== row.browser_hash)
      return {
        status: "denied",
        message:
          "Open this request in the browser where you started connecting.",
      };
    const session = await auth();
    if (!session?.sessionId || !session.user?.id)
      return {
        status: "sign-in",
        returnTo: `/oauth/consent?request=${row.id}`,
      };
    const member = await verifiedMember(session.sessionId, session.user.id);
    if (row.session_id && row.session_id !== member.sessionId)
      return {
        status: "denied",
        message:
          "Your signed-in account changed. Start a new connection request.",
      };
    const bound =
      await oauthSql()`update oauth_requests set session_id=${member.sessionId}, user_id=${member.userId} where id=${row.id} and status='pending' and (session_id is null or session_id=${member.sessionId}) returning id`;
    const client = registeredClient(row.client_id);
    if (!bound.length || !client)
      return {
        status: "denied",
        message: "This connection request is no longer available.",
      };
    return {
      status: "ready",
      requestId: row.id,
      csrfToken: csrf(row.id, member.sessionId, browser),
      client: { id: client.id, name: client.name },
      redirectHost: new URL(row.redirect_uri).host,
      redirectUri: row.redirect_uri,
      requestedScopes: row.scopes,
      expiresAt: row.expires_at.toISOString(),
      connectionExpiresAt: new Date(member.expiresAt).toISOString(),
    };
  } catch (error) {
    return {
      status: "denied",
      message:
        error instanceof BackendError && error.status < 500
          ? "An active Heima invitation and household membership are required. Sign in to Heima first, then reconnect your agent."
          : "We cannot verify your access right now. Try again shortly.",
    };
  }
}
export async function verifyConsentBrowser(
  request: PendingRequest,
  suppliedCsrf: string,
) {
  const member = await currentMember();
  const origin = (await headers()).get("origin");
  const browser = (await cookies()).get(browserCookie)?.value;
  const expected = browser ? csrf(request.id, member.sessionId, browser) : "";
  if (
    origin !== issuer() ||
    !browser ||
    hash(browser) !== request.browser_hash ||
    request.session_id !== member.sessionId ||
    request.user_id !== member.userId ||
    suppliedCsrf.length !== expected.length ||
    !timingSafeEqual(Buffer.from(suppliedCsrf), Buffer.from(expected))
  )
    throw new BackendError(
      403,
      "CONSENT_CHANGED",
      "This request changed. Start again from your agent.",
    );
  return member;
}
export async function getAgentAccessView(): Promise<AgentAccessView> {
  const member = await currentMember();
  const rows =
    await oauthSql()`select g.*, s.id as live_session from oauth_grants g left join auth_sessions s on s.id=g.session_id and s.expires_at>now() where g.user_id=${member.userId} order by case when g.revoked_at is null and g.expires_at>now() and s.id is not null then 0 else 1 end, g.created_at desc limit 100`;
  return {
    endpoint: mcpResource(),
    clients: [...clients],
    connections: rows.map((row) => ({
      id: row.id,
      clientId: row.client_id,
      clientName: registeredClient(row.client_id)?.name ?? "Agent",
      scopes: row.scopes as McpScope[],
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      status: row.revoked_at
        ? "revoked"
        : !row.live_session || new Date(row.expires_at).getTime() <= Date.now()
          ? "expired"
          : "active",
    })),
  };
}
export function oauthFailure(
  status: number,
  error: string,
  description: string,
  requiredScopes?: readonly McpScope[],
) {
  const responseHeaders: Record<string, string> = {
    "cache-control": "no-store",
    pragma: "no-cache",
  };
  if (status === 401 || status === 403)
    responseHeaders["www-authenticate"] =
      `Bearer resource_metadata="${issuer()}/.well-known/oauth-protected-resource/api/mcp", error="${error}", scope="${(requiredScopes ?? ["heima.read"]).join(" ")}"`;
  return Response.json(
    { error, error_description: description },
    { status, headers: responseHeaders },
  );
}
export async function authenticateMcpRequest(
  request: Request,
): Promise<
  { ok: true; context: McpContext } | { ok: false; response: Response }
> {
  const bad = () => ({
    ok: false as const,
    response: oauthFailure(
      401,
      "invalid_token",
      "Connect your agent with Heima to continue.",
    ),
  });
  const params = new URL(request.url).searchParams;
  if (
    params.has("access_token") ||
    params.has("token") ||
    params.has("authorization")
  )
    return bad();
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (!token) return bad();
  try {
    const [row] =
      await oauthSql()`select g.id,g.user_id,g.session_id,g.client_id,g.resource,g.expires_at,g.revoked_at,t.scopes,t.access_expires_at from oauth_tokens t join oauth_grants g on g.id=t.grant_id where t.access_hash=${hash(token)}`;
    if (
      !row ||
      row.revoked_at ||
      row.resource !== mcpResource() ||
      !registeredClient(row.client_id) ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      new Date(row.access_expires_at).getTime() <= Date.now()
    )
      return bad();
    const member = await verifiedMember(row.session_id, row.user_id);
    return {
      ok: true,
      context: {
        userId: member.userId,
        householdId: member.access.household.id,
        role: member.access.member.role,
        grantId: row.id,
        scopes: row.scopes as McpScope[],
        expiresAt: Math.min(
          new Date(row.access_expires_at).getTime(),
          member.expiresAt,
        ),
        backendJson: <T>(path: string, init?: RequestInit) =>
          sessionBackendJson<T>(member.sessionId, path, init),
      },
    };
  } catch (error) {
    if (error instanceof BackendError && error.status < 500) return bad();
    return {
      ok: false,
      response: oauthFailure(
        503,
        "temporarily_unavailable",
        "Heima cannot verify access right now.",
      ),
    };
  }
}
export function requireMcpScopes(
  context: McpContext,
  required: readonly McpScope[],
): Response | null {
  return required.every((scope) => context.scopes.includes(scope))
    ? null
    : oauthFailure(
        403,
        "insufficient_scope",
        "Reconnect and approve the required permission.",
        required,
      );
}
