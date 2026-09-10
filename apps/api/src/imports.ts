import { createHash } from "node:crypto";
import type { ImportRow } from "@heima/contracts";
import { Hono } from "hono";
import * as XLSX from "xlsx";
import { z } from "zod";
import { type ApiVariables, requireMember } from "./access";
import { canManage, decimal, minor } from "./domain";
import { ApiFailure } from "./errors";
import {
  detectStatementDelimiter,
  parseExcelStatementDate,
  parseStatementAmount,
  parseStatementDate,
  suggestStatementMapping,
} from "./import-format";
import { loadResources, visibleResource } from "./resources";
import { semanticId } from "./security";

const inputSchema = z.object({
  accountId: z.string().uuid(),
  provider: z.enum(["other", "revolut", "faroese"]).default("other"),
  feeTreatment: z
    .enum(["included", "subtract-positive", "add-signed"])
    .optional(),
  fileName: z.string().min(1).max(240),
  contentBase64: z.string().max(14_000_000),
  delimiter: z.enum([",", ";", "\t"]).optional(),
  sheet: z.string().optional(),
  headerRow: z.number().int().min(1).max(50).default(1),
  hasHeaders: z.boolean().default(true),
  firstDataRow: z.number().int().min(1).max(50).default(1),
  layout: z
    .enum(["custom", "faroese-bookings", "faroese-details"])
    .default("custom"),
  mapping: z.record(z.string()).optional(),
  decimalSeparator: z.enum([".", ","]).default("."),
  dateFormat: z
    .enum([
      "yyyy-MM-dd",
      "yyyy-MM-dd HH:mm:ss",
      "dd/MM/yyyy",
      "MM/dd/yyyy",
      "dd-MM-yyyy",
      "dd.MM.yyyy",
    ])
    .default("yyyy-MM-dd"),
});
export const importRoutes = new Hono<{ Variables: ApiVariables }>();
importRoutes.post("/finance/imports/preview", async (c) => {
  const identity = c.get("identity");
  await requireMember(identity);
  const input = inputSchema.parse(await c.req.json());
  const all = await loadResources();
  const account = visibleResource(
    all,
    "finance/accounts",
    input.accountId,
    identity.userId,
  );
  if (!canManage(account, identity.userId, all))
    throw new ApiFailure("not-found", 404, "This account is not available.");
  if (!/\.(csv|xls|xlsx)$/i.test(input.fileName))
    throw new ApiFailure(
      "unsupported-file",
      400,
      "Choose a CSV, XLS or XLSX statement.",
    );
  const content = Buffer.from(input.contentBase64, "base64");
  if (!content.length || content.length > 10 * 1024 * 1024)
    throw new ApiFailure(
      "invalid-file-size",
      400,
      "Choose a file up to 10 MB.",
    );
  let csvText: string | undefined;
  if (/\.csv$/i.test(input.fileName)) {
    try {
      // Decode explicitly: SheetJS's buffer CSV default is a legacy codepage.
      // TextDecoder strips a UTF-8 BOM and rejects corruption instead of replacing it.
      csvText = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new ApiFailure(
        "invalid-file",
        400,
        "Save the CSV with UTF-8 encoding, or choose an Excel statement.",
      );
    }
  }
  const delimiter =
    input.delimiter ??
    (csvText === undefined ? "," : detectStatementDelimiter(csvText));
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(csvText ?? content, {
      type: csvText === undefined ? "buffer" : "string",
      raw: true,
      cellDates: false,
      cellNF: true,
      sheetRows: 5052,
      FS: delimiter,
      dense: true,
    });
  } catch {
    throw new ApiFailure(
      "invalid-file",
      400,
      "This statement could not be read. Check the file format.",
    );
  }
  const sheetName = input.sheet ?? workbook.SheetNames[0];
  if (!sheetName || !workbook.Sheets[sheetName])
    throw new ApiFailure(
      "invalid-sheet",
      400,
      "Choose an available worksheet.",
    );
  const fullRange = workbook.Sheets[sheetName]?.["!fullref"];
  const readRange = workbook.Sheets[sheetName]?.["!ref"];
  // CSV stops at sheetRows without !fullref. Reaching the read boundary is
  // ambiguous, so reject rather than silently import only a prefix.
  if (
    (fullRange && XLSX.utils.decode_range(fullRange).e.r >= 5052) ||
    (readRange && XLSX.utils.decode_range(readRange).e.r >= 5051)
  )
    throw new ApiFailure(
      "too-many-rows",
      400,
      "This statement exceeds the readable row limit. Choose a shorter statement period with no more than 5,000 source rows.",
    );
  const matrix = XLSX.utils.sheet_to_json<string[]>(
    workbook.Sheets[sheetName]!,
    { header: 1, raw: false, defval: "", blankrows: true, range: 0 },
  );
  const firstIndex = input.hasHeaders
    ? input.headerRow
    : input.firstDataRow - 1;
  const dataMatrix = matrix.slice(firstIndex);
  const width = Math.max(0, ...dataMatrix.map((cells) => cells.length));
  const headers = input.hasHeaders
    ? (matrix[input.headerRow - 1] ?? []).map((v) => String(v).trim())
    : Array.from({ length: width }, (_, index) => `Column ${index + 1}`);
  const headerIssue =
    !headers.length ||
    new Set(headers).size !== headers.length ||
    headers.some((h) => !h) ||
    (input.hasHeaders && width > headers.length)
      ? input.hasHeaders
        ? "Choose a header row with unique, non-empty column names, or choose a no-headings layout. Adjust the worksheet, separator or header row below."
        : "No columns were found. Check the separator, worksheet and first data row."
      : null;
  const sourceRows = dataMatrix
    .map((cells, index) => ({ cells, rowNumber: index + firstIndex + 1 }))
    .filter(({ cells }) => cells.some((cell) => String(cell).trim()));
  if (sourceRows.length > 5000)
    throw new ApiFailure(
      "too-many-rows",
      400,
      "Import no more than 5,000 source rows at a time. Choose a shorter statement period.",
    );
  const presetWidth =
    input.layout === "faroese-bookings"
      ? 5
      : input.layout === "faroese-details"
        ? 16
        : null;
  const layoutIssue =
    presetWidth && (input.hasHeaders || width !== presetWidth)
      ? `This layout needs ${presetWidth} columns and no headings. Choose the matching export or use custom mapping.`
      : null;
  const suggested =
    input.layout === "faroese-bookings"
      ? {
          bookingDate: "Column 1",
          description: "Column 2",
          amount: "Column 3",
          currency: "Column 5",
        }
      : input.layout === "faroese-details"
        ? {
            bookingDate: "Column 9",
            description: "Column 2",
            amount: "Column 5",
          }
        : input.provider === "other"
          ? {}
          : suggestStatementMapping(headers);
  const preview = sourceRows.map(({ cells }) =>
    Object.fromEntries(headers.map((h, i) => [h, String(cells[i] ?? "")])),
  );
  const sourceHash = createHash("sha256").update(content).digest("hex");
  const result = {
    accountId: account.id,
    provider: input.provider,
    delimiter,
    sheet: sheetName,
    headerRow: input.headerRow,
    hasHeaders: input.hasHeaders,
    firstDataRow: input.firstDataRow,
    layout: input.layout,
    headerIssue: layoutIssue ?? headerIssue,
    sourceRowCount: sourceRows.length,
    eligibleRowCount: 0,
    excludedRowCount: 0,
    excluded: [] as {
      row: number;
      reason: string;
      original: Record<string, string>;
    }[],
    feeTreatment: input.feeTreatment ?? null,
    fileName: input.fileName,
    sourceHash,
    currency: String(account.data.currency),
    sheets: workbook.SheetNames,
    headers,
    preview: preview.slice(0, 10),
    rows: [] as ImportRow[],
    errors: [] as { row: number; message: string }[],
    mapping: input.mapping ?? suggested,
    valid: false,
  };
  if (result.headerIssue || !input.mapping) return c.json(result);
  if (
    input.provider === "revolut" &&
    (!input.mapping.currency || !input.mapping.state)
  )
    throw new ApiFailure(
      "mapping-required",
      400,
      "For Revolut, also map currency and transaction state before validating.",
    );
  if (
    !["bookingDate", "amount", "description"].every(
      (key) => input.mapping?.[key] && headers.includes(input.mapping[key]!),
    )
  )
    throw new ApiFailure(
      "mapping-required",
      400,
      "Map booking date, signed amount and description.",
    );
  if (Object.values(input.mapping).some((header) => !headers.includes(header)))
    throw new ApiFailure(
      "invalid-mapping",
      400,
      "A selected column is not in this worksheet.",
    );
  for (const [index, original] of preview.entries()) {
    const get = (field: string) =>
      input.mapping?.[field] ? (original[input.mapping[field]!] ?? "") : "";
    const getDate = (field: string) => {
      const column = headers.indexOf(input.mapping?.[field] ?? "");
      const cell =
        column < 0
          ? undefined
          : workbook.Sheets[sheetName]?.["!data"]?.[
              sourceRows[index]!.rowNumber - 1
            ]?.[column];
      const excelDate =
        csvText === undefined
          ? parseExcelStatementDate(
              cell,
              workbook.Workbook?.WBProps?.date1904 === true,
            )
          : undefined;
      return excelDate === undefined
        ? parseStatementDate(get(field), input.dateFormat)
        : excelDate;
    };
    try {
      if (
        input.mapping.currency &&
        get("currency").trim().toUpperCase() !== result.currency
      )
        throw new Error(
          `Row currency must match the selected ${result.currency} account. Choose a statement for this currency.`,
        );
      if (input.mapping.state) {
        const state = get("state").trim().toUpperCase();
        if (
          [
            "PENDING",
            "REVERTED",
            "CANCELLED",
            "CANCELED",
            "FAILED",
            "DECLINED",
          ].includes(state)
        ) {
          result.excluded.push({
            row: sourceRows[index]!.rowNumber,
            reason: `Not imported: ${state.toLowerCase()} transaction`,
            original,
          });
          continue;
        }
        if (state !== "COMPLETED")
          throw new Error(
            "Transaction state must be COMPLETED, or a recognized unsettled/reverted state.",
          );
      }
      const bookingDate = getDate("bookingDate");
      if (!bookingDate) throw new Error("Booking date is required");
      let amount = parseStatementAmount(
        get("amount"),
        input.decimalSeparator,
        result.currency,
      );
      if (input.mapping.fee) {
        const fee = minor(
          parseStatementAmount(
            get("fee"),
            input.decimalSeparator,
            result.currency,
          ),
          result.currency,
        );
        if (fee !== 0n && !input.feeTreatment)
          throw new Error("Choose how nonzero fees affect the signed amount.");
        if (input.feeTreatment === "subtract-positive" && fee < 0n)
          throw new Error(
            "A separate positive charge cannot be negative. Check the fee interpretation.",
          );
        if (input.feeTreatment === "subtract-positive")
          amount = decimal(
            minor(amount, result.currency) - fee,
            result.currency,
          );
        if (input.feeTreatment === "add-signed")
          amount = decimal(
            minor(amount, result.currency) + fee,
            result.currency,
          );
      }
      const description = get("description").trim();
      if (!description) throw new Error("Description is required");
      const sourceId = get("sourceId").trim() || null;
      const reference = get("reference").trim();
      result.rows.push({
        id: semanticId(`${sourceHash}:${index}`),
        sourceId,
        bookingDate,
        transactionDate: getDate("transactionDate"),
        valueDate: getDate("valueDate"),
        amount,
        description,
        reference,
        categoryId: null,
        role: "adjustment",
        status: "unmatched",
        explanation: "",
        transactionId: null,
        original,
      });
    } catch (error) {
      result.errors.push({
        row: sourceRows[index]!.rowNumber,
        message: error instanceof Error ? error.message : "Check this row",
      });
    }
  }
  if (!sourceRows.length)
    result.errors.push({
      row: firstIndex + 1,
      message: "This statement has no transaction rows.",
    });
  if (sourceRows.length && !result.rows.length && !result.errors.length)
    result.errors.push({
      row: firstIndex + 1,
      message:
        "No completed transactions remain to import. Excluded rows are listed for review.",
    });
  result.valid = result.rows.length > 0 && result.errors.length === 0;
  result.eligibleRowCount = result.rows.length;
  result.excludedRowCount = result.excluded.length;
  return c.json(result);
});
