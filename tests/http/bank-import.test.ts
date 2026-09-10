import { beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { loadTestEnv, request, tokenFor } from "../fixtures/auth";

const XLSX = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
)("xlsx");
let owner: string;
let accountId: string;
const columns = [
  "Type",
  "Product",
  "Started Date",
  "Completed Date",
  "Description",
  "Amount",
  "Fee",
  "Currency",
  "State",
  "Balance",
];
const baseMapping = {
  bookingDate: "Completed Date",
  transactionDate: "Started Date",
  description: "Description",
  amount: "Amount",
  fee: "Fee",
  currency: "Currency",
  state: "State",
};
const row = (
  description: string,
  amount: string,
  fee = "0.00",
  currency = "DKK",
  state = "COMPLETED",
) => [
  "CARD_PAYMENT",
  "Current",
  "2035-04-15 23:59:59",
  "2035-04-16 00:00:01",
  description,
  amount,
  fee,
  currency,
  state,
  "",
];
function file(rows: string[][], options: Record<string, unknown> = {}) {
  return {
    accountId,
    provider: "revolut",
    fileName: "synthetic-revolut.csv",
    contentBase64: Buffer.from(
      [columns, ...rows].map((cells) => cells.join(",")).join("\n"),
    ).toString("base64"),
    dateFormat: "yyyy-MM-dd HH:mm:ss",
    mapping: baseMapping,
    ...options,
  };
}
async function preview(input: Record<string, unknown>) {
  const response = await request("finance/imports/preview", owner, input);
  expect(response.status).toBe(200);
  return response.json();
}
async function create(path: string, data: Record<string, unknown>) {
  const response = await request(path, owner, {
    commandId: crypto.randomUUID(),
    ...data,
  });
  expect(response.status).toBe(201);
  return response.json();
}
beforeAll(async () => {
  await loadTestEnv();
  owner = await tokenFor();
  expect((await request("access/admit", owner, {})).status).toBe(200);
  accountId = (
    await create("finance/accounts", {
      name: `Bank import ${crypto.randomUUID()}`,
      currency: "DKK",
    })
  ).id;
});

// 393e3d11-a251-45c7-9755-895554451e74 S1/S3: synthetic export shapes, not bank-issued samples.
test("guided statements preserve dates and exact signed fees, and explain excluded states", async () => {
  const rows = [
    row("Groceries", "-12.34", "0.50"),
    row("Refund", "10.00", "0.25"),
    row("Pending", "-100.00", "0.00", "DKK", "PENDING"),
    row("Reverted", "-50.00", "0.00", "DKK", "REVERTED"),
  ];
  const ambiguous = await preview(file(rows));
  expect(ambiguous.valid).toBe(false);
  expect(ambiguous.errors.map((error: { row: number }) => error.row)).toEqual([
    2, 3,
  ]);
  const valid = await preview(
    file(rows, { feeTreatment: "subtract-positive" }),
  );
  expect(valid.valid).toBe(true);
  expect(valid.rows.map((item: { amount: string }) => item.amount)).toEqual([
    "-12.84",
    "9.75",
  ]);
  expect(valid.rows[0]).toMatchObject({
    bookingDate: "2035-04-16",
    transactionDate: "2035-04-15",
    original: { Amount: "-12.34", Fee: "0.50" },
  });
  expect(valid.excluded.map((item: { row: number }) => item.row)).toEqual([
    4, 5,
  ]);
  expect(valid.excluded[0].reason).toContain("pending");
  expect(
    (
      await preview(
        file([row("Included", "-12.34", "0.50")], { feeTreatment: "included" }),
      )
    ).rows[0].amount,
  ).toBe("-12.34");
  expect(
    (
      await preview(
        file([row("Signed", "-12.34", "-0.50")], {
          feeTreatment: "add-signed",
        }),
      )
    ).rows[0].amount,
  ).toBe("-12.84");
  expect(
    (
      await preview(
        file([row("Wrong fee sign", "-12.34", "-0.50")], {
          feeTreatment: "subtract-positive",
        }),
      )
    ).valid,
  ).toBe(false);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([columns, ...rows]),
    "Transactions",
  );
  const excel = await preview(
    file([], {
      fileName: "synthetic-revolut.xlsx",
      contentBase64: Buffer.from(
        XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
      ).toString("base64"),
      feeTreatment: "subtract-positive",
    }),
  );
  expect(excel.rows.map((item: { amount: string }) => item.amount)).toEqual([
    "-12.84",
    "9.75",
  ]);
});

test("currency, unknown states, malformed precision and missing Revolut safeguards block confirmation", async () => {
  for (const candidate of [
    row("Wrong currency", "-1.00", "0.00", "EUR"),
    row("Unknown state", "-1.00", "0.00", "DKK", "NEW_STATE"),
    row("Empty state", "-1.00", "0.00", "DKK", ""),
    row("Precision", "-1.001"),
  ]) {
    const result = await preview(file([row("Valid", "1.00"), candidate]));
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(3);
  }
  expect(
    (
      await request(
        "finance/imports/preview",
        owner,
        file([row("Missing maps", "1.00")], {
          mapping: {
            bookingDate: "Completed Date",
            description: "Description",
            amount: "Amount",
          },
        }),
      )
    ).status,
  ).toBe(400);
  const invalidDate = row("Invalid calendar", "1.00");
  invalidDate[3] = "2035-02-30 00:00:00";
  expect((await preview(file([invalidDate]))).valid).toBe(false);
  expect(
    (await request("finance/imports/preview", undefined, file([]))).status,
  ).toBe(401);
  expect(
    (
      await request(
        "finance/imports/preview",
        owner,
        file([], { accountId: crypto.randomUUID() }),
      )
    ).status,
  ).toBe(404);
});

// S2/S5: physical blank rows and cover worksheets remain recoverable.
test("Faroese-style statements recover physical header rows, separators and worksheets", async () => {
  const csv =
    '\nStatement report\n\nDagfesting;Upphædd;Tekstur\n15-04-2035;-1.234,56;"Mjólk, breyð"\n';
  const source = {
    accountId,
    provider: "faroese",
    fileName: "synthetic-faroese.csv",
    contentBase64: Buffer.from(csv).toString("base64"),
    decimalSeparator: ",",
    dateFormat: "dd-MM-yyyy",
  };
  const first = await preview(source);
  expect(first.valid).toBe(false);
  expect(first.headerIssue).toBeTruthy();
  const read = await preview({ ...source, headerRow: 4 });
  expect(read.delimiter).toBe(";");
  expect(read.headers).toEqual(["Dagfesting", "Upphædd", "Tekstur"]);
  expect(read.mapping).toMatchObject({
    bookingDate: "Dagfesting",
    amount: "Upphædd",
    description: "Tekstur",
  });
  const mapped = await preview({
    ...source,
    headerRow: 4,
    mapping: read.mapping,
  });
  expect(mapped.valid).toBe(true);
  const withBom = await preview({
    ...source,
    headerRow: 4,
    mapping: read.mapping,
    contentBase64: Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(csv),
    ]).toString("base64"),
  });
  expect(withBom.rows[0].description).toBe("Mjólk, breyð");
  const malformedEncoding = await request("finance/imports/preview", owner, {
    ...source,
    contentBase64: Buffer.from([0xff, 0xfe, 0x61]).toString("base64"),
  });
  expect(malformedEncoding.status).toBe(400);
  expect((await malformedEncoding.json()).error.message).toContain("UTF-8");
  expect(mapped.rows[0]).toMatchObject({
    amount: "-1234.56",
    bookingDate: "2035-04-15",
    description: "Mjólk, breyð",
  });
  for (const [date, dateFormat] of [
    ["15.04.2035", "dd.MM.yyyy"],
    ["15/04/2035", "dd/MM/yyyy"],
  ]) {
    const input = {
      ...source,
      headerRow: 4,
      dateFormat,
      mapping: read.mapping,
      contentBase64: Buffer.from(csv.replace("15-04-2035", date!)).toString(
        "base64",
      ),
    };
    expect((await preview(input)).rows[0].bookingDate).toBe("2035-04-15");
  }
  const invalid = await preview({
    ...source,
    headerRow: 4,
    mapping: read.mapping,
    decimalSeparator: ".",
  });
  expect(invalid.valid).toBe(false);
  expect(invalid.errors[0].row).toBe(5);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Statement report"],
      [],
      ["Account", "Statement"],
    ]),
    "Cover",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Dagfesting", "Upphædd", "Tekstur"],
      ["15-04-2035", "-1.234,56", "Mjólk"],
    ]),
    "Transactions",
  );
  const excel = {
    ...source,
    fileName: "synthetic-faroese.xlsx",
    contentBase64: Buffer.from(
      XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }),
    ).toString("base64"),
  };
  const cover = await preview(excel);
  expect(cover.sheets).toEqual(["Cover", "Transactions"]);
  expect(cover.headerIssue).toBeTruthy();
  expect(
    (await preview({ ...excel, sheet: "Transactions", mapping: read.mapping }))
      .valid,
  ).toBe(true);
});

test("real Excel numeric date cells retain calendar dates across workbook epochs without guessing numbers", async () => {
  function excel(value: number | Date, format: string, date1904 = false) {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet(
      [
        ["Date", "Description", "Amount"],
        [value, "Synthetic numeric Excel date", "-12.34"],
      ],
      { cellDates: false },
    );
    sheet.A2.z = format;
    book.Workbook = { WBProps: { date1904 } };
    XLSX.utils.book_append_sheet(book, sheet, "Transactions");
    return {
      accountId,
      provider: "faroese",
      fileName: "synthetic-numeric-date.xlsx",
      contentBase64: Buffer.from(
        XLSX.write(book, { type: "buffer", bookType: "xlsx" }),
      ).toString("base64"),
      dateFormat: "dd-MM-yyyy",
      mapping: {
        bookingDate: "Date",
        description: "Description",
        amount: "Amount",
      },
    };
  }
  const timestamp = await preview(
    excel(new Date(2035, 3, 16, 23, 59, 59), "m/d/yy h:mm"),
  );
  expect(timestamp.valid).toBe(true);
  expect(timestamp.rows[0].bookingDate).toBe("2035-04-16");
  expect(timestamp.rows[0].amount).toBe("-12.34");
  expect(timestamp.rows[0].original.Date).toContain("4/16/35");
  const serial1904 =
    (Date.UTC(2035, 3, 16) - Date.UTC(1904, 0, 1)) / 86400000 + 0.5;
  const epoch = await preview(excel(serial1904, "d.m.yy hh:mm", true));
  expect(epoch.valid).toBe(true);
  expect(epoch.rows[0].bookingDate).toBe("2035-04-16");
  const fictionalLeapDay = await preview(excel(60, "m/d/yy"));
  expect(fictionalLeapDay.valid).toBe(false);
  expect(fictionalLeapDay.errors[0].row).toBe(2);
  const plainNumber = await preview(excel(49050, "General"));
  expect(plainNumber.valid).toBe(false);
  const timeOnly = await preview(excel(0.5, "h:mm", true));
  expect(timeOnly.valid).toBe(false);
});

test("preview writes nothing; explicit import retains file dedup and overlapping row review", async () => {
  const input = file([
    row(`Synthetic purchase ${crypto.randomUUID()}`, "-12.34"),
  ]);
  const before = await (
    await request(
      `finance/transactions?accountId=${accountId}&month=2035-04`,
      owner,
    )
  ).json();
  const initial = await preview({ ...input, mapping: undefined });
  expect(initial.valid).toBe(false);
  expect(initial.mapping.amount).toBe("Amount");
  const parsed = await preview(input);
  expect(parsed.valid).toBe(true);
  const after = await (
    await request(
      `finance/transactions?accountId=${accountId}&month=2035-04`,
      owner,
    )
  ).json();
  expect(after).toEqual(before);
  const confirmed = await create("finance/imports", parsed);
  expect(confirmed.status).toBe("needs-review");
  expect(confirmed.rows).toHaveLength(1);
  const duplicate = await request("finance/imports", owner, {
    commandId: crypto.randomUUID(),
    ...parsed,
  });
  expect(duplicate.status).toBe(409);
  const overlap = await preview({
    ...input,
    contentBase64: Buffer.from(
      `${Buffer.from(input.contentBase64, "base64").toString()}\n`,
    ).toString("base64"),
  });
  const second = await create("finance/imports", overlap);
  expect(second.duplicateCount).toBe(1);
  expect(second.rows[0].status).toBe("possible-duplicate");
  expect(second.status).toBe("needs-review");
});

test("empty sources and malformed layouts remain explicit and invalid", async () => {
  const empty = await preview(file([]));
  expect(empty.valid).toBe(false);
  expect(empty.errors[0].message).toContain("no transaction rows");
  const duplicateHeaders = await preview(
    file([], {
      contentBase64: Buffer.from(
        "Date,Date,Amount\n2035-04-15,2035-04-15,1.00",
      ).toString("base64"),
    }),
  );
  expect(duplicateHeaders.headerIssue).toBeTruthy();
  expect(duplicateHeaders.valid).toBe(false);
  const allExcluded = await preview(
    file([row("Waiting", "-1.00", "0.00", "DKK", "PENDING")]),
  );
  expect(allExcluded.valid).toBe(false);
  expect(allExcluded.excluded).toHaveLength(1);
});

// S2/S5: blank physical rows must never conceal a truncated suffix.
test("statements cannot silently truncate later transactions after blank rows", async () => {
  const content =
    "Date,Amount,Description\n2035-04-15,-1.00,First\n" +
    "\n".repeat(1055) +
    "2035-04-16,-2.00,Last\n";
  const response = await request("finance/imports/preview", owner, {
    accountId,
    fileName: "synthetic-physical-row-limit.csv",
    contentBase64: Buffer.from(content).toString("base64"),
    mapping: {
      bookingDate: "Date",
      amount: "Amount",
      description: "Description",
    },
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("too-many-rows");
});
