import { Temporal } from "@js-temporal/polyfill";
import * as XLSX from "xlsx";
import { decimal, minor } from "./domain";

/** Excel dates are typed serials, independent of displayed locale or CSV text interpretation. */
export function parseExcelStatementDate(
  cell: XLSX.CellObject | undefined,
  date1904: boolean,
) {
  if (
    cell?.t !== "n" ||
    typeof cell.z !== "string" ||
    !XLSX.SSF.is_date(cell.z)
  )
    return undefined;
  // Time-only or elapsed-duration formats do not establish a booking calendar date.
  const calendarFormat = cell.z.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "");
  if (
    !/[yd]/i.test(calendarFormat) ||
    typeof cell.v !== "number" ||
    !Number.isFinite(cell.v)
  )
    throw new Error(
      "Use an Excel calendar-date cell or an explicit date, not a time-only value.",
    );
  const date = XLSX.SSF.parse_date_code(cell.v, { date1904 }) as {
    y: number;
    m: number;
    d: number;
  } | null;
  if (!date)
    throw new Error("This Excel date is outside the supported calendar.");
  // Validate Excel's fictional 1900-02-29 and invalid day zero without coercion.
  return parseStatementDate(
    `${String(date.y).padStart(4, "0")}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`,
    "yyyy-MM-dd",
  );
}

export function parseStatementDate(value: string, format: string) {
  const text = value.trim();
  if (!text) return null;
  if (format === "yyyy-MM-dd HH:mm:ss") {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text))
      throw new Error(
        "Date does not match the selected timestamp interpretation",
      );
    // Preserve the bank's calendar date, including timestamps near midnight.
    return Temporal.PlainDateTime.from(text.replace(" ", "T"))
      .toPlainDate()
      .toString();
  }
  if (format === "yyyy-MM-dd") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
      throw new Error("Date does not match the selected interpretation");
    return Temporal.PlainDate.from(text).toString();
  }
  const separator = format.includes("/")
    ? "/"
    : format.includes(".")
      ? "."
      : "-";
  const parts = text.split(separator);
  if (
    parts.length !== 3 ||
    !/^\d{2}$/.test(parts[0]!) ||
    !/^\d{2}$/.test(parts[1]!) ||
    !/^\d{4}$/.test(parts[2]!)
  )
    throw new Error("Date does not match the selected interpretation");
  const [first, second, year] = parts;
  return Temporal.PlainDate.from(
    `${year}-${format === "MM/dd/yyyy" ? first : second}-${format === "MM/dd/yyyy" ? second : first}`,
  ).toString();
}

export function parseStatementAmount(
  value: string,
  separator: "." | ",",
  currency: string,
) {
  const text = value.trim();
  const pattern =
    separator === "."
      ? /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/
      : /^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/;
  if (!pattern.test(text))
    throw new Error(
      "Amount does not match the selected decimal interpretation",
    );
  const normalized =
    separator === "."
      ? text.replaceAll(",", "")
      : text.replaceAll(".", "").replace(",", ".");
  return decimal(minor(normalized, currency), currency);
}

// Suggestions are conveniences for discovered columns, not bank-certified schemas.
const aliases: Record<string, string[]> = {
  bookingDate: [
    "booking date",
    "booked",
    "completed date",
    "date completed (utc)",
    "date",
    "dagfesting",
    "bókingardagur",
  ],
  transactionDate: [
    "transaction date",
    "started date",
    "date started (utc)",
    "occurred",
  ],
  valueDate: ["value date", "valued", "valørdag"],
  amount: ["amount", "signed amount", "upphædd", "beløb"],
  description: [
    "description",
    "memo",
    "tekstur",
    "tekst",
    "frágreiðing",
    "gjalding/flyting",
  ],
  sourceId: ["transaction id", "source", "id"],
  reference: ["reference", "tilvísing"],
  currency: ["currency", "gjaldoyra", "valuta"],
  state: ["state", "status"],
  fee: ["fee", "fees", "gebyr"],
};
export function suggestStatementMapping(headers: string[]) {
  const mapping: Record<string, string> = {};
  for (const [field, names] of Object.entries(aliases)) {
    const matches = headers.filter((h) =>
      names.includes(h.toLocaleLowerCase("en")),
    );
    if (matches.length === 1) mapping[field] = matches[0]!;
  }
  return mapping;
}

export function detectStatementDelimiter(text: string): "," | ";" | "\t" {
  const scores = new Map<"," | ";" | "\t", number>([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  let quoted = false;
  let lines = 0;
  let counts = { ",": 0, ";": 0, "\t": 0 };
  for (let i = 0; i < text.length && lines < 50; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted && (char === "," || char === ";" || char === "\t"))
      counts[char]++;
    else if (!quoted && char === "\n") {
      for (const delimiter of scores.keys())
        scores.set(
          delimiter,
          Math.max(scores.get(delimiter)!, counts[delimiter]),
        );
      counts = { ",": 0, ";": 0, "\t": 0 };
      lines++;
    }
  }
  for (const delimiter of scores.keys())
    scores.set(delimiter, Math.max(scores.get(delimiter)!, counts[delimiter]));
  return [...scores].sort((a, b) => b[1] - a[1])[0]![0];
}
