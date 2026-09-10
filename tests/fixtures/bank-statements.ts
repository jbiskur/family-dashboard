// Independently invented transactions. Only layout and aggregate record counts
// mirror user-supplied exports; no actual bank data belongs in tests or artifacts.
export const revolutHeaders = [
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
export const revolutMapping = {
  bookingDate: "Completed Date",
  transactionDate: "Started Date",
  description: "Description",
  amount: "Amount",
  fee: "Fee",
  currency: "Currency",
  state: "State",
};
export const bookingsMapping = {
  bookingDate: "Column 1",
  description: "Column 2",
  amount: "Column 3",
  currency: "Column 5",
};
export const detailsMapping = {
  bookingDate: "Column 9",
  description: "Column 2",
  amount: "Column 5",
  transactionDate: "Column 8",
  valueDate: "Column 10",
  sourceId: "Column 11",
};
export function csvText(rows: string[][], delimiter = ";", bom = true) {
  const quote = (cell: string) => `"${cell.replaceAll('"', '""')}"`;
  return (
    (bom ? "\uFEFF" : "") +
    rows.map((cells) => cells.map(quote).join(delimiter)).join("\r\n") +
    "\r\n"
  );
}
export function bookingsRows(count = 405, label = "Fictional purchase") {
  return Array.from({ length: count }, (_, i) => [
    "16-04-2035",
    `${label} ${i + 1} — mjólk, breyð`,
    "-1,00",
    `${5000 - i - 1},00`,
    "DKK",
  ]);
}
export function detailsRows(count = 405, label = "Fictional purchase") {
  return Array.from({ length: count }, (_, i) => [
    "Example shop",
    `${label} ${i + 1} — mjólk, breyð`,
    "Example type",
    "Example channel",
    "-1,00",
    "",
    "",
    "15-04-2035",
    "16-04-2035",
    "17-04-2035",
    String(9000000000 + i),
    "",
    "",
    "",
    "",
    "",
  ]);
}
export function revolutRows(count = 1198, label = "Fictional purchase") {
  return Array.from({ length: count }, (_, i) => {
    const state = i < 1192 ? "COMPLETED" : i < 1196 ? "REVERTED" : "PENDING";
    return [
      "CARD_PAYMENT",
      "Current",
      "2035-04-15 23:59:59",
      state === "COMPLETED" ? "2035-04-16 00:00:01" : "",
      `${label} ${i + 1}`,
      "-1.00",
      i === 0 ? "0.50" : "0.00",
      "DKK",
      state,
      `${5000 - i - 1}.00`,
    ];
  });
}
export function annualRevolut(label?: string) {
  return csvText([revolutHeaders, ...revolutRows(1198, label)], ",", false);
}
