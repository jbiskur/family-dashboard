"use client";
import { type RefObject, useLayoutEffect } from "react";

/** Reserve the real dock height; move it with the visual viewport on iOS. */
export function useCaptureLayout(dock: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const nav = document.querySelector(".mobile-nav");
    const viewport = window.visualViewport;
    root.dataset.capture = "true";
    const measure = () => {
      const height = dock.current?.getBoundingClientRect().height ?? 0;
      root.style.setProperty("--capture-height", `${height}px`);
      root.style.setProperty(
        "--mobile-nav-height",
        `${nav?.getBoundingClientRect().height ?? 63}px`,
      );
      const keyboard =
        viewport &&
        viewport.scale === 1 &&
        window.innerHeight - viewport.height > 120;
      root.dataset.captureKeyboard = keyboard ? "true" : "false";
      root.style.setProperty(
        "--capture-keyboard-offset",
        `${keyboard ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0}px`,
      );
      root.style.setProperty(
        "--capture-viewport-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
      root.style.setProperty(
        "--capture-viewport-top",
        `${viewport?.offsetTop ?? 0}px`,
      );
    };
    const observer = new ResizeObserver(measure);
    if (dock.current) observer.observe(dock.current);
    if (nav) observer.observe(nav);
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      delete root.dataset.capture;
      delete root.dataset.captureKeyboard;
      for (const property of [
        "--capture-height",
        "--mobile-nav-height",
        "--capture-keyboard-offset",
        "--capture-viewport-height",
        "--capture-viewport-top",
      ])
        root.style.removeProperty(property);
    };
  }, [dock]);
}
