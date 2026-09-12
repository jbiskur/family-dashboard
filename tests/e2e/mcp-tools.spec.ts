import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect, type Page, test } from "@playwright/test";
import {
  approveOAuth,
  beginOAuth,
  oauthResource,
  oauthScopes,
  signInForOAuth,
} from "../fixtures/oauth";

test.use({ trace: "off", video: "off", actionTimeout: 15000 });
const allTools = [
  "heima_context",
  "list_shopping_lists",
  "list_shopping_items",
  "add_shopping_item",
  "update_shopping_item",
  "list_work_items",
  "add_work_item",
  "update_work_item",
  "get_command",
  "get_finance_overview",
  "list_finance_accounts",
  "list_finance_transactions",
];
type Item = {
  id: string;
  version: number;
  ownerId: string;
  visibility: string;
  completed?: boolean;
  completedBy?: string;
  status?: string;
  note?: string;
  title?: string;
  amount?: string;
  balance?: string | null;
};
type Result = {
  item?: Item;
  items?: Item[];
  nextCursor?: string | null;
  commandId?: string;
  status?: string;
  userId?: string;
  householdId?: string;
  role?: string;
  overview?: {
    income: string | null;
    spending: string | null;
    incomplete: boolean;
  };
  error?: { code: string };
};
async function connect(accessToken: string, protocol = "2026-07-28") {
  const client = new Client(
    { name: "Heima acceptance", version: "1.0.0" },
    {
      supportedProtocolVersions: [protocol],
      versionNegotiation: {
        mode: protocol === "2026-07-28" ? { pin: "2026-07-28" } : "legacy",
      },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(oauthResource), {
      authProvider: { token: async () => accessToken },
      onInsufficientScope: "throw",
    }),
  );
  return client;
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  error = false,
): Promise<Result> {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError === true, `${name} error state`).toBe(error);
  const text = response.content as { type: string; text?: string }[];
  return (response.structuredContent ??
    JSON.parse(
      text.find((item) => item.type === "text")?.text ?? "{}",
    )) as Result;
}
async function grant(page: Page, scopes = oauthScopes) {
  const flow = await beginOAuth(page, scopes);
  return approveOAuth(page, flow, scopes);
}
async function raw(
  accessToken: string | undefined,
  method: string,
  args?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return fetch(oauthResource, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(args ? { params: args } : {}),
    }),
  });
}
async function wireJson(response: Response) {
  const text = await response.text();
  const json = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : text;
  return JSON.parse(json ?? "{}");
}
function foreignHostStatus() {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      oauthResource,
      {
        method: "POST",
        headers: {
          host: "foreign.example",
          "content-type": "application/json",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end("{}");
  });
}
async function shoppingList(
  page: Page,
  name: string,
  visibility = "household",
) {
  await page.goto("/shopping");
  await page.getByRole("button", { name: "New list", exact: true }).click();
  await page.getByRole("textbox", { name: /List name/ }).fill(name);
  await page
    .getByRole("combobox", { name: "Who can see it?", exact: true })
    .selectOption(visibility);
  await page.getByRole("button", { name: "Create list", exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}
async function financeAccount(
  page: Page,
  name: string,
  visibility = "household",
) {
  await page.goto("/finance/accounts");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Account name", exact: true })
    .fill(name);
  await page
    .getByRole("combobox", { name: "Account visibility", exact: true })
    .selectOption(visibility);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add account", exact: true })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split("/").at(-1)!;
}
async function financeFact(page: Page, accountId: string, description: string) {
  await page.goto(`/finance/transactions?accountId=${accountId}&new=true`);
  const dialog = page.getByRole("dialog", { name: "Add a manual exception" });
  await dialog
    .getByRole("textbox", { name: "Description", exact: true })
    .fill(description);
  await dialog
    .getByRole("textbox", { name: "Signed amount", exact: true })
    .fill("-12.34");
  await dialog.getByLabel(/^Booking date/).fill("2030-09-15");
  await dialog
    .getByRole("combobox", { name: "Transaction role", exact: true })
    .selectOption("spending");
  await dialog
    .getByRole("textbox", {
      name: "Why is this entered manually?",
      exact: true,
    })
    .fill("Synthetic MCP acceptance receipt");
  await dialog
    .getByRole("button", { name: "Record exception", exact: true })
    .click();
  await expect(dialog).toBeHidden();
}
async function read(page: Page, actorId: string, path: string) {
  const response = await page.request.get(`/api/backend/${path}`, {
    headers: { "x-heima-actor-id": actorId },
  });
  expect(response.status()).toBe(200);
  return response.json();
}

test("MCP requires its own bearer, validates origin and advertises only consented tools", async ({
  page,
}) => {
  test.setTimeout(120000);
  const missing = await raw(undefined, "tools/list");
  expect(missing.status).toBe(401);
  expect(missing.headers.get("www-authenticate")).toContain(
    "/.well-known/oauth-protected-resource/api/mcp",
  );
  expect(missing.headers.get("cache-control")).toBe("no-store");
  expect((await raw("x".repeat(43), "tools/list")).status).toBe(401);
  await signInForOAuth(page);
  const cookieOnly = await page.request.post("/api/mcp", {
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(cookieOnly.status()).toBe(401);
  const tokens = await grant(page, ["heima.read"]);
  const client = await connect(tokens.accessToken);
  try {
    expect(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ).toEqual(
      [
        "heima_context",
        "list_shopping_lists",
        "list_shopping_items",
        "list_work_items",
        "get_command",
      ].sort(),
    );
    for (const name of [
      "add_shopping_item",
      "update_shopping_item",
      "add_work_item",
      "update_work_item",
      "get_finance_overview",
      "list_finance_accounts",
      "list_finance_transactions",
    ]) {
      const denied = await raw(tokens.accessToken, "tools/call", {
        name,
        arguments: {},
      });
      expect(denied.status, name).toBe(403);
      expect(denied.headers.get("www-authenticate")).toContain(
        'error="insufficient_scope"',
      );
    }
    expect(
      (
        await raw(tokens.accessToken, "tools/list", undefined, {
          origin: "https://foreign.example",
        })
      ).status,
    ).toBe(403);
    expect(await foreignHostStatus()).toBe(403);
    expect(
      (
        await raw(tokens.accessToken, "tools/list", undefined, {
          "mcp-protocol-version": "1999-01-01",
        })
      ).status,
    ).toBe(400);
    const oversized = await fetch(oauthResource, {
      method: "POST",
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ data: "a".repeat(65537) }),
    });
    expect(oversized.status).toBe(413);
    const alias = await fetch(
      `${oauthResource}?access_token=${tokens.accessToken}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(alias.status).toBe(401);
    for (const protocol of ["2026-07-28", "2025-11-25"]) {
      const compatible = await connect(tokens.accessToken, protocol);
      expect((await compatible.listTools()).tools).toHaveLength(5);
      await compatible.close();
    }
  } finally {
    await client.close();
  }
});

test("official MCP SDK performs all 12 tools with versioned commands and reload-visible Shopping and Work", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  await signInForOAuth(page);
  const suffix = randomUUID();
  const listId = await shoppingList(page, `Agent shopping ${suffix}`);
  const accountId = await financeAccount(page, `Agent account ${suffix}`);
  await financeFact(page, accountId, `Agent receipt ${suffix}`);
  const tokens = await grant(page);
  const client = await connect(tokens.accessToken);
  try {
    expect(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
    ).toEqual([...allTools].sort());
    const context = await call(client, "heima_context");
    const actorId = context.userId!;
    expect(context.role).toBe("owner");
    expect(
      (await call(client, "list_shopping_lists", { q: suffix })).items?.map(
        (item) => item.id,
      ),
    ).toContain(listId);
    const commandId = randomUUID();
    const input = {
      commandId,
      listId,
      name: `Agent milk ${suffix}`,
      quantity: "2 cartons",
      category: "Dairy & eggs",
      note: "From the agent",
    };
    const shopping = (await call(client, "add_shopping_item", input)).item!;
    expect(shopping.ownerId).toBe(actorId);
    expect((await call(client, "add_shopping_item", input)).item?.id).toBe(
      shopping.id,
    );
    expect(
      (await call(client, "list_shopping_items", { listId })).items?.filter(
        (item) => item.id === shopping.id,
      ),
    ).toHaveLength(1);
    expect((await call(client, "get_command", { commandId })).status).toBe(
      "completed",
    );
    let updated = (
      await call(client, "update_shopping_item", {
        id: shopping.id,
        commandId: randomUUID(),
        baseVersion: shopping.version,
        completed: true,
        note: "Picked up by agent",
      })
    ).item!;
    expect(updated.completed).toBe(true);
    expect(updated.completedBy).toBe(actorId);
    const conflict = await call(
      client,
      "update_shopping_item",
      {
        id: shopping.id,
        commandId: randomUUID(),
        baseVersion: shopping.version,
        completed: false,
      },
      true,
    );
    expect(conflict.error?.code).toBe("conflict");
    updated = (
      await call(client, "update_shopping_item", {
        id: shopping.id,
        commandId: randomUUID(),
        baseVersion: updated.version,
        completed: false,
      })
    ).item!;
    expect(updated.completed).toBe(false);
    await page.goto(`/shopping/${listId}`);
    await page.reload();
    await expect(
      page.getByRole("button", { name: `Complete ${input.name}`, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Dairy & eggs", { exact: true })).toBeVisible();
    expect(
      (await read(page, actorId, `shopping/items/${shopping.id}`)).note,
    ).toBe("Picked up by agent");
    await page.screenshot({
      path: info.outputPath("mcp-shopping-reloaded.png"),
    });
    const workInput = {
      commandId: randomUUID(),
      title: `Agent work ${suffix}`,
      visibility: "personal",
      dueDate: "2030-09-15",
      note: "An exact MCP command",
    };
    const work = (await call(client, "add_work_item", workInput)).item!;
    expect((await call(client, "add_work_item", workInput)).item?.id).toBe(
      work.id,
    );
    let workUpdated = (
      await call(client, "update_work_item", {
        id: work.id,
        commandId: randomUUID(),
        baseVersion: work.version,
        status: "done",
        note: "Edited through MCP",
      })
    ).item!;
    expect(workUpdated.completedBy).toBe(actorId);
    workUpdated = (
      await call(client, "update_work_item", {
        id: work.id,
        commandId: randomUUID(),
        baseVersion: workUpdated.version,
        status: "todo",
      })
    ).item!;
    expect(workUpdated.status).toBe("todo");
    expect(
      (await call(client, "list_work_items", { q: suffix })).items?.map(
        (item) => item.id,
      ),
    ).toContain(work.id);
    await page.goto("/work");
    await page.reload();
    await expect(
      page.getByRole("button", {
        name: `Details ${workInput.title}`,
        exact: true,
      }),
    ).toBeVisible();
    expect((await read(page, actorId, `work/items/${work.id}`)).note).toBe(
      "Edited through MCP",
    );
    await page.screenshot({ path: info.outputPath("mcp-work-reloaded.png") });
    const overview = await call(client, "get_finance_overview", {
      month: "2030-09",
    });
    expect(overview.overview).toEqual(
      await read(page, actorId, "finance/overview?month=2030-09"),
    );
    const accounts = await call(client, "list_finance_accounts", {
      q: suffix,
      limit: 1,
    });
    expect(accounts.items?.[0]?.id).toBe(accountId);
    expect(accounts.items?.[0]?.balance).toBe("-12.34");
    const transactions = await call(client, "list_finance_transactions", {
      accountId,
      month: "2030-09",
      limit: 1,
    });
    expect(transactions.items?.[0]?.amount).toBe("-12.34");
    await page.goto(
      `/finance/transactions?accountId=${accountId}&month=2030-09`,
    );
    await expect(page.getByText("-12.34 DKK", { exact: true })).toBeVisible();
    await page.screenshot({
      path: info.outputPath("mcp-finance-exact-read.png"),
    });
    const pageOne = await call(client, "list_work_items", { limit: 1 });
    expect(pageOne.items).toHaveLength(1);
    if (pageOne.nextCursor) {
      const pageTwo = await call(client, "list_work_items", {
        limit: 1,
        cursor: pageOne.nextCursor,
      });
      expect(
        pageTwo.items?.some((item) => item.id === pageOne.items![0]!.id),
      ).toBe(false);
    }
    const invalid = await raw(tokens.accessToken, "tools/call", {
      name: "add_work_item",
      arguments: {
        commandId: randomUUID(),
        title: "Invalid actor injection",
        actorId: randomUUID(),
      },
    });
    const invalidBody = await wireJson(invalid);
    expect(invalidBody.error || invalidBody.result?.isError).toBeTruthy();
    const overLimit = await raw(tokens.accessToken, "tools/call", {
      name: "list_work_items",
      arguments: { limit: 101 },
    });
    const limitBody = await wireJson(overLimit);
    expect(limitBody.error || limitBody.result?.isError).toBeTruthy();
  } finally {
    await client.close();
  }
});

test("MCP reports a failed Flowcore write honestly and confirms a same-command retry exactly once", async ({
  page,
}) => {
  test.setTimeout(120000);
  await signInForOAuth(page);
  const tokens = await grant(page, ["heima.read", "heima.work.write"]);
  const client = await connect(tokens.accessToken);
  const commandId = randomUUID();
  const title = `Agent retry ${randomUUID()}`;
  const input = { commandId, title, visibility: "personal" };
  const control = async (webhookStatus: number) => {
    const response = await fetch("http://127.0.0.1:3212/__controls", {
      method: "POST",
      body: JSON.stringify({ webhookStatus }),
    });
    expect(response.status).toBe(200);
  };
  try {
    await control(503);
    try {
      expect(
        (await call(client, "add_work_item", input, true)).error?.code,
      ).toBe("unavailable");
      expect((await call(client, "get_command", { commandId })).status).toBe(
        "unconfirmed",
      );
      expect(
        (await call(client, "list_work_items", { q: title })).items,
      ).toEqual([]);
    } finally {
      await control(200);
    }
    const created = (await call(client, "add_work_item", input)).item!;
    expect((await call(client, "add_work_item", input)).item?.id).toBe(
      created.id,
    );
    expect((await call(client, "get_command", { commandId })).status).toBe(
      "completed",
    );
    const secret = readFileSync(".env.test.local", "utf8")
      .split("\n")
      .find((line) => line.startsWith("PATHWAYS_ENCRYPTION_KEY="))
      ?.slice("PATHWAYS_ENCRYPTION_KEY=".length);
    if (!secret) throw new Error("Missing local fixture encryption key");
    const events = (await (
      await fetch("http://127.0.0.1:3212/__events")
    ).json()) as { eventType: string; payload: { encryptedPayload: string } }[];
    const ownEvents = events.filter((event) => {
      if (event.eventType !== "resource.changed.0") return false;
      const [iv, data, tag] = event.payload.encryptedPayload.split(".");
      if (!iv || !data || !tag) return false;
      const decipher = createDecipheriv(
        "aes-256-gcm",
        createHash("sha256").update(secret).digest(),
        Buffer.from(iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      const payload = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(data, "base64")),
          decipher.final(),
        ]).toString(),
      );
      return payload.commandId === commandId;
    });
    expect(ownEvents).toHaveLength(1);
  } finally {
    await control(200);
    await client.close();
  }
});

test("MCP caps concurrent requests and releases capacity after aborted bodies and failed calls", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signInForOAuth(page);
  const tokens = await grant(page, ["heima.read"]);
  const pending = Array.from({ length: 4 }, () => {
    const request = httpRequest(
      oauthResource,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.accessToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
      },
      (response) => response.resume(),
    );
    request.on("error", () => {});
    request.write('{"jsonrpc":');
    return request;
  });
  try {
    await expect
      .poll(
        async () => {
          const response = await raw(tokens.accessToken, "tools/list");
          await response.text();
          if (response.status === 429)
            expect(response.headers.get("retry-after")).toBe("2");
          return response.status;
        },
        { timeout: 5000 },
      )
      .toBe(429);
  } finally {
    for (const request of pending) request.destroy();
  }
  await expect
    .poll(
      async () => {
        const response = await raw(tokens.accessToken, "tools/list");
        await response.text();
        return response.status;
      },
      { timeout: 15000 },
    )
    .toBe(200);
  const client = await connect(tokens.accessToken);
  try {
    for (let i = 0; i < 6; i++) {
      expect(
        (
          await call(
            client,
            "list_shopping_items",
            { listId: randomUUID() },
            true,
          )
        ).error?.code,
      ).toBe("not-found");
    }
    expect((await client.listTools()).tools).toHaveLength(5);
  } finally {
    await client.close();
  }
});

test("MCP preserves owner, spouse and administrator private-resource and actor-command boundaries", async ({
  page,
  browser,
}) => {
  test.setTimeout(180000);
  await signInForOAuth(page);
  const suffix = randomUUID();
  const listId = await shoppingList(
    page,
    `Private agent list ${suffix}`,
    "personal",
  );
  const privateAccountId = await financeAccount(
    page,
    `Private agent account ${suffix}`,
    "personal",
  );
  const ownerTokens = await grant(page);
  const owner = await connect(ownerTokens.accessToken);
  try {
    const ownerCommand = randomUUID();
    const privateWork = (
      await call(owner, "add_work_item", {
        commandId: ownerCommand,
        title: `Private agent work ${suffix}`,
        visibility: "personal",
      })
    ).item!;
    const privateItem = (
      await call(owner, "add_shopping_item", {
        commandId: randomUUID(),
        listId,
        name: `Private agent item ${suffix}`,
      })
    ).item!;
    for (const user of ["spouse", "admin"]) {
      const otherContext = await browser.newContext({
        baseURL: "http://localhost:3010",
      });
      const otherPage = await otherContext.newPage();
      let other: Client | undefined;
      try {
        await signInForOAuth(otherPage, user);
        const tokens = await grant(otherPage);
        other = await connect(tokens.accessToken);
        expect((await call(other, "heima_context")).role).toBe(user);
        expect(
          (await call(other, "list_work_items", { q: suffix })).items,
        ).toEqual([]);
        expect(
          (await call(other, "list_shopping_lists", { q: suffix })).items,
        ).toEqual([]);
        expect(
          (await call(other, "list_finance_accounts", { q: suffix })).items,
        ).toEqual([]);
        const privateFinance = await call(
          other,
          "list_finance_transactions",
          { accountId: privateAccountId },
          true,
        );
        const missingFinance = await call(
          other,
          "list_finance_transactions",
          { accountId: randomUUID() },
          true,
        );
        expect(privateFinance).toEqual(missingFinance);
        expect(privateFinance.error?.code).toBe("not-found");
        const hidden = await call(
          other,
          "list_shopping_items",
          { listId },
          true,
        );
        const absent = await call(
          other,
          "list_shopping_items",
          { listId: randomUUID() },
          true,
        );
        expect(hidden).toEqual(absent);
        expect(hidden.error?.code).toBe("not-found");
        const hiddenAdd = await call(
          other,
          "add_shopping_item",
          { commandId: randomUUID(), listId, name: "Unavailable parent" },
          true,
        );
        const absentAdd = await call(
          other,
          "add_shopping_item",
          {
            commandId: randomUUID(),
            listId: randomUUID(),
            name: "Unavailable parent",
          },
          true,
        );
        expect(hiddenAdd).toEqual(absentAdd);
        expect(hiddenAdd.error?.code).toBe("not-found");
        for (const [name, item] of [
          ["update_work_item", privateWork],
          ["update_shopping_item", privateItem],
        ] as const) {
          expect(
            (
              await call(
                other,
                name,
                {
                  id: item.id,
                  commandId: randomUUID(),
                  baseVersion: item.version,
                  note: "Must not alter private data",
                },
                true,
              )
            ).error?.code,
          ).toBe("not-found");
        }
        const foreignCommand = await call(other, "get_command", {
          commandId: ownerCommand,
        });
        expect(foreignCommand.status).toBe("unconfirmed");
      } finally {
        await other?.close();
        await otherContext.close();
      }
    }
    expect(
      (await call(owner, "list_work_items", { q: suffix })).items?.find(
        (item) => item.id === privateWork.id,
      )?.note,
    ).toBe("");
  } finally {
    await owner.close();
  }
});
