import type { MemberRole } from "@heima/contracts";

export type McpScope =
  | "heima.read"
  | "heima.shopping.write"
  | "heima.work.write"
  | "heima.finance.read";
export type ConsentView =
  | { status: "sign-in"; returnTo: string }
  | { status: "expired" | "denied"; message: string }
  | {
      status: "ready";
      requestId: string;
      csrfToken: string;
      client: { id: string; name: string };
      redirectHost: string;
      redirectUri: string;
      requestedScopes: McpScope[];
      expiresAt: string;
      connectionExpiresAt: string;
    };
export type AgentConnection = {
  id: string;
  clientId: string;
  clientName: string;
  scopes: McpScope[];
  createdAt: string;
  expiresAt: string;
  status: "active" | "expired" | "revoked";
};
export type AgentAccessView = {
  endpoint: string;
  clients: Array<{
    id: string;
    name: string;
    callbackUri: string;
    callbackPort: number;
  }>;
  connections: AgentConnection[];
};
export type McpContext = {
  userId: string;
  householdId: string;
  role: MemberRole;
  grantId: string;
  scopes: readonly McpScope[];
  expiresAt: number;
  backendJson<T>(path: string, init?: RequestInit): Promise<T>;
};
export type ActionFailure = { ok: false; code: string; message: string };
