"use client";
import { useState } from "react";
import { Button, Column, Row, Text } from "@once-ui-system/core";
import type { Vec3 } from "../shared/types";

export default function SelectionInspector({
  count,
  movable,
  disabled,
  onTranslate,
  onFrame,
  translating,
  onToggleMove,
  rotatable,
  rotating,
  onToggleRotate,
}: {
  count: number;
  movable: boolean;
  disabled: boolean;
  translating: boolean;
  onTranslate(delta: Vec3): void;
  onFrame(): void;
  onToggleMove(): void;
  rotatable: boolean;
  rotating: boolean;
  onToggleRotate(): void;
}) {
  const [offset, setOffset] = useState({ x: "0", y: "0", z: "0" });
  const delta = {
    x: Number(offset.x),
    y: Number(offset.y),
    z: Number(offset.z),
  };
  const valid = Object.values(offset).every(
    (value) => value.trim() !== "" && Number.isSafeInteger(Number(value)),
  );
  return (
    <Column padding="20" gap="16" data-testid="selection-inspector">
      <Row horizontal="between">
        <Text variant="body-strong-s">{count} items selected</Text>
        <Button size="s" variant="tertiary" onClick={onFrame}>
          Frame selection
        </Button>
      </Row>
      <Text variant="body-default-s">
        Cmd/Ctrl-click adds or removes an item. Drag the move tool to translate
        the whole selection, use Rotate to turn it around its shared center, or enter an offset below.
      </Text>
      <Button
        size="s"
        disabled={disabled || !movable}
        variant={translating ? "primary" : "secondary"}
        aria-pressed={translating}
        onClick={onToggleMove}
      >
        Move selected items
      </Button>
      <Button size="s" disabled={disabled || !rotatable} variant={rotating ? "primary" : "secondary"} aria-pressed={rotating} onClick={onToggleRotate}>Rotate selected items</Button>
      {(["x", "y", "z"] as const).map((axis) => (
        <label className="value-field" key={axis}>
          Move selection {axis.toUpperCase()}
          <input
            type="number"
            step="1"
            aria-label={`Move selection ${axis.toUpperCase()}`}
            disabled={disabled || !movable}
            value={offset[axis]}
            onChange={(event) =>
              setOffset((value) => ({ ...value, [axis]: event.target.value }))
            }
          />
        </label>
      ))}
      <Button
        disabled={
          disabled || !movable || !valid || (!delta.x && !delta.y && !delta.z)
        }
        onClick={() => onTranslate(delta)}
      >
        Apply selection offset
      </Button>
      {!movable && (
        <Text variant="body-default-s">
          The selection includes records without an editable position. Deselect those records to transform the group.
        </Text>
      )}
      <Text variant="body-default-xs" onBackground="neutral-weak">
        Shared vertices move once. One Undo restores the entire group move.
      </Text>
    </Column>
  );
}
