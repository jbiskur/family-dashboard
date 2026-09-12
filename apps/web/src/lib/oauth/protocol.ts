import "server-only";
import { randomUUID } from "node:crypto";
import OAuth2Server from "@node-oauth/oauth2-server";
import { BackendError } from "../backend";
import {
  clientRedirectUris,
  issuer,
  mcpResource,
  parseScopes,
  registeredClient,
  validRedirect,
} from "./clients";
import { oauthFailure, verifiedMember, verifyConsentBrowser } from "./server";
import { hash, oauthSql, type PendingRequest, secret } from "./store";
import type { McpScope } from "./types";

function clientModel(id: string) {
  const client = registeredClient(id);
  return client
    ? {
        id: client.id,
        grants: ["authorization_code", "refresh_token"],
        redirectUris: clientRedirectUris(client),
      }
    : false;
}
export async function consentDecision(input: {
  requestId: string;
  csrfToken: string;
  decision: "approve" | "cancel";
  scopes: McpScope[];
}) {
  const [request] = await oauthSql()<
    PendingRequest[]
  >`select * from oauth_requests where id=${input.requestId}`;
  if (!request)
    throw new BackendError(
      400,
      "REQUEST_EXPIRED",
      "This request has expired. Start again from your agent.",
    );
  const member = await verifyConsentBrowser(request, input.csrfToken);
  const approved =
    input.decision === "approve" ? parseScopes(input.scopes.join(" ")) : [];
  if (approved.some((scope) => !request.scopes.includes(scope)))
    throw new BackendError(
      400,
      "INVALID_SCOPE",
      "Only requested permissions can be approved.",
    );
  return oauthSql().begin(async (tx) => {
    const [locked] = await tx<
      PendingRequest[]
    >`select * from oauth_requests where id=${request.id} for update`;
    if (
      locked?.status !== "pending" ||
      locked.expires_at.getTime() <= Date.now() ||
      locked.session_id !== member.sessionId
    )
      throw new BackendError(
        400,
        "REQUEST_EXPIRED",
        "This request is no longer available.",
      );
    const redirect = new URL(locked.redirect_uri);
    redirect.searchParams.set("state", locked.state);
    redirect.searchParams.set("iss", issuer());
    if (input.decision === "cancel") {
      await tx`update oauth_requests set status='cancelled' where id=${locked.id}`;
      redirect.searchParams.set("error", "access_denied");
      return redirect.href;
    }
    const [capacity] =
      await tx`select count(*)::int as count from oauth_grants g join auth_sessions s on s.id=g.session_id where g.user_id=${member.userId} and g.revoked_at is null and g.expires_at>now() and s.expires_at>now()`;
    if (capacity.count >= 100)
      throw new BackendError(
        429,
        "CONNECTION_LIMIT",
        "Disconnect an existing agent in Household settings before connecting another.",
      );
    const model: OAuth2Server.AuthorizationCodeModel = {
      getClient: async (id) => clientModel(id),
      getAccessToken: async () => false,
      validateRedirectUri: async (uri, client) => validRedirect(client.id, uri),
      validateScope: async (_user, _client, requested) =>
        requested?.every((scope) => approved.includes(scope as McpScope))
          ? requested
          : false,
      generateAuthorizationCode: async () => secret(),
      getAuthorizationCode: async () => false,
      revokeAuthorizationCode: async () => false,
      saveToken: async () => false,
      saveAuthorizationCode: async (code, client, user) => {
        if (
          code.codeChallengeMethod !== "S256" ||
          code.codeChallenge !== locked.challenge
        )
          throw new OAuth2Server.InvalidRequestError("Invalid PKCE");
        const expiresAt = new Date(
          Math.min(
            Date.now() + 90_000,
            member.expiresAt,
            locked.expires_at.getTime(),
          ),
        );
        await tx`update oauth_requests set status='authorized', code_hash=${hash(code.authorizationCode)}, code_expires_at=${expiresAt}, scopes=${tx.json(approved)} where id=${locked.id}`;
        return { ...code, expiresAt, client, user };
      },
    };
    const oauth = new OAuth2Server({
      model,
      authorizationCodeLifetime: 90,
      allowEmptyState: false,
    });
    const response = new OAuth2Server.Response();
    const code = await oauth.authorize(
      new OAuth2Server.Request({
        method: "GET",
        headers: {},
        query: {
          response_type: "code",
          client_id: locked.client_id,
          redirect_uri: locked.redirect_uri,
          scope: approved.join(" "),
          state: locked.state,
          code_challenge: locked.challenge,
          code_challenge_method: "S256",
        },
      }),
      response,
      { authenticateHandler: { handle: async () => ({ id: member.userId }) } },
    );
    redirect.searchParams.set("code", code.authorizationCode);
    return redirect.href;
  });
}

export async function exchangeToken(
  params: Record<string, string>,
): Promise<Response> {
  const presented =
    params.grant_type === "authorization_code"
      ? params.code
      : params.refresh_token;
  if (!presented || !/^[A-Za-z0-9_-]{43}$/.test(presented))
    return oauthFailure(
      400,
      "invalid_grant",
      "This credential is invalid or expired.",
    );
  const sql = oauthSql();
  try {
    const hints =
      params.grant_type === "authorization_code"
        ? await sql`select session_id,user_id,client_id,resource from oauth_requests where code_hash=${hash(presented)}`
        : await sql`select g.session_id,g.user_id,g.client_id,g.resource from oauth_tokens t join oauth_grants g on g.id=t.grant_id where t.refresh_hash=${hash(presented)}`;
    const hint = hints[0];
    if (
      !hint ||
      hint.client_id !== params.client_id ||
      hint.resource !== params.resource
    )
      return oauthFailure(
        400,
        "invalid_grant",
        "This credential is invalid or expired.",
      );
    const member = await verifiedMember(hint.session_id, hint.user_id);
    const outcome = await sql.begin(async (tx) => {
      let codeRequest: PendingRequest | undefined;
      let refresh:
        | {
            id: string;
            grant_id: string;
            scopes: McpScope[];
            expires_at: Date;
            refresh_expires_at: Date;
          }
        | undefined;
      const model: OAuth2Server.AuthorizationCodeModel &
        OAuth2Server.RefreshTokenModel = {
        getClient: async (id, suppliedSecret) =>
          suppliedSecret ? false : clientModel(id),
        getAccessToken: async () => false,
        saveAuthorizationCode: async () => false,
        generateAccessToken: async () => secret(),
        generateRefreshToken: async () => secret(),
        validateScope: async (_user, _client, requested) =>
          requested?.every((scope) =>
            (codeRequest?.scopes ?? refresh?.scopes ?? []).includes(
              scope as McpScope,
            ),
          )
            ? requested
            : false,
        getAuthorizationCode: async (code) => {
          const [row] = await tx<
            PendingRequest[]
          >`select * from oauth_requests where code_hash=${hash(code)} for update`;
          if (
            row?.status !== "authorized" ||
            row.code_consumed_at ||
            !row.code_expires_at ||
            row.resource !== mcpResource() ||
            row.client_id !== params.client_id ||
            row.session_id !== member.sessionId ||
            !/^[A-Za-z0-9_-]{43}$/.test(row.challenge)
          )
            return false;
          codeRequest = row;
          return {
            authorizationCode: code,
            expiresAt: row.code_expires_at,
            redirectUri: row.redirect_uri,
            scope: row.scopes,
            codeChallenge: row.challenge,
            codeChallengeMethod: "S256",
            client: clientModel(row.client_id) as OAuth2Server.Client,
            user: { id: row.user_id },
          };
        },
        revokeAuthorizationCode: async () => {
          if (!codeRequest) return false;
          const rows =
            await tx`update oauth_requests set code_consumed_at=now() where id=${codeRequest.id} and code_consumed_at is null returning id`;
          return rows.length === 1;
        },
        getRefreshToken: async (token) => {
          const [row] =
            await tx`select t.id,t.grant_id,t.scopes,t.refresh_expires_at,t.refresh_used_at,g.expires_at,g.revoked_at,g.client_id,g.resource,g.session_id from oauth_tokens t join oauth_grants g on g.id=t.grant_id where t.refresh_hash=${hash(token)} for update of g,t`;
          if (
            !row ||
            row.client_id !== params.client_id ||
            row.resource !== params.resource ||
            row.session_id !== member.sessionId ||
            row.revoked_at ||
            new Date(row.expires_at).getTime() <= Date.now()
          )
            return false;
          if (row.refresh_used_at) {
            await tx`update oauth_grants set revoked_at=now() where id=${row.grant_id}`;
            throw new OAuth2Server.InvalidGrantError("Refresh token reused");
          }
          // Reject widening before the library consumes this valid credential.
          if (
            params.scope &&
            parseScopes(params.scope).some(
              (scope) => !(row.scopes as McpScope[]).includes(scope),
            )
          )
            throw new OAuth2Server.InvalidScopeError(
              "Scope exceeds token grant",
            );
          refresh = row as typeof refresh;
          return {
            refreshToken: token,
            refreshTokenExpiresAt: row.refresh_expires_at,
            scope: row.scopes,
            client: clientModel(row.client_id) as OAuth2Server.Client,
            user: { id: member.userId },
          };
        },
        revokeToken: async () => {
          if (!refresh) return false;
          const rows =
            await tx`update oauth_tokens set refresh_used_at=now() where id=${refresh.id} and refresh_used_at is null returning id`;
          return rows.length === 1;
        },
        saveToken: async (token, client, user) => {
          const expires = Math.min(
            member.expiresAt,
            refresh ? new Date(refresh.expires_at).getTime() : member.expiresAt,
          );
          if (expires <= Date.now())
            throw new OAuth2Server.InvalidGrantError("Session expired");
          const grantId = refresh?.grant_id ?? randomUUID();
          if (codeRequest) {
            // Serialize only connection creation, across every web replica.
            await tx`select pg_advisory_xact_lock(hashtextextended(${`oauth-grants:${member.userId}`},0))`;
            const [capacity] =
              await tx`select count(*)::int as count from oauth_grants g join auth_sessions s on s.id=g.session_id where g.user_id=${member.userId} and g.revoked_at is null and g.expires_at>now() and s.expires_at>now()`;
            if (capacity.count >= 100)
              throw new OAuth2Server.InvalidGrantError(
                "Connection limit reached",
              );
            await tx`insert into oauth_grants (id,request_id,user_id,session_id,client_id,resource,scopes,expires_at) values (${grantId},${codeRequest.id},${member.userId},${member.sessionId},${client.id},${mcpResource()},${tx.json(token.scope ?? [])},${new Date(expires)})`;
          } else if (!refresh) throw new Error("MISSING_GRANT_CONTEXT");
          const accessExpiresAt = new Date(
            Math.min(Date.now() + 300_000, expires),
          );
          const refreshExpiresAt = new Date(
            Math.min(
              expires,
              refresh
                ? new Date(refresh.refresh_expires_at).getTime()
                : expires,
            ),
          );
          if (!token.refreshToken) throw new Error("MISSING_REFRESH_TOKEN");
          await tx`insert into oauth_tokens (id,grant_id,access_hash,refresh_hash,scopes,access_expires_at,refresh_expires_at) values (${randomUUID()},${grantId},${hash(token.accessToken)},${hash(token.refreshToken)},${tx.json(token.scope ?? [])},${accessExpiresAt},${refreshExpiresAt})`;
          return {
            ...token,
            accessTokenExpiresAt: accessExpiresAt,
            refreshTokenExpiresAt: refreshExpiresAt,
            client,
            user,
          };
        },
      };
      const oauth = new OAuth2Server({
        model,
        accessTokenLifetime: 300,
        refreshTokenLifetime: Math.max(
          1,
          Math.floor((member.expiresAt - Date.now()) / 1000),
        ),
        alwaysIssueNewRefreshToken: true,
        allowExtendedTokenAttributes: false,
        requireClientAuthentication: {
          authorization_code: false,
          refresh_token: false,
        },
      });
      try {
        const token = await oauth.token(
          new OAuth2Server.Request({
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "content-length": String(
                Buffer.byteLength(new URLSearchParams(params).toString()),
              ),
            },
            query: {},
            body: params,
          }),
          new OAuth2Server.Response(),
        );
        return {
          ok: true as const,
          body: {
            access_token: token.accessToken,
            token_type: "Bearer",
            expires_in: Math.max(
              0,
              Math.floor(
                ((token.accessTokenExpiresAt?.getTime() ?? 0) - Date.now()) /
                  1000,
              ),
            ),
            refresh_token: token.refreshToken,
            scope: token.scope?.join(" ") ?? "",
          },
        };
      } catch (error) {
        // ServerError also extends OAuthError: never commit arbitrary failures.
        if (
          error instanceof OAuth2Server.InvalidGrantError ||
          error instanceof OAuth2Server.InvalidRequestError ||
          error instanceof OAuth2Server.InvalidScopeError ||
          error instanceof OAuth2Server.InvalidClientError
        )
          return {
            ok: false as const,
            error: error.name,
            connectionLimit:
              error instanceof OAuth2Server.InvalidGrantError &&
              error.message === "Connection limit reached",
          };
        throw error;
      }
    });
    return outcome.ok
      ? Response.json(outcome.body, {
          headers: { "cache-control": "no-store", pragma: "no-cache" },
        })
      : oauthFailure(
          400,
          outcome.error,
          outcome.connectionLimit
            ? "Disconnect an existing agent in Household settings before connecting another."
            : "This request is invalid or its credential has expired. Reconnect if needed.",
        );
  } catch (error) {
    if (error instanceof BackendError && error.status < 500)
      return oauthFailure(
        400,
        "invalid_grant",
        "This connection has ended. Sign in again.",
      );
    return oauthFailure(
      503,
      "temporarily_unavailable",
      "Heima could not complete the request. Try again shortly.",
    );
  }
}
