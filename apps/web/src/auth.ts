import NextAuth from "next-auth";
import type { OAuthConfig } from "next-auth/providers";
import { env } from "@/lib/env";
import {
  createProviderSession,
  destroyProviderSession,
  PROVIDER_SESSION_MAX_AGE_SECONDS,
  verifyProviderToken,
} from "@/lib/session-store";

const provider: OAuthConfig<Record<string, unknown>> = {
  id: "usable",
  name: "Usable",
  type: "oidc",
  issuer: env.USABLE_ISSUER,
  clientId: env.USABLE_CLIENT_ID,
  clientSecret: env.USABLE_CLIENT_SECRET,
  checks: ["pkce", "state", "nonce"],
  // Request an offline-capable provider refresh token. The token remains
  // encrypted in the server-only session store; it is never sent to the UI.
  authorization: {
    params: { scope: "openid profile email offline_access" },
  },
  profile(profile) {
    return {
      id: String(profile.sub),
      name:
        typeof profile.name === "string" ? profile.name : "Household member",
    };
  },
};
export const { auth, handlers, signIn, signOut } = NextAuth({
  secret: env.AUTH_SECRET,
  trustHost: true,
  providers: [provider],
  session: { strategy: "jwt", maxAge: PROVIDER_SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/", error: "/auth/error" },
  callbacks: {
    async signIn({ account }) {
      if (!account?.access_token) return false;
      try {
        await verifyProviderToken(account.access_token);
        return true;
      } catch {
        return false;
      }
    },
    async jwt({ token, account }) {
      if (account?.access_token) {
        const stored = await createProviderSession({
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          idToken: account.id_token,
          expiresAt: (account.expires_at ?? 0) * 1000,
        });
        return { sub: stored.userId, name: stored.name, sessionId: stored.id };
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.sub ?? "";
      return {
        ...session,
        sessionId: typeof token.sessionId === "string" ? token.sessionId : "",
      };
    },
    redirect({ url, baseUrl }) {
      return url.startsWith("/")
        ? `${baseUrl}${url}`
        : new URL(url).origin === baseUrl
          ? url
          : `${baseUrl}/dashboard`;
    },
  },
  events: {
    async signOut(message) {
      if ("token" in message && typeof message.token?.sessionId === "string")
        await destroyProviderSession(message.token.sessionId);
    },
  },
  logger: {
    error(error) {
      console.error("Authentication could not be completed", error.name);
    },
  },
});
