import type { FlowcoreEvent } from "@flowcore/pathways";
import type {
  ImportBatchEvent,
  ImportCommitEvent,
  ImportRow,
  ImportTransferHeader,
  ResourceEvent,
} from "@heima/contracts";
import { eq, sql } from "drizzle-orm";
import { db } from "./db/client";
import { commands, importTransfers } from "./db/schema";
import { ApiFailure } from "./errors";
import {
  assertImportEventSize,
  canonicalImportValue,
  importDigest,
  importIntent,
} from "./import-transport";
import { projectResourceInTransaction } from "./resource-projection";

function conflict(
  message = "This statement transfer conflicts with an earlier attempt.",
): never {
  throw new ApiFailure("import-transfer-conflict", 409, message);
}

async function projectTransfer(
  event: FlowcoreEvent<ImportBatchEvent | ImportCommitEvent>,
  isCommit: boolean,
) {
  const p = event.payload;
  assertImportEventSize(p);
  const {
    commandId,
    householdId,
    actorId,
    resourceId,
    action,
    baseVersion,
    digest,
    rowCount,
    partCount,
    normalizedBytes,
  } = p;
  const header: ImportTransferHeader = {
    commandId,
    householdId,
    actorId,
    resourceId,
    action,
    baseVersion,
    digest,
    rowCount,
    partCount,
    normalizedBytes,
  };
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${p.householdId}, 0))`,
    );
    const priorStage = (
      await tx
        .select()
        .from(importTransfers)
        .where(eq(importTransfers.commandId, p.commandId))
        .limit(1)
    )[0];
    const previous = (
      await tx
        .select()
        .from(commands)
        .where(eq(commands.id, p.commandId))
        .limit(1)
    )[0];
    // A completed legacy command cannot be claimed by a different transport.
    if (previous && !priorStage) conflict();
    await tx
      .insert(importTransfers)
      .values({
        commandId: p.commandId,
        householdId: p.householdId,
        actorId: p.actorId,
        header,
        parts: {},
        occurredAt: new Date(p.occurredAt),
      })
      .onConflictDoNothing();
    const staged = (
      await tx
        .select()
        .from(importTransfers)
        .where(eq(importTransfers.commandId, p.commandId))
        .limit(1)
    )[0];
    if (
      !staged ||
      canonicalImportValue(staged.header) !== canonicalImportValue(header)
    )
      conflict();
    if (
      previous &&
      (previous.actorId !== p.actorId || previous.householdId !== p.householdId)
    )
      conflict();
    const parts = { ...staged.parts };
    let manifest = staged.manifest;
    let commitReceived = staged.commitReceived;
    if (isCommit) {
      const commit = p as ImportCommitEvent;
      if ("rows" in commit.data)
        conflict("Statement commit metadata cannot contain row data.");
      if (
        manifest !== null &&
        canonicalImportValue(manifest) !== canonicalImportValue(commit.data)
      )
        conflict();
      manifest = commit.data;
      commitReceived = true;
    } else {
      const batch = p as ImportBatchEvent;
      if (
        batch.index >= header.partCount ||
        batch.offset + batch.rows.length > header.rowCount
      )
        conflict();
      const part = {
        offset: batch.offset,
        partDigest: batch.partDigest,
        rows: batch.rows,
      };
      if (
        importDigest({ offset: part.offset, rows: part.rows }) !==
        part.partDigest
      )
        conflict();
      const existing = parts[String(batch.index)];
      if (
        existing &&
        canonicalImportValue(existing) !== canonicalImportValue(part)
      )
        conflict();
      parts[String(batch.index)] = part;
    }
    const accumulatedRows = Object.values(parts).reduce(
      (total, part) => total + part.rows.length,
      0,
    );
    if (
      accumulatedRows > header.rowCount ||
      Object.keys(parts).length > header.partCount
    )
      conflict();
    // Early staging is bounded even before all rows/manifest arrive.
    if (
      Buffer.byteLength(
        canonicalImportValue(Object.values(parts).flatMap((part) => part.rows)),
        "utf8",
      ) > header.normalizedBytes
    )
      conflict();
    if (previous) return;
    await tx
      .update(importTransfers)
      .set({ parts, manifest, commitReceived })
      .where(eq(importTransfers.commandId, p.commandId));
    if (
      !commitReceived ||
      manifest === null ||
      Object.keys(parts).length !== header.partCount
    )
      return;
    const rows: ImportRow[] = [];
    for (let index = 0; index < header.partCount; index++) {
      const part = parts[String(index)];
      if (!part || part.offset !== rows.length)
        conflict("This statement transfer has missing or overlapping rows.");
      rows.push(...part.rows);
    }
    if (rows.length !== header.rowCount) conflict();
    const assembled: ResourceEvent = {
      commandId: p.commandId,
      householdId: p.householdId,
      actorId: p.actorId,
      occurredAt: staged.occurredAt.toISOString(),
      kind: "finance/imports",
      resourceId: p.resourceId,
      baseVersion: p.baseVersion,
      action: p.action,
      data: { ...manifest, rows },
    };
    const intent = importIntent(assembled);
    if (
      importDigest(intent) !== header.digest ||
      Buffer.byteLength(canonicalImportValue(intent), "utf8") !==
        header.normalizedBytes
    )
      conflict();
    // All financial facts, history and the parent command outcome commit with
    // staging in this transaction. Existing rules recheck current membership,
    // account access, version, duplicates and reconciliation here.
    await projectResourceInTransaction({ ...event, payload: assembled }, tx);
  });
}
export async function projectImportBatch(
  event: FlowcoreEvent<ImportBatchEvent>,
) {
  await projectTransfer(event, false);
}
export async function projectImportCommit(
  event: FlowcoreEvent<ImportCommitEvent>,
) {
  await projectTransfer(event, true);
}
