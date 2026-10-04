"use client";
import { useEffect, useRef, useState } from "react";
import { Button, Column, Media, Row, Text } from "@once-ui-system/core";
import type { ActorVisual, AppApi, AuthoringCatalog } from "../shared/types";
import { assetThumbnail } from "./assetThumbnails";
import { PreviewStatus, PreviewDetails } from "./PreviewDiagnostics";
export interface LibraryDrop {
  kind: "actor" | "geometry" | "skybox";
  id: string;
}
function AssetCard({
  id,
  name,
  kind,
  api,
  catalog,
  disabled,
  onInsert,
}: {
  id: string;
  name: string;
  kind: LibraryDrop["kind"];
  api: AppApi;
  catalog: AuthoringCatalog;
  disabled: boolean;
  onInsert(asset: LibraryDrop): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState("");
  const [note, setNote] = useState("");
  const [visual, setVisual] = useState<ActorVisual>();
  const [messages, setMessages] = useState<string[]>([]);
  useEffect(() => {
    let active = true,
      started = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (started || !entries.some((e) => e.isIntersecting)) return;
        started = true;
        observer.disconnect();
        (async () => {
          try {
            const prototype =
              kind === "actor"
                ? catalog.actorPrototypes.find((p) => p.id === id)
                : undefined;
            const payload = await (kind === "actor"
              ? api.loadActorPrototype(id)
              : kind === "geometry"
                ? api.loadGeometryAsset(id)
                : api.loadSkyboxAsset(id));
            if (!active) return;
            if ("actorVisuals" in payload) {
              setVisual(payload.actorVisuals[0]);
              setMessages(
                payload.actorModels.flatMap((model) => model.warnings),
              );
            } else if ("warnings" in payload) setMessages(payload.warnings);
            const url = await assetThumbnail(payload, prototype);
            if (active) setImage(url);
          } catch (e) {
            if (active)
              setNote(e instanceof Error ? e.message : "Preview unavailable.");
          }
        })();
      },
      { rootMargin: "100px" },
    );
    if (host.current) observer.observe(host.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [id, kind, api, catalog]);
  return (
    <div
      ref={host}
      data-testid="asset-card"
      data-asset-id={id}
      data-asset-kind={kind}
      className="asset-card"
      draggable={!disabled}
      onDragStart={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData(
          "application/x-mnsg-asset",
          JSON.stringify({ kind, id }),
        );
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      {image ? (
        <Media
          src={image}
          alt={name}
          aspectRatio="3 / 2"
          radius="m"
          sizes="240px"
        />
      ) : (
        <div className="asset-thumbnail-empty">
          {note ? "No visual preview" : "Reading native asset…"}
        </div>
      )}
      <Text variant="label-strong-s">{name}</Text>
      <PreviewStatus
        visual={visual}
        fallback={
          note
            ? "Preview unavailable"
            : kind === "actor"
              ? "Reading native preview"
              : "Native ROM asset"
        }
        messages={[...messages, note]}
      />
      <Button
        size="s"
        variant="secondary"
        disabled={disabled}
        onClick={() => onInsert({ kind, id })}
      >
        {kind === "skybox" ? "Use skybox" : "Place at origin"}
      </Button>
      <PreviewDetails visual={visual} messages={[...messages, note]} />
    </div>
  );
}
export default function AssetLibrary({
  catalog,
  api,
  disabled,
  onInsert,
  onClose,
}: {
  catalog: AuthoringCatalog;
  api: AppApi;
  disabled: boolean;
  onInsert(asset: LibraryDrop): void;
  onClose(): void;
}) {
  const [kind, setKind] = useState<LibraryDrop["kind"]>("actor"),
    [search, setSearch] = useState("");
  const items =
    kind === "actor"
      ? catalog.actors.flatMap((a) =>
          a.prototypeIds.map((id, i) => ({
            id,
            name: `${a.name} · 0x${a.actorId.toString(16).toUpperCase()}${a.prototypeIds.length > 1 ? ` · variant ${i + 1}` : ""}`,
          })),
        )
      : kind === "geometry"
        ? catalog.geometry
        : catalog.skyboxes;
  const visible = items.filter((a) =>
    `${a.name} ${a.id}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Column
      className="asset-library"
      data-testid="authoring-library"
      borderRight
    >
      <Row padding="16" horizontal="between">
        <Text variant="label-strong-s">ASSET LIBRARY</Text>
        <Button size="s" variant="tertiary" onClick={onClose}>
          Close
        </Button>
      </Row>
      <Row paddingX="16" gap="4">
        {(["actor", "geometry", "skybox"] as const).map((k) => (
          <Button
            size="s"
            key={k}
            variant={kind === k ? "secondary" : "tertiary"}
            onClick={() => setKind(k)}
          >
            {k === "actor" ? "Actors" : k === "geometry" ? "Geometry" : "Sky"}
          </Button>
        ))}
      </Row>
      <label className="search-box">
        <input
          aria-label="Search native assets"
          placeholder="Search names or IDs…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <Text paddingX="16" variant="body-default-xs" onBackground="neutral-weak">
        {visible.length} native assets · drag into the viewport or place at the
        origin. Preview availability is independent of insertion.
      </Text>
      <div className="asset-grid">
        {visible.map((item) => (
          <AssetCard
            key={item.id}
            {...item}
            kind={kind}
            catalog={catalog}
            api={api}
            disabled={disabled}
            onInsert={onInsert}
          />
        ))}
      </div>
    </Column>
  );
}
