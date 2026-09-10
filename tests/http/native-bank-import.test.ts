import { beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { loadTestEnv, request, tokenFor } from "../fixtures/auth";
import {
  annualRevolut,
  bookingsMapping,
  bookingsRows,
  csvText,
  detailsMapping,
  detailsRows,
  revolutMapping,
} from "../fixtures/bank-statements";

const XLSX = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
)("xlsx");
let owner: string;
let accountId: string;
beforeAll(async () => {
  await loadTestEnv();
  owner = await tokenFor();
  expect((await request("access/admit", owner, {})).status).toBe(200);
  const response = await request("finance/accounts", owner, {
    commandId: crypto.randomUUID(),
    name: `Native preview ${crypto.randomUUID()}`,
    currency: "DKK",
  });
  expect(response.status).toBe(201);
  accountId = (await response.json()).id;
});
function source(text: string, extra: Record<string, unknown> = {}) {
  return {
    accountId,
    provider: "faroese",
    fileName: "fictional-native.csv",
    contentBase64: Buffer.from(text).toString("base64"),
    hasHeaders: false,
    firstDataRow: 1,
    decimalSeparator: ",",
    dateFormat: "dd-MM-yyyy",
    ...extra,
  };
}
async function preview(body: Record<string, unknown>) {
  const response = await request("finance/imports/preview", owner, body);
  expect(response.status).toBe(200);
  return response.json();
}

test("headerless bookings keep all 405 physical rows and editable native suggestions without writes", async () => {
  const before = await (
    await request(
      `finance/transactions?accountId=${accountId}&month=2035-04`,
      owner,
    )
  ).json();
  const input = source(csvText(bookingsRows()), { layout: "faroese-bookings" });
  const discovered = await preview(input);
  expect(discovered.headerIssue).toBeNull();
  expect(discovered.headers).toEqual([
    "Column 1",
    "Column 2",
    "Column 3",
    "Column 4",
    "Column 5",
  ]);
  expect(discovered.sourceRowCount).toBe(405);
  expect(discovered.mapping).toMatchObject(bookingsMapping);
  const parsed = await preview({ ...input, mapping: discovered.mapping });
  expect(parsed.valid).toBe(true);
  expect(parsed.rows).toHaveLength(405);
  expect(parsed.rows[0]).toMatchObject({
    bookingDate: "2035-04-16",
    amount: "-1.00",
    description: "Fictional purchase 1 — mjólk, breyð",
  });
  expect(parsed.rows.at(-1).description).toBe(
    "Fictional purchase 405 — mjólk, breyð",
  );
  expect(parsed.rows[0].original).toEqual(
    Object.fromEntries(
      bookingsRows(1)[0]!.map((v, i) => [`Column ${i + 1}`, v]),
    ),
  );
  expect(
    await (
      await request(
        `finance/transactions?accountId=${accountId}&month=2035-04`,
        owner,
      )
    ).json(),
  ).toEqual(before);
});

test("sixteen-column details retain blank metadata, unique source IDs and explicit optional dates", async () => {
  const input = source(csvText(detailsRows()), { layout: "faroese-details" });
  const discovered = await preview(input);
  expect(discovered.headerIssue).toBeNull();
  expect(discovered.headers).toHaveLength(16);
  expect(discovered.sourceRowCount).toBe(405);
  expect(discovered.mapping).toMatchObject({
    bookingDate: "Column 9",
    description: "Column 2",
    amount: "Column 5",
  });
  const parsed = await preview({ ...input, mapping: detailsMapping });
  expect(parsed.valid).toBe(true);
  expect(parsed.rows).toHaveLength(405);
  expect(parsed.rows[0]).toMatchObject({
    sourceId: "9000000000",
    bookingDate: "2035-04-16",
    transactionDate: "2035-04-15",
    valueDate: "2035-04-17",
    amount: "-1.00",
  });
  expect(
    new Set(parsed.rows.map((r: { sourceId: string }) => r.sourceId)).size,
  ).toBe(405);
  expect(parsed.rows.at(-1).sourceId).toBe("9000000404");
  expect(parsed.rows[0].original["Column 16"]).toBe("");
});

test("annual Revolut inspects 1198 records with explicit fees and six visible exclusions", async () => {
  const input = source(annualRevolut(), {
    provider: "revolut",
    hasHeaders: true,
    decimalSeparator: ".",
    dateFormat: "yyyy-MM-dd HH:mm:ss",
    mapping: revolutMapping,
  });
  const blocked = await preview(input);
  expect(blocked.valid).toBe(false);
  expect(blocked.sourceRowCount).toBe(1198);
  expect(blocked.errors).toHaveLength(1);
  expect(blocked.errors[0].row).toBe(2);
  const parsed = await preview({ ...input, feeTreatment: "subtract-positive" });
  expect(parsed.valid).toBe(true);
  expect(parsed.rows).toHaveLength(1192);
  expect(parsed.excluded).toHaveLength(6);
  expect(parsed.excluded.map((r: { row: number }) => r.row)).toEqual([
    1194, 1195, 1196, 1197, 1198, 1199,
  ]);
  expect(parsed.rows[0].amount).toBe("-1.50");
  expect(parsed.rows.at(-1).description).toBe("Fictional purchase 1192");
});

test("headerless first-data-row recovery preserves physical error rows and Excel dates", async () => {
  const input = source(
    `Report\r\n\r\n${csvText(bookingsRows(2), ";", false)}`,
    { firstDataRow: 3, mapping: bookingsMapping, layout: "faroese-bookings" },
  );
  const parsed = await preview(input);
  expect(parsed.valid).toBe(true);
  expect(parsed.rows).toHaveLength(2);
  const invalid = await preview({ ...input, dateFormat: "yyyy-MM-dd" });
  expect(invalid.errors.map((r: { row: number }) => r.row)).toEqual([3, 4]);
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(
    [
      ["Report"],
      [],
      [new Date(2035, 3, 16, 12), "Fictional numeric Excel", -1, 4999, "DKK"],
    ],
    { cellDates: false },
  );
  sheet.A3.z = "dd-mm-yyyy";
  XLSX.utils.book_append_sheet(book, sheet, "Transactions");
  const excel = await preview({
    ...input,
    fileName: "fictional-native.xlsx",
    decimalSeparator: ".",
    contentBase64: Buffer.from(
      XLSX.write(book, { type: "buffer", bookType: "xlsx" }),
    ).toString("base64"),
  });
  expect(excel.valid).toBe(true);
  expect(excel.rows[0].bookingDate).toBe("2035-04-16");
});

test("5000-row boundary is explicit and unknown headerless layouts remain manually mappable", async () => {
  const limit = await preview(
    source(csvText(bookingsRows(5000)), { mapping: bookingsMapping }),
  );
  expect(limit.valid).toBe(true);
  expect(limit.rows).toHaveLength(5000);
  const over = await request(
    "finance/imports/preview",
    owner,
    source(csvText(bookingsRows(5001)), { mapping: bookingsMapping }),
  );
  expect(over.status).toBe(400);
  expect((await over.json()).error.code).toBe("too-many-rows");
  const custom = await preview(
    source(csvText([["16-04-2035", "Fictional", "-1,00"]]), {
      mapping: {
        bookingDate: "Column 1",
        description: "Column 2",
        amount: "Column 3",
      },
    }),
  );
  expect(custom.valid).toBe(true);
  expect(custom.rows).toHaveLength(1);
});
