import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { BackendError, backendFetch } from "@/lib/backend";
export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      throw new BackendError(
        401,
        "SIGN_IN_REQUIRED",
        "Please sign in to continue.",
      );
    if (request.headers.get("x-heima-actor-id") !== session.user.id)
      throw new BackendError(
        403,
        "SESSION_CHANGED",
        "Your signed-in account changed. Sign in again.",
      );
    const { path } = await context.params;
    const response = await backendFetch(
      `/v1/${path.map(encodeURIComponent).join("/")}${new URL(request.url).search}`,
    );
    return NextResponse.json(await response.json(), {
      status: response.status,
      headers: { "Cache-Control": "no-store, private" },
    });
  } catch (error) {
    const status = error instanceof BackendError ? error.status : 503;
    return NextResponse.json(
      {
        error: {
          code:
            error instanceof BackendError ? error.code : "SERVICE_UNAVAILABLE",
          message:
            error instanceof BackendError
              ? error.message
              : "Heima is temporarily unavailable. Try again shortly.",
        },
      },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
