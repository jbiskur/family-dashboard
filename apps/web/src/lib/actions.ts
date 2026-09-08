"use server";
import { auth } from "@/auth";
import { BackendError, backendJson } from "./backend";

export async function emitEvent(
  path: string,
  data: Record<string, unknown>,
  expectedActorId: string,
) {
  try {
    const session = await auth();
    if (!expectedActorId || session?.user?.id !== expectedActorId)
      return {
        ok: false as const,
        error: {
          code: "SESSION_CHANGED",
          message:
            "Your signed-in account changed. Sign in again before making changes.",
          status: 403,
        },
      };
    const result = await backendJson(
      path.startsWith("/v1/") ? path : `/v1/${path.replace(/^\//, "")}`,
      { method: "POST", body: JSON.stringify(data) },
    );
    return { ok: true as const, data: result };
  } catch (error) {
    if (error instanceof BackendError)
      return {
        ok: false as const,
        error: {
          code: error.code,
          message: error.message,
          status: error.status,
        },
      };
    return {
      ok: false as const,
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "We couldn't reach Heima. Keep your changes and try again.",
        status: 503,
      },
    };
  }
}
