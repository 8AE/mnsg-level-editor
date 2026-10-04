"use client";
import { createElement, type ReactNode } from "react";
import { ThemeProvider } from "@once-ui-system/core";

/** Fixed local theme avoids an external font or stylesheet dependency. */
export function EditorTheme({ children }: { children: ReactNode }) {
  return createElement(ThemeProvider, { children, theme: "dark", neutral: "slate", brand: "cyan", accent: "blue", solid: "color", solidStyle: "flat", border: "conservative", surface: "filled", transition: "micro", persistence: "none" });
}
