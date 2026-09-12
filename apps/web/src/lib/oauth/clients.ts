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
  callbackUris?: readonly string[];
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
    // Public, pre-registered profile for the Usable Chat MCP client. The
    // callback is fixed by the deployed Usable Chat application; local and
    // legacy hosts are listed explicitly so no redirect wildcard is needed.
    id: "40c9eee8-9eee-4742-9025-2ce398b78437",
    name: "Usable Chat",
    callbackUri: "https://chat.usable.dev/api/mcp-servers/oauth/callback",
    callbackPort: 0,
    callbackUris: [
      "https://chat.usable.tools/api/mcp-servers/oauth/callback",
      "http://localhost:3001/api/mcp-servers/oauth/callback",
      "http://localhost:3002/api/mcp-servers/oauth/callback",
      "http://127.0.0.1:3001/api/mcp-servers/oauth/callback",
      "http://127.0.0.1:3002/api/mcp-servers/oauth/callback",
    ],
  },
];

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
export function clientRedirectUris(client: OAuthClient) {
  return [client.callbackUri, ...(client.callbackUris ?? [])].filter(
    (uri): uri is string => Boolean(uri),
  );
}
export function validRedirect(clientId: string, uri: string) {
  const client = registeredClient(clientId);
  if (!client || typeof uri !== "string" || uri.length > 500) return false;
  if (client.callbackUris?.length)
    return clientRedirectUris(client).includes(uri);
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
