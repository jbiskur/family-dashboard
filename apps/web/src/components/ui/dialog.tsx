"use client";
import * as Primitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Button } from "./button";
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement)
      opener.current = document.activeElement;
  }, [open]);
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="dialog-overlay" />
        <Primitive.Content
          className={`dialog-content ${wide ? "dialog-wide" : ""}`}
          onCloseAutoFocus={(event) => {
            if (opener.current?.isConnected) {
              event.preventDefault();
              const target = opener.current;
              setTimeout(() => target.focus(), 0);
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
