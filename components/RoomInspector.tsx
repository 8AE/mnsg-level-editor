"use client";

import { Button, Column, Row, Text } from "@once-ui-system/core";
import { useState } from "react";
import RoomInitializationDetails from "./RoomInitializationDetails";
import type { RoomData, Vec3 } from "../shared/types";
import { ValueField } from "./Inspector";
import { checkedGeometryTranslation, formatAddress, parseInteger } from "./editorModel";

interface Props {
  room: RoomData;
  translation: Vec3;
  modified: boolean;
  busy: boolean;
  sample: boolean;
  sharedImpacts: number[];
  onChange(translation: Vec3): void;
  onReset(): void;
  onFrame(): void;
}

export default function RoomInspector({ room, translation, modified, busy, sample, sharedImpacts, onChange, onReset, onFrame }: Props) {
  const [resetVersion, setResetVersion] = useState(0);
  const geometry = room.geometryEdit;
  const disabled = sample || busy || !geometry?.supported;
  return <Column className="inspector-content room-geometry-inspector" data-testid="geometry-panel" gap="24" padding="20">
    <Column gap="8"><Row horizontal="between" vertical="center"><Text variant="label-default-s" onBackground="brand-medium">ROOM GEOMETRY</Text>{modified && <span className="modified-dot" title="Modified in this project" />}</Row><Text variant="heading-strong-m">{room.name}</Text><Text variant="label-default-xs" onBackground="neutral-weak">Room {formatAddress(room.id)}</Text></Column>
    <Text variant="body-default-s" onBackground="neutral-weak">Translate the static room surface and any attached collision. Actor and event placements, entrances, and camera data keep their original positions.</Text>
    {disabled && <div className="inspector-notice">{sample ? "Procedural sample · read only" : geometry?.reason ?? "Room geometry editing is not verified for this room."}</div>}
    <Column gap="8"><Text variant="label-default-s" onBackground="neutral-weak">TRANSLATION · WORLD UNITS</Text><div className="vector-fields">{(["x", "y", "z"] as const).map(axis => <ValueField key={`${axis}:${resetVersion}`} label={axis.toUpperCase()} testId={`geometry-${axis}`} value={String(translation[axis])} disabled={disabled} commit={draft => {
      const min = geometry?.translationBounds?.min[axis] ?? -32768;
      const max = geometry?.translationBounds?.max[axis] ?? 32767;
      onChange(checkedGeometryTranslation(room, { ...translation, [axis]: parseInteger(draft, min, max) }));
    }} />)}</div></Column>
    {geometry?.translationBounds && <Column gap="8" className="geometry-bounds"><Text variant="label-default-xs" onBackground="neutral-weak">VERIFIED TRANSLATION RANGE</Text>{(["x", "y", "z"] as const).map(axis => <Row key={axis} horizontal="between" textVariant="label-default-xs"><span>{axis.toUpperCase()}</span><code>{geometry.translationBounds!.min[axis]} … {geometry.translationBounds!.max[axis]}</code></Row>)}</Column>}
    <Column gap="12" className="source-block"><Text variant="label-default-s" onBackground="neutral-weak">NATIVE DATA</Text><Row horizontal="between" textVariant="label-default-xs"><span>Editable vertices</span><code>{geometry?.vertexCount.toLocaleString() ?? "—"}</code></Row><Row horizontal="between" textVariant="label-default-xs"><span>Collision planes</span><code>{geometry?.planeCount.toLocaleString() ?? "—"}</code></Row><Row horizontal="between" textVariant="label-default-xs"><span>Spatial cells</span><code>{geometry?.cellCount.toLocaleString() ?? "—"}</code></Row>{geometry && !geometry.planeCount && <Text variant="body-default-xs" onBackground="neutral-weak">No native collision planes are attached to this room's editable geometry.</Text>}</Column>
    {geometry?.supported && geometry.affectedRoomIds.filter(id => id !== room.id).length > 0 && <Column gap="8"><Text variant="label-default-s" onBackground="neutral-weak">SHARED GEOMETRY GROUP</Text><div className="inspector-notice">Rooms {geometry.affectedRoomIds.filter(id => id !== room.id).map(id => `0x${id.toString(16).toUpperCase()}`).join(", ")} use the same complete geometry resources. Translation and reset affect the entire group; actor edits are retained.</div></Column>}
    {sharedImpacts.length > 0 && <div className="inspector-notice geometry-shared-notice" role="status">Showing the shared translation set in {sharedImpacts.length === 1 ? "room" : "rooms"} {sharedImpacts.map(id => `0x${id.toString(16).toUpperCase()}`).join(", ")}. Editing here updates the same geometry group.</div>}
    <Row gap="8"><Button variant="secondary" size="s" fillWidth onClick={onFrame} disabled={!room.meshes.length}>Frame room</Button><Button variant="tertiary" size="s" fillWidth data-testid="geometry-reset" disabled={disabled || !modified} onClick={() => { onReset(); setResetVersion(value => value + 1); }}>{geometry?.affectedRoomIds.some(id => id !== room.id) ? "Reset group" : "Reset geometry"}</Button></Row>
    <Text variant="body-default-xs" onBackground="neutral-weak">Translation preserves the native vertex layout. Editing individual vertices or rebuilding room topology is not available.</Text>
    <RoomInitializationDetails initialization={room.initialization} sample={sample} />
  </Column>;
}
