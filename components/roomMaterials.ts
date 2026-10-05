import * as THREE from "three";
import type {
  GeometryMesh,
  GeometryTexture,
  RoomData,
  ProjectRoomScene,
  NativeTexgen,
} from "../shared/types";

type NativeMaterial = NonNullable<GeometryMesh["material"]>;
export interface RenderTextureCoverage {
  roomId: number;
  textured: number;
  total: number;
  images: number;
  warnings: string[];
}
const wrapping = {
  repeat: THREE.RepeatWrapping,
  mirror: THREE.MirroredRepeatWrapping,
  clamp: THREE.ClampToEdgeWrapping,
};

/** These are the original signed native normals, not reconstructed face normals. */
export function hasNativeNormals(data: GeometryMesh): boolean {
  return Boolean(
    data.positions.length > 0 &&
      finiteTuple(data.normals, data.positions.length),
  );
}

function finiteTuple(value: number[] | undefined, length: number): boolean {
  if (!Array.isArray(value) || value.length !== length) return false;
  // Array.every skips holes; an absent attribute entry uploads as NaN.
  for (let index = 0; index < length; index++)
    if (!Number.isFinite(value[index])) return false;
  return true;
}

export function hasNativeTextureCoordinates(data: GeometryMesh): boolean {
  const generated = data.material?.texgen;
  if (!generated)
    return Boolean(finiteTuple(data.uvs, (data.positions.length / 3) * 2));
  return Boolean(
    hasNativeNormals(data) &&
      (generated.mode === "sphere" || generated.mode === "linear") &&
      finiteTuple(generated.scale, 2) &&
      finiteTuple(generated.offset, 2) &&
      generated.basis &&
      typeof generated.basis === "object" &&
      (generated.basis.kind === "editor-camera" ||
        (generated.basis.kind === "world" &&
          (generated.basis.source === "movemem" ||
            generated.basis.source === "native-reset") &&
          finiteTuple(generated.basis.x, 3) &&
          finiteTuple(generated.basis.y, 3))),
  );
}

/** Native LookAt axes are transformed into the vertex's local space. The raw
 * s8/127 normal is deliberately neither normalized nor inverse-transposed.
 * Builtin matrices are uploaded per draw, including shared actor instances.
 */
function installNativeTexgen(
  material: THREE.MeshBasicMaterial,
  state: NativeTexgen,
): void {
  material.customProgramCacheKey = () => "mnsg-native-texgen-v1";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.mnsgGenScale = { value: new THREE.Vector2(...state.scale) };
    shader.uniforms.mnsgGenOffset = {
      value: new THREE.Vector2(...state.offset),
    };
    shader.uniforms.mnsgGenLinear = { value: state.mode === "linear" ? 1 : 0 };
    shader.uniforms.mnsgGenCamera = {
      value: state.basis.kind === "editor-camera" ? 1 : 0,
    };
    shader.uniforms.mnsgGenX = {
      value: new THREE.Vector3(
        ...(state.basis.kind === "world" ? state.basis.x : [0, 0, 0]),
      ),
    };
    shader.uniforms.mnsgGenY = {
      value: new THREE.Vector3(
        ...(state.basis.kind === "world" ? state.basis.y : [0, 0, 0]),
      ),
    };
    shader.vertexShader =
      `
uniform vec2 mnsgGenScale;
uniform vec2 mnsgGenOffset;
uniform float mnsgGenLinear;
uniform float mnsgGenCamera;
uniform vec3 mnsgGenX;
uniform vec3 mnsgGenY;
vec3 mnsgSafeAxis(vec3 axis) {
  float magnitude = dot(axis, axis);
  return magnitude > 0.0 ? axis * inversesqrt(magnitude) : vec3(0.0);
}
vec3 mnsgCameraAxis(vec3 axis) {
  vec3 bytes = min(axis * 128.0, vec3(127.0));
  bytes = sign(bytes) * floor(abs(bytes));
  return mnsgSafeAxis(bytes);
}
` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <uv_vertex>",
      `
#include <uv_vertex>
#ifdef USE_MAP
  vec3 mnsgWorldX = mnsgGenX;
  vec3 mnsgWorldY = mnsgGenY;
  if (mnsgGenCamera > 0.5) {
    // Extract world camera axes BEFORE native signed-byte quantization.
    mnsgWorldX = mnsgCameraAxis(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
    mnsgWorldY = mnsgCameraAxis(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]));
  }
  vec3 mnsgLocalX = mnsgSafeAxis((vec4(mnsgWorldX, 0.0) * modelMatrix).xyz);
  vec3 mnsgLocalY = mnsgSafeAxis((vec4(mnsgWorldY, 0.0) * modelMatrix).xyz);
  vec2 mnsgDots = clamp(vec2(dot(normal, mnsgLocalX), dot(normal, mnsgLocalY)), -1.0, 1.0);
  vec2 mnsgGenerated = mnsgGenLinear > 0.5
    ? acos(-mnsgDots) * (1024.0 / 3.141592653589793)
    : (mnsgDots + 1.0) * 512.0;
  vMapUv = (mapTransform * vec3(mnsgGenerated * mnsgGenScale + mnsgGenOffset, 1.0)).xy;
#endif
`,
    );
  };
}

export function decodeTexturePixels(source: GeometryTexture): Uint8Array {
  if (
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width < 1 ||
    source.height < 1 ||
    source.width > 4096 ||
    source.height > 4096 ||
    source.width * source.height > 262144
  )
    throw new Error(
      "Decoded ROM texture dimensions exceed the supported pixel budget.",
    );
  if (
    typeof source.rgbaBase64 !== "string" ||
    source.rgbaBase64.length !==
      Math.ceil((source.width * source.height * 4) / 3) * 4
  )
    throw new Error(
      "Decoded ROM texture does not contain its expected RGBA pixels.",
    );
  const raw = atob(source.rgbaBase64);
  if (raw.length !== source.width * source.height * 4)
    throw new Error(
      "Decoded ROM texture does not contain its expected RGBA pixels.",
    );
  return Uint8Array.from(raw, (value) => value.charCodeAt(0));
}

/** Data remains in memory; no image URLs or asset requests are involved. */
export class RoomTexturePool {
  private readonly sources: Map<string, GeometryTexture>;
  private readonly decoded = new Map<
    string,
    { pixels: Uint8Array; alpha: boolean }
  >();
  private readonly textures = new Map<string, THREE.DataTexture>();
  constructor(sources: GeometryTexture[] = []) {
    this.sources = new Map(sources.map((source) => [source.id, source]));
  }
  get(
    textureId: string,
    sampler: Pick<NativeMaterial, "wrapS" | "wrapT" | "filter">,
    colorSpace:
      | typeof THREE.SRGBColorSpace
      | typeof THREE.NoColorSpace = THREE.SRGBColorSpace,
  ): { texture: THREE.DataTexture; alpha: boolean } {
    const source = this.sources.get(textureId);
    if (!source)
      throw new Error(
        "A surface references a ROM texture that was not decoded.",
      );
    let decoded = this.decoded.get(textureId);
    if (!decoded) {
      const pixels = decodeTexturePixels(source);
      const alpha = pixels.some(
        (value, index) => index % 4 === 3 && value !== 255,
      );
      decoded = { pixels, alpha };
      this.decoded.set(textureId, decoded);
    }
    const key = `${textureId}:${sampler.wrapS}:${sampler.wrapT}:${sampler.filter}:${colorSpace}`;
    let texture = this.textures.get(key);
    if (!texture) {
      texture = new THREE.DataTexture(
        decoded.pixels,
        source.width,
        source.height,
        THREE.RGBAFormat,
        THREE.UnsignedByteType,
      );
      // The parser emits ROM row zero first and normalized +T downward. With an
      // unflipped DataTexture, UV v=0 addresses that row without a second inversion.
      texture.flipY = false;
      texture.wrapS = wrapping[sampler.wrapS];
      texture.wrapT = wrapping[sampler.wrapT];
      texture.magFilter = texture.minFilter =
        sampler.filter === "linear" ? THREE.LinearFilter : THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.premultiplyAlpha = false;
      texture.colorSpace = colorSpace;
      texture.needsUpdate = true;
      this.textures.set(key, texture);
    }
    return { texture, alpha: decoded.alpha };
  }
  get size(): number {
    return this.textures.size;
  }
  dispose(): void {
    this.textures.forEach((texture) => texture.dispose());
    this.textures.clear();
    this.decoded.clear();
  }
}

function validSampler(
  state: Pick<NativeMaterial, "wrapS" | "wrapT" | "filter">,
): boolean {
  return (
    Object.hasOwn(wrapping, state.wrapS) &&
    Object.hasOwn(wrapping, state.wrapT) &&
    (state.filter === "nearest" || state.filter === "linear")
  );
}

/** This closed rule has two static UV sets; generated-coordinate rules remain separate. */
export function hasNativeDualTextureCoordinates(data: GeometryMesh): boolean {
  const state = data.material,
    dual = state?.dualTexture;
  return Boolean(
    dual &&
      state &&
      !state.texgen &&
      state.textureId &&
      dual.textureId &&
      dual.mode === "multiply-shade-primitive-alpha" &&
      dual.opaqueFirstCycle === true &&
      validSampler(state) &&
      validSampler(dual) &&
      data.positions.length > 0 &&
      finiteTuple(data.uvs, (data.positions.length / 3) * 2) &&
      finiteTuple(data.secondaryUvs, (data.positions.length / 3) * 2) &&
      Number.isFinite(state.opacity) &&
      state.opacity >= 0 &&
      state.opacity <= 1 &&
      state.alphaTest === 0 &&
      (!(state.vertexColors && !state.lighting) ||
        (finiteTuple(
          data.colors,
          (data.positions.length / 3) * (data.colorItemSize ?? 3),
        ) &&
          data.colors!.every((value) => value >= 0 && value <= 1))),
  );
}

/** Keep encoded shade interpolation separate from the existing linear color attribute. */
export function bindNativeDualAttributes(
  geometry: THREE.BufferGeometry,
  data: GeometryMesh,
): void {
  if (!data.material?.dualTexture || !hasNativeDualTextureCoordinates(data))
    return;
  geometry.setAttribute(
    "mnsgSecondaryUv",
    new THREE.Float32BufferAttribute(data.secondaryUvs!, 2),
  );
  const shade = new Float32Array(data.positions.length).fill(1);
  if (data.material.vertexColors && !data.material.lighting) {
    const stride = data.colorItemSize ?? 3;
    for (let vertex = 0; vertex < data.positions.length / 3; vertex++)
      shade.set(
        data.colors!.slice(vertex * stride, vertex * stride + 3),
        vertex * 3,
      );
  }
  geometry.setAttribute(
    "mnsgEncodedShade",
    new THREE.BufferAttribute(shade, 3),
  );
}

function installNativeDualTexture(
  material: THREE.MeshBasicMaterial,
  secondary: THREE.DataTexture,
): void {
  material.customProgramCacheKey = () => "mnsg-native-encoded-dual-v1";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.mnsgSecondaryMap = { value: secondary };
    shader.vertexShader =
      `attribute vec2 mnsgSecondaryUv;
attribute vec3 mnsgEncodedShade;
varying vec2 mnsgVSecondaryUv;
varying vec3 mnsgVEncodedShade;
` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <uv_vertex>",
      `#include <uv_vertex>
mnsgVSecondaryUv = mnsgSecondaryUv;
mnsgVEncodedShade = mnsgEncodedShade;`,
    );
    shader.fragmentShader =
      `uniform sampler2D mnsgSecondaryMap;
varying vec2 mnsgVSecondaryUv;
varying vec3 mnsgVEncodedShade;
` + shader.fragmentShader;
    // Both maps are NoColorSpace: filtering happens on the original encoded bytes.
    // First-cycle alpha is proven opaque; final alpha is solely primitive opacity.
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `
vec3 mnsgEncoded = texture2D(map, vMapUv).rgb * texture2D(mnsgSecondaryMap, mnsgVSecondaryUv).rgb * mnsgVEncodedShade;
diffuseColor.rgb = sRGBTransferEOTF(vec4(mnsgEncoded, 1.0)).rgb;
`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      "",
    );
  };
}

export function roomTextureCoverage(room: RoomData | ProjectRoomScene): {
  textured: number;
  total: number;
  images: number;
} {
  const ids = new Set(room.textures?.map((texture) => texture.id));
  const pool = new RoomTexturePool(room.textures);
  let textured = 0,
    total = 0;
  for (const mesh of room.meshes) {
    const triangles = mesh.indices.length / 3;
    total += triangles;
    if (mesh.material?.dualTexture) {
      const result = createNativeSurfaceMaterial(mesh, pool);
      if (result.textured) textured += triangles;
      result.material.dispose();
    } else if (
      mesh.material?.textureId &&
      ids.has(mesh.material.textureId) &&
      hasNativeTextureCoordinates(mesh)
    )
      textured += triangles;
  }
  pool.dispose();
  return { textured, total, images: ids.size };
}

/** Preserve display-space native bytes through Three's linear working space.
 * Texture/shade multiplication still approximates the N64 byte-space combiner.
 */
export function linearNativeColors(
  colors: number[],
  stride: 3 | 4 = 3,
): Float32Array {
  const output = new Float32Array(colors.length);
  const color = new THREE.Color();
  for (let offset = 0; offset < colors.length; offset += stride) {
    color.setRGB(
      colors[offset],
      colors[offset + 1],
      colors[offset + 2],
      THREE.SRGBColorSpace,
    );
    output[offset] = color.r;
    output[offset + 1] = color.g;
    output[offset + 2] = color.b;
    if (stride === 4) output[offset + 3] = colors[offset + 3];
  }
  return output;
}

export function createNativeSurfaceMaterial(
  data: GeometryMesh,
  pool: RoomTexturePool,
): { material: THREE.MeshBasicMaterial; textured: boolean; warning?: string } {
  const state = data.material;
  const colors = Boolean(
    ((state?.vertexColors && !state.lighting) || data.colorItemSize === 4) &&
      data.colors?.length ===
        (data.positions.length / 3) * (data.colorItemSize ?? 3),
  );
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color().setRGB(
      ...(state?.color ?? [1, 1, 1]),
      THREE.SRGBColorSpace,
    ),
    side: THREE.DoubleSide,
    vertexColors: colors,
    opacity: state?.opacity ?? 1,
    alphaTest: state?.alphaTest ?? 0,
    toneMapped: false,
  });
  let textured = false,
    alpha = Boolean(
      colors &&
        data.colorItemSize === 4 &&
        data.colors?.some((value, index) => index % 4 === 3 && value < 1),
    );
  let warning: string | undefined;
  if (state?.dualTexture) {
    try {
      if (!hasNativeDualTextureCoordinates(data))
        throw new Error(
          "A two-texture surface has incomplete verified sampler, coordinate or alpha state and is shown in solid color.",
        );
      const first = pool.get(state.textureId!, state, THREE.NoColorSpace);
      const second = pool.get(
        state.dualTexture.textureId,
        state.dualTexture,
        THREE.NoColorSpace,
      );
      if (first.alpha || second.alpha)
        throw new Error(
          "A two-texture surface does not prove opaque first-cycle alpha and is shown in solid color.",
        );
      material.map = first.texture;
      material.color.setRGB(1, 1, 1);
      material.vertexColors = false;
      material.alphaTest = 0;
      alpha = false;
      installNativeDualTexture(material, second.texture);
      textured = true;
      if (state.lighting)
        warning =
          "Two ROM textures are displayed with an initial white shade approximation; native lighting and three-point filtering are not reproduced.";
    } catch (error) {
      warning =
        error instanceof Error
          ? error.message
          : "A two-texture surface could not be displayed.";
    }
  } else if (state?.textureId && hasNativeTextureCoordinates(data)) {
    try {
      const decoded = pool.get(state.textureId, state);
      material.map = decoded.texture;
      alpha ||= decoded.alpha;
      textured = true;
      if (state.texgen) installNativeTexgen(material, state.texgen);
    } catch (error) {
      warning =
        error instanceof Error
          ? error.message
          : "A ROM texture could not be displayed.";
    }
  }
  if (
    !state?.dualTexture &&
    state?.textureId &&
    !hasNativeTextureCoordinates(data)
  )
    warning = state.texgen
      ? "A generated-texture surface has no complete verified native normals or coordinate state and is shown in solid color."
      : "A textured surface has no verified UV coordinates and is shown in solid color.";
  material.transparent =
    material.opacity < 1 || (alpha && material.alphaTest === 0);
  material.depthWrite = !material.transparent;
  material.forceSinglePass = true;
  return { material, textured, warning };
}
