"use client";
import { Check, LoaderCircle, Pencil, RotateCcw } from "lucide-react";
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import {
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "../ui/button";
import "./swipe-actions.css";

type Gesture = {
  id: number;
  x: number;
  y: number;
  offset: number;
  direction: "waiting" | "horizontal" | "vertical";
};
const reveal = 96;
const openEvent = "heima:swipe-open";
const controls =
  "button,a,input,select,textarea,[role=button],[contenteditable=true]";

/** A gesture composition. Callers retain all item state and command semantics. */
export function SwipeRow({
  itemName,
  actionLabel,
  onAction,
  onEdit,
  disabled = false,
  allowFullSwipe = true,
  children,
}: {
  itemName: string;
  actionLabel: "Complete" | "Reopen";
  onAction: () => Promise<unknown>;
  onEdit: () => void;
  disabled?: boolean;
  allowFullSwipe?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const locked = useRef(false);
  const suppressClick = useRef(false);
  const x = useMotionValue(0);
  const reducedMotion = useReducedMotion();
  const animation = useRef<ReturnType<typeof animate> | null>(null);
  const [side, setSide] = useState<"leading" | "trailing" | null>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const settle = useCallback(
    (value: number) => {
      animation.current?.stop();
      if (reducedMotion) x.set(value);
      else
        animation.current = animate(x, value, {
          duration: 0.18,
          ease: "easeOut",
        });
    },
    [reducedMotion, x],
  );
  const close = useCallback(() => {
    gesture.current = null;
    setSide(null);
    setArmed(false);
    settle(0);
  }, [settle]);

  useEffect(() => {
    function otherRow(event: Event) {
      if ((event as CustomEvent<string>).detail !== id) close();
    }
    function pointerDown(event: globalThis.PointerEvent) {
      if (gesture.current && gesture.current.id !== event.pointerId) close();
      if (!root.current?.contains(event.target as Node)) close();
    }
    function keyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    function scroll(event: Event) {
      // Blurring a horizontally scrolled search input emits its own scroll.
      // Only viewport/ancestor scrolling moves this row and cancels its gesture.
      const target = event.target;
      if (
        target === document ||
        target === window ||
        (target instanceof Element &&
          root.current &&
          target.contains(root.current))
      )
        close();
    }
    window.addEventListener(openEvent, otherRow);
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("keydown", keyDown);
    return () => {
      animation.current?.stop();
      window.removeEventListener(openEvent, otherRow);
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("keydown", keyDown);
    };
  }, [close, id]);

  async function act() {
    if (locked.current || disabled) return;
    locked.current = true;
    setBusy(true);
    setError("");
    close();
    try {
      await onAction();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The item could not be updated. Try again.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function start(event: PointerEvent<HTMLDivElement>) {
    suppressClick.current = false;
    if (
      disabled ||
      locked.current ||
      !event.isPrimary ||
      event.button !== 0 ||
      event.clientX < 24 ||
      event.clientX > window.innerWidth - 24 ||
      (event.target as Element).closest(controls)
    )
      return;
    animation.current?.stop();
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offset: x.get(),
      direction: "waiting",
    };
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (
      !current ||
      current.id !== event.pointerId ||
      current.direction === "vertical"
    )
      return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.direction === "waiting") {
      if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx) / 1.5) {
        current.direction = "vertical";
        setSide(null);
        settle(0);
        return;
      }
      if (Math.abs(dx) <= 12 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
      current.direction = "horizontal";
      suppressClick.current = true;
      window.dispatchEvent(new CustomEvent(openEvent, { detail: id }));
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    const width = root.current?.getBoundingClientRect().width ?? 320;
    const offset = Math.max(-reveal, Math.min(width - 16, current.offset + dx));
    x.set(offset);
    setSide(offset > 0 ? "leading" : offset < 0 ? "trailing" : null);
    setArmed(allowFullSwipe && offset >= Math.max(160, width * 0.6));
  }
  function end(event: PointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    gesture.current = null;
    if (current.direction !== "horizontal") return;
    const width = root.current?.getBoundingClientRect().width ?? 320;
    if (allowFullSwipe && x.get() >= Math.max(160, width * 0.6)) {
      void act();
      return;
    }
    setArmed(false);
    const destination =
      Math.abs(x.get()) >= 48 ? Math.sign(x.get()) * reveal : 0;
    setSide(destination > 0 ? "leading" : destination < 0 ? "trailing" : null);
    settle(destination);
  }
  const StatusIcon = actionLabel === "Reopen" ? RotateCcw : Check;
  return (
    <div
      ref={root}
      className="swipe-row"
      data-swipe-row={itemName}
      data-swipe-side={side ?? "closed"}
      aria-busy={busy || disabled}
    >
      <div
        className={`swipe-action swipe-leading ${armed ? "swipe-armed" : ""}`}
        aria-hidden={side !== "leading"}
        inert={side !== "leading"}
      >
        <Button
          disabled={busy || disabled}
          onClick={() => void act()}
          aria-label={`Swipe ${actionLabel.toLowerCase()} ${itemName}`}
        >
          <StatusIcon size={21} />
          <span>
            {armed ? `Release to ${actionLabel.toLowerCase()}` : actionLabel}
          </span>
        </Button>
      </div>
      <div
        className="swipe-action swipe-trailing"
        aria-hidden={side !== "trailing"}
        inert={side !== "trailing"}
      >
        <Button
          variant="secondary"
          disabled={busy || disabled}
          aria-label={`Swipe edit ${itemName}`}
          onClick={() => {
            close();
            onEdit();
          }}
        >
          <Pencil size={19} />
          Edit
        </Button>
      </div>
      <motion.div
        className="swipe-foreground"
        style={{ x }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={close}
        onLostPointerCapture={() => {
          if (gesture.current) close();
        }}
        onClickCapture={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick.current = false;
          }
        }}
      >
        <div className="swipe-content">{children}</div>
        <Button
          className="swipe-visible-edit"
          variant="ghost"
          size="icon"
          disabled={busy || disabled}
          aria-label={`Edit ${itemName}`}
          onClick={() => {
            close();
            onEdit();
          }}
        >
          {busy ? (
            <LoaderCircle className="swipe-saving" size={18} />
          ) : (
            <Pencil size={17} />
          )}
        </Button>
      </motion.div>
      {error && (
        <div className="swipe-error" role="alert">
          <p>{error}</p>
          <Button
            variant="ghost"
            disabled={busy || disabled}
            onClick={() => void act()}
          >
            Retry {actionLabel.toLowerCase()}
          </Button>
        </div>
      )}
    </div>
  );
}
