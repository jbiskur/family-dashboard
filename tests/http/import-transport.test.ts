import { beforeAll, expect, test } from "bun:test";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { TimeUuid } from "@flowcore/time-uuid";
import { controls, loadTestEnv, request, tokenFor } from "../fixtures/auth";

// 25f5be41-3819-4312-a42e-da3f3b044397 S4/S5. Public HTTP and encrypted
// event protocol only. All transaction values below are independently fictional.
let owner: string;
let householdId: string;
let actorId: string;
type Row = {
  id: string;
  sourceId: string | null;
  bookingDate: string;
  transactionDate: string | null;
  valueDate: string | null;
  amount: string;
  description: string;
  reference: string;
  categoryId: string | null;
  role: string;
  status: string;
  explanation: string;
  transactionId: string | null;
  original: Record<string, string>;
};
type Envelope = {
  eventId: string;
  flowType: string;
  eventType: string;
  metadata: Record<string, string>;
  payload: { encryptedPayload: string };
  tenant: string;
  dataCoreId: string;
  timeBucket: string;
  validTime: string;
};
beforeAll(async () => {
  await loadTestEnv();
  owner = await tokenFor();
  const response = await request("access/admit", owner, {});
  expect(response.status).toBe(200);
  const access = await response.json();
  householdId = access.household.id;
  actorId = access.member.userId;
});
async function json(path: string) {
  const response = await request(path, owner);
  expect(response.status).toBe(200);
  return response.json();
}
async function account() {
  const response = await request("finance/accounts", owner, {
    commandId: crypto.randomUUID(),
    name: `Fictional transport ${crypto.randomUUID()}`,
    currency: "DKK",
  });
  expect(response.status).toBe(201);
  return (await response.json()).id as string;
}
function statement(accountId: string, count: number) {
  const marker = crypto.randomUUID();
  const rows: Row[] = Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    sourceId: `${marker}:${i}`,
    bookingDate: "2035-04-16",
    transactionDate: "2035-04-15",
    valueDate: null,
    amount: "-1.00",
    description: `Fictional groceries ${i + 1}`,
    reference: "",
    categoryId: null,
    role: "adjustment",
    status: "unmatched",
    explanation: "",
    transactionId: null,
    original: {
      Date: "16-04-2035",
      Description: `Fictional groceries ${i + 1}`,
      Amount: "-1,00",
      Currency: "DKK",
      Note: "Fictional føroyskt dømi",
    },
  }));
  return {
    commandId: crypto.randomUUID(),
    id: crypto.randomUUID(),
    accountId,
    fileName: "fictional-whole-statement.csv",
    sourceHash: createHash("sha256").update(marker).digest("hex"),
    currency: "DKK",
    rows,
    mapping: {
      bookingDate: "Date",
      description: "Description",
      amount: "Amount",
      currency: "Currency",
    },
    openingBalance: "2000.00",
    closingBalance: `${2000 - count}.00`,
  };
}
async function facts(accountId: string) {
  return {
    imports: (await json(`finance/imports?accountId=${accountId}`)).items,
    transactions: (
      await json(`finance/transactions?accountId=${accountId}&month=2035-04`)
    ).items,
  };
}
async function events(): Promise<Envelope[]> {
  const response = await fetch("http://127.0.0.1:3212/__events");
  expect(response.ok).toBe(true);
  return response.json();
}
function key() {
  return createHash("sha256")
    .update(process.env.PATHWAYS_ENCRYPTION_KEY!)
    .digest();
}
function decode(event: Envelope) {
  const [iv, data, tag] = event.payload.encryptedPayload.split(".");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(iv!, "base64"),
  );
  cipher.setAuthTag(Buffer.from(tag!, "base64"));
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(data!, "base64")),
      cipher.final(),
    ]).toString(),
  );
}
function encode(template: Envelope, payload: unknown): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const now = new Date();
  return {
    ...template,
    eventId: TimeUuid.fromDate(now).toString(),
    validTime: now.toISOString(),
    payload: {
      encryptedPayload: [iv, data, cipher.getAuthTag()]
        .map((value) => value.toString("base64"))
        .join("."),
    },
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
async function commandEvents(commandId: string) {
  return (await events()).filter(
    (event) =>
      event.eventType.startsWith("import.") &&
      decode(event).commandId === commandId,
  );
}
async function deliver(event: Envelope) {
  return fetch("http://127.0.0.1:3212/__deliver-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

test("whole statement create and reconciliation publish bounded encrypted events and replay exactly once", async () => {
  const accountId = await account();
  const input = statement(accountId, 1192);
  const created = await request("finance/imports", owner, input);
  expect(created.status).toBe(201);
  const imported = await created.json();
  expect(imported.id).toBe(input.id);
  expect(imported.rows).toHaveLength(1192);
  expect(imported.importedCount).toBe(1192);
  expect(imported.duplicateCount).toBe(0);
  const saved = await facts(accountId);
  expect(saved.imports).toHaveLength(1);
  expect(saved.transactions).toHaveLength(1192);
  expect(
    new Set(saved.transactions.map((r: { id: string }) => r.id)).size,
  ).toBe(1192);
  expect(
    saved.transactions.every((r: { amount: string }) => r.amount === "-1.00"),
  ).toBe(true);
  expect((await request("finance/imports", owner, input)).status).toBe(201);
  expect(await facts(accountId)).toEqual(saved);
  const accepted = await commandEvents(input.commandId);
  expect(
    accepted.filter((e) => e.eventType === "import.rows-staged.0").length,
  ).toBeGreaterThan(1);
  expect(
    accepted.filter((e) => e.eventType === "import.commit-requested.0"),
  ).toHaveLength(1);
  for (const event of accepted) {
    expect(event.metadata["pathways/encrypted"]).toBe("true");
    expect(
      Buffer.byteLength(JSON.stringify(event.payload)),
    ).toBeLessThanOrEqual(64000);
    expect(JSON.stringify(event.payload)).not.toContain("Fictional groceries");
  }
  const reconcileCommand = crypto.randomUUID();
  const reconciled = await request(
    `finance/imports/${imported.id}/reconcile`,
    owner,
    {
      commandId: reconcileCommand,
      baseVersion: imported.version,
      rows: imported.rows,
      openingBalance: "2000.00",
      closingBalance: "808.00",
    },
  );
  expect(reconciled.status).toBe(200);
  expect((await reconciled.json()).status).toBe("reconciled");
  const after = await facts(accountId);
  expect(
    after.transactions.every(
      (r: { reconciliationState: string }) =>
        r.reconciliationState === "reconciled",
    ),
  ).toBe(true);
  for (const event of await commandEvents(reconcileCommand))
    expect(
      Buffer.byteLength(JSON.stringify(event.payload)),
    ).toBeLessThanOrEqual(64000);
  expect((await json(`commands/${reconcileCommand}`)).status).toBe("completed");
}, 120000);

test("an interrupted row batch exposes no partial facts and same-command retry resumes without duplication", async () => {
  const accountId = await account();
  const input = statement(accountId, 405);
  const before = await facts(accountId);
  await controls({
    webhookFault: { eventType: "import.rows-staged.0", afterAccepted: 1 },
  });
  try {
    expect((await request("finance/imports", owner, input)).status).toBe(503);
    expect(
      (await commandEvents(input.commandId)).filter(
        (e) => e.eventType === "import.rows-staged.0",
      ),
    ).toHaveLength(1);
    expect(await facts(accountId)).toEqual(before);
    expect((await json(`commands/${input.commandId}`)).status).toBe(
      "unconfirmed",
    );
  } finally {
    await controls({ webhookFault: null });
  }
  const changed = { ...input, fileName: "different-reviewed-source.csv" };
  expect((await request("finance/imports", owner, changed)).status).toBe(409);
  expect(await facts(accountId)).toEqual(before);
  const retry = await request("finance/imports", owner, input);
  expect(retry.status).toBe(201);
  const after = await facts(accountId);
  expect(after.imports).toHaveLength(1);
  expect(after.transactions).toHaveLength(405);
  expect((await request("finance/imports", owner, input)).status).toBe(201);
  expect(await facts(accountId)).toEqual(after);
}, 120000);

test("a lost commit acknowledgment leaves one complete result recoverable through the public command query", async () => {
  const accountId = await account();
  const input = statement(accountId, 120);
  await controls({
    webhookFault: {
      eventType: "import.commit-requested.0",
      loseAcknowledgments: true,
    },
  });
  try {
    expect((await request("finance/imports", owner, input)).status).toBe(503);
    expect((await json(`commands/${input.commandId}`)).status).toBe(
      "completed",
    );
    const saved = await facts(accountId);
    expect(saved.imports).toHaveLength(1);
    expect(saved.transactions).toHaveLength(120);
  } finally {
    await controls({ webhookFault: null });
  }
  const before = await facts(accountId);
  expect((await request("finance/imports", owner, input)).status).toBe(201);
  expect(await facts(accountId)).toEqual(before);
}, 120000);

test("oversized rows and normalized commands fail before any encrypted event is published", async () => {
  const accountId = await account();
  const input = statement(accountId, 1);
  input.rows[0]!.original = { Huge: "ø".repeat(40000) };
  const before = (await events()).length;
  const response = await request("finance/imports", owner, input);
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("import-too-large");
  expect((await events()).length).toBe(before);
  expect((await facts(accountId)).transactions).toHaveLength(0);
  const normalized = statement(accountId, 300);
  for (const row of normalized.rows) row.original = { Wide: "ø".repeat(15000) };
  expect((await request("finance/imports", owner, normalized)).status).toBe(
    400,
  );
  expect((await events()).length).toBe(before);
  const attemptResponse = await fetch("http://127.0.0.1:3212/__event-attempts");
  expect(
    (await attemptResponse.json())
      .filter(
        (entry: { accepted: boolean; payloadBytes: number }) => entry.accepted,
      )
      .every((entry: { payloadBytes: number }) => entry.payloadBytes <= 64000),
  ).toBe(true);
}, 120000);

test("encrypted commit-before-parts, duplicate replay and conflicting parts preserve one atomic result", async () => {
  const templateAccount = await account();
  const templateInput = statement(templateAccount, 150);
  expect((await request("finance/imports", owner, templateInput)).status).toBe(
    201,
  );
  const captured = await commandEvents(templateInput.commandId);
  const commitEnvelope = captured.find(
    (e) => e.eventType === "import.commit-requested.0",
  )!;
  const batchEnvelopes = captured
    .filter((e) => e.eventType === "import.rows-staged.0")
    .sort((a, b) => decode(a).index - decode(b).index);
  const accountId = await account();
  const commandId = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  const commit = decode(commitEnvelope);
  const rows = batchEnvelopes.flatMap((e) => decode(e).rows);
  const data = {
    ...commit.data,
    accountId,
    sourceHash: createHash("sha256").update(commandId).digest("hex"),
  };
  const intent = {
    commandId,
    householdId,
    actorId,
    resourceId,
    kind: "finance/imports",
    baseVersion: 0,
    action: "create",
    data: { ...data, rows },
  };
  const changes = {
    commandId,
    resourceId,
    digest: digest(intent),
    normalizedBytes: Buffer.byteLength(canonical(intent)),
  };
  const finalCommit = encode(commitEnvelope, { ...commit, ...changes, data });
  expect((await deliver(finalCommit)).status).toBe(200);
  expect((await facts(accountId)).imports).toHaveLength(0);
  expect((await json(`commands/${commandId}`)).status).toBe("unconfirmed");
  const batches = batchEnvelopes.map((e) =>
    encode(e, { ...decode(e), ...changes }),
  );
  const last = batches.at(-1)!;
  expect((await deliver(last)).status).toBe(200);
  expect((await deliver(encode(last, decode(last)))).status).toBe(200);
  const conflicting = decode(last);
  conflicting.rows[0].description = "A different fictional row";
  conflicting.partDigest = digest({
    offset: conflicting.offset,
    rows: conflicting.rows,
  });
  expect((await deliver(encode(last, conflicting))).ok).toBe(false);
  expect((await facts(accountId)).transactions).toHaveLength(0);
  for (const event of batches.slice(0, -1).reverse())
    expect((await deliver(event)).status).toBe(200);
  const after = await facts(accountId);
  expect(after.imports).toHaveLength(1);
  expect(after.transactions).toHaveLength(150);
  expect((await json(`commands/${commandId}`)).status).toBe("completed");
  expect((await deliver(encode(finalCommit, decode(finalCommit)))).status).toBe(
    200,
  );
  expect(await facts(accountId)).toEqual(after);
}, 120000);

test("interrupted large reconciliation stays unchanged and a concurrent version update rejects its stale retry atomically", async () => {
  const accountId = await account();
  const input = statement(accountId, 150);
  const create = await request("finance/imports", owner, input);
  expect(create.status).toBe(201);
  const imported = await create.json();
  const mutation = {
    commandId: crypto.randomUUID(),
    baseVersion: imported.version,
    rows: imported.rows,
    openingBalance: "2000.00",
    closingBalance: "1850.00",
  };
  const before = await facts(accountId);
  const historyBefore = await json(`finance/imports/${imported.id}/history`);
  await controls({
    webhookFault: { eventType: "import.rows-staged.0", afterAccepted: 1 },
  });
  try {
    expect(
      (
        await request(
          `finance/imports/${imported.id}/reconcile`,
          owner,
          mutation,
        )
      ).status,
    ).toBe(503);
    expect(await facts(accountId)).toEqual(before);
    expect(await json(`finance/imports/${imported.id}/history`)).toEqual(
      historyBefore,
    );
    expect((await json(`commands/${mutation.commandId}`)).status).toBe(
      "unconfirmed",
    );
  } finally {
    await controls({ webhookFault: null });
  }
  const other = await request(`finance/imports/${imported.id}`, owner, {
    commandId: crypto.randomUUID(),
    baseVersion: imported.version,
    openingBalance: "2500.00",
    closingBalance: "2350.00",
  });
  expect(other.status).toBe(200);
  const changed = await facts(accountId);
  const changedHistory = await json(`finance/imports/${imported.id}/history`);
  const stale = await request(
    `finance/imports/${imported.id}/reconcile`,
    owner,
    mutation,
  );
  expect(stale.status).toBe(409);
  expect((await stale.json()).error.code).toBe("version-conflict");
  expect(await facts(accountId)).toEqual(changed);
  expect(await json(`finance/imports/${imported.id}/history`)).toEqual(
    changedHistory,
  );
  expect((await json(`commands/${mutation.commandId}`)).status).toBe(
    "rejected",
  );
}, 120000);

test("transport identity rejects completed-command reuse and actor or household changes without poisoning valid staged rows", async () => {
  const accountCommand = crypto.randomUUID();
  const result = await request("finance/accounts", owner, {
    commandId: accountCommand,
    name: "Fictional identity boundary",
    currency: "DKK",
  });
  expect(result.status).toBe(201);
  const templateAccount = (await result.json()).id;
  const template = statement(templateAccount, 120);
  expect(
    (
      await request("finance/imports", owner, {
        ...template,
        commandId: accountCommand,
      })
    ).status,
  ).toBe(409);
  expect((await facts(templateAccount)).imports).toHaveLength(0);
  expect((await request("finance/imports", owner, template)).status).toBe(201);
  expect(
    (
      await request("finance/imports", owner, {
        ...template,
        fileName: "different-content.csv",
      })
    ).status,
  ).toBe(409);
  const captured = await commandEvents(template.commandId);
  const commitEnvelope = captured.find(
    (e) => e.eventType === "import.commit-requested.0",
  )!;
  const partEnvelopes = captured
    .filter((e) => e.eventType === "import.rows-staged.0")
    .sort((a, b) => decode(a).index - decode(b).index);
  const rows = partEnvelopes.flatMap((e) => decode(e).rows);
  const accountId = await account();
  const commandId = crypto.randomUUID();
  const resourceId = crypto.randomUUID();
  const originalCommit = decode(commitEnvelope);
  const data = {
    ...originalCommit.data,
    accountId,
    sourceHash: createHash("sha256").update(commandId).digest("hex"),
  };
  const intent = {
    commandId,
    householdId,
    actorId,
    resourceId,
    kind: "finance/imports",
    baseVersion: 0,
    action: "create",
    data: { ...data, rows },
  };
  const change = {
    commandId,
    resourceId,
    digest: digest(intent),
    normalizedBytes: Buffer.byteLength(canonical(intent)),
  };
  const parts = partEnvelopes.map((e) =>
    encode(e, { ...decode(e), ...change }),
  );
  expect((await deliver(parts[0]!)).status).toBe(200);
  for (const field of [
    "actorId",
    "householdId",
    "resourceId",
    "baseVersion",
    "partCount",
    "rowCount",
    "normalizedBytes",
  ] as const) {
    const payload = decode(parts[0]!);
    payload[field] = ["actorId", "householdId", "resourceId"].includes(field)
      ? crypto.randomUUID()
      : payload[field] + 1;
    expect((await deliver(encode(parts[0]!, payload))).ok).toBe(false);
  }
  expect((await facts(accountId)).transactions).toHaveLength(0);
  expect((await json(`commands/${commandId}`)).status).toBe("unconfirmed");
  for (const part of parts.slice(1))
    expect((await deliver(part)).status).toBe(200);
  expect(
    (
      await deliver(
        encode(commitEnvelope, { ...originalCommit, ...change, data }),
      )
    ).status,
  ).toBe(200);
  expect((await facts(accountId)).transactions).toHaveLength(120);
  // A new complete, correctly hashed operation with a non-member actor must
  // still fail final authorization in the real existing resource projector.
  const deniedAccount = await account();
  const deniedCommand = crypto.randomUUID();
  const deniedActor = crypto.randomUUID();
  const deniedResource = crypto.randomUUID();
  const deniedData = {
    ...originalCommit.data,
    accountId: deniedAccount,
    sourceHash: createHash("sha256").update(deniedCommand).digest("hex"),
  };
  const deniedIntent = {
    commandId: deniedCommand,
    householdId,
    actorId: deniedActor,
    resourceId: deniedResource,
    kind: "finance/imports",
    baseVersion: 0,
    action: "create",
    data: { ...deniedData, rows },
  };
  const deniedChange = {
    commandId: deniedCommand,
    actorId: deniedActor,
    resourceId: deniedResource,
    digest: digest(deniedIntent),
    normalizedBytes: Buffer.byteLength(canonical(deniedIntent)),
  };
  for (const part of partEnvelopes)
    expect(
      (await deliver(encode(part, { ...decode(part), ...deniedChange })))
        .status,
    ).toBe(200);
  expect((await facts(deniedAccount)).imports).toHaveLength(0);
  expect(
    (
      await deliver(
        encode(commitEnvelope, {
          ...originalCommit,
          ...deniedChange,
          data: deniedData,
        }),
      )
    ).status,
  ).toBe(200);
  expect((await facts(deniedAccount)).imports).toHaveLength(0);
  expect((await facts(deniedAccount)).transactions).toHaveLength(0);
}, 120000);

test("fixture enforces the exact 64000-byte encrypted body boundary and unknown row fields fail before publication", async () => {
  const accountId = await account();
  const source = statement(accountId, 120);
  const before = (await events()).length;
  Object.assign(source.rows[0]!, { unexpectedPrivateField: "fictional extra" });
  expect((await request("finance/imports", owner, source)).status).toBe(400);
  expect((await events()).length).toBe(before);
  const url = `http://127.0.0.1:3212/event/${process.env.FLOWCORE_TENANT}/${process.env.FLOWCORE_DATA_CORE}/heima.household.0/import.rows-staged.0`;
  const wrapperBytes = Buffer.byteLength(
    JSON.stringify({ encryptedPayload: "" }),
  );
  for (const size of [64001, 64000]) {
    const body = JSON.stringify({
      encryptedPayload: "x".repeat(size - wrapperBytes),
    });
    expect(Buffer.byteLength(body)).toBe(size);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    // At the allowed limit, deliberately invalid ciphertext reaches the real
    // transformer and fails there; above it the ingestion fixture rejects first.
    expect(response.status).toBe(size > 64000 ? 400 : 502);
    if (size > 64000)
      expect((await response.json()).message).toContain("64000 bytes");
  }
  expect((await events()).length).toBe(before);
  expect((await facts(accountId)).transactions).toHaveLength(0);
}, 120000);

test("complete but invalid assembly digests or overlapping row offsets never produce financial facts", async () => {
  const templateAccount = await account();
  const template = statement(templateAccount, 120);
  expect((await request("finance/imports", owner, template)).status).toBe(201);
  const captured = await commandEvents(template.commandId);
  const commitEnvelope = captured.find(
    (e) => e.eventType === "import.commit-requested.0",
  )!;
  const batches = captured
    .filter((e) => e.eventType === "import.rows-staged.0")
    .sort((a, b) => decode(a).index - decode(b).index);
  expect(batches.length).toBeGreaterThan(1);
  const rows = batches.flatMap((e) => decode(e).rows);
  for (const failure of ["digest", "offset"] as const) {
    const accountId = await account();
    const commandId = crypto.randomUUID();
    const resourceId = crypto.randomUUID();
    const commit = decode(commitEnvelope);
    const data = {
      ...commit.data,
      accountId,
      sourceHash: createHash("sha256").update(commandId).digest("hex"),
    };
    const intent = {
      commandId,
      householdId,
      actorId,
      resourceId,
      kind: "finance/imports",
      baseVersion: 0,
      action: "create",
      data: { ...data, rows },
    };
    const change = {
      commandId,
      resourceId,
      digest: failure === "digest" ? "0".repeat(64) : digest(intent),
      normalizedBytes: Buffer.byteLength(canonical(intent)),
    };
    expect(
      (await deliver(encode(commitEnvelope, { ...commit, ...change, data })))
        .status,
    ).toBe(200);
    for (let index = 0; index < batches.length; index++) {
      const source = batches[index]!;
      const payload = { ...decode(source), ...change };
      if (failure === "offset" && index === 0) {
        payload.offset = 1;
        payload.partDigest = digest({
          offset: payload.offset,
          rows: payload.rows,
        });
      }
      const delivered = await deliver(encode(source, payload));
      expect(delivered.ok).toBe(index < batches.length - 1);
      expect((await facts(accountId)).imports).toHaveLength(0);
      expect((await facts(accountId)).transactions).toHaveLength(0);
    }
    expect((await json(`commands/${commandId}`)).status).toBe("unconfirmed");
  }
}, 120000);

test("more than 256 individually safe row parts fail preflight before any event", async () => {
  const accountId = await account();
  const input = statement(accountId, 300);
  // Each row fits45KB; two do not. Total stays below8MiB, so this exercises
  // the part-count bound rather than either byte-size bound.
  for (const row of input.rows) row.original = { Wide: "x".repeat(23000) };
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(
    8 * 1024 * 1024,
  );
  const before = (await events()).length;
  const response = await request("finance/imports", owner, input);
  expect(response.status).toBe(400);
  const error = await response.json();
  expect(error.error.code).toBe("import-too-large");
  expect(error.error.message).toContain("too many transport parts");
  expect((await events()).length).toBe(before);
  expect((await facts(accountId)).transactions).toHaveLength(0);
  expect((await json(`commands/${input.commandId}`)).status).toBe(
    "unconfirmed",
  );
}, 120000);

test("withdrawing the destination account after staging rejects the complete statement without partial financial facts", async () => {
  const accountId = await account();
  const input = statement(accountId, 405);
  const before = await facts(accountId);
  await controls({
    webhookFault: { eventType: "import.rows-staged.0", afterAccepted: 1 },
  });
  try {
    expect((await request("finance/imports", owner, input)).status).toBe(503);
    expect(await facts(accountId)).toEqual(before);
    expect((await json(`commands/${input.commandId}`)).status).toBe(
      "unconfirmed",
    );
  } finally {
    await controls({ webhookFault: null });
  }
  const current = await json(`finance/accounts/${accountId}`);
  expect(
    (
      await request(`finance/accounts/${accountId}/archive`, owner, {
        commandId: crypto.randomUUID(),
        baseVersion: current.version,
      })
    ).status,
  ).toBe(200);
  const retry = await request("finance/imports", owner, input);
  expect(retry.status).toBe(404);
  expect(await json(`commands/${input.commandId}`)).toMatchObject({
    status: "rejected",
    errorCode: "not-found",
  });
  expect(await facts(accountId)).toEqual(before);
}, 120000);
