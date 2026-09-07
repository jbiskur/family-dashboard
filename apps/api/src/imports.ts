import { createHash } from "node:crypto";
import type { ImportRow } from "@heima/contracts";
import { Temporal } from "@js-temporal/polyfill";
import { Hono } from "hono";
import * as XLSX from "xlsx";
import { z } from "zod";
import { type ApiVariables, requireMember } from "./access";
import { canManage, decimal, minor } from "./domain";
import { ApiFailure } from "./errors";
import { loadResources, visibleResource } from "./resources";
import { semanticId } from "./security";

const inputSchema = z.object({
  accountId: z.string().uuid(),
  fileName: z.string().min(1).max(240),
  contentBase64: z.string().max(14_000_000),
  delimiter: z.enum([",", ";", "\t"]).optional(),
  sheet: z.string().optional(),
  headerRow: z.number().int().min(1).max(50).default(1),
  mapping: z.record(z.string()).optional(),
  decimalSeparator: z.enum([".", ","]).default("."),
  dateFormat: z
    .enum(["yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy"])
    .default("yyyy-MM-dd"),
});
function parseDate(value: string, format: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed =
    format === "yyyy-MM-dd"
      ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
      : /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (!parsed)
    throw new Error("Date does not match the selected interpretation");
  const valueISO =
    format === "yyyy-MM-dd"
      ? trimmed
      : `${parsed[3]}-${format === "dd/MM/yyyy" ? parsed[2] : parsed[1]}-${format === "dd/MM/yyyy" ? parsed[1] : parsed[2]}`;
  return Temporal.PlainDate.from(valueISO).toString();
}
function parseAmount(value: string, separator: "." | ",", currency: string) {
  const s = value.trim();
  const pattern =
    separator === "."
      ? /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/
      : /^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/;
  if (!pattern.test(s))
    throw new Error(
      "Amount does not match the selected decimal interpretation",
    );
  const normalized =
    separator === "."
      ? s.replaceAll(",", "")
      : s.replaceAll(".", "").replace(",", ".");
  return decimal(minor(normalized, currency), currency);
}
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
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(content, {
      type: "buffer",
      raw: true,
      cellDates: false,
      sheetRows: 1052,
      FS: input.delimiter,
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
  const matrix = XLSX.utils.sheet_to_json<string[]>(
    workbook.Sheets[sheetName]!,
    { header: 1, raw: false, defval: "", blankrows: false },
  );
  const headers = (matrix[input.headerRow - 1] ?? []).map((v) =>
    String(v).trim(),
  );
  if (
    !headers.length ||
    new Set(headers).size !== headers.length ||
    headers.some((h) => !h)
  )
    throw new ApiFailure(
      "invalid-headers",
      400,
      "Choose a header row with unique, non-empty column names.",
    );
  const sourceRows = matrix.slice(input.headerRow);
  if (sourceRows.length > 1000)
    throw new ApiFailure(
      "too-many-rows",
      400,
      "Import no more than 1000 source rows at a time.",
    );
  const preview = sourceRows.map((row) =>
    Object.fromEntries(headers.map((h, i) => [h, String(row[i] ?? "")])),
  );
  const sourceHash = createHash("sha256").update(content).digest("hex");
  const result = {
    accountId: account.id,
    fileName: input.fileName,
    sourceHash,
    currency: String(account.data.currency),
    sheets: workbook.SheetNames,
    headers,
    preview: preview.slice(0, 10),
    rows: [] as ImportRow[],
    errors: [] as { row: number; message: string }[],
    mapping: input.mapping ?? {},
    valid: false,
  };
  if (!input.mapping) return c.json(result);
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
    try {
      const bookingDate = parseDate(get("bookingDate"), input.dateFormat);
      if (!bookingDate) throw new Error("Booking date is required");
      const amount = parseAmount(
        get("amount"),
        input.decimalSeparator,
        result.currency,
      );
      const description = get("description").trim();
      if (!description) throw new Error("Description is required");
      const sourceId = get("sourceId").trim() || null;
      const reference = get("reference").trim();
      result.rows.push({
        id: semanticId(`${sourceHash}:${index}`),
        sourceId,
        bookingDate,
        transactionDate: parseDate(get("transactionDate"), input.dateFormat),
        valueDate: parseDate(get("valueDate"), input.dateFormat),
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
        row: index + input.headerRow + 1,
        message: error instanceof Error ? error.message : "Check this row",
      });
    }
  }
  result.valid = result.rows.length > 0 && result.errors.length === 0;
  return c.json(result);
});
