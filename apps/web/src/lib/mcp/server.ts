import "server-only";
import type {
  FinanceAccount,
  FinanceOverview,
  FinanceTransaction,
  ShoppingItem,
  ShoppingList,
  WorkItem,
} from "@heima/contracts";
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod-mcp";
import { version } from "../../../../../package.json";
import { BackendError } from "../backend";
import { authenticateMcpRequest, requireMcpScopes } from "../oauth/server";
import type { McpContext, McpScope } from "../oauth/types";
import * as schema from "./schemas";

export const toolScopes: Readonly<Record<string, readonly McpScope[]>> = {
  heima_context: ["heima.read"],
  list_shopping_lists: ["heima.read"],
  list_shopping_items: ["heima.read"],
  add_shopping_item: ["heima.read", "heima.shopping.write"],
  update_shopping_item: ["heima.read", "heima.shopping.write"],
  list_work_items: ["heima.read"],
  add_work_item: ["heima.read", "heima.work.write"],
  update_work_item: ["heima.read", "heima.work.write"],
  get_command: ["heima.read"],
  get_finance_overview: ["heima.read", "heima.finance.read"],
  list_finance_accounts: ["heima.read", "heima.finance.read"],
  list_finance_transactions: ["heima.read", "heima.finance.read"],
};
const MAX_RESULT_BYTES = 1024 * 1024;
function result(value: Record<string, unknown>): CallToolResult {
  const text = JSON.stringify(value);
  const response: CallToolResult = {
    content: [{ type: "text", text }],
    structuredContent: value,
  };
  if (Buffer.byteLength(JSON.stringify(response)) > MAX_RESULT_BYTES)
    return failure(
      "result-too-large",
      "Narrow the date range or request fewer items.",
    );
  return response;
}
function failure(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: JSON.stringify({ error: { code, message } }) },
    ],
  };
}
function safeFailure(error: unknown): CallToolResult {
  if (error instanceof BackendError) {
    if (error.status === 404 || error.code === "not-found")
      return failure("not-found", "This item is not available.");
    if (error.status === 409)
      return failure(
        "conflict",
        "Refresh this item and use its current version with a new command ID.",
      );
    if (error.status === 401 || error.status === 403)
      return failure("access-denied", "Reconnect your agent to verify access.");
    if (error.status >= 400 && error.status < 500)
      return failure("invalid-input", "Check the item fields and try again.");
  }
  return failure(
    "unavailable",
    "The result could not be confirmed. Check your command ID before retrying.",
  );
}
function query(input: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    if (key !== "limit" && key !== "cursor" && value !== undefined)
      params.set(key, String(value));
  return params.size ? `?${params}` : "";
}
async function page<T extends { id: string }>(
  context: McpContext,
  path: string,
  input: { limit: number; cursor?: string },
) {
  // The guarded API filters unauthorized rows before continuation is evaluated.
  const response = await context.backendJson<{ items: T[] }>(path);
  const start = input.cursor
    ? response.items.findIndex((item) => item.id === input.cursor) + 1
    : 0;
  if (input.cursor && start === 0)
    throw new BackendError(400, "INVALID_CURSOR", "Refresh the list.");
  const items = response.items.slice(start, start + input.limit);
  return {
    items,
    nextCursor:
      start + items.length < response.items.length
        ? (items.at(-1)?.id ?? null)
        : null,
  };
}
function post<T>(
  context: McpContext,
  path: string,
  input: Record<string, unknown>,
) {
  return context.backendJson<T>(path, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
export function createMcpServer(request: Request, initial: McpContext) {
  const server = new McpServer(
    { name: "Heima Family Dashboard", version },
    { supportedProtocolVersions: ["2026-07-28", "2025-11-25"] },
  );
  function register<I>(
    name: string,
    description: string,
    inputSchema: z.ZodType<I>,
    run: (input: I, context: McpContext) => Promise<Record<string, unknown>>,
  ) {
    const required = toolScopes[name];
    if (!required || requireMcpScopes(initial, required)) return;
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: !required.some((scope) => scope.endsWith(".write")),
          destructiveHint: name.startsWith("update_"),
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) => {
        // Each invocation checks the live grant and provider session again, including batched calls.
        const verified = await authenticateMcpRequest(request);
        if (!verified.ok || verified.context.grantId !== initial.grantId)
          return failure(
            "access-denied",
            "Reconnect your agent to verify access.",
          );
        if (requireMcpScopes(verified.context, required))
          return failure(
            "insufficient-scope",
            "Reconnect and approve this permission.",
          );
        try {
          return result(await run(input, verified.context));
        } catch (error) {
          return safeFailure(error);
        }
      },
    );
  }
  register(
    "heima_context",
    "Your active household role and approved permissions. No other household members or private profile data.",
    schema.empty,
    async (_, c) => ({
      userId: c.userId,
      householdId: c.householdId,
      role: c.role,
      scopes: [...c.scopes],
      expiresAt: new Date(c.expiresAt).toISOString(),
    }),
  );
  register(
    "list_shopping_lists",
    "List visible active shopping lists. Continue with nextCursor; at most 100 items.",
    schema.shoppingLists,
    async (i, c) => page<ShoppingList>(c, `/v1/shopping/lists${query(i)}`, i),
  );
  register(
    "list_shopping_items",
    "List visible active items in one shopping list. Continue with nextCursor; at most 100 items.",
    schema.shoppingItems,
    async (i, c) => page<ShoppingItem>(c, `/v1/shopping/items${query(i)}`, i),
  );
  register(
    "add_shopping_item",
    "Add an item through Heima's event command. Supply a new command UUID; reuse it only to retry the same command.",
    schema.addShopping,
    async (i, c) => ({
      item: await post<ShoppingItem>(c, "/v1/shopping/items", i),
      commandId: i.commandId,
    }),
  );
  register(
    "update_shopping_item",
    "Edit or complete/undo an item using completed true/false. Requires its observed baseVersion and a command UUID.",
    schema.updateShopping,
    async (i, c) => ({
      item: await post<ShoppingItem>(c, `/v1/shopping/items/${i.id}`, i),
      commandId: i.commandId,
    }),
  );
  register(
    "list_work_items",
    "List visible active work items. Continue with nextCursor; at most 100 items.",
    schema.workItems,
    async (i, c) => page<WorkItem>(c, `/v1/work/items${query(i)}`, i),
  );
  register(
    "add_work_item",
    "Add work through Heima's event command. Supply a new command UUID; reuse it only to retry the same command.",
    schema.addWork,
    async (i, c) => ({
      item: await post<WorkItem>(c, "/v1/work/items", i),
      commandId: i.commandId,
    }),
  );
  register(
    "update_work_item",
    "Edit work or set status todo/doing/done, including undo. Requires its observed baseVersion and a command UUID.",
    schema.updateWork,
    async (i, c) => ({
      item: await post<WorkItem>(c, `/v1/work/items/${i.id}`, i),
      commandId: i.commandId,
    }),
  );
  register(
    "get_command",
    "Check only your own command's confirmed status before retrying an uncertain write.",
    schema.command,
    async (i, c) =>
      c.backendJson<{
        commandId: string;
        status: string;
        errorCode?: string | null;
      }>(`/v1/commands/${i.commandId}`),
  );
  register(
    "get_finance_overview",
    "Read the existing permitted finance summary. Monetary values remain exact decimal strings; incomplete totals stay marked incomplete.",
    schema.overview,
    async (i, c) => {
      const overview = await c.backendJson<FinanceOverview>(
        `/v1/finance/overview${query(i)}`,
      );
      if (overview.categories.length > 100 || overview.trend.length > 100)
        throw new BackendError(
          400,
          "RESULT_TOO_LARGE",
          "Narrow the date range.",
        );
      return { overview };
    },
  );
  register(
    "list_finance_accounts",
    "Read permitted active accounts and exact balances. Does not initialize categories or mutate finance.",
    schema.accounts,
    async (i, c) =>
      page<FinanceAccount>(c, `/v1/finance/accounts${query(i)}`, i),
  );
  register(
    "list_finance_transactions",
    "Read permitted transactions in the requested period (current month by default). Amounts remain exact decimal strings; at most 100 items.",
    schema.transactions,
    async (i, c) =>
      page<FinanceTransaction>(c, `/v1/finance/transactions${query(i)}`, i),
  );
  return server;
}
