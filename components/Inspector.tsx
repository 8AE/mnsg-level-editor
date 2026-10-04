"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button, Column, Row, Text } from "@once-ui-system/core";
import type {
  ActorData,
  ActorOverride,
  ActorVisual,
  ProjectSceneEvent,
  EventOverride,
  Vec3,
} from "../shared/types";
import {
  checkedActorPosition,
  formatAddress,
  parseInteger,
  parseWords,
} from "./editorModel";

export function ValueField({
  label,
  value,
  disabled,
  commit,
  testId,
}: {
  label: string;
  value: string;
  disabled: boolean;
  commit(value: string): void;
  testId?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  const id = useId();
  const skipBlur = useRef(false);
  useEffect(() => {
    setDraft(value);
    setError("");
  }, [value]);
  const submit = () => {
    if (draft === value) return;
    try {
      commit(draft);
      setError("");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Invalid value.");
    }
  };
  return (
    <label className="value-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        data-testid={testId}
        value={draft}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (skipBlur.current) {
            skipBlur.current = false;
            return;
          }
          submit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            event.stopPropagation();
            skipBlur.current = true;
            setDraft(value);
            setError("");
            event.currentTarget.blur();
          }
        }}
      />
      {error && (
        <span id={`${id}-error`} className="field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

function VectorFields({
  label,
  value,
  disabled,
  commit,
}: {
  label: string;
  value: Vec3;
  disabled: boolean;
  commit(value: Vec3): void;
}) {
  return (
    <Column gap="8">
      <Text variant="label-default-s" onBackground="neutral-weak">
        {label}
      </Text>
      <div className="vector-fields">
        {(["x", "y", "z"] as const).map((axis) => (
          <ValueField
            key={axis}
            label={axis.toUpperCase()}
            value={String(value[axis])}
            disabled={disabled}
            commit={(draft) =>
              commit({ ...value, [axis]: parseInteger(draft, -32768, 32767) })
            }
          />
        ))}
      </div>
    </Column>
  );
}

interface Props {
  actor?: ActorData;
  event?: ProjectSceneEvent;
  visual?: ActorVisual;
  visualsPending: boolean;
  sample: boolean;
  busy: boolean;
  supportedActorIds: number[];
  modified: boolean;
  onActor(value: ActorOverride): void;
  onEvent(value: EventOverride): void;
  onReset(): void;
  onFrame(): void;
  onInspectActor(id: string): void;
}

export default function Inspector({
  actor,
  event,
  visual,
  visualsPending,
  sample,
  busy,
  supportedActorIds,
  modified,
  onActor,
  onEvent,
  onReset,
  onFrame,
  onInspectActor,
}: Props) {
  const entity = actor ?? event;
  if (!entity)
    return (
      <Column className="inspector-empty" gap="12" padding="24">
        <span className="empty-selection">⌖</span>
        <Text variant="body-strong-s">Select a record</Text>
        <Text variant="body-default-s" onBackground="neutral-weak">
          Choose an actor or event from the outliner, or click its model or
          marker in the viewport.
        </Text>
      </Column>
    );
  const disabled =
    sample || busy || !entity.editable || Boolean(event && !event.source);
  const positionDisabled =
    disabled || (actor?.sourceKind === "partition" && !actor.partition);
  return (
    <Column className="inspector-content" gap="24" padding="20">
      <Column gap="8">
        <Row horizontal="between" vertical="center">
          <Text variant="label-default-s" onBackground="brand-medium">
            {actor ? "ACTOR RECORD" : "EVENT RECORD"}
          </Text>
          {modified && (
            <span className="modified-dot" title="Modified in this project" />
          )}
        </Row>
        <Text variant="heading-strong-m">{entity.name}</Text>
        <Text variant="label-default-xs" onBackground="neutral-weak">
          Record {entity.index.toString().padStart(3, "0")} ·{" "}
          {actor ? formatAddress(actor.actorId) : event?.kind}
        </Text>
      </Column>
      {(sample || !entity.editable) && (
        <div className="inspector-notice">
          {sample
            ? "Procedural sample · read only"
            : event?.actorRef
              ? "This event is derived from an actor. Edit its source actor to update the placement and raw parameters."
              : "This record's edit schema is not verified. Inspection is available."}
        </div>
      )}
      {event?.actorRef && (
        <Button
          variant="secondary"
          size="s"
          disabled={busy}
          onClick={() => onInspectActor(event.actorRef!)}
        >
          Inspect source actor
        </Button>
      )}
      {entity.position && (
        <VectorFields
          label="POSITION · WORLD UNITS"
          value={entity.position}
          disabled={positionDisabled}
          commit={(value) =>
            actor
              ? onActor({ position: checkedActorPosition(actor, value) })
              : onEvent({ position: value })
          }
        />
      )}
      {actor?.sourceKind === "partition" && (
        <div className="inspector-notice">
          {actor.partition
            ? "Movement must stay within the original spawn-grid cell. Cross-cell relocation is not yet supported."
            : "Spatial partition relocation is not yet supported for this record."}
        </div>
      )}
      {actor && (
        <>
          <VectorFields
            label="ROTATION · RAW SIGNED VALUES"
            value={actor.rotation}
            disabled={disabled}
            commit={(rotation) => onActor({ rotation })}
          />
          <ValueField
            label="Room-supported actor type"
            value={formatAddress(actor.actorId)}
            disabled={disabled}
            commit={(value) => {
              const actorId = parseInteger(value, 0, 65535);
              if (!supportedActorIds.includes(actorId))
                throw new Error(
                  "Choose an actor type already present in this room. New types may require resources the room does not load.",
                );
              onActor({ actorId });
            }}
          />
          <ValueField
            label={`Parameters · ${actor.parameters.length} unsigned words`}
            value={actor.parameters.map(formatAddress).join(", ")}
            disabled={disabled}
            commit={(value) =>
              onActor({
                parameters: parseWords(value, actor.parameters.length),
              })
            }
          />
          <Text variant="body-default-xs" onBackground="neutral-weak">
            Advanced raw parameters have actor-specific meanings. Keep a saved
            copy before changing unknown values.
          </Text>
        </>
      )}
      {event && (
        <ValueField
          label={`Raw values · ${event.values.length} words`}
          value={event.values.map(formatAddress).join(", ")}
          disabled={disabled || !event.values.length}
          commit={(value) =>
            onEvent({ values: parseWords(value, event.values.length) })
          }
        />
      )}
      {entity.source && (
        <Column gap="12" className="source-block">
          <Text variant="label-default-s" onBackground="neutral-weak">
            SOURCE RECORD
          </Text>
          <Row horizontal="between" textVariant="label-default-xs">
            <span>ROM offset</span>
            <code>{sample ? "—" : formatAddress(entity.source.romOffset)}</code>
          </Row>
          {entity.source.segmentedAddress !== undefined && (
            <Row horizontal="between" textVariant="label-default-xs">
              <span>Segment address</span>
              <code>{formatAddress(entity.source.segmentedAddress)}</code>
            </Row>
          )}
          <Row horizontal="between" textVariant="label-default-xs">
            <span>Record bytes</span>
            <code>{entity.source.expectedHex.length / 2}</code>
          </Row>
        </Column>
      )}
      <Row gap="8">
        <Button
          variant="secondary"
          size="s"
          fillWidth
          disabled={!entity.position}
          onClick={onFrame}
        >
          Frame
        </Button>
        <Button
          variant="tertiary"
          size="s"
          fillWidth
          disabled={disabled || !modified}
          onClick={onReset}
        >
          Reset record
        </Button>
      </Row>
      {actor ? (
        <Column gap="8" data-testid="actor-visual-status">
          <Text variant="body-default-xs" onBackground="neutral-weak">
            {sample
              ? "Procedural placement marker · no game assets."
              : visualsPending
                ? "Refreshing native actor visuals. The previous preview is retained until decoding completes."
                : visual?.status === "supported"
                  ? `Native ROM model · ${visual.parts.some((part) => part.pose === "initial-frame") ? "initial animation pose" : "static pose"}. Placement fields edit the actor origin. Game behavior is not simulated.`
                  : visual?.status === "conditional"
                    ? `Conditional native model declaration · initial state. Runtime spawning and visibility are not simulated. ${visual.reason ?? ""}`
                    : visual?.status === "nonvisual"
                      ? `Nonvisual controller · shown as a hollow placement marker. ${visual.reason ?? ""}`
                      : visual?.status === "unsupported"
                        ? `${visual.parts.length ? "Partial native model preview with an amber origin marker" : "Model unavailable · amber placement marker"}. ${visual.reason ?? "This actor's native draw path is not yet supported."}`
                        : "Actor visuals have not been decoded. A placement marker is shown."}
          </Text>
          {visual?.warnings.map((warning, index) => (
            <Text
              key={index}
              variant="body-default-xs"
              onBackground="neutral-weak"
            >
              {warning}
            </Text>
          ))}
        </Column>
      ) : (
        <Text variant="body-default-xs" onBackground="neutral-weak">
          These values describe the source actor’s verified event fields. Event
          behavior is not simulated.
        </Text>
      )}
    </Column>
  );
}
