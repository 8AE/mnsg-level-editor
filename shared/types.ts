import type { ModSettings, ModAttachment } from "./mod-settings";
export type { ModSettings, ModAttachment, ModConfigOption } from "./mod-settings";
import type { RoomInitialization } from "./room-initialization";
export type { RoomInitialization, NativeInitializationSource } from "./room-initialization";
/** The renderer contract contains data only. Filesystem paths stay in Electron. */
export interface Vec3 { x: number; y: number; z: number }
export interface RomIdentity {
  sha256: string;
  normalizedSha256: string;
  title: string;
  gameCode: string;
  region: "US";
  byteLength: number;
  decompressed: boolean;
}
export interface SourceRecord {
  fileId?: number;
  /** Offset in the normalized, decompressed ROM. */
  romOffset: number;
  segmentedAddress?: number;
  /** Original record bytes, as lowercase hexadecimal. */
  expectedHex: string;
}
export interface ActorData {
  id: string;
  index: number;
  actorId: number;
  name: string;
  position: Vec3;
  rotation: Vec3;
  parameters: number[];
  source: SourceRecord;
  definitionSource?: SourceRecord;
  sourceKind?: "resident" | "normal" | "partition";
  partition?: { origin: Vec3; cellSize: Vec3; cellCount: Vec3; originalCell: Vec3 };
  editable: boolean;
}
export interface EventData {
  actorRef?: string;
  trigger?: string;
  id: string;
  index: number;
  name: string;
  kind: string;
  position?: Vec3;
  values: number[];
  source: SourceRecord;
  editable: boolean;
}
/** Native generated UV state captured at vertex load. Camera substitution is explicit. */
export interface NativeTexgen {
  mode: "sphere" | "linear";
  basis: {kind:"world";x:[number,number,number];y:[number,number,number];source:"movemem"|"native-reset"} | {kind:"editor-camera"};
  /** Generated texels map to normalized sampler coordinates using these coefficients. */
  scale: [number,number];
  offset: [number,number];
}
/** Exact two-cycle TEXEL0*TEXEL1*SHADE with independently sampled native tiles. */
export interface NativeDualTexture {
  textureId: string;
  wrapS: "repeat" | "mirror" | "clamp";
  wrapT: "repeat" | "mirror" | "clamp";
  filter: "nearest" | "linear";
  mode: "multiply-shade-primitive-alpha";
  /** Both decoded tile images are opaque, proving first-cycle alpha comparison passes. */
  opaqueFirstCycle: true;
}
export interface GeometryMesh {
  id: string;
  /** Stable ROM-backed material library ID; never a native pointer. */
  materialId?: string;
  positions: number[];
  indices: number[];
  colors?: number[];
  colorItemSize?: 3 | 4;
  uvs?: number[];
  secondaryUvs?: number[];
  normals?: number[];
  material?: {
    textureId?: string;
    texgen?: NativeTexgen;
    dualTexture?: NativeDualTexture;
    wrapS: "repeat" | "mirror" | "clamp";
    wrapT: "repeat" | "mirror" | "clamp";
    filter: "nearest" | "linear";
    color: [number,number,number];
    opacity: number;
    alphaTest: number;
    vertexColors: boolean;
    lighting: boolean;
  };
  source: "collision" | "display-list";
}
export interface GeometryTexture {
  id: string;
  width: number;
  height: number;
  rgbaBase64: string;
  format: string;
}
export interface AxisFlags {x:boolean;y:boolean;z:boolean}
export interface ActorModelNode {
  parentIndex:number|null;
  /** Native column-major local transform; placement is applied separately. */
  matrix:number[];
  billboardAxes?:AxisFlags;
  meshIndices:number[];
}
export interface ActorModel {
  id:string;
  meshes:GeometryMesh[];
  textures:GeometryTexture[];
  nodes:ActorModelNode[];
  warnings:string[];
  localBounds?:{min:Vec3;max:Vec3};
}
export interface ActorVisualPart {
  assetId:string;
  /** Initial native scale/pivot; current placement position/rotation stays live. */
  rootMatrix:number[];
  positionOffset:Vec3;
  rotationOverrides:Partial<Vec3>;
  billboardAxes:AxisFlags;
  pose:"static"|"initial-frame";
  provenance:{identity:number;slot:number;fileIds:number[];modelPointer:number;animationFrame?:number;animationBlendCountdown?:number};
}
export interface ActorVisual {
  actorRef:string;
  status:"supported"|"conditional"|"nonvisual"|"unsupported";
  parts:ActorVisualPart[];
  reason?:string;
  warnings:string[];
}
export interface ActorVisualPayload {actorVisuals:ActorVisual[];actorModels:ActorModel[]}
export interface RoomSummary {
  id: number;
  name: string;
  actorCount: number;
  eventCount: number;
  geometryAvailable: boolean;
  warnings: string[];
}
export interface RoomData extends RoomSummary {
  initialization?: RoomInitialization;
  actors: ActorData[];
  events: EventData[];
  meshes: GeometryMesh[];
  textures?: GeometryTexture[];
  actorVisuals?:ActorVisual[];
  actorModels?:ActorModel[];
  bounds?: { min: Vec3; max: Vec3 };
  source: SourceRecord;
  geometryEdit?: {
    supported: boolean;
    reason?: string;
    vertexCount: number;
    planeCount: number;
    cellCount: number;
    affectedRoomIds: number[];
    translationBounds?: { min: Vec3; max: Vec3 };
  };
}
export interface ActorOverride {
  actorId?: number;
  position?: Vec3;
  rotation?: Vec3;
  parameters?: number[];
}
export interface EventOverride { position?: Vec3; values?: number[] }
export interface RoomOverride {
  actors: Record<string, ActorOverride>;
  events: Record<string, EventOverride>;
  geometry?: { translation: Vec3 };
}
export interface LegacyEditorProject {
  format: "mnsg-level-project";
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  rom: RomIdentity;
  roomOverrides: Record<string, RoomOverride>;
}
export type NativeActorParameters = [number, number, number];
export interface AuthoredVertex {
  position: Vec3;
  /** Normalized texture coordinates, including tiling outside 0..1. */
  uv: [number, number];
  color: [number, number, number, number];
}
export interface AuthoredMesh {
  id: string;
  vertices: AuthoredVertex[];
  indices: number[];
  materialId: string;
  sourceAssetId?: string;
}
export interface AuthoredMaterial { id: string; sourceMaterialId: string }
export interface AuthoredCollisionTriangle {
  id: string;
  vertices: [Vec3, Vec3, Vec3];
  /** Opaque native plane-side classifier, not a named gameplay material. */
  classifier: number;
  /** Opaque native cell/surface value. */
  surface: number;
  surfaceId?: string;
  sourceMeshId?: string;
}
export interface AuthoredActor {
  id: string;
  prototypeId: string;
  position: Vec3;
  rotation: Vec3;
  parameters: NativeActorParameters;
  /** Resident list or distance-grid spawning; omitted uses the prototype default. */
  spawnPolicy?: "resident" | "proximity";
}
export interface AuthoredDoor {
  id: string;
  position: Vec3;
  rotation: Vec3;
  dimensions: Vec3;
  activation: "interact" | "touch";
  appearancePrototypeId?: string;
  destination: { roomId: number; entranceId: string };
}
export interface AuthoredEntrance {
  id: string;
  name: string;
  position: Vec3;
  /** Native body heading and camera baseline, in 1024 units per turn. */
  baseYaw: number;
  /** Native startup-behavior index and three direction bits, not Euler yaw. */
  entryParameter: number;
}
export interface AuthoredRoom {
  id: number;
  name: string;
  kind: "replacement" | "new";
  /** Verified vanilla donor for native room staging/service metadata. */
  templateRoomId: number;
  meshes: AuthoredMesh[];
  materials: AuthoredMaterial[];
  /** Template keeps the donor's exact native BSP; authored uses explicit triangles. */
  collisionMode: "template" | "authored";
  /** Private donor BSP translation, allowed only with template collision. */
  collisionTranslation?: Vec3;
  collision: AuthoredCollisionTriangle[];
  actors: AuthoredActor[];
  doors: AuthoredDoor[];
  entrances: AuthoredEntrance[];
  /** Undefined inherits the donor background; null explicitly removes it. */
  skyboxId?: string | null;
}
export interface EditorProjectV2 extends Omit<LegacyEditorProject, "version"> {
  version: 2;
  authoredRooms: Record<string, AuthoredRoom>;
  mod?: ModSettings;
}
/** Disk input supports V1; create/open/save canonicalize to V2. */
export type EditorProject = LegacyEditorProject | EditorProjectV2;
export interface ActorCatalogEntry {
  actorId: number;
  name: string;
  prototypeIds: string[];
  warnings: string[];
}
export interface ActorPrototype {
  id: string;
  actorId: number;
  name: string;
  parameters: NativeActorParameters;
  unknownHalfword: number;
  sourceRoomId?: number;
  sourceActorRef?: string;
  /** Canonical exemplar policy; individual authored placements may differ. */
  sourceKind?: "resident" | "normal" | "partition";
  resourceFileIds: number[];
  warnings: string[];
}
export interface GeometryAssetEntry {
  id: string;
  name: string;
  roomIds: number[];
  meshCount: number;
  vertexCount: number;
  triangleCount: number;
  warnings: string[];
}
export interface MaterialAssetEntry {
  id: string;
  name: string;
  material: NonNullable<GeometryMesh["material"]>;
  textureIds: string[];
}
export interface CollisionSurfaceEntry { id: string; classifier: number; surface: number }
export interface NativeEntranceEntry extends AuthoredEntrance { roomId: number }
export interface SkyboxAssetEntry { id: string; name: string; nativeIndex: number; fileId: number; warnings: string[] }
export interface AuthoringCatalog {
  romHash: string;
  actors: ActorCatalogEntry[];
  actorPrototypes: ActorPrototype[];
  geometry: GeometryAssetEntry[];
  materials: MaterialAssetEntry[];
  surfaces: CollisionSurfaceEntry[];
  nativeEntrances: NativeEntranceEntry[];
  skyboxes: SkyboxAssetEntry[];
  roomAdmission: { minId: 620; maxId: 799; supported: boolean; reason?: string };
}
export interface GeometryAssetPayload {
  id: string;
  meshes: GeometryMesh[];
  textures: GeometryTexture[];
  vertexRefs: string[][];
  vertexSources: { id: string; position: Vec3; source: SourceRecord }[];
  collision: AuthoredCollisionTriangle[];
  warnings: string[];
}
/** Native scrolling background texture; not a cubemap or a simulated game sky. */
export interface SkyboxAssetPayload { id: string; texture: GeometryTexture; warnings: string[]; projection?: "native-scroll" }
export interface ActorPrototypeEdits { parameters?: NativeActorParameters; position?: Vec3; rotation?: Vec3 }
export interface ProjectSceneActor extends Omit<ActorData, "source"> { source?: SourceRecord; prototypeId?: string }
export interface ProjectSceneEvent extends Omit<EventData, "source"> { source?: SourceRecord }
export interface ProjectRoomScene extends Omit<RoomData, "source" | "actors" | "events"> {
  kind: "native" | "replacement" | "new";
  source?: SourceRecord;
  actors: ProjectSceneActor[];
  events: ProjectSceneEvent[];
  authoredMeshes: AuthoredMesh[];
  collisionMode: "template" | "authored";
  /** Effective native alias translation, or the authored donor BSP delta. */
  collisionTranslation?: Vec3;
  collision: AuthoredCollisionTriangle[];
  doors: AuthoredDoor[];
  entrances: AuthoredEntrance[];
  skybox?: SkyboxAssetPayload;
}
export interface ToolchainStatus {
  configured: boolean;
  ready: boolean;
  label?: string;
  missing: string[];
  warnings: string[];
}
export interface AppStatus {
  desktop: boolean;
  appVersion: string;
  rom: RomIdentity | null;
  roomCount: number;
  project: EditorProject | null;
  toolchain: ToolchainStatus;
  warnings: string[];
}
export interface ProjectSaveResult { project: EditorProjectV2; fileName: string }
export interface ExportResult {
  kind: "patch" | "nrm";
  fileNames: string[];
  outputPaths?: string[];
  roomIds?: number[];
  changes?: string[];
  warnings: string[];
  buildLog?: string;
}
export interface AppApi {
  getStatus(): Promise<AppStatus>;
  importRom(): Promise<AppStatus | null>;
  listRooms(): Promise<RoomSummary[]>;
  loadRoom(roomId: number): Promise<RoomData>;
  loadActorVisuals(roomId:number,actorOverrides:Record<string,ActorOverride>):Promise<ActorVisualPayload>;
  getAuthoringCatalog(): Promise<AuthoringCatalog>;
  loadGeometryAsset(assetId: string): Promise<GeometryAssetPayload>;
  loadActorPrototype(prototypeId: string, edits?: ActorPrototypeEdits): Promise<ActorVisualPayload>;
  loadSkyboxAsset(assetId: string): Promise<SkyboxAssetPayload>;
  listProjectRooms(project: EditorProject): Promise<RoomSummary[]>;
  loadProjectRoom(project: EditorProject, roomId: number): Promise<ProjectRoomScene>;
  loadProjectActorVisuals(project: EditorProject, roomId: number): Promise<ActorVisualPayload>;
  newProject(name: string): Promise<EditorProjectV2>;
  openProject(): Promise<EditorProjectV2 | null>;
  saveProject(project: EditorProject): Promise<ProjectSaveResult | null>;
  exportPatch(project: EditorProject): Promise<ExportResult | null>;
  exportNrm(project: EditorProject): Promise<ExportResult | null>;
  workspaceStatus(project:EditorProject):Promise<{path:string;templateVersion:string}>;
  importModFile(kind: "icon" | "additional" | "symbols" | "native-library"): Promise<ModAttachment | null>;
  configureToolchain(): Promise<ToolchainStatus | null>;
  getToolchainStatus(): Promise<ToolchainStatus>;
}
declare global { interface Window { mnsg?: AppApi } }
