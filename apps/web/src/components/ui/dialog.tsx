"use client";
import * as Primitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from "react";
import { Button } from "./button";

let observers = 0;
let clickedTrigger: HTMLElement | null = null;
let clickedAt = 0;
function rememberTrigger(event: MouseEvent) {
  const target =
    event.target instanceof Element
      ? event.target.closest('button, [role="button"], a[href]')
      : null;
  clickedTrigger = target instanceof HTMLElement ? target : null;
  clickedAt = performance.now();
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  className = "",
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  onCloseAutoFocus?: ComponentProps<
    typeof Primitive.Content
  >["onCloseAutoFocus"];
}) {
  const opener = useRef<HTMLElement | null>(null);
  const focusFallback = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (observers++ === 0)
      document.addEventListener("click", rememberTrigger, true);
    return () => {
      if (--observers === 0) {
        document.removeEventListener("click", rememberTrigger, true);
        clickedTrigger = null;
      }
    };
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    // Safari does not focus clicked buttons. Capture the actual trigger before
    // React opens the dialog; keyboard openings retain their active element.
    const active = document.activeElement;
    focusFallback.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    opener.current =
      clickedTrigger?.isConnected && performance.now() - clickedAt < 1000
        ? clickedTrigger
        : active instanceof HTMLElement && active !== document.body
          ? active
          : null;
  }, [open]);
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="dialog-overlay" />
        <Primitive.Content
          className={`dialog-content ${wide ? "dialog-wide" : ""} ${className}`}
          onEscapeKeyDown={(event) => {
            const focused = document.activeElement;
            if (
              focused?.getAttribute("role") === "combobox" &&
              focused.getAttribute("aria-expanded") === "true"
            )
              event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            if (event.defaultPrevented) return;
            const target = opener.current?.isConnected
              ? opener.current
              : focusFallback.current;
            if (target?.isConnected) {
              event.preventDefault();
              setTimeout(() => {
                if (target.isConnected) target.focus({ preventScroll: true });
              }, 0);
            }
          }}
        >
          <div className="dialog-heading">
            <div>
              <Primitive.Title className="dialog-title">
                {title}
              </Primitive.Title>
              <Primitive.Description
                className={description ? "muted" : "sr-only"}
              >
                {description ?? title}
              </Primitive.Description>
            </div>
            <Primitive.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close dialog">
                <X size={20} />
              </Button>
            </Primitive.Close>
          </div>
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
