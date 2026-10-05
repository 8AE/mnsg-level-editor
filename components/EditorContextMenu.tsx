"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
export interface ContextMenuLocation {
  document: Document;
  x: number;
  y: number;
  id: string | null;
  kind?: "room";
  asset?: import("./AssetLibrary").LibraryDrop;
}
export default function EditorContextMenu({
  location,
  canCopy,
  canPaste,
  onCopy,
  onPaste,
  onClose,
}: {
  location: ContextMenuLocation;
  canCopy: boolean;
  canPaste: boolean;
  onCopy(): void;
  onPaste(): void;
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = menu.current,
      view = location.document.defaultView;
    if (!node || !view) return;
    const before = location.document.activeElement as HTMLElement | null;
    const box = node.getBoundingClientRect();
    node.style.left = `${Math.max(4, Math.min(location.x, view.innerWidth - box.width - 4))}px`;
    node.style.top = `${Math.max(4, Math.min(location.y, view.innerHeight - box.height - 4))}px`;
    node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dismiss = (e: Event) => {
      if (!node.contains(e.target as Node)) onClose();
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const items = [
          ...node.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
        ];
        const index = items.indexOf(
          location.document.activeElement as HTMLButtonElement,
        );
        const next =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? items.length - 1
              : (index + (e.key === "ArrowUp" ? -1 : 1) + items.length) %
                items.length;
        items[next]?.focus();
      }
    };
    location.document.addEventListener("pointerdown", dismiss);
    node.addEventListener("keydown", keys);
    view.addEventListener("blur", onClose);
    return () => {
      location.document.removeEventListener("pointerdown", dismiss);
      node.removeEventListener("keydown", keys);
      view.removeEventListener("blur", onClose);
      if (before?.isConnected && !before.ownerDocument.defaultView?.closed)
        before.focus();
    };
  }, [location, onClose]);
  return createPortal(
    <div className="mnsg-editor editor-context-host">
      <div
        ref={menu}
        role="menu"
        aria-label="Edit selection"
        className="editor-context-menu"
        style={{ left: location.x, top: location.y }}
      >
        <button
          role="menuitem"
          disabled={!canCopy}
          onClick={() => {
            onCopy();
            onClose();
          }}
        >
          Copy <kbd>⌘/Ctrl+C</kbd>
        </button>
        <button
          role="menuitem"
          disabled={!canPaste}
          onClick={() => {
            onPaste();
            onClose();
          }}
        >
          Paste <kbd>⌘/Ctrl+V</kbd>
        </button>
      </div>
    </div>,
    location.document.body,
  );
}
