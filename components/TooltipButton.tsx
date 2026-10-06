"use client";
import { useEffect, useId, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import { Button } from "@once-ui-system/core";

/** Portal into the control's own window so dock/popout overflow cannot clip help. */
export default function TooltipButton({ title, ...props }: ComponentProps<typeof Button>) {
  const anchor = useRef<HTMLSpanElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const [location, setLocation] = useState<{ document: Document; left: number; top: number; above: boolean } | null>(null);
  const text = title ?? props["aria-label"];
  const hide = () => { clearTimeout(timer.current);setLocation(null); };
  const show = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const node = anchor.current, document = node?.ownerDocument, window = document?.defaultView;
      if (!node || !document || !window || !text) return;
      const rect = node.getBoundingClientRect(), above = rect.bottom + 48 > window.innerHeight;
      setLocation({ document, left: Math.max(130, Math.min(window.innerWidth - 130, rect.left + rect.width / 2)), top: above ? rect.top - 6 : rect.bottom + 6, above });
    }, delay);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!location) return;
    const window = location.document.defaultView!;
    const dismiss = (event: Event) => { if (event.type !== "keydown" || (event as KeyboardEvent).key === "Escape") hide(); };
    window.addEventListener("keydown", dismiss);window.addEventListener("blur", dismiss);window.addEventListener("resize", dismiss);window.addEventListener("scroll", dismiss, true);
    return () => { window.removeEventListener("keydown", dismiss);window.removeEventListener("blur", dismiss);window.removeEventListener("resize", dismiss);window.removeEventListener("scroll", dismiss, true); };
  }, [location]);
  return <span className="tooltip-button" ref={anchor} onPointerEnter={() => show(300)} onPointerLeave={hide} onFocusCapture={() => show(0)} onBlurCapture={hide} onPointerDown={hide}>
    <Button {...props} title={text} aria-describedby={location ? id : props["aria-describedby"]} />
    {location && createPortal(<span id={id} role="tooltip" className="editor-tooltip" style={{ left: location.left, top: location.top, transform: `translate(-50%,${location.above ? "-100%" : "0"})` }}>{text}</span>, location.document.body)}
  </span>;
}
