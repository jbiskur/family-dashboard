"use client";
import { type SelectHTMLAttributes, useState } from "react";
import { Input, Select } from "../ui/input";
export function SearchableSelect({
  options,
  label,
  ...props
}: {
  options: { value: string; label: string }[];
  label: string;
} & SelectHTMLAttributes<HTMLSelectElement>) {
  const [search, setSearch] = useState("");
  const matches = options.filter(
    (option) =>
      option.value === "" ||
      option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const selected = options.find((option) => option.value === props.value);
  const shown =
    selected && !matches.includes(selected) ? [selected, ...matches] : matches;
  return (
    <>
      <Input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        aria-label={`Search ${label.toLowerCase()} choices`}
        placeholder="Search stores…"
        style={{ marginBottom: 8 }}
      />
      <Select {...props}>
        {shown.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      {search && !matches.some((option) => option.value) && (
        <p className="field-hint" role="status">
          No matching stores. Your current choice is kept until you change it.
        </p>
      )}
    </>
  );
}
