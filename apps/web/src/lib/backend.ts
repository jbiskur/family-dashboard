import "server-only";
import { auth } from "@/auth";
import { env } from "./env";
import { sessionBearer } from "./session-store";

export class BackendError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function backendFetch(path: string, init: RequestInit = {}) {
  const session = await auth();
  if (!session?.sessionId)
    throw new BackendError(
      401,
      "SIGN_IN_REQUIRED",
      "Please sign in to continue.",
    );
  return backendFetchForSession(session.sessionId, path, init);
}

// Server-only entry for a session reference verified by the delegated OAuth guard.
export async function backendFetchForSession(
  sessionId: string,
  path: string,
  init: RequestInit = {},
) {
  if (!/^\/v1\/[a-zA-Z0-9/_-]+(?:\?[^#\r\n]*)?$/.test(path))
    throw new BackendError(400, "INVALID_PATH", "Invalid request.");
  const target = new URL(path, env.HEIMA_API_URL);
  if (target.origin !== new URL(env.HEIMA_API_URL).origin)
    throw new BackendError(400, "INVALID_PATH", "Invalid request.");
  const bearer = await sessionBearer(sessionId);
  if (!bearer)
    throw new BackendError(
      401,
      "SESSION_EXPIRED",
      "Your session ended. Please sign in again.",
    );
  return fetch(target, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(45000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
  });
}
export async function backendJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await backendFetch(path, init);
  const body = await response.json();
  if (!response.ok)
    throw new BackendError(
      response.status,
      body.error?.code ?? "REQUEST_FAILED",
      body.error?.message ?? "Something went wrong. Please try again.",
    );
  return body as T;
}
