"use client";
import { useForm } from "@tanstack/react-form";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { Button } from "../ui/button";
import { Input, Select, Textarea } from "../ui/input";
import { ErrorState } from "./page";
import { SearchableSelect } from "./searchable-select";

export type FormField = {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
  min?: string;
  max?: string;
  step?: string;
  optional?: boolean;
  searchable?: boolean;
};
export function EntityForm({
  fields,
  submitLabel = "Save",
  onSubmit,
  onCancel,
  footer,
  onValuesChange,
}: {
  fields: FormField[];
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
  onCancel?: () => void;
  footer?: string;
  onValuesChange?: (values: Record<string, string>) => void;
}) {
  const [error, setError] = useState<unknown>(null);
  const defaults: Record<string, string> = Object.fromEntries(
    fields.map((f) => [
      f.name,
      (f.options && !f.options.some((o) => o.value === (f.defaultValue ?? ""))
        ? f.options[0]?.value
        : f.defaultValue) ?? "",
    ]),
  );
  const form = useForm({
    defaultValues: defaults,
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        await onSubmit(value);
      } catch (e) {
        setError(e);
      }
    },
  });
  const renderField = (config: FormField) => (
    <form.Field
      key={config.name}
      name={config.name}
      validators={
        config.required
          ? {
              onChange: z.string().trim().min(1, `${config.label} is required`),
            }
          : undefined
      }
    >
      {(field) => {
        const id = `field-${config.name}`;
        const errors = field.state.meta.errors
          .map((e) => (typeof e === "string" ? e : e?.message))
          .filter(Boolean);
        const props = {
          id,
          name: config.name,
          value: field.state.value,
          onBlur: field.handleBlur,
          onChange: (
            e: React.ChangeEvent<
              HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
            >,
          ) => {
            field.handleChange(e.target.value);
            onValuesChange?.({
              ...form.state.values,
              [config.name]: e.target.value,
            });
          },
          "aria-invalid": errors.length > 0,
          "aria-describedby":
            config.hint || errors.length ? `${id}-hint` : undefined,
          required: config.required,
        };
        return (
          <div className="form-field">
            <label htmlFor={id}>
              {config.label}
              {config.required && <span aria-hidden="true"> *</span>}
            </label>
            {config.options && config.searchable ? (
              <SearchableSelect
                {...props}
                options={config.options}
                label={config.label}
              />
            ) : config.options ? (
              <Select {...props}>
                {config.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : config.type === "textarea" ? (
              <Textarea {...props} placeholder={config.placeholder} rows={3} />
            ) : (
              <Input
                {...props}
                type={config.type ?? "text"}
                placeholder={config.placeholder}
                min={config.min}
                max={config.max}
                step={config.step}
              />
            )}
            {(config.hint || errors.length > 0) && (
              <p
                id={`${id}-hint`}
                className={errors.length ? "field-error" : "field-hint"}
              >
                {errors.length ? errors.join(". ") : config.hint}
              </p>
            )}
          </div>
        );
      }}
    </form.Field>
  );
  return (
    <form
      className="entity-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {fields.filter((f) => !f.optional).map(renderField)}
      {fields.some((f) => f.optional) && (
        <details>
          <summary className="text-link">More details & options</summary>
          <div className="entity-form" style={{ marginTop: 12 }}>
            {fields.filter((f) => f.optional).map(renderField)}
          </div>
        </details>
      )}
      {error ? <ErrorState error={error} /> : null}
      {footer && <p className="field-hint">{footer}</p>}
      <div className="form-actions">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <form.Subscribe
          selector={(state) => [state.canSubmit, state.isSubmitting]}
        >
          {([canSubmit, submitting]) => (
            <Button type="submit" disabled={!canSubmit || submitting}>
              {submitting && <LoaderCircle size={16} className="spin" />}
              {submitting ? "Saving…" : submitLabel}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  );
}
