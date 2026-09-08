import type { AccessResponse } from "@heima/contracts";
import { auth } from "@/auth";
import { BackendError, backendJson } from "@/lib/backend";
import { providerSessionLease } from "@/lib/session-store";

export async function GET(request: Request) {
  const headers = { "cache-control": "no-store" };
  try {
    const session = await auth();
    if (!session?.sessionId)
      return Response.json(
        { error: "sign-in-required" },
        { status: 401, headers },
      );
    const expectedActor = request.headers.get("x-heima-actor-id");
    if (expectedActor && expectedActor !== session.user?.id)
      return Response.json(
        { error: "session-changed" },
        { status: 403, headers },
      );
    // Current Usable eligibility and household admission are required to renew.
    // backendJson refreshes provider custody under the shared row lock.
    const access = await backendJson<AccessResponse>("/v1/access");
    const lease = await providerSessionLease(session.sessionId);
    return lease
      ? Response.json(
          {
            ...lease,
            actorId: access.member.userId,
            householdId: access.household.id,
          },
          { headers },
        )
      : Response.json({ error: "session-expired" }, { status: 401, headers });
  } catch (error) {
    return Response.json(
      { error: "access-unavailable" },
      { status: error instanceof BackendError ? error.status : 503, headers },
    );
  }
}
