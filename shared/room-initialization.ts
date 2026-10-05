/** Inspection provenance only. No native code or editable executable pointers. */
export interface NativeInitializationSource {
  readonly fileId: number;
  readonly cpuAddress: number;
  readonly romOffset: number;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface RoomInitialization {
  /** Canonical native identity, retained when an authored room uses this donor. */
  readonly roomId: number;
  readonly status: "world-metadata" | "special-geometry-alias";
  readonly context: {
    readonly stage: number;
    readonly localIndex: number;
    readonly geometryGroup: number;
    readonly geometryIndex: number;
  };
  readonly tableEntryRomOffset: number;
  readonly metadata?: { readonly source: NativeInitializationSource };
  readonly actorDataFileId?: number;
  readonly reservedHalfword?: number;
  readonly loadCallback?: {
    readonly source: NativeInitializationSource;
    readonly symbol: string;
    readonly dependencyList: {
      readonly source: NativeInitializationSource;
      readonly orderedFileIds: readonly number[];
    };
  };
  readonly geometry?: {
    readonly primarySource: NativeInitializationSource;
    readonly resourceSource: NativeInitializationSource;
    readonly resourceHalfwords: readonly [number, number, number, number];
    readonly coldLoadOrder: readonly number[];
    readonly ordinaryGeometryAliasRoomId?: number;
  };
  readonly reason: string;
  readonly limits: readonly string[];
}
