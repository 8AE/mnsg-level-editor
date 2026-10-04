import { Column, Text } from "@once-ui-system/core";
import type { ActorVisual } from "../shared/types";

export interface PreviewInfo {
  visual?: ActorVisual;
  pending?: boolean;
  fallback?: string;
  messages?: string[];
}

export function previewMessages({
  visual,
  messages = [],
}: PreviewInfo): string[] {
  const seen = new Set<string>();
  return [visual?.reason ?? "", ...(visual?.warnings ?? []), ...messages]
    .flatMap((message) => message.split(/;\s*|\r?\n/))
    .map((message) => message.trim())
    .filter((message) => {
      const key = message.replace(/\s+/g, " ").replace(/[.;]+$/, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function PreviewStatus(info: PreviewInfo) {
  const { visual, pending, fallback = "Reading native preview" } = info;
  const status = pending
    ? "Refreshing native preview"
    : !visual
      ? fallback
      : visual.status === "supported"
        ? "Native initial pose"
        : visual.status === "conditional"
          ? "Conditional native model"
          : visual.status === "nonvisual"
            ? "Nonvisual controller"
            : visual.parts.length
              ? "Partial native model · unsupported behavior"
              : "Native model unavailable";
  const message = previewMessages(info)[0];
  const reason =
    message && message.length > 140
      ? `${message.slice(0, 137).trimEnd()}…`
      : message;
  return (
    <Column gap="4" data-testid="preview-status">
      <Text variant="label-default-s">{status}</Text>
      {reason && (
        <Text
          className="preview-reason"
          variant="body-default-xs"
          onBackground="neutral-weak"
        >
          {reason}
        </Text>
      )}
    </Column>
  );
}

export function PreviewDetails(info: PreviewInfo) {
  const messages = previewMessages(info);
  if (!messages.length) return null;
  return (
    <details className="preview-details" data-testid="preview-details">
      <summary>
        Preview details · {messages.length}{" "}
        {messages.length === 1 ? "note" : "notes"}
      </summary>
      <ul>
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </details>
  );
}
