"use client";
import { useForm } from "@tanstack/react-form";
import {
  Check,
  LoaderCircle,
  type LucideIcon,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Select } from "../ui/input";
import { useCaptureLayout } from "./capture-layout";
import { EntityForm, type FormField } from "./form";
import { HistoryInput } from "./history-input";

export type CaptureChoice = {
  id: string;
  label: string;
  icon: LucideIcon;
  title: FormField;
  context?: FormField[];
  details: FormField[];
  destination?: ReactNode;
  unavailable?: ReactNode;
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
};

export function CaptureComposer({ choices }: { choices: CaptureChoice[] }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [active, setActive] = useState(choices[0]?.id);
  const [busy, setBusy] = useState(false);
  const drafts = useRef<Record<string, Record<string, string>>>({});
  const dock = useRef<HTMLDivElement>(null);
  useCaptureLayout(dock);
  const choice = choices.find((c) => c.id === active) ?? choices[0];
  if (!choice) return null;
  return (
    <section
      ref={dock}
      className="capture-dock"
      aria-label="Quick add"
      aria-busy={!ready}
    >
      {choices.length > 1 && (
        <fieldset className="capture-kinds" aria-label="Add to">
          {choices.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              variant="ghost"
              aria-pressed={choice.id === id}
              disabled={!ready || busy}
              onClick={() => setActive(id)}
            >
              <Icon size={17} />
              {label}
            </Button>
          ))}
        </fieldset>
      )}
      {choice.unavailable ?? (
        <CaptureForm
          key={choice.id}
          choice={choice}
          ready={ready}
          draft={drafts.current[choice.id]}
          onDraft={(draft) => {
            drafts.current[choice.id] = draft;
          }}
          onBusy={setBusy}
        />
      )}
    </section>
  );
}

function CaptureForm({
  choice,
  ready,
  draft,
  onDraft,
  onBusy,
}: {
  choice: CaptureChoice;
  ready: boolean;
  draft?: Record<string, string>;
  onDraft: (draft: Record<string, string>) => void;
  onBusy: (busy: boolean) => void;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const closeFocusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  const detailsOpen = useRef(false);
  const focusInputOnClose = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(
    () => () => {
      if (closeFocusTimer.current !== null)
        clearTimeout(closeFocusTimer.current);
    },
    [],
  );
  function changeExpanded(open: boolean) {
    detailsOpen.current = open;
    if (open) {
      focusInputOnClose.current = false;
      if (closeFocusTimer.current !== null)
        clearTimeout(closeFocusTimer.current);
    }
    setExpanded(open);
  }
  const fields = [choice.title, ...(choice.context ?? []), ...choice.details];
  const [defaults] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.name,
        draft?.[f.name] ?? f.defaultValue ?? f.options?.[0]?.value ?? "",
      ]),
    ),
  );
  const form = useForm({
    defaultValues: defaults,
    onSubmit: async ({ value }) => {
      await save(value);
    },
  });
  function change(name: string, value: string) {
    form.setFieldValue(name, value);
    onDraft({ ...form.state.values, [name]: value });
  }
  async function save(values: Record<string, string>) {
    if (saving.current) return;
    setError("");
    setNotice("");
    for (const field of fields) {
      if (
        field.required &&
        !z.string().trim().min(1).safeParse(values[field.name]).success
      ) {
        setError(`${field.label} is required.`);
        throw new Error(`${field.label} is required.`);
      }
      if (
        field.options &&
        !field.options.some((option) => option.value === values[field.name])
      ) {
        setError(`Choose an available ${field.label.toLowerCase()}.`);
        throw new Error(`Choose an available ${field.label.toLowerCase()}.`);
      }
    }
    saving.current = true;
    onBusy(true);
    try {
      const result = await choice.onSubmit({
        ...values,
        [choice.title.name]: (values[choice.title.name] ?? "").trim(),
      });
      const queued =
        !!result &&
        typeof result === "object" &&
        "pending" in result &&
        result.pending === true;
      const next = Object.fromEntries(
        fields.map((field) => [
          field.name,
          field.defaultValue ?? field.options?.[0]?.value ?? "",
        ]),
      );
      for (const field of choice.context ?? [])
        next[field.name] = values[field.name] ?? "";
      next[choice.title.name] = "";
      // A person can start the next entry while this command is in flight.
      // Keep edits made after the submitted snapshot instead of erasing them.
      for (const [name, value] of Object.entries(form.state.values))
        if (value !== values[name]) next[name] = value;
      form.reset(next, { keepDefaultValues: true });
      onDraft(next);
      setNotice(
        queued
          ? "Added to this device’s sync queue."
          : `${values[choice.title.name]} added.`,
      );
      focusInputOnClose.current = true;
      if (detailsOpen.current) {
        // Restore focus when the dialog finishes closing, after its focus trap.
        changeExpanded(false);
      } else input.current?.focus({ preventScroll: true });
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Couldn’t add this. Try again.";
      setError(message);
      throw cause;
    } finally {
      saving.current = false;
      onBusy(false);
    }
  }
  return (
    <>
      <form
        className="capture-form"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit().catch(() => {});
        }}
      >
        <div className="capture-context">
          {choice.destination}
          {(choice.context ?? []).map((config) => (
            <form.Field key={config.name} name={config.name}>
              {(field) => (
                <label htmlFor={`${id}-${config.name}`}>
                  <span>{config.label}</span>
                  <Select
                    id={`${id}-${config.name}`}
                    aria-label={config.label}
                    value={field.state.value}
                    onChange={(event) =>
                      change(config.name, event.target.value)
                    }
                    disabled={!ready || saving.current}
                  >
                    {config.options?.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
            </form.Field>
          ))}
        </div>
        <label className="capture-label" htmlFor={`${id}-name`}>
          {choice.title.label}
        </label>
        <div className="capture-entry">
          <form.Field
            name={choice.title.name}
            validators={{
              onChange: z
                .string()
                .trim()
                .min(1, `${choice.title.label} is required`),
            }}
          >
            {(field) => {
              const validation = field.state.meta.errors
                .map((issue) =>
                  typeof issue === "string" ? issue : issue?.message,
                )
                .filter(Boolean)
                .join(". ");
              return (
                <div className="capture-name">
                  <form.Subscribe selector={(state) => state.values}>
                    {(values) => (
                      <HistoryInput
                        ref={input}
                        suggestionsEnabled={!expanded}
                        disabled={!ready}
                        id={`${id}-name`}
                        name={choice.title.name}
                        value={field.state.value}
                        history={
                          choice.title.history?.(values) ?? { names: [] }
                        }
                        onValueChange={(value) =>
                          change(choice.title.name, value)
                        }
                        onBlur={field.handleBlur}
                        placeholder={choice.title.placeholder}
                        required
                        autoComplete="off"
                        enterKeyHint="done"
                        aria-describedby={
                          [
                            error ? `${id}-error` : "",
                            validation ? `${id}-validation` : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined
                        }
                        aria-invalid={!!error || !!validation}
                      />
                    )}
                  </form.Subscribe>
                  {validation && (
                    <p
                      id={`${id}-validation`}
                      className="field-error"
                      role="alert"
                    >
                      {validation}
                    </p>
                  )}
                </div>
              );
            }}
          </form.Field>
          <form.Subscribe
            selector={(state) => [state.canSubmit, state.isSubmitting]}
          >
            {([canSubmit, submitting]) => (
              <Button
                type="submit"
                disabled={!ready || !canSubmit || submitting || saving.current}
                aria-label={`Add ${choice.label.toLowerCase()}`}
              >
                {submitting ? (
                  <LoaderCircle size={18} className="spin" />
                ) : (
                  <Plus size={18} />
                )}
                <span>Add</span>
              </Button>
            )}
          </form.Subscribe>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Details"
            disabled={!ready || saving.current}
            onClick={(event) => {
              detailsTrigger.current = event.currentTarget;
              changeExpanded(true);
            }}
          >
            <SlidersHorizontal size={20} />
          </Button>
        </div>
      </form>
      {error && (
        <p
          id={`${id}-error`}
          className="field-error capture-feedback"
          role="alert"
        >
          {error}
        </p>
      )}
      {notice && (
        <p className="capture-feedback" role="status">
          <Check size={15} />
          {notice}
          <Button variant="ghost" size="compact" onClick={() => setNotice("")}>
            Dismiss
          </Button>
        </p>
      )}
      <Dialog
        open={expanded}
        onOpenChange={changeExpanded}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // A save can finish after dismissal queues its focus restoration.
          // Choose the target when that work runs, using the latest outcome.
          closeFocusTimer.current = setTimeout(() => {
            closeFocusTimer.current = null;
            if (detailsOpen.current) return;
            const target = focusInputOnClose.current
              ? input.current
              : detailsTrigger.current;
            focusInputOnClose.current = false;
            if (target?.isConnected) target.focus({ preventScroll: true });
          }, 0);
        }}
        title={`${choice.label} details`}
        description="Keep it simple, or add a little more."
        className="capture-details"
      >
        <EntityForm
          scrollBody
          fields={fields.map((field) => ({
            ...field,
            defaultValue: form.state.values[field.name],
          }))}
          onValuesChange={(values) => {
            for (const [name, value] of Object.entries(values))
              form.setFieldValue(name, value);
            onDraft(values);
          }}
          onSubmit={save}
          submitLabel={`Add ${choice.label.toLowerCase()}`}
          onCancel={() => changeExpanded(false)}
        />
      </Dialog>
    </>
  );
}
