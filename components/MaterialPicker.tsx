"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { Button, Column, Row, Text } from "@once-ui-system/core";
import { FiSearch, FiX } from "react-icons/fi";
import type { AuthoringCatalog, MaterialAssetEntry } from "../shared/types";
import { decodeTexturePixels } from "./roomMaterials";
import { WorkspacePanelWindowContext } from "./DockWorkspace";

type Loader = NonNullable<Window["mnsg"]>["loadMaterialPreview"];
const cache = new Map<string, string>();
let previewQueue: Promise<unknown> = Promise.resolve();
function thumbnail(
  entry: MaterialAssetEntry,
  key: string,
  load: Loader,
  document: Document,
  isActive: () => boolean,
) {
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const job = previewQueue.then(async () => {
    const existing = cache.get(key);
    if (existing) return existing;
    if (!isActive()) throw new Error("Preview no longer visible");
    const payload = await load(entry.id);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Texture preview unavailable");
    context.imageSmoothingEnabled = false;
    const color = payload.material.color.map((v) => Math.round(v * 255));
    context.fillStyle = `rgb(${color.join(",")})`;
    context.fillRect(0, 0, 96, 96);
    for (const [index, id] of [
      payload.material.textureId,
      payload.material.dualTexture?.textureId,
    ].entries()) {
      const texture = payload.textures.find((t) => t.id === id);
      if (!texture) continue;
      const source = document.createElement("canvas");
      source.width = texture.width;
      source.height = texture.height;
      const pixels = decodeTexturePixels(texture);
      const image = source
        .getContext("2d")!
        .createImageData(texture.width, texture.height);
      image.data.set(pixels);
      source.getContext("2d")!.putImageData(image, 0, 0);
      context.globalCompositeOperation = index ? "multiply" : "source-over";
      context.drawImage(source, 0, 0, 96, 96);
    }
    const url = canvas.toDataURL("image/png");
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(key, url);
    return url;
  });
  previewQueue = job.catch(() => {});
  return job;
}
function MaterialPreview({
  entry,
  romHash,
  load,
}: {
  entry: MaterialAssetEntry;
  romHash: string;
  load: Loader;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const owner = useContext(WorkspacePanelWindowContext);
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl("");
    setFailed(false);
    const node = element.current;
    const view = node?.ownerDocument.defaultView;
    if (!node || !view) return;
    let active = true;
    const observer = new view.IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      void thumbnail(
        entry,
        `${romHash}/${entry.id}`,
        load,
        node.ownerDocument,
        () => active,
      )
        .then((value) => {
          if (active) setUrl(value);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    });
    observer.observe(node);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [entry, romHash, load, owner]);
  return (
    <span
      ref={element}
      className="material-preview"
      aria-label={`Preview of ${entry.name}`}
    >
      {url ? (
        <img src={url} alt="" />
      ) : (
        <span>{failed ? "Preview unavailable" : "Loading…"}</span>
      )}
    </span>
  );
}
export default function MaterialPicker({
  catalog,
  value,
  disabled,
  load,
  onChange,
}: {
  catalog: AuthoringCatalog;
  value: string;
  disabled: boolean;
  load: Loader;
  onChange(id: string): void;
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState("");
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const owner = useContext(WorkspacePanelWindowContext);
  const selected = catalog.materials.find((m) => m.id === value);
  const visible = catalog.materials.filter((m) =>
    `${m.name} ${m.id}`.toLowerCase().includes(search.toLowerCase()),
  );
  useEffect(() => {
    if (!open) return;
    const node = dialog.current;
    if (!node) return;
    if (!node.open) node.showModal();
    node.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      node.close();
      trigger.current?.focus();
    };
  }, [open, owner]);
  return (
    <Column gap="8" className="material-picker">
      <Text variant="label-default-s">Material</Text>
      <Button
        ref={trigger}
        variant="secondary"
        disabled={disabled}
        className="material-picker-trigger"
        aria-label="Choose material"
        aria-haspopup="dialog"
        onClick={() => {
          setSearch("");
          setOpen(true);
        }}
      >
        {selected && (
          <MaterialPreview
            entry={selected}
            romHash={catalog.romHash}
            load={load}
          />
        )}
        <span>{selected?.name ?? "Choose material"}</span>
        <FiSearch />
      </Button>
      {open && (
        <dialog
          ref={dialog}
          className="material-dialog"
          aria-modal="true"
          aria-label="Choose material"
          role="dialog"
          onCancel={() => setOpen(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              const box = event.currentTarget.getBoundingClientRect();
              if (
                event.clientX < box.left ||
                event.clientX > box.right ||
                event.clientY < box.top ||
                event.clientY > box.bottom
              )
                setOpen(false);
            }
          }}
        >
          <Column gap="12" fill>
            <Row horizontal="between" vertical="center">
              <Text variant="heading-strong-s">Choose material</Text>
              <Button
                size="s"
                variant="tertiary"
                aria-label="Close material picker"
                onClick={() => setOpen(false)}
              >
                <FiX />
              </Button>
            </Row>
            <label className="search-box">
              <FiSearch />
              <input
                aria-label="Search materials"
                placeholder="Search materials by name or ID…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <Text variant="body-default-xs" onBackground="neutral-weak">
              {visible.length} materials · texture and color previews
            </Text>
            <div className="material-grid" aria-label="Material previews">
              {visible.map((entry) => (
                <button
                  type="button"
                  key={entry.id}
                  className="material-tile"
                  aria-pressed={value === entry.id}
                  disabled={disabled}
                  onClick={() => {
                    onChange(entry.id);
                    setOpen(false);
                  }}
                >
                  <MaterialPreview
                    entry={entry}
                    romHash={catalog.romHash}
                    load={load}
                  />
                  <span>{entry.name}</span>
                </button>
              ))}
              {!visible.length && <p>No matching materials.</p>}
            </div>
          </Column>
        </dialog>
      )}
    </Column>
  );
}
