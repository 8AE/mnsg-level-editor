"use client";

import { Column, Row, Text } from "@once-ui-system/core";
import type {
  NativeInitializationSource,
  RoomInitialization,
} from "../shared/room-initialization";

interface Props {
  initialization?: RoomInitialization;
  authored?: boolean;
  templateRoomId?: number;
  sample?: boolean;
}
const address = (value: number) => `0x${value.toString(16).toUpperCase()}`;

function SourceDetails({
  label,
  source,
}: {
  label: string;
  source: NativeInitializationSource;
}) {
  return (
    <details className="initialization-source">
      <summary>{label}</summary>
      <Column gap="8" paddingTop="12" textVariant="label-default-xs">
        <Row horizontal="between" gap="8">
          <span>File</span>
          <code>{source.fileId}</code>
        </Row>
        <Row horizontal="between" gap="8">
          <span>CPU address</span>
          <code>{address(source.cpuAddress)}</code>
        </Row>
        <Row horizontal="between" gap="8">
          <span>ROM offset</span>
          <code>{address(source.romOffset)}</code>
        </Row>
        <Row horizontal="between" gap="8">
          <span>Bytes</span>
          <code>{source.byteLength.toLocaleString()}</code>
        </Row>
        <Text variant="label-default-xs" onBackground="neutral-weak">
          SHA256
        </Text>
        <code className="initialization-hash">{source.sha256}</code>
      </Column>
    </details>
  );
}
function FileOrder({ ids, testId }: { ids: readonly number[]; testId: string }) {
  return (
    <ol className="initialization-file-order" data-testid={testId}>
      {ids.map((id, index) => (
        <li key={index}>
          <code>File {id}</code>
        </li>
      ))}
    </ol>
  );
}

/** Read-only native inventory. Opening this section has no project or runtime effects. */
export default function RoomInitializationDetails({
  initialization,
  authored = false,
  templateRoomId,
  sample = false,
}: Props) {
  const donor = initialization?.roomId ?? templateRoomId;
  return (
    <details className="room-initialization" data-testid="room-initialization">
      <summary>Room initialization</summary>
      <Column gap="16" paddingTop="16">
        {authored && donor !== undefined && (
          <Text variant="body-default-s">
            Template room {donor} provides initialization.
          </Text>
        )}
        {!initialization ? (
          <Text variant="body-default-s" onBackground="neutral-weak">
            {sample
              ? "The procedural sample has no native room initialization data."
              : "A native initialization inventory is not available for this room."}
          </Text>
        ) : (
          <>
            <Text variant="body-default-s" onBackground="neutral-weak">
              Native resource-loading setup. Actor-linked behavior is listed
              separately in Events.
            </Text>
            {initialization.status === "special-geometry-alias" && (
              <Text variant="body-strong-s">
                No ordinary-world metadata. Special-scene setup has not been
                recovered.
              </Text>
            )}
            <Text variant="body-default-s" onBackground="neutral-weak">
              {initialization.reason}
            </Text>
            <Column gap="8" textVariant="label-default-xs">
              <Row horizontal="between" gap="8">
                <span>Native room</span>
                <code>{initialization.roomId}</code>
              </Row>
              <Row horizontal="between" gap="8">
                <span>Stage / local index</span>
                <code>
                  {initialization.context.stage} /{" "}
                  {initialization.context.localIndex}
                </code>
              </Row>
              <Row horizontal="between" gap="8">
                <span>Geometry group / index</span>
                <code>
                  {initialization.context.geometryGroup} /{" "}
                  {initialization.context.geometryIndex}
                </code>
              </Row>
              {initialization.actorDataFileId !== undefined && (
                <Row horizontal="between" gap="8">
                  <span>Actor data file</span>
                  <code>{initialization.actorDataFileId}</code>
                </Row>
              )}
            </Column>
            {initialization.loadCallback && (
              <Column gap="8">
                <Text variant="label-strong-s">Room resource load order</Text>
                <Text variant="body-default-xs" onBackground="neutral-weak">
                  Files requested by the room’s loading callback, in native
                  order.
                </Text>
                <FileOrder
                  ids={
                    initialization.loadCallback.dependencyList.orderedFileIds
                  }
                  testId="initialization-resource-order"
                />
              </Column>
            )}
            {initialization.geometry && (
              <Column gap="8">
                <Text variant="label-strong-s">Cold geometry load order</Text>
                <FileOrder
                  ids={initialization.geometry.coldLoadOrder}
                  testId="initialization-geometry-order"
                />
                {initialization.geometry.ordinaryGeometryAliasRoomId !==
                  undefined && (
                  <Text variant="body-default-s">
                    Geometry aliases ordinary room{" "}
                    {initialization.geometry.ordinaryGeometryAliasRoomId}.
                  </Text>
                )}
              </Column>
            )}
            {initialization.limits.length > 0 && (
              <Column gap="8">
                <Text variant="label-strong-s">Inventory limits</Text>
                <ul className="initialization-limits">
                  {initialization.limits.map((limit, index) => (
                    <li key={index}>{limit}</li>
                  ))}
                </ul>
              </Column>
            )}
            <details className="initialization-source">
              <summary>Native sources</summary>
              <Column gap="12" paddingTop="12">
                <Row
                  horizontal="between"
                  gap="8"
                  textVariant="label-default-xs"
                >
                  <span>Room table ROM offset</span>
                  <code>{address(initialization.tableEntryRomOffset)}</code>
                </Row>
                {initialization.reservedHalfword !== undefined && (
                  <Row
                    horizontal="between"
                    gap="8"
                    textVariant="label-default-xs"
                  >
                    <span>Reserved halfword</span>
                    <code>{address(initialization.reservedHalfword)}</code>
                  </Row>
                )}
                {initialization.metadata && (
                  <SourceDetails
                    label="Metadata source"
                    source={initialization.metadata.source}
                  />
                )}
                {initialization.loadCallback && (
                  <>
                    <Text variant="label-default-xs">
                      {initialization.loadCallback.symbol}
                    </Text>
                    <SourceDetails
                      label="Loading callback source"
                      source={initialization.loadCallback.source}
                    />
                    <SourceDetails
                      label="Dependency list source"
                      source={initialization.loadCallback.dependencyList.source}
                    />
                  </>
                )}
                {initialization.geometry && (
                  <>
                    <SourceDetails
                      label="Geometry selection source"
                      source={initialization.geometry.primarySource}
                    />
                    <SourceDetails
                      label="Geometry resources source"
                      source={initialization.geometry.resourceSource}
                    />
                    <Text variant="label-default-xs">
                      Resource words:{" "}
                      {initialization.geometry.resourceHalfwords
                        .map(address)
                        .join(", ")}
                    </Text>
                  </>
                )}
              </Column>
            </details>
          </>
        )}
      </Column>
    </details>
  );
}
