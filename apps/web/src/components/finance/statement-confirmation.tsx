"use client";
import type { FinanceImport } from "@heima/contracts";
import { useRef, useState } from "react";
import { RequestError, useCommand, useHeima } from "@/lib/client";
import { EntityForm, type FormField } from "../shared/form";
import { ErrorState } from "../shared/page";
import { Button } from "../ui/button";

type Intent = { path: string; body: Record<string, unknown> };
type PendingIntent = Intent & { values: Record<string, string> };

/** Page-owned volatile state survives the offline boundary, never navigation. */
export function useStatementConfirmation() {
  const command = useCommand();
  const intent = useRef<PendingIntent | null>(null);
  const locked = useRef(false);
  const [pending, setPending] = useState<PendingIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<unknown>(null);
  const [result, setResult] = useState<FinanceImport | null>(null);
  const outcome = useHeima<{ status: string; errorCode?: string }>(
    `/v1/commands/${pending?.body.commandId ?? ""}`,
    false,
  );
  async function send(selected?: Intent, values: Record<string, string> = {}) {
    if (locked.current) return;
    const retry = !selected;
    const current = selected
      ? {
          ...selected,
          body: { ...selected.body, commandId: crypto.randomUUID() },
          values,
        }
      : intent.current;
    if (!current) return;
    locked.current = true;
    setBusy(true);
    setRecoveryError(null);
    setResult(null);
    intent.current = current;
    setPending(current);
    let mutationStarted = false;
    try {
      if (retry) {
        const checked = await outcome.refetch();
        if (checked.error) throw checked.error;
        // Replaying this same identity returns the recorded result or resumes
        // incomplete delivery. A missing result never means nothing happened.
      }
      mutationStarted = true;
      const confirmed = (await command.execute(
        current.path,
        current.body,
      )) as FinanceImport;
      intent.current = null;
      setPending(null);
      setResult(confirmed);
      return confirmed;
    } catch (error) {
      if (
        mutationStarted &&
        error instanceof RequestError &&
        [400, 401, 403, 404, 409, 422].includes(error.status) &&
        error.code !== "REQUEST_FAILED"
      ) {
        // Only an explicit mutation rejection releases this intent. A failed
        // status lookup, rate limit, timeout or offline result proves nothing
        // about the earlier confirmation and must retain its identity.
        intent.current = null;
        setPending(null);
      }
      setRecoveryError(error);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return { pending, busy, recoveryError, result, send };
}

/** Keep one reviewed financial intent until its command outcome is known. */
export function StatementConfirmation({
  controller,
  fields,
  submitLabel,
  footer,
  request,
  onSuccess,
  onValuesChange,
  onCancel,
}: {
  controller: ReturnType<typeof useStatementConfirmation>;
  fields: FormField[];
  submitLabel: string;
  footer: string;
  request: (values: Record<string, string>) => Intent | null;
  onSuccess?: (result: FinanceImport) => void;
  onValuesChange?: (values: Record<string, string>) => void;
  onCancel?: () => void;
}) {
  const { pending, busy, recoveryError } = controller;
  async function submit(values?: Record<string, string>) {
    const selected = values ? request(values) : undefined;
    if (selected === null) return;
    const result = await controller.send(selected, values);
    if (result) onSuccess?.(result);
  }
  return (
    <>
      {pending && (
        <div className="notice import-recovery" role="status">
          <p>
            {busy
              ? "Checking the whole statement. Keep this review open…"
              : "Confirmation has not been verified yet. Your reviewed statement is kept. Retry checks its status and safely continues the same request."}
          </p>
          <Button type="button" disabled={busy} onClick={() => void submit()}>
            Retry confirmation
          </Button>
        </div>
      )}
      {recoveryError ? <ErrorState error={recoveryError} /> : null}
      <fieldset className="import-locked" disabled={pending !== null}>
        <EntityForm
          fields={fields.map((field) => ({
            ...field,
            defaultValue: pending?.values[field.name] ?? field.defaultValue,
          }))}
          submitLabel={submitLabel}
          footer={footer}
          onSubmit={submit}
          onValuesChange={onValuesChange}
          onCancel={onCancel}
        />
      </fieldset>
    </>
  );
}
