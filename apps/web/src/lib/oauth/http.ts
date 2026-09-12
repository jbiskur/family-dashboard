import "server-only";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import {
  issuer,
  mcpResource,
  parseScopes,
  registeredClient,
  scopes,
  validRedirect,
} from "./clients";
import { exchangeToken } from "./protocol";
import { oauthFailure } from "./server";
import {
  browserCookie,
  hash,
  oauthSql,
  retireExpiredOAuthState,
  secret,
} from "./store";

const buckets = new Map<string, { start: number; count: number }>();
function limited(key: string) {
  const now = Date.now();
  for (const [id, entry] of buckets)
    if (now - entry.start > 60_000) buckets.delete(id);
  if (!buckets.has(key) && buckets.size >= 1024) return true;
  const entry = buckets.get(key) ?? { start: now, count: 0 };
  entry.count++;
  buckets.set(key, entry);
  return entry.count > 120;
}
function parse(params: URLSearchParams, allowed: string[]) {
  const data: Record<string, string> = {};
  for (const [key, value] of params) {
    // RFC 8707 repeats resource. Some clients add the same resource twice.
    if (
      key === "resource" &&
      key in data &&
      data[key] === value &&
      value === mcpResource()
    )
      continue;
    if (!allowed.includes(key) || key in data || value.length > 2048)
      throw new Error("INVALID_REQUEST");
    data[key] = value;
  }
  return data;
}
async function form(request: Request, allowed: string[]) {
  if (
    request.method !== "POST" ||
    request.headers.get("authorization") ||
    new URL(request.url).search ||
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/x-www-form-urlencoded"
  )
    throw new Error("INVALID_REQUEST");
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 8192) throw new Error("INVALID_REQUEST");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_REQUEST");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        await reader.cancel();
        throw new Error("INVALID_REQUEST");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("INVALID_REQUEST");
  }
  return parse(new URLSearchParams(decoded), allowed);
}
function requestFailure(error: unknown, description: string) {
  return error instanceof Error &&
    ["INVALID_REQUEST", "INVALID_SCOPE"].includes(error.message)
    ? oauthFailure(400, "invalid_request", description)
    : oauthFailure(
        503,
        "temporarily_unavailable",
        "Heima could not complete the request. Try again shortly.",
      );
}
export function authorizationMetadata() {
  return Response.json(
    {
      issuer: issuer(),
      authorization_endpoint: `${issuer()}/api/oauth/authorize`,
      token_endpoint: `${issuer()}/api/oauth/token`,
      revocation_endpoint: `${issuer()}/api/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: scopes,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
export function protectedResourceMetadata() {
  return Response.json(
    {
      resource: mcpResource(),
      resource_name: "Heima",
      authorization_servers: [issuer()],
      bearer_methods_supported: ["header"],
      scopes_supported: scopes,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
export async function authorizeRequest(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.search.length > 8192) throw new Error("INVALID_REQUEST");
    const data = parse(url.searchParams, [
      "response_type",
      "client_id",
      "redirect_uri",
      "resource",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
    ]);
    if (
      data.response_type !== "code" ||
      !registeredClient(data.client_id) ||
      !validRedirect(data.client_id, data.redirect_uri) ||
      data.resource !== mcpResource() ||
      !/^[\x21-\x7e]{1,1024}$/.test(data.state ?? "") ||
      data.code_challenge_method !== "S256" ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.code_challenge ?? "")
    )
      throw new Error("INVALID_REQUEST");
    const requestedScopes = parseScopes(data.scope ?? "heima.read");
    if (limited(`authorize:${data.client_id}`))
      return oauthFailure(
        429,
        "temporarily_unavailable",
        "Too many connection attempts. Try again in a minute.",
      );
    await retireExpiredOAuthState();
    const jar = await cookies();
    const previous = jar.get(browserCookie)?.value;
    const browser =
      previous && /^[A-Za-z0-9_-]{43}$/.test(previous) ? previous : secret();
    jar.set(browserCookie, browser, {
      httpOnly: true,
      secure: issuer().startsWith("https:"),
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 60 * 60,
    });
    const id = randomUUID();
    await oauthSql()`insert into oauth_requests (id,browser_hash,client_id,redirect_uri,resource,scopes,state,challenge,expires_at) values (${id},${hash(browser)},${data.client_id},${data.redirect_uri},${data.resource},${oauthSql().json(requestedScopes)},${data.state},${data.code_challenge},${new Date(Date.now() + 600_000)})`;
    return new Response(null, {
      status: 302,
      headers: {
        location: `${issuer()}/oauth/consent?request=${id}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    return requestFailure(
      error,
      "The connection request is invalid. Start again from your agent.",
    );
  }
}
export async function tokenRequest(request: Request) {
  try {
    const data = await form(request, [
      "grant_type",
      "client_id",
      "resource",
      "code",
      "code_verifier",
      "redirect_uri",
      "refresh_token",
      "scope",
    ]);
    if (
      !registeredClient(data.client_id) ||
      data.resource !== mcpResource() ||
      !["authorization_code", "refresh_token"].includes(data.grant_type)
    )
      throw new Error("INVALID_REQUEST");
    if (
      data.grant_type === "authorization_code" &&
      (!validRedirect(data.client_id, data.redirect_uri) ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(data.code_verifier ?? ""))
    )
      throw new Error("INVALID_REQUEST");
    if ("scope" in data) parseScopes(data.scope);
    if (limited(`token:${data.client_id}`))
      return oauthFailure(
        429,
        "temporarily_unavailable",
        "Too many requests. Try again in a minute.",
      );
    return exchangeToken(data);
  } catch (error) {
    return requestFailure(error, "The token request is invalid.");
  }
}
export async function revocationRequest(request: Request) {
  try {
    const data = await form(request, ["client_id", "token", "token_type_hint"]);
    if (
      !registeredClient(data.client_id) ||
      !/^[A-Za-z0-9_-]{43}$/.test(data.token ?? "") ||
      (data.token_type_hint &&
        !["access_token", "refresh_token"].includes(data.token_type_hint))
    )
      throw new Error("INVALID_REQUEST");
    if (limited(`revoke:${data.client_id}`))
      return oauthFailure(
        429,
        "temporarily_unavailable",
        "Too many requests. Try again in a minute.",
      );
    await oauthSql()`update oauth_grants set revoked_at=coalesce(revoked_at,now()) where client_id=${data.client_id} and id in (select grant_id from oauth_tokens where access_hash=${hash(data.token)} or refresh_hash=${hash(data.token)})`;
    return new Response(null, {
      status: 200,
      headers: { "cache-control": "no-store", pragma: "no-cache" },
    });
  } catch (error) {
    return requestFailure(error, "The revocation request is invalid.");
  }
}
