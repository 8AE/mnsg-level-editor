"use client";
import { createElement, type ReactNode } from "react";
import { LayoutProvider, ThemeProvider } from "@once-ui-system/core";

/** Local DOM adapters support static Electron pages and ROM thumbnail data URLs. */
export function EditorTheme({ children }: { children: ReactNode }) {
  return createElement(ThemeProvider, {
    children: createElement(LayoutProvider, { children }),
    theme: "dark",
    neutral: "slate",
    brand: "cyan",
    accent: "blue",
    solid: "color",
    solidStyle: "flat",
    border: "conservative",
    surface: "filled",
    transition: "micro",
    persistence: "none",
  });
}
