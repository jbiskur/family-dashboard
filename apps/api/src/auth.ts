import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { config } from "./config";
import { ApiFailure } from "./errors";

export type Identity = {
  userId: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  token: string;
};
const jwks = createRemoteJWKSet(
  new URL(`${config.USABLE_OIDC_ISSUER}/protocol/openid-connect/certs`),
  { cooldownDuration: 30_000, cacheMaxAge: 600_000 },
);
const claimsSchema = z.object({
  sub: z.string().uuid(),
  usable_user_id: z.string().uuid(),
  exp: z.number(),
  typ: z.literal("Bearer"),
  azp: z.literal(config.USABLE_APP_ID),
  groups: z.array(z.string()),
  email: z.string().email().optional(),
  email_verified: z.boolean().optional(),
});

export async function verifyIdentity(
  header: string | undefined,
): Promise<Identity> {
  const token = /^Bearer ([^\s]+)$/i.exec(header ?? "")?.[1];
  if (!token)
    throw new ApiFailure("invalid-token", 401, "Sign in to continue.");
  let claims: z.infer<typeof claimsSchema>;
  try {
    const verified = await jwtVerify(token, jwks, {
      issuer: config.USABLE_OIDC_ISSUER,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
      clockTolerance: 5,
    });
    claims = claimsSchema.parse(verified.payload);
  } catch {
    throw new ApiFailure(
      "invalid-token",
      401,
      "Your session could not be verified. Sign in again.",
    );
  }
  if (!claims.groups.includes(`/app-marketplace-${config.USABLE_APP_ID}-users`))
    throw new ApiFailure(
      "not-installed",
      403,
      "This app requires an invitation.",
    );
  let response: Response;
  try {
    response = await fetch(
      `${config.USABLE_API_BASE_URL}/api/marketplace/apps/${config.USABLE_APP_ID}/check-access`,
      {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      },
    );
  } catch {
    throw new ApiFailure(
      "eligibility-unavailable",
      503,
      "Access verification is temporarily unavailable. Try again shortly.",
    );
  }
  if (response.status === 401)
    throw new ApiFailure("invalid-token", 401, "Sign in again to continue.");
  if (response.status === 403 || response.status === 404)
    throw new ApiFailure(
      "not-installed",
      403,
      "This app requires an active invitation.",
    );
  if (!response.ok)
    throw new ApiFailure(
      "eligibility-unavailable",
      503,
      "Access verification is temporarily unavailable. Try again shortly.",
    );
  const access = (await response.json().catch(() => null)) as {
    installed?: unknown;
    accessPolicy?: { kind?: unknown };
  } | null;
  if (
    !access ||
    typeof access.installed !== "boolean" ||
    access.accessPolicy?.kind !== "invite-only"
  )
    throw new ApiFailure(
      "eligibility-unavailable",
      503,
      "This app's access policy could not be verified.",
    );
  if (!access.installed)
    throw new ApiFailure(
      "not-installed",
      403,
      "This app requires an active invitation.",
    );
  return {
    userId: claims.usable_user_id,
    subject: claims.sub,
    email: claims.email?.trim().toLowerCase(),
    emailVerified: claims.email_verified === true,
    token,
  };
}
