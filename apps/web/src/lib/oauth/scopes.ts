import type { McpScope } from "./types";

export const usableChatClientId =
  "40c9eee8-9eee-4742-9025-2ce398b78437" as const;

/**
 * List permissions offered by the explicit access-level picker. Keeping this
 * shared module server-free lets the consent client and OAuth request handler
 * use the same scope set.
 */
export const listWriteScopes = [
  "heima.shopping.write",
  "heima.work.write",
] as const satisfies readonly McpScope[];
