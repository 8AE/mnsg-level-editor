"use client";
import { useEffect, useState } from "react";
import { Button, Column, Row, Text } from "@once-ui-system/core";
import type {
  AuthoredRoom,
  AuthoringCatalog,
  AuthoredEntrance,
  ActorVisual,
  RoomSummary,
  Vec3,
} from "../shared/types";
import { ValueField } from "./Inspector";
import RoomInitializationDetails from "./RoomInitializationDetails";
import type { RoomInitialization } from "../shared/room-initialization";
import { PreviewStatus, PreviewDetails } from "./PreviewDiagnostics";
import { parseInteger } from "./editorModel";
import {
  newId,
  replaceMesh,
  transformAuthoredMesh,
  generateRoomCollision,
} from "./authoringModel";
import {
  addFace,
  addVertex,
  editFace,
  editVertex,
  removeFace,
  removeVertex,
  type GeometrySelection,
} from "./authoringState";

export function AuthoringVector({
  label,
  value,
  disabled,
  onChange,
  positive = false,
}: {
  label: string;
  value: Vec3;
  disabled: boolean;
  onChange(value: Vec3): void;
  positive?: boolean;
}) {
  return (
    <Column gap="8">
      <Text variant="label-default-s">{label}</Text>
      <div className="vector-fields">
        {(["x", "y", "z"] as const).map((axis) => (
          <ValueField
            key={axis}
            label={axis.toUpperCase()}
            value={String(value[axis])}
            disabled={disabled}
            commit={(draft) =>
              onChange({
                ...value,
                [axis]: parseInteger(draft, positive ? 1 : -32768, 32767),
              })
            }
          />
        ))}
      </div>
    </Column>
  );
}
const numberList = (
  draft: string,
  length: number,
  min: number,
  max: number,
  integer = true,
) => {
  const values = draft
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    values.length !== length ||
    values.some(
      (v) =>
        !Number.isFinite(v) ||
        v < min ||
        v > max ||
        (integer && !Number.isInteger(v)),
    )
  )
    throw new Error(
      `Enter ${length} ${integer ? "integer " : ""}values between ${min} and ${max}.`,
    );
  return values;
};
interface Props {
  room: AuthoredRoom;
  initialization?: RoomInitialization;
  catalog: AuthoringCatalog;
  selected: string | null;
  geometrySelection: GeometrySelection | null;
  disabled: boolean;
  onChange(room: AuthoredRoom): void;
  onSelect(id: string | null): void;
  onGeometrySelect(selection: GeometrySelection | null): void;
  onFrame(): void;
  destinationRooms: RoomSummary[];
  loadEntrances(roomId: number): Promise<AuthoredEntrance[]>;
  savedRoom?: AuthoredRoom;
  onRevertSaved(): void;
  onRestoreNative(): void;
  followCollision: boolean;
  onFollowCollision(value: boolean): void;
  visual?: ActorVisual;
  visualsPending: boolean;
  referencedEntrances: Set<string>;
  externalEntranceIds: Set<string>;
  nativeEntranceIds: Set<string>;
}
export default function AuthoringInspector({
  room,
  initialization,
  catalog,
  selected,
  geometrySelection,
  disabled,
  onChange,
  onSelect,
  onGeometrySelect,
  onFrame,
  destinationRooms,
  loadEntrances,
  savedRoom,
  onRevertSaved,
  onRestoreNative,
  followCollision,
  onFollowCollision,
  visual,
  visualsPending,
  referencedEntrances,
  externalEntranceIds,
  nativeEntranceIds,
}: Props) {
  const [translation, setTranslation] = useState({ x: 0, y: 0, z: 0 });
  const [rotation, setRotation] = useState({ x: 0, y: 0, z: 0 });
  const [scale, setScale] = useState({ x: 1, y: 1, z: 1 });
  const [collisionClassifier, setCollisionClassifier] = useState(1);
  const [collisionSurface, setCollisionSurface] = useState(0);
  const [transformError, setTransformError] = useState("");
  const mesh = room.meshes.find((m) => m.id === geometrySelection?.meshId);
  const actor = room.actors.find((a) => a.id === selected);
  const door = room.doors.find((d) => `door:${d.id}` === selected);
  const [destinationEntrances, setDestinationEntrances] = useState<
    AuthoredEntrance[]
  >([]);
  const [linkError, setLinkError] = useState("");
  useEffect(() => {
    let active = true;
    setDestinationEntrances([]);
    if (door)
      loadEntrances(door.destination.roomId)
        .then((values) => {
          if (active) setDestinationEntrances(values);
        })
        .catch((e) => {
          if (active)
            setLinkError(
              e instanceof Error
                ? e.message
                : "Cannot read destination entrances.",
            );
        });
    return () => {
      active = false;
    };
  }, [door?.id, door?.destination.roomId, loadEntrances]);
  const entrance = room.entrances.find((e) => `entrance:${e.id}` === selected);
  const changeMesh = (next: NonNullable<typeof mesh>) =>
    onChange(
      replaceMesh(
        room,
        next,
        followCollision && room.collisionMode === "authored",
      ),
    );
  const removeSelected = () => {
    if (mesh) {
      onChange({
        ...room,
        meshes: room.meshes.filter((m) => m.id !== mesh.id),
        collision: room.collision.filter((t) => t.sourceMeshId !== mesh.id),
      });
      onGeometrySelect(null);
    } else if (actor)
      onChange({
        ...room,
        actors: room.actors.filter((a) => a.id !== actor.id),
      });
    else if (door)
      onChange({ ...room, doors: room.doors.filter((d) => d.id !== door.id) });
    else if (entrance) {
      if (referencedEntrances.has(entrance.id))
        throw new Error(
          "This entrance is used by a door. Relink the door before removing it.",
        );
      if (room.entrances.length === 1)
        throw new Error("Keep at least one entrance in this room.");
      onChange({
        ...room,
        entrances: room.entrances.filter((e) => e.id !== entrance.id),
      });
    }
    onSelect(null);
  };
  const vertex =
    mesh && geometrySelection?.mode === "vertex"
      ? mesh.vertices[geometrySelection.vertexIndex]
      : undefined;
  const face =
    mesh && geometrySelection?.mode === "face"
      ? geometrySelection.faceIndex
      : undefined;
  return (
    <Column
      data-testid="authoring-inspector"
      className="inspector-content authoring-inspector"
      gap="20"
      padding="20"
    >
      <Row horizontal="between">
        <Text variant="label-strong-s">
          {mesh
            ? "MESH"
            : actor
              ? "ACTOR"
              : door
                ? "DOOR"
                : entrance
                  ? "ENTRANCE"
                  : "AUTHORED ROOM"}
        </Text>
        <Button size="s" variant="tertiary" onClick={onFrame}>
          Frame
        </Button>
      </Row>
      {(actor || door) && (
        <PreviewStatus
          visual={door && !door.appearancePrototypeId ? undefined : visual}
          pending={Boolean(
            (actor || door?.appearancePrototypeId) && visualsPending,
          )}
          fallback={
            door && !door.appearancePrototypeId
              ? "Generated door trigger box"
              : undefined
          }
        />
      )}
      {mesh ? (
        <>
          <Text variant="body-strong-s">
            {mesh.vertices.length} vertices · {mesh.indices.length / 3}{" "}
            triangles
          </Text>
          <label className="value-field">
            <span>Material</span>
            <select
              aria-label="Material"
              disabled={disabled}
              value={
                room.materials.find((m) => m.id === mesh.materialId)
                  ?.sourceMaterialId ?? ""
              }
              onChange={(e) => {
                let material = room.materials.find(
                  (m) => m.sourceMaterialId === e.target.value,
                );
                const materials = [...room.materials];
                if (!material) {
                  material = {
                    id: newId("material"),
                    sourceMaterialId: e.target.value,
                  };
                  materials.push(material);
                }
                onChange(
                  replaceMesh(
                    { ...room, materials },
                    { ...mesh, materialId: material.id },
                    followCollision && room.collisionMode === "authored",
                  ),
                );
              }}
            >
              {catalog.materials.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={followCollision && room.collisionMode === "authored"}
              disabled={disabled || room.collisionMode === "template"}
              onChange={(e) => onFollowCollision(e.target.checked)}
            />
            Update linked collision with mesh edits
          </label>
          <Text variant="body-default-xs" onBackground="neutral-weak">
            {room.collision.some((t) => t.sourceMeshId === mesh.id)
              ? "Linked collision is included in the project."
              : "No linked collision. Enabling this option creates triangle collision using classifier 1 / surface 0; these are raw native values."}
          </Text>
          <Row gap="4">
            {(["mesh", "vertex", "face"] as const).map((mode) => (
              <Button
                key={mode}
                size="s"
                variant={
                  geometrySelection?.mode === mode ? "secondary" : "tertiary"
                }
                onClick={() =>
                  onGeometrySelect(
                    mode === "vertex"
                      ? { meshId: mesh.id, mode, vertexIndex: 0 }
                      : mode === "face"
                        ? { meshId: mesh.id, mode, faceIndex: 0 }
                        : { meshId: mesh.id, mode },
                  )
                }
                disabled={
                  (mode === "vertex" && !mesh.vertices.length) ||
                  (mode === "face" && !mesh.indices.length)
                }
              >
                {mode}
              </Button>
            ))}
          </Row>
          {geometrySelection?.mode === "vertex" && vertex ? (
            <>
              <ValueField
                testId="vertex-index"
                label="Vertex index"
                value={String(geometrySelection.vertexIndex)}
                disabled={disabled}
                commit={(d) =>
                  onGeometrySelect({
                    ...geometrySelection,
                    vertexIndex: parseInteger(d, 0, mesh.vertices.length - 1),
                  })
                }
              />
              <AuthoringVector
                label="Vertex position"
                value={vertex.position}
                disabled={disabled}
                onChange={(v) =>
                  changeMesh(editVertex(mesh, geometrySelection.vertexIndex, v))
                }
              />
              <ValueField
                label="Texture coordinates U, V"
                value={vertex.uv.join(", ")}
                disabled={disabled}
                commit={(d) => {
                  const uv = numberList(d, 2, -1024, 1024, false) as [
                    number,
                    number,
                  ];
                  changeMesh({
                    ...mesh,
                    vertices: mesh.vertices.map((v, i) =>
                      i === geometrySelection.vertexIndex ? { ...v, uv } : v,
                    ),
                  });
                }}
              />
              <ValueField
                label="Vertex color R, G, B, A"
                value={vertex.color.join(", ")}
                disabled={disabled}
                commit={(d) => {
                  const color = numberList(d, 4, 0, 255) as [
                    number,
                    number,
                    number,
                    number,
                  ];
                  changeMesh({
                    ...mesh,
                    vertices: mesh.vertices.map((v, i) =>
                      i === geometrySelection.vertexIndex ? { ...v, color } : v,
                    ),
                  });
                }}
              />
              <Button
                size="s"
                variant="danger"
                disabled={disabled}
                onClick={() => {
                  changeMesh(removeVertex(mesh, geometrySelection.vertexIndex));
                  onGeometrySelect({ meshId: mesh.id, mode: "mesh" });
                }}
              >
                Remove vertex & incident faces
              </Button>
            </>
          ) : geometrySelection?.mode === "face" && face !== undefined ? (
            <>
              <ValueField
                label="Face index"
                value={String(face)}
                disabled={disabled}
                commit={(d) =>
                  onGeometrySelect({
                    meshId: mesh.id,
                    mode: "face",
                    faceIndex: parseInteger(d, 0, mesh.indices.length / 3 - 1),
                  })
                }
              />
              <ValueField
                testId="face-indices"
                label="Triangle vertex indices"
                value={mesh.indices.slice(face * 3, face * 3 + 3).join(", ")}
                disabled={disabled}
                commit={(d) =>
                  changeMesh(
                    editFace(
                      mesh,
                      face,
                      numberList(d, 3, 0, mesh.vertices.length - 1),
                    ),
                  )
                }
              />
              <Button
                size="s"
                variant="danger"
                disabled={disabled}
                onClick={() => {
                  changeMesh(removeFace(mesh, face));
                  onGeometrySelect({ meshId: mesh.id, mode: "mesh" });
                }}
              >
                Remove face
              </Button>
            </>
          ) : (
            <>
              <AuthoringVector
                label="Translate by"
                value={translation}
                disabled={disabled}
                onChange={setTranslation}
              />
              <AuthoringVector
                label="Rotate degrees XYZ"
                value={rotation}
                disabled={disabled}
                onChange={setRotation}
              />
              <div className="vector-fields">
                {(["x", "y", "z"] as const).map((axis) => (
                  <ValueField
                    key={axis}
                    label={`Scale ${axis.toUpperCase()}`}
                    value={String(scale[axis])}
                    disabled={disabled}
                    commit={(d) => {
                      const n = Number(d);
                      if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 100)
                        throw new Error(
                          "Enter a nonzero scale between -100 and 100.",
                        );
                      setScale({ ...scale, [axis]: n });
                    }}
                  />
                ))}
              </div>
              <Button
                disabled={disabled}
                onClick={() => {
                  try {
                    onChange(
                      transformAuthoredMesh(
                        room,
                        mesh,
                        { translation, rotationDegrees: rotation, scale },
                        followCollision && room.collisionMode === "authored",
                      ),
                    );
                    setTranslation({ x: 0, y: 0, z: 0 });
                    setRotation({ x: 0, y: 0, z: 0 });
                    setScale({ x: 1, y: 1, z: 1 });
                    setTransformError("");
                  } catch (e) {
                    setTransformError(
                      e instanceof Error ? e.message : "Transform failed.",
                    );
                  }
                }}
              >
                Apply mesh transform
              </Button>
              {transformError && (
                <span role="alert" className="field-error">
                  {transformError}
                </span>
              )}
            </>
          )}
          <Row gap="8">
            <Button
              size="s"
              disabled={disabled}
              onClick={() => {
                const next = addVertex(mesh, {
                  position: { x: 0, y: 0, z: 0 },
                  uv: [0, 0],
                  color: [255, 255, 255, 255],
                });
                changeMesh(next);
                onGeometrySelect({
                  meshId: mesh.id,
                  mode: "vertex",
                  vertexIndex: next.vertices.length - 1,
                });
              }}
            >
              Add vertex
            </Button>
            <Button
              size="s"
              disabled={disabled || mesh.vertices.length < 3}
              onClick={() => {
                try {
                  changeMesh(addFace(mesh, [0, 1, 2]));
                  onGeometrySelect({
                    meshId: mesh.id,
                    mode: "face",
                    faceIndex: mesh.indices.length / 3,
                  });
                } catch (e) {
                  setTransformError(
                    e instanceof Error ? e.message : "Invalid triangle.",
                  );
                }
              }}
            >
              Add triangle
            </Button>
          </Row>
          <Button
            size="s"
            variant="secondary"
            disabled={disabled}
            onClick={() => {
              const copy = { ...structuredClone(mesh), id: newId("mesh") };
              onChange({
                ...room,
                meshes: [...room.meshes, copy],
                collision: [
                  ...room.collision,
                  ...room.collision
                    .filter((t) => t.sourceMeshId === mesh.id)
                    .map((t) => ({
                      ...structuredClone(t),
                      id: newId("collision"),
                      sourceMeshId: copy.id,
                    })),
                ],
              });
              onGeometrySelect({ meshId: copy.id, mode: "mesh" });
            }}
          >
            Duplicate mesh
          </Button>
        </>
      ) : actor ? (
        <>
          <label className="value-field">
            <span>Actor prototype</span>
            <select
              aria-label="Actor prototype"
              disabled={disabled}
              value={actor.prototypeId}
              onChange={(e) =>
                onChange({
                  ...room,
                  actors: room.actors.map((a) =>
                    a.id === actor.id
                      ? { ...a, prototypeId: e.target.value }
                      : a,
                  ),
                })
              }
            >
              {catalog.actorPrototypes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.id}
                </option>
              ))}
            </select>
          </label>
          <label className="value-field">
            <span>Actor loading</span>
            <select
              aria-label="Actor loading"
              disabled={disabled}
              value={
                actor.spawnPolicy ??
                (catalog.actorPrototypes.find((p) => p.id === actor.prototypeId)
                  ?.sourceKind === "partition"
                  ? "proximity"
                  : "resident")
              }
              onChange={(e) =>
                onChange({
                  ...room,
                  actors: room.actors.map((a) =>
                    a.id === actor.id
                      ? {
                          ...a,
                          spawnPolicy: e.target.value as
                            | "resident"
                            | "proximity",
                        }
                      : a,
                  ),
                })
              }
            >
              <option value="resident">Always loaded</option>
              <option value="proximity">Near player</option>
            </select>
          </label>
          <AuthoringVector
            label="Position"
            value={actor.position}
            disabled={disabled}
            onChange={(position) =>
              onChange({
                ...room,
                actors: room.actors.map((a) =>
                  a.id === actor.id ? { ...a, position } : a,
                ),
              })
            }
          />
          <AuthoringVector
            label="Native rotation"
            value={actor.rotation}
            disabled={disabled}
            onChange={(rotation) =>
              onChange({
                ...room,
                actors: room.actors.map((a) =>
                  a.id === actor.id ? { ...a, rotation } : a,
                ),
              })
            }
          />
          <ValueField
            label="Parameters (3 unsigned words)"
            value={actor.parameters.join(", ")}
            disabled={disabled}
            commit={(d) => {
              const parameters = numberList(d, 3, 0, 0xffffffff) as [
                number,
                number,
                number,
              ];
              onChange({
                ...room,
                actors: room.actors.map((a) =>
                  a.id === actor.id ? { ...a, parameters } : a,
                ),
              });
            }}
          />
          <Text variant="body-default-xs" onBackground="neutral-weak">
            The native initial pose is shown. Parameters control actor-specific
            behavior; conditional and unavailable previews remain labeled.
          </Text>
        </>
      ) : door ? (
        <>
          <AuthoringVector
            label="Trigger position"
            value={door.position}
            disabled={disabled}
            onChange={(position) =>
              onChange({
                ...room,
                doors: room.doors.map((d) =>
                  d.id === door.id ? { ...d, position } : d,
                ),
              })
            }
          />
          <AuthoringVector
            label="Rotation"
            value={door.rotation}
            disabled={disabled}
            onChange={(rotation) =>
              onChange({
                ...room,
                doors: room.doors.map((d) =>
                  d.id === door.id ? { ...d, rotation } : d,
                ),
              })
            }
          />
          <AuthoringVector
            label="Trigger dimensions"
            positive
            value={door.dimensions}
            disabled={disabled}
            onChange={(dimensions) =>
              onChange({
                ...room,
                doors: room.doors.map((d) =>
                  d.id === door.id ? { ...d, dimensions } : d,
                ),
              })
            }
          />
          <label className="value-field">
            <span>Activation</span>
            <select
              aria-label="Activation"
              disabled={disabled}
              value={door.activation}
              onChange={(e) =>
                onChange({
                  ...room,
                  doors: room.doors.map((d) =>
                    d.id === door.id
                      ? {
                          ...d,
                          activation: e.target.value as "interact" | "touch",
                        }
                      : d,
                  ),
                })
              }
            >
              <option value="interact">Interact</option>
              <option value="touch">Touch</option>
            </select>
          </label>
          <label className="value-field">
            <span>Destination room</span>
            <select
              aria-label="Destination room"
              disabled={disabled}
              value={door.destination.roomId}
              onChange={(e) => {
                const roomId = Number(e.target.value);
                loadEntrances(roomId)
                  .then((entries) => {
                    const first = entries[0];
                    if (!first)
                      throw new Error(
                        "This room has no verified destination entrances. Add an authored entrance first.",
                      );
                    setLinkError("");
                    onChange({
                      ...room,
                      doors: room.doors.map((d) =>
                        d.id === door.id
                          ? {
                              ...d,
                              destination: { roomId, entranceId: first.id },
                            }
                          : d,
                      ),
                    });
                  })
                  .catch((e) =>
                    setLinkError(
                      e instanceof Error ? e.message : "Door link failed.",
                    ),
                  );
              }}
            >
              {destinationRooms.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.name} · {r.id}
                </option>
              ))}
            </select>
          </label>
          <label className="value-field">
            <span>Destination entrance</span>
            <select
              aria-label="Destination entrance"
              disabled={disabled || !destinationEntrances.length}
              value={door.destination.entranceId}
              onChange={(e) =>
                onChange({
                  ...room,
                  doors: room.doors.map((d) =>
                    d.id === door.id
                      ? {
                          ...d,
                          destination: {
                            ...d.destination,
                            entranceId: e.target.value,
                          },
                        }
                      : d,
                  ),
                })
              }
            >
              {destinationEntrances.map((e) => (
                <option value={e.id} key={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          {linkError && (
            <span className="field-error" role="alert">
              {linkError}
            </span>
          )}
          <label className="value-field">
            <span>Door appearance</span>
            <select
              aria-label="Door appearance"
              value={door.appearancePrototypeId ?? ""}
              disabled={disabled}
              onChange={(e) =>
                onChange({
                  ...room,
                  doors: room.doors.map((d) =>
                    d.id === door.id
                      ? {
                          ...d,
                          appearancePrototypeId: e.target.value || undefined,
                        }
                      : d,
                  ),
                })
              }
            >
              <option value="">Generated door box</option>
              {catalog.actorPrototypes.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name} · {p.id}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : entrance ? (
        <>
          <ValueField
            label="Entrance name"
            value={entrance.name}
            disabled={disabled}
            commit={(name) =>
              onChange({
                ...room,
                entrances: room.entrances.map((e) =>
                  e.id === entrance.id ? { ...e, name } : e,
                ),
              })
            }
          />
          <Text variant="body-default-xs">ID: {entrance.id}</Text>
          <AuthoringVector
            label="Spawn position"
            value={entrance.position}
            disabled={disabled}
            onChange={(position) =>
              onChange({
                ...room,
                entrances: room.entrances.map((e) =>
                  e.id === entrance.id ? { ...e, position } : e,
                ),
              })
            }
          />
          {(["entryParameter", "baseYaw"] as const).map((field) => (
            <ValueField
              key={field}
              label={
                field === "entryParameter"
                  ? "Camera-start mode + direction byte"
                  : "Base heading (1024 units per turn)"
              }
              value={String(entrance[field])}
              disabled={disabled}
              commit={(v) =>
                onChange({
                  ...room,
                  entrances: room.entrances.map((e) =>
                    e.id === entrance.id
                      ? {
                          ...e,
                          [field]: parseInteger(
                            v,
                            field === "entryParameter" ? 0 : -32768,
                            field === "entryParameter" ? 39 : 32767,
                          ),
                        }
                      : e,
                  ),
                })
              }
            />
          ))}
        </>
      ) : (
        <>
          <ValueField
            label="Room name"
            value={room.name}
            disabled={disabled}
            commit={(name) => {
              if (!name.trim()) throw new Error("A room needs a name.");
              onChange({ ...room, name });
            }}
          />
          <Text variant="body-default-xs" onBackground="neutral-weak">
            {room.kind} · ID {room.id} · native service template{" "}
            {room.templateRoomId}
          </Text>
          <label className="value-field">
            <span>Skybox</span>
            <select
              aria-label="Skybox"
              disabled={disabled}
              value={
                room.skyboxId === null ? "none" : (room.skyboxId ?? "inherit")
              }
              onChange={(e) =>
                onChange({
                  ...room,
                  skyboxId:
                    e.target.value === "inherit"
                      ? undefined
                      : e.target.value === "none"
                        ? null
                        : e.target.value,
                })
              }
            >
              <option value="inherit">Inherit template sky</option>
              <option value="none">No skybox</option>
              {catalog.skyboxes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <Text variant="body-default-xs" onBackground="neutral-weak">
            Native sky imagery previews as a scrolling bitmap, with editor
            camera projection approximated.
          </Text>
          <Text variant="body-strong-s">
            Collision:{" "}
            {room.collisionMode === "template"
              ? "original template physics"
              : `${room.collision.length} authored triangles`}
          </Text>
          <ValueField
            label="Collision classifier (raw byte)"
            value={String(collisionClassifier)}
            disabled={disabled}
            commit={(v) => setCollisionClassifier(parseInteger(v, 1, 255))}
          />
          <ValueField
            label="Collision surface (raw word)"
            value={String(collisionSurface)}
            disabled={disabled}
            commit={(v) => setCollisionSurface(parseInteger(v, 0, 65535))}
          />
          {transformError && (
            <span role="alert" className="field-error">
              {transformError}
            </span>
          )}
          <Button
            size="s"
            variant="secondary"
            disabled={disabled || !room.meshes.length}
            onClick={() => {
              try {
                const result = generateRoomCollision(
                  room,
                  collisionClassifier,
                  collisionSurface,
                );
                onChange(result.room);
                setTransformError(
                  result.skipped
                    ? `${result.skipped} zero-area visual triangles were omitted from collision.`
                    : "",
                );
              } catch (e) {
                setTransformError(
                  e instanceof Error ? e.message : "Collision failed.",
                );
                return;
              }
              onFollowCollision(true);
            }}
          >
            Generate collision from geometry
          </Button>
          {room.collisionMode === "template" && (
            <Text variant="body-default-xs" onBackground="neutral-weak">
              Visual mesh changes do not alter template physics until collision
              is generated explicitly.
            </Text>
          )}
          <Text variant="body-default-xs" onBackground="neutral-weak">
            Visual surfaces and collision are saved separately. Imported native
            collision is preserved when supplied by the geometry library.
          </Text>
          <Button
            size="s"
            disabled={disabled}
            onClick={() => {
              const entry = {
                id: newId("entrance"),
                name: `Entrance ${room.entrances.length + 1}`,
                position: { x: 0, y: 0, z: 0 },
                baseYaw: 0,
                entryParameter: 16,
              };
              onChange({ ...room, entrances: [...room.entrances, entry] });
              onSelect(`entrance:${entry.id}`);
            }}
          >
            Add entrance
          </Button>
          <Button
            size="s"
            disabled={disabled}
            onClick={() => {
              const entry = {
                id: newId("door"),
                position: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0 },
                dimensions: { x: 80, y: 120, z: 40 },
                activation: "interact" as const,
                destination: {
                  roomId: room.id,
                  entranceId: room.entrances[0]?.id ?? "",
                },
              };
              onChange({ ...room, doors: [...room.doors, entry] });
              onSelect(`door:${entry.id}`);
            }}
          >
            Add custom door
          </Button>
          <Column gap="4">
            {room.doors.map((d) => (
              <Button
                size="s"
                variant="tertiary"
                key={d.id}
                onClick={() => onSelect(`door:${d.id}`)}
              >
                Door → room {d.destination.roomId}
              </Button>
            ))}
            {room.entrances.map((e) => (
              <Button
                size="s"
                variant="tertiary"
                key={e.id}
                onClick={() => onSelect(`entrance:${e.id}`)}
              >
                {e.name}
              </Button>
            ))}
          </Column>
        </>
      )}
      {!mesh && !actor && !door && !entrance && (
        <RoomInitializationDetails
          initialization={initialization}
          authored
          templateRoomId={room.templateRoomId}
        />
      )}
      {!mesh && !actor && !door && !entrance && (
        <Column gap="8">
          <Button
            size="s"
            variant="secondary"
            disabled={
              disabled ||
              !savedRoom ||
              [...externalEntranceIds].some(
                (id) => !savedRoom.entrances.some((e) => e.id === id),
              )
            }
            onClick={onRevertSaved}
          >
            Revert room to saved
          </Button>
          {room.kind === "replacement" ? (
            <Button
              size="s"
              variant="danger"
              disabled={
                disabled ||
                [...externalEntranceIds].some(
                  (id) => !nativeEntranceIds.has(id),
                )
              }
              onClick={onRestoreNative}
            >
              Restore native room
            </Button>
          ) : !savedRoom ? (
            <Button
              size="s"
              variant="danger"
              disabled={disabled}
              onClick={() =>
                onChange({
                  ...room,
                  meshes: [],
                  materials: [],
                  collisionMode: "authored",
                  collisionTranslation: undefined,
                  collision: [],
                  actors: [],
                  doors: [],
                })
              }
            >
              Clear room contents
            </Button>
          ) : null}
          {referencedEntrances.size > 0 && (
            <Text variant="body-default-xs" onBackground="neutral-weak">
              Door links to this room's entrances are preserved. Relink doors
              before replacing a referenced entrance.
            </Text>
          )}
        </Column>
      )}
      {(mesh || actor || door || entrance) && (
        <Button
          size="s"
          variant="danger"
          disabled={
            disabled ||
            Boolean(
              entrance &&
                (room.entrances.length === 1 ||
                  referencedEntrances.has(entrance.id)),
            )
          }
          onClick={removeSelected}
        >
          Remove {mesh ? "mesh" : actor ? "actor" : door ? "door" : "entrance"}
        </Button>
      )}
      {(actor || door?.appearancePrototypeId) && (
        <PreviewDetails visual={visual} />
      )}
    </Column>
  );
}
