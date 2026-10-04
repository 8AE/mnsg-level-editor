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
export interface GeometryMesh {
  id: string;
  positions: number[];
  indices: number[];
  colors?: number[];
  uvs?: number[];
  normals?: number[];
  material?: {
    textureId?: string;
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
export interface EditorProject {
  format: "mnsg-level-project";
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  rom: RomIdentity;
  roomOverrides: Record<string, RoomOverride>;
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
export interface ProjectSaveResult { project: EditorProject; fileName: string }
export interface ExportResult {
  kind: "patch" | "nrm";
  fileNames: string[];
  warnings: string[];
  buildLog?: string;
}
export interface AppApi {
  getStatus(): Promise<AppStatus>;
  importRom(): Promise<AppStatus | null>;
  listRooms(): Promise<RoomSummary[]>;
  loadRoom(roomId: number): Promise<RoomData>;
  loadActorVisuals(roomId:number,actorOverrides:Record<string,ActorOverride>):Promise<ActorVisualPayload>;
  newProject(name: string): Promise<EditorProject>;
  openProject(): Promise<EditorProject | null>;
  saveProject(project: EditorProject): Promise<ProjectSaveResult | null>;
  exportPatch(project: EditorProject): Promise<ExportResult | null>;
  exportNrm(project: EditorProject): Promise<ExportResult | null>;
  configureToolchain(): Promise<ToolchainStatus | null>;
  getToolchainStatus(): Promise<ToolchainStatus>;
}
declare global { interface Window { mnsg?: AppApi } }
