"use client";
import { RotateCcw, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import "./swipe-actions.css";

/** Persistent, reachable feedback; the caller owns the acknowledged Undo record. */
export function ActionNotice({
  message,
  undoLabel = "Undo",
  onUndo,
  onDismiss,
  secondary,
  busy = false,
}: {
  message: string;
  undoLabel?: string;
  onUndo?: () => Promise<unknown>;
  onDismiss: () => void;
  secondary?: { label: string; onClick: () => void };
  busy?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const locked = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useLayoutEffect(() => {
    if (!message) return;
    const html = document.documentElement;
    html.dataset.actionNotice = "true";
    const measure = () =>
      html.style.setProperty(
        "--action-notice-height",
        `${root.current?.getBoundingClientRect().height ?? 0}px`,
      );
    const observer = new ResizeObserver(measure);
    if (root.current) observer.observe(root.current);
    measure();
    return () => {
      observer.disconnect();
      delete html.dataset.actionNotice;
      html.style.removeProperty("--action-notice-height");
    };
  }, [message]);
  if (!message) return null;
  async function undo() {
    if (locked.current || busy || !onUndo) return;
    locked.current = true;
    setSaving(true);
    setError("");
    try {
      await onUndo();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not undo. Try again.",
      );
    } finally {
      locked.current = false;
      setSaving(false);
    }
  }
  return (
    <section
      ref={root}
      className="notice action-notice"
      aria-label="Recent action"
    >
      <p role="status">{message}</p>
      <div className="action-notice-buttons">
        {onUndo && (
          <Button
            variant="secondary"
            disabled={busy || saving}
            aria-label={undoLabel}
            onClick={() => void undo()}
          >
            <RotateCcw size={17} />
            {saving ? "Undoing…" : "Undo"}
          </Button>
        )}
        {secondary && (
          <Button
            variant="ghost"
            disabled={busy || saving}
            onClick={secondary.onClick}
          >
            {secondary.label}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Dismiss recent action"
          disabled={busy || saving}
          onClick={onDismiss}
        >
          <X size={18} />
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
