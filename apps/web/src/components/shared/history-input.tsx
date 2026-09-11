"use client";
import { History } from "lucide-react";
import { type ComponentPropsWithRef, useEffect, useRef, useState } from "react";
import { Autocomplete } from "../ui/autocomplete";
import { Input } from "../ui/input";

export type EntryHistory = {
  names: string[];
  loading?: boolean;
  unavailable?: boolean;
};

export function HistoryInput({
  value,
  onValueChange,
  history,
  suggestionsEnabled = true,
  ref,
  ...props
}: Omit<ComponentPropsWithRef<"input">, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
  history: EntryHistory;
  suggestionsEnabled?: boolean;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!suggestionsEnabled) setOpen(false);
  }, [suggestionsEnabled]);
  const normalize = (name: string) =>
    name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const query = normalize(value);
  const seen = new Set<string>();
  const matches = history.names
    .filter((name) => {
      const key = normalize(name);
      if (!query || !key.includes(query) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        Number(normalize(b).startsWith(query)) -
        Number(normalize(a).startsWith(query)),
    )
    .slice(0, 5);
  const visible = suggestionsEnabled && open && matches.length > 0;
  return (
    <Autocomplete.Root<string>
      items={matches}
      filter={null}
      value={value}
      onValueChange={(next, details) => {
        if (details.reason === "escape-key") {
          details.cancel();
          details.allowPropagation();
          return;
        }
        onValueChange(next);
      }}
      submitOnItemClick={false}
      open={visible}
      onOpenChange={(next) => {
        setContainer(
          input.current?.closest<HTMLElement>('[role="dialog"]') ?? null,
        );
        setOpen(suggestionsEnabled && next);
      }}
      openOnInputClick
    >
      <Autocomplete.Input
        {...props}
        render={<Input />}
        ref={(element) => {
          input.current = element;
          if (typeof ref === "function") ref(element);
          else if (ref) ref.current = element;
        }}
        aria-busy={history.loading || undefined}
        onFocus={(event) => {
          setContainer(
            input.current?.closest<HTMLElement>('[role="dialog"]') ?? null,
          );
          setOpen(suggestionsEnabled);
          props.onFocus?.(event);
        }}
      />
      <Autocomplete.Portal container={container ?? undefined}>
        <Autocomplete.Positioner
          side="top"
          align="start"
          sideOffset={8}
          className="history-positioner"
        >
          <Autocomplete.Popup className="history-popup">
            <p className="history-heading">
              <History size={14} />
              Previously added
            </p>
            <Autocomplete.List
              className="history-options"
              aria-label="Previous entries"
            >
              {(name: string) => (
                <Autocomplete.Item
                  key={name}
                  value={name}
                  className="history-option"
                >
                  {name}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
      <Autocomplete.Status className="sr-only">
        {suggestionsEnabled && query
          ? history.loading
            ? "Loading previous entries."
            : history.unavailable
              ? "Previous entries are unavailable. You can add a new entry."
              : `${matches.length} previous ${matches.length === 1 ? "entry" : "entries"} found. ${matches.length ? "Use arrow keys to choose." : "Keep typing to add something new."}`
          : ""}
      </Autocomplete.Status>
    </Autocomplete.Root>
  );
}
