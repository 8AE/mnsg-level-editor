import type { Metadata } from "next";
import "@once-ui-system/core/css/styles.css";
import "@once-ui-system/core/css/tokens.css";
import "./globals.scss";
import { EditorTheme } from "./once-config";

export const metadata: Metadata = { title: "MNSG Level Editor", description: "A local room and actor editor for Mystical Ninja Starring Goemon." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-theme="dark" data-neutral="slate" data-brand="cyan" data-accent="blue" data-solid="color" data-solid-style="flat" data-border="conservative" data-surface="filled" data-transition="micro" data-scaling="100" suppressHydrationWarning>
    <body><EditorTheme>{children}</EditorTheme></body>
  </html>;
}
