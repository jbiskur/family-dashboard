import "server-only";

// Per-process admission bounds, independent of untrusted forwarding headers.
let inFlight = 0;
const grants = new Map<string, number>();
export function admitRequest() {
  if (inFlight >= 32) return null;
  inFlight++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      inFlight--;
    }
  };
}
export function admitGrant(grantId: string) {
  const count = grants.get(grantId) ?? 0;
  if (count >= 4) return null;
  grants.set(grantId, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (grants.get(grantId) ?? 1) - 1;
    if (remaining) grants.set(grantId, remaining);
    else grants.delete(grantId);
  };
}
export function busy() {
  return Response.json(
    {
      error: "temporarily_unavailable",
      error_description: "Too many requests are in progress. Retry shortly.",
    },
    {
      status: 429,
      headers: { "cache-control": "no-store", "retry-after": "2" },
    },
  );
}
export function releaseAfterResponse(response: Response, release: () => void) {
  if (
    !response.body ||
    !response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
