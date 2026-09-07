import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { requireMember } from "./access";
import { verifyIdentity } from "./auth";
import { config } from "./config";
import { sqlClient } from "./db/client";

// Same private custody wire format as the Next BFF. No token-returning HTTP endpoint exists.
type Tokens = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
};
function key() {
  return createHash("sha256").update(config.AUTH_SECRET!).digest();
}
function decrypt(value: string): Tokens {
  const [iv, tag, body] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv!);
  decipher.setAuthTag(tag!);
  return JSON.parse(
    Buffer.concat([decipher.update(body!), decipher.final()]).toString("utf8"),
  );
}
function encrypt(value: Tokens) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), body]
    .map((p) => p.toString("base64url"))
    .join(".");
}
export async function confirmRecipient(userId: string): Promise<boolean> {
  if (!config.AUTH_SECRET || !config.USABLE_CLIENT_SECRET) return false;
  try {
    const token = await sqlClient.begin(async (tx) => {
      const [row] =
        await tx`select id, encrypted_tokens from auth_sessions where user_id=${userId} and expires_at>now() order by created_at desc limit 1 for update`;
      if (!row) return null;
      let value = decrypt(String(row.encrypted_tokens));
      if (value.expiresAt <= Date.now() + 60_000) {
        if (!value.refreshToken) return null;
        const response = await fetch(
          `${config.USABLE_OIDC_ISSUER}/protocol/openid-connect/token`,
          {
            method: "POST",
            cache: "no-store",
            signal: AbortSignal.timeout(10_000),
            body: new URLSearchParams({
              grant_type: "refresh_token",
              client_id: config.USABLE_APP_ID,
              client_secret: config.USABLE_CLIENT_SECRET!,
              refresh_token: value.refreshToken,
            }),
          },
        );
        if (!response.ok) {
          if (response.status < 500)
            await tx`delete from auth_sessions where id=${row.id}`;
          return null;
        }
        const next = (await response.json()) as {
          access_token?: unknown;
          refresh_token?: unknown;
          id_token?: unknown;
          expires_in?: unknown;
        };
        if (
          typeof next.access_token !== "string" ||
          typeof next.expires_in !== "number"
        )
          return null;
        value = {
          accessToken: next.access_token,
          refreshToken:
            typeof next.refresh_token === "string"
              ? next.refresh_token
              : value.refreshToken,
          idToken:
            typeof next.id_token === "string" ? next.id_token : value.idToken,
          expiresAt: Date.now() + next.expires_in * 1000,
        };
        // Validate eligibility and identity BEFORE persisting a refreshed credential.
        const identity = await verifyIdentity(`Bearer ${value.accessToken}`);
        if (identity.userId !== userId) return null;
        await tx`update auth_sessions set encrypted_tokens=${encrypt(value)} where id=${row.id}`;
      }
      return value.accessToken;
    });
    if (!token) return false;
    const identity = await verifyIdentity(`Bearer ${token}`);
    if (identity.userId !== userId) return false;
    await requireMember(identity);
    return true;
  } catch {
    return false;
  }
}
