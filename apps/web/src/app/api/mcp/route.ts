import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  admitGrant,
  admitRequest,
  busy,
  releaseAfterResponse,
} from "@/lib/mcp/admission";
import { createMcpServer, toolScopes } from "@/lib/mcp/server";
import { issuer } from "@/lib/oauth/clients";
import { authenticateMcpRequest, requireMcpScopes } from "@/lib/oauth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 65536;
function fail(status: number, error: string) {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "no-store" } },
  );
}
async function body(request: Request) {
  if (!request.body) throw new Error("invalid-request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 10000);
  try {
    while (true) {
      const chunk = await reader.read();
      if (expired) throw new Error("invalid-request");
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_BODY_BYTES) throw new Error("request-too-large");
      chunks.push(chunk.value);
    }
  } finally {
    clearTimeout(deadline);
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
async function serve(
  request: Request,
  acquired: (release: () => void) => void,
) {
  const origin = issuer();
  if (
    request.headers.get("host") !== new URL(origin).host ||
    (request.headers.has("origin") && request.headers.get("origin") !== origin)
  )
    return fail(403, "invalid-origin");
  const authenticated = await authenticateMcpRequest(request);
  if (!authenticated.ok) return authenticated.response;
  const grantRelease = admitGrant(authenticated.context.grantId);
  if (!grantRelease) return busy();
  acquired(grantRelease);
  const basicScope = requireMcpScopes(authenticated.context, ["heima.read"]);
  if (basicScope) return basicScope;
  if (request.method !== "POST")
    return new Response(null, {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return fail(415, "unsupported-media-type");
  let parsed: unknown;
  try {
    parsed = await body(request);
  } catch (error) {
    return fail(
      error instanceof Error && error.message === "request-too-large"
        ? 413
        : 400,
      "invalid-request",
    );
  }
  // MCP does not accept JSON-RPC batches. Preflight scope errors carry HTTP OAuth challenges.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return fail(400, "invalid-request");
  const rpc = parsed as { method?: unknown; params?: { name?: unknown } };
  if (rpc.method === "tools/call" && typeof rpc.params?.name === "string") {
    const required = Object.hasOwn(toolScopes, rpc.params.name)
      ? toolScopes[rpc.params.name]
      : undefined;
    if (required) {
      const denied = requireMcpScopes(authenticated.context, required);
      if (denied) return denied;
    }
  }
  const handler = createMcpHandler(
    () => createMcpServer(request, authenticated.context),
    { legacy: "stateless" },
  );
  try {
    const response = await handler.fetch(request, {
      parsedBody: parsed,
    });
    response.headers.set("cache-control", "no-store");
    response.headers.set("pragma", "no-cache");
    return response;
  } catch {
    await handler.close();
    return fail(500, "temporarily-unavailable");
  }
}
async function handle(request: Request) {
  const releaseRequest = admitRequest();
  if (!releaseRequest) return busy();
  let releaseGrant: (() => void) | undefined;
  const release = () => {
    releaseGrant?.();
    releaseRequest();
  };
  try {
    return releaseAfterResponse(
      await serve(request, (fn) => {
        releaseGrant = fn;
      }),
      release,
    );
  } catch {
    release();
    return fail(503, "temporarily-unavailable");
  }
}
export const POST = handle;
export const GET = handle;
export const DELETE = handle;
