import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import postgres from "postgres";
import { env } from "../env";
import type { McpScope } from "./types";

let connection: ReturnType<typeof postgres> | undefined;
export function oauthSql() {
  connection ??= postgres(env.DATABASE_URL, {
    max: 4,
    connection: { search_path: env.DATABASE_SCHEMA },
  });
  return connection;
}
export type OAuthSql = ReturnType<typeof oauthSql>;
export function secret() {
  return randomBytes(32).toString("base64url");
}
export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function csrf(requestId: string, sessionId: string, browser: string) {
  return createHmac("sha256", env.AUTH_SECRET)
    .update(JSON.stringify(["oauth-consent", requestId, sessionId, browser]))
    .digest("base64url");
}
export const browserCookie = "heima-oauth-browser";
let lastRetirement = 0;
export async function retireExpiredOAuthState() {
  if (Date.now() - lastRetirement < 60_000) return;
  await oauthSql().begin(async (tx) => {
    // Keep spent refresh tombstones for the whole grant lifetime, plus 24h.
    await tx`delete from oauth_tokens where id in (select t.id from oauth_tokens t join oauth_grants g on g.id=t.grant_id where g.expires_at < now()-interval '24 hours' limit 1000 for update of t skip locked)`;
    await tx`delete from oauth_grants where id in (select g.id from oauth_grants g where g.expires_at < now()-interval '24 hours' and not exists(select 1 from oauth_tokens t where t.grant_id=g.id) limit 200 for update skip locked)`;
    await tx`delete from oauth_requests where id in (select r.id from oauth_requests r where r.expires_at < now()-interval '1 hour' and not exists(select 1 from oauth_grants g where g.request_id=r.id) limit 500 for update skip locked)`;
  });
  lastRetirement = Date.now();
}
export type PendingRequest = {
  id: string;
  browser_hash: string;
  session_id: string | null;
  user_id: string | null;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scopes: McpScope[];
  state: string;
  challenge: string;
  status: string;
  code_hash: string | null;
  expires_at: Date;
  code_expires_at: Date | null;
  code_consumed_at: Date | null;
};
