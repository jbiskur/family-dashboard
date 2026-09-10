"use client";
import { FileSpreadsheet, Landmark } from "lucide-react";
import { useState } from "react";
import { EntityForm, type FormField } from "../shared/form";
import { Select } from "../ui/input";

export type StatementProvider = "other" | "revolut" | "faroese";
export type StatementLayout = "custom" | "faroese-bookings" | "faroese-details";
export function StatementGuidance({
  provider,
  onChange,
}: {
  provider: StatementProvider;
  onChange: (value: StatementProvider) => void;
}) {
  return (
    <div className="import-guidance">
      <div className="form-field">
        <label htmlFor="statement-provider">
          <Landmark size={16} aria-hidden="true" /> Statement from
        </label>
        <Select
          id="statement-provider"
          value={provider}
          onChange={(event) =>
            onChange(event.target.value as StatementProvider)
          }
        >
          <option value="other">Other bank / manual mapping</option>
          <option value="revolut">Revolut</option>
          <option value="faroese">Faroese bank</option>
        </Select>
      </div>
      {provider === "revolut" ? (
        <p className="field-hint">
          In Revolut: Home → Accounts → choose a currency → More → Statement →
          CSV or Excel. Choose the same currency here. We suggest columns for
          you to check; only completed transactions are included.{" "}
          <a
            className="text-link"
            href="https://help.revolut.com/help/profile-and-plan/managing-my-account/account-statement-per-chosen-currency/"
            target="_blank"
            rel="noreferrer"
          >
            Revolut export help
          </a>
        </p>
      ) : provider === "faroese" ? (
        <p className="field-hint">
          Choose your bank’s CSV or Excel export. In Føroya Banki: open the
          account, select the period and transactions, then Flyt út → CSV or
          Excel. Layouts vary; check the column suggestions and date format.{" "}
          <a
            className="text-link"
            href="https://www.bankin.fo/privat/hjalp/netbankin-landingsida/hjalp-web---landingssida/vinnusida-web"
            target="_blank"
            rel="noreferrer"
          >
            Føroya Banki export help
          </a>{" "}
          Choose either the bookings export or payment-details export for a
          period. They describe the same transactions: importing both can create
          duplicates. The simpler bookings export is usually enough. For files
          without column names, choose the matching no-headings layout below.
        </p>
      ) : (
        <p className="field-hint">
          Use a CSV or Excel statement from your bank. You choose which columns
          to use before anything is imported.
        </p>
      )}
    </div>
  );
}

export function StatementFormat({
  delimiter,
  sheet,
  sheets,
  headerRow,
  hasHeaders,
  firstDataRow,
  layout,
  issue,
  onSubmit,
  onChange,
}: {
  delimiter: string;
  sheet?: string;
  sheets: string[];
  headerRow: number;
  hasHeaders: boolean;
  firstDataRow: number;
  layout: StatementLayout;
  issue?: string | null;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
  onChange: () => void;
}) {
  const [headings, setHeadings] = useState(hasHeaders);
  const fields: FormField[] = [
    {
      name: "layout",
      label: "Statement layout",
      defaultValue:
        layout === "custom"
          ? hasHeaders
            ? "headings"
            : "no-headings"
          : layout,
      options: [
        { value: "headings", label: "Column names in a heading row" },
        { value: "no-headings", label: "No headings · custom mapping" },
        {
          value: "faroese-bookings",
          label: "Faroese bookings · 5 columns, no headings",
        },
        {
          value: "faroese-details",
          label: "Faroese payment details · 16 columns, no headings",
        },
      ],
      hint: "Presets suggest columns only. Check the source and edit the mapping before confirmation.",
    },
    {
      name: "delimiter",
      label: "CSV separator",
      defaultValue: delimiter,
      options: [
        { value: "auto", label: "Detect automatically" },
        { value: ",", label: "Comma" },
        { value: ";", label: "Semicolon" },
        { value: "\t", label: "Tab" },
      ],
    },
    {
      name: "headerRow",
      label: headings ? "Header row" : "First data row",
      type: "number",
      min: "1",
      max: "50",
      step: "1",
      required: true,
      defaultValue: String(hasHeaders ? headerRow : firstDataRow),
      hint: headings
        ? "Count rows from 1, including blank rows before the column names."
        : "Count physical rows from 1. This row is a transaction and will be included.",
    },
    ...(sheets.length
      ? [
          {
            name: "sheet",
            label: "Worksheet",
            defaultValue: sheet ?? sheets[0],
            options: sheets.map((name) => ({ value: name, label: name })),
          },
        ]
      : []),
  ];
  return (
    <details className="import-format" open={issue ? true : undefined}>
      <summary>
        <FileSpreadsheet size={17} aria-hidden="true" /> File layout &amp;
        format
      </summary>
      {issue && (
        <p className="notice warning" role="alert">
          {issue}
        </p>
      )}
      <p className="field-hint">
        If the columns look wrong, change these settings and read the file
        again. This clears the previous review.
      </p>
      <EntityForm
        fields={fields}
        submitLabel="Read with these settings"
        onSubmit={onSubmit}
        onValuesChange={(values) => {
          setHeadings(values.layout === "headings");
          onChange();
        }}
      />
    </details>
  );
}
