"use server";
import { headers } from "next/headers";
import { z } from "zod";
import { BackendError } from "../backend";
import { issuer, scopes } from "./clients";
import { consentDecision } from "./protocol";
import { currentMember } from "./server";
import { oauthSql } from "./store";
import type { ActionFailure, McpScope } from "./types";

export async function decideAgentConsent(input: {
  requestId: string;
  csrfToken: string;
  decision: "approve" | "cancel";
  scopes: McpScope[];
}): Promise<{ ok: true; redirectTo: string } | ActionFailure> {
  try {
    const valid = z
      .object({
        requestId: z.string().uuid(),
        csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        decision: z.enum(["approve", "cancel"]),
        scopes: z
          .array(
            z.string().refine((scope) => scopes.includes(scope as McpScope)),
          )
          .max(4),
      })
      .strict()
      .parse(input);
    return {
      ok: true,
      redirectTo: await consentDecision({
        ...valid,
        scopes: valid.scopes as McpScope[],
      }),
    };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof BackendError ? error.code : "CONSENT_FAILED",
      message:
        error instanceof BackendError
          ? error.message
          : "The connection could not be approved. Check your selection and try again.",
    };
  }
}
export async function revokeAgentConnection(
  connectionId: string,
): Promise<{ ok: true } | ActionFailure> {
  try {
    z.string().uuid().parse(connectionId);
    if ((await headers()).get("origin") !== issuer())
      throw new Error("INVALID_ORIGIN");
    const member = await currentMember();
    const rows =
      await oauthSql()`update oauth_grants set revoked_at=coalesce(revoked_at,now()) where id=${connectionId} and user_id=${member.userId} returning id`;
    if (!rows.length)
      return {
        ok: false,
        code: "NOT_FOUND",
        message: "This connection is not available.",
      };
    return { ok: true };
  } catch {
    return {
      ok: false,
      code: "REVOKE_FAILED",
      message: "The connection could not be disconnected. Try again shortly.",
    };
  }
}
