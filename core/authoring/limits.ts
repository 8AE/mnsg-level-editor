/** Identical encoded budget for IPC, disk reads and atomic saves. */
export const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
export const AUTHORING_LIMITS = Object.freeze({
  rooms: 800,
  meshesPerRoom: 512,
  materialsPerRoom: 512,
  verticesPerRoom: 16384,
  trianglesPerRoom: 32768,
  collisionTrianglesPerRoom: 9362,
  actorsAndDoorsPerRoom: 4096,
  entrancesPerRoom: 256,
  sceneDecodedBytes: 64 * 1024 * 1024,
  texturePixels: 262144,
  newRoomMin: 620,
  newRoomMax: 799,
});

export function assertProjectBytes(input: unknown): void {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(input); } catch { throw new Error("Project must contain acyclic JSON data."); }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_PROJECT_BYTES)
    throw new Error("Project exceeds the 16 MiB encoded limit.");
}
