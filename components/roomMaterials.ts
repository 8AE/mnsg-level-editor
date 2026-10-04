import * as THREE from "three";
import type { GeometryMesh, GeometryTexture, RoomData } from "../shared/types";

type NativeMaterial = NonNullable<GeometryMesh["material"]>;
export interface RenderTextureCoverage { roomId: number; textured: number; total: number; images: number; warnings: string[] }
const wrapping = { repeat: THREE.RepeatWrapping, mirror: THREE.MirroredRepeatWrapping, clamp: THREE.ClampToEdgeWrapping };

export function decodeTexturePixels(source: GeometryTexture): Uint8Array {
  if (!Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) || source.width < 1 || source.height < 1 || source.width > 4096 || source.height > 4096 || source.width * source.height > 262144) throw new Error("Decoded ROM texture dimensions exceed the supported pixel budget.");
  if (typeof source.rgbaBase64 !== "string" || source.rgbaBase64.length !== Math.ceil(source.width * source.height * 4 / 3) * 4) throw new Error("Decoded ROM texture does not contain its expected RGBA pixels.");
  const raw = atob(source.rgbaBase64);
  if (raw.length !== source.width * source.height * 4) throw new Error("Decoded ROM texture does not contain its expected RGBA pixels.");
  return Uint8Array.from(raw, value => value.charCodeAt(0));
}

/** Data remains in memory; no image URLs or asset requests are involved. */
export class RoomTexturePool {
  private readonly sources: Map<string, GeometryTexture>;
  private readonly decoded = new Map<string, { pixels: Uint8Array; alpha: boolean }>();
  private readonly textures = new Map<string, THREE.DataTexture>();
  constructor(sources: GeometryTexture[] = []) { this.sources = new Map(sources.map(source => [source.id, source])); }
  get(textureId: string, sampler: Pick<NativeMaterial, "wrapS" | "wrapT" | "filter">): { texture: THREE.DataTexture; alpha: boolean } {
    const source = this.sources.get(textureId);
    if (!source) throw new Error("A surface references a ROM texture that was not decoded.");
    let decoded = this.decoded.get(textureId);
    if (!decoded) {
      const pixels = decodeTexturePixels(source);
      const alpha = pixels.some((value, index) => index % 4 === 3 && value !== 255);
      decoded = { pixels, alpha }; this.decoded.set(textureId, decoded);
    }
    const key = `${textureId}:${sampler.wrapS}:${sampler.wrapT}:${sampler.filter}`;
    let texture = this.textures.get(key);
    if (!texture) {
      texture = new THREE.DataTexture(decoded.pixels, source.width, source.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      // The parser emits ROM row zero first and normalized +T downward. With an
      // unflipped DataTexture, UV v=0 addresses that row without a second inversion.
      texture.flipY = false;
      texture.wrapS = wrapping[sampler.wrapS]; texture.wrapT = wrapping[sampler.wrapT];
      texture.magFilter = texture.minFilter = sampler.filter === "linear" ? THREE.LinearFilter : THREE.NearestFilter;
      texture.generateMipmaps = false; texture.premultiplyAlpha = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      this.textures.set(key, texture);
    }
    return { texture, alpha: decoded.alpha };
  }
  get size(): number { return this.textures.size; }
  dispose(): void { this.textures.forEach(texture => texture.dispose()); this.textures.clear(); this.decoded.clear(); }
}

export function roomTextureCoverage(room: RoomData): { textured: number; total: number; images: number } {
  const ids = new Set(room.textures?.map(texture => texture.id));
  let textured = 0, total = 0;
  for (const mesh of room.meshes) {
    const triangles = mesh.indices.length / 3;
    total += triangles;
    if (mesh.material?.textureId && ids.has(mesh.material.textureId) && mesh.uvs?.length === mesh.positions.length / 3 * 2) textured += triangles;
  }
  return { textured, total, images: ids.size };
}

/** Preserve display-space native bytes through Three's linear working space.
 * Texture/shade multiplication still approximates the N64 byte-space combiner.
 */
export function linearNativeColors(colors: number[]): Float32Array {
  const output = new Float32Array(colors.length);
  const color = new THREE.Color();
  for (let offset = 0; offset < colors.length; offset += 3) {
    color.setRGB(colors[offset], colors[offset + 1], colors[offset + 2], THREE.SRGBColorSpace);
    output[offset] = color.r; output[offset + 1] = color.g; output[offset + 2] = color.b;
  }
  return output;
}

export function createNativeSurfaceMaterial(data: GeometryMesh, pool: RoomTexturePool): { material: THREE.MeshBasicMaterial; textured: boolean; warning?: string } {
  const state = data.material;
  const colors = Boolean(state?.vertexColors && !state.lighting && data.colors?.length === data.positions.length);
  const material = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(...(state?.color ?? [1, 1, 1]), THREE.SRGBColorSpace), side: THREE.DoubleSide, vertexColors: colors, opacity: state?.opacity ?? 1, alphaTest: state?.alphaTest ?? 0, toneMapped: false });
  let textured = false, alpha = false;
  let warning: string | undefined;
  if (state?.textureId && data.uvs?.length === data.positions.length / 3 * 2) {
    try { const decoded = pool.get(state.textureId, state); material.map = decoded.texture; alpha = decoded.alpha; textured = true; }
    catch (error) { warning = error instanceof Error ? error.message : "A ROM texture could not be displayed."; }
  }
  if (state?.textureId && data.uvs?.length !== data.positions.length / 3 * 2) warning = "A textured surface has no verified UV coordinates and is shown in solid color.";
  material.transparent = material.opacity < 1 || (alpha && material.alphaTest === 0);
  material.depthWrite = !material.transparent;
  material.forceSinglePass = true;
  return { material, textured, warning };
}
