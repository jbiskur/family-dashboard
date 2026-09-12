import "server-only";
import { env } from "../env";
import type { McpScope } from "./types";

export const scopes: readonly McpScope[] = [
  "heima.read",
  "heima.shopping.write",
  "heima.work.write",
  "heima.finance.read",
];
export type OAuthClient = {
  id: string;
  name: string;
  callbackUri: string;
  callbackPort: number;
};

export const clients: readonly OAuthClient[] = [
  {
    id: "ae7d2f6d-5d9d-4d17-8bdf-1c4b0b62e984",
    name: "Codex",
    callbackUri: "http://127.0.0.1:43215/callback",
    callbackPort: 43215,
  },
  {
    id: "955329f3-8992-4e39-899c-2653f94cbbe6",
    name: "Claude Code",
    callbackUri: "http://localhost:43216/callback",
    callbackPort: 43216,
  },
  {
    // Public, pre-registered profile for Coder's per-server callback. Coder
    // supplies a new callback path for each MCP configuration, so validation
    // below applies the exact approved path shape instead of a URL wildcard.
    id: "4e4eaeff-2a9f-48d2-a111-78371a0589c6",
    name: "Coder",
    callbackUri: "",
    callbackPort: 0,
  },
];

const coderCallbackPattern =
  /^\/api\/(?:experimental\/)?mcp\/servers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/oauth2\/callback$/i;

export function validCoderRedirect(uri: string) {
  try {
    const parsed = new URL(uri);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
      parsed.hostname,
    );
    return (
      (parsed.protocol === "https:" ||
        (parsed.protocol === "http:" && loopback)) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      coderCallbackPattern.test(parsed.pathname) &&
      uri === parsed.href
    );
  } catch {
    return false;
  }
}
export function issuer() {
  const url = new URL(env.AUTH_URL);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      (url.protocol !== "http:" ||
        !["localhost", "127.0.0.1"].includes(url.hostname)))
  )
    throw new Error("INVALID_OAUTH_ORIGIN");
  return url.origin;
}
export function mcpResource() {
  return `${issuer()}/api/mcp`;
}
export function registeredClient(id: string) {
  return clients.find((client) => client.id === id);
}
export function validRedirect(clientId: string, uri: string) {
  const client = registeredClient(clientId);
  if (!client || typeof uri !== "string" || uri.length > 500) return false;
  if (!client.callbackUri)
    return client.name === "Coder" && validCoderRedirect(uri);
  try {
    const actual = new URL(uri),
      expected = new URL(client.callbackUri);
    return (
      actual.protocol === "http:" &&
      actual.hostname === expected.hostname &&
      actual.pathname === expected.pathname &&
      !actual.username &&
      !actual.password &&
      !actual.search &&
      !actual.hash &&
      actual.port !== "0" &&
      uri === actual.href
    );
  } catch {
    return false;
  }
}
export function parseScopes(value: string) {
  const requested = value.split(" ");
  if (
    !requested.length ||
    requested.length > scopes.length ||
    new Set(requested).size !== requested.length ||
    requested.some((scope) => !scopes.includes(scope as McpScope)) ||
    !requested.includes("heima.read")
  )
    throw new Error("INVALID_SCOPE");
  return requested as McpScope[];
}
