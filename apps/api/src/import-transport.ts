import { createHash } from "node:crypto";
import {
  IMPORT_EVENT_PLAINTEXT_BYTES,
  IMPORT_MAX_NORMALIZED_BYTES,
  IMPORT_MAX_PARTS,
  IMPORT_MAX_ROWS,
  type ImportBatchEvent,
  type ImportCommitEvent,
  type ImportRow,
  importBatchEventSchema,
  importCommitEventSchema,
  importTransportRowSchema,
  type ResourceEvent,
} from "@heima/contracts";
import { ApiFailure } from "./errors";

/** Stable property order; array order is part of the financial intent. */
export function canonicalImportValue(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalImportValue).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, item]) => `${JSON.stringify(key)}:${canonicalImportValue(item)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export function importDigest(value: unknown) {
  return createHash("sha256").update(canonicalImportValue(value)).digest("hex");
}
export function importIntent(event: ResourceEvent) {
  const { occurredAt: _attemptTime, ...intent } = event;
  return intent;
}
export function importEventBytes(event: unknown) {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}
function tooLarge(message: string): never {
  throw new ApiFailure("import-too-large", 400, message);
}
export function assertImportEventSize(event: unknown) {
  // SDK2.7.0 encrypted body:65+4*ceil(plaintext UTF-8 bytes/3).
  // 45KB plaintext gives60,065 bytes, below Flowcore's64,000-byte cap.
  if (importEventBytes(event) > IMPORT_EVENT_PLAINTEXT_BYTES)
    tooLarge(
      "This statement has metadata or a row too large to save safely. Shorten the export fields or choose a simpler export.",
    );
}

/** Pure preflight: all envelopes are built and checked before the first write. */
export function prepareImportTransfer(event: ResourceEvent): {
  batches: ImportBatchEvent[];
  commit: ImportCommitEvent;
} | null {
  if (event.kind !== "finance/imports") return null;
  const intent = importIntent(event);
  const normalizedBytes = Buffer.byteLength(
    canonicalImportValue(intent),
    "utf8",
  );
  if (normalizedBytes > IMPORT_MAX_NORMALIZED_BYTES)
    tooLarge(
      "This statement exceeds the 8 MiB normalized import limit. Export a shorter period.",
    );
  if (
    Array.isArray(event.data.rows) &&
    event.data.rows.length > IMPORT_MAX_ROWS
  )
    tooLarge("Import no more than 5,000 rows at a time.");
  if (importEventBytes(event) <= IMPORT_EVENT_PLAINTEXT_BYTES) return null;
  if (
    !["create", "update", "reconcile"].includes(event.action) ||
    !Array.isArray(event.data.rows)
  )
    tooLarge(
      "This statement change is too large to save safely. Choose a simpler export.",
    );
  const rows = event.data.rows.map((row) => {
    importTransportRowSchema.parse(row);
    return row as ImportRow;
  });
  if (!rows.length) tooLarge("This statement has no transaction rows.");
  const { rows: _rows, ...data } = event.data;
  const header = {
    commandId: event.commandId,
    householdId: event.householdId,
    actorId: event.actorId,
    resourceId: event.resourceId,
    action: event.action as ImportCommitEvent["action"],
    baseVersion: event.baseVersion,
    occurredAt: event.occurredAt,
    digest: importDigest(intent),
    rowCount: rows.length,
    normalizedBytes,
    partCount: IMPORT_MAX_PARTS,
  };
  assertImportEventSize({ ...header, data });
  const batches: ImportBatchEvent[] = [];
  let batchRows: ImportRow[] = [];
  let offset = 0;
  const batch = (next: ImportRow[]) => ({
    ...header,
    index: batches.length,
    offset,
    partDigest: importDigest({ offset, rows: next }),
    rows: next,
  });
  for (const row of rows) {
    if (
      importEventBytes(batch([...batchRows, row])) >
      IMPORT_EVENT_PLAINTEXT_BYTES
    ) {
      if (!batchRows.length)
        tooLarge(
          `Statement row ${offset + 1} is too large to save safely. Use a simpler export; no rows have been saved.`,
        );
      batches.push(batch(batchRows));
      offset += batchRows.length;
      batchRows = [];
    }
    batchRows.push(row);
    // Catch an oversized row even when it immediately follows a full batch.
    assertImportEventSize(batch(batchRows));
  }
  if (batchRows.length) batches.push(batch(batchRows));
  if (batches.length > IMPORT_MAX_PARTS)
    tooLarge(
      "This statement needs too many transport parts. Export a shorter period.",
    );
  for (const item of batches) {
    item.partCount = batches.length;
    importBatchEventSchema.parse(item);
    assertImportEventSize(item);
  }
  const commit = importCommitEventSchema.parse({
    ...header,
    partCount: batches.length,
    data,
  });
  assertImportEventSize(commit);
  return { batches, commit };
}
