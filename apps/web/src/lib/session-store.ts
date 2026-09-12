import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import postgres from "postgres";
import { z } from "zod";
import { env } from "./env";

type ProviderTokens = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
};
let connection: ReturnType<typeof postgres> | undefined;
function sql() {
  connection ??= postgres(env.DATABASE_URL, {
    max: 5,
    connection: { search_path: env.DATABASE_SCHEMA },
  });
  return connection;
}
function encryptionKey() {
  return createHash("sha256").update(env.AUTH_SECRET).digest();
}
function encrypt(value: ProviderTokens) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), body]
    .map((part) => part.toString("base64url"))
    .join(".");
}
function decrypt(value: string): ProviderTokens {
  const [iv, tag, body] = value
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(body), cipher.final()]).toString("utf8"),
  );
}
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
export async function verifyProviderToken(accessToken: string) {
  if (
    env.NODE_ENV === "production" &&
    env.USABLE_ISSUER !== "https://auth.flowcore.io/realms/memory-mesh"
  )
    throw new Error("UNTRUSTED_ISSUER");
  jwks ??= createRemoteJWKSet(
    new URL(`${env.USABLE_ISSUER}/protocol/openid-connect/certs`),
  );
  const { payload } = await jwtVerify(accessToken, jwks, {
    issuer: env.USABLE_ISSUER,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "sub", "azp"],
  });
  if (
    payload.azp !== env.USABLE_CLIENT_ID ||
    (payload.typ && payload.typ !== "Bearer")
  )
    throw new Error("WRONG_APPLICATION");
  if (
    !Array.isArray(payload.groups) ||
    !payload.groups.includes(`/app-marketplace-${env.USABLE_CLIENT_ID}-users`)
  )
    throw new Error("INVITATION_REQUIRED");
  const userId = z.string().uuid().parse(payload.usable_user_id);
  const subject = z.string().uuid().parse(payload.sub);
  return {
    userId,
    subject,
    name: typeof payload.name === "string" ? payload.name : "Household member",
  };
}
export async function createProviderSession(tokens: ProviderTokens) {
  const identity = await verifyProviderToken(tokens.accessToken);
  const id = randomUUID();
  await sql()`insert into auth_sessions (id, user_id, encrypted_tokens, expires_at) values (${id}, ${identity.userId}, ${encrypt(tokens)}, ${new Date(Date.now() + 8 * 60 * 60 * 1000)})`;
  return { id, ...identity };
}
export async function sessionBearer(id: string): Promise<string | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  return sql().begin(async (tx) => {
    const [row] =
      await tx`select user_id, encrypted_tokens, expires_at from auth_sessions where id=${id} for update`;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await tx`delete from auth_sessions where id=${id}`;
      return null;
    }
    const tokens = decrypt(row.encrypted_tokens);
    if (tokens.expiresAt > Date.now() + 60_000) return tokens.accessToken;
    if (!tokens.refreshToken) {
      await tx`delete from auth_sessions where id=${id}`;
      return null;
    }
    const response = await fetch(
      `${env.USABLE_ISSUER}/protocol/openid-connect/token`,
      {
        method: "POST",
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: env.USABLE_CLIENT_ID,
          client_secret: env.USABLE_CLIENT_SECRET,
          refresh_token: tokens.refreshToken,
        }),
      },
    );
    if (!response.ok) {
      if (response.status >= 500)
        throw new Error("IDENTITY_PROVIDER_UNAVAILABLE");
      await tx`delete from auth_sessions where id=${id}`;
      return null;
    }
    const next = await response.json();
    if (
      typeof next.access_token !== "string" ||
      typeof next.expires_in !== "number"
    )
      throw new Error("INVALID_REFRESH_RESPONSE");
    try {
      const refreshedIdentity = await verifyProviderToken(next.access_token);
      // The original token was verified before being encrypted into this row.
      // Decode only to pin its subject across refresh, including legacy rows.
      const original = decodeJwt(tokens.accessToken);
      if (
        refreshedIdentity.userId !== (row.user_id ?? original.usable_user_id) ||
        refreshedIdentity.subject !== original.sub
      )
        throw new Error("SESSION_PRINCIPAL_CHANGED");
    } catch {
      await tx`delete from auth_sessions where id=${id}`;
      return null;
    }
    const refreshed: ProviderTokens = {
      accessToken: next.access_token,
      refreshToken: next.refresh_token ?? tokens.refreshToken,
      idToken: next.id_token ?? tokens.idToken,
      expiresAt: Date.now() + next.expires_in * 1000,
    };
    await tx`update auth_sessions set encrypted_tokens=${encrypt(refreshed)} where id=${id}`;
    return refreshed.accessToken;
  });
}
export async function destroyProviderSession(id: string) {
  const [row] =
    await sql()`delete from auth_sessions where id=${id} returning encrypted_tokens`;
  if (!row) return;
  const tokens = decrypt(row.encrypted_tokens);
  if (!tokens.refreshToken) return;
  const body = new URLSearchParams({
    client_id: env.USABLE_CLIENT_ID,
    client_secret: env.USABLE_CLIENT_SECRET,
    refresh_token: tokens.refreshToken,
  });
  if (tokens.idToken) body.set("id_token_hint", tokens.idToken);
  // Local custody is already revoked above. Remote provider logout is best
  // effort and must not hold the browser on the signed-in page when the
  // provider is slow or unavailable.
  void fetch(`${env.USABLE_ISSUER}/protocol/openid-connect/logout`, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  }).catch(() => undefined);
}

export async function providerSessionLease(
  id: string,
): Promise<{ expiresAt: number } | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [row] =
    await sql()`select encrypted_tokens, expires_at from auth_sessions where id=${id}`;
  if (!row) return null;
  const tokens = decrypt(row.encrypted_tokens);
  const expiresAt = Math.min(
    tokens.expiresAt,
    new Date(row.expires_at).getTime(),
  );
  return expiresAt > Date.now() ? { expiresAt } : null;
}

// Operational session metadata only; never expose encrypted provider custody.
export async function providerSessionMetadata(id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [row] =
    await sql()`select user_id, expires_at from auth_sessions where id=${id}`;
  if (!row?.user_id || new Date(row.expires_at).getTime() <= Date.now())
    return null;
  return {
    userId: String(row.user_id),
    expiresAt: new Date(row.expires_at).getTime(),
  };
}
