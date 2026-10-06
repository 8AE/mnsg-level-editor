import type { AuthoringCatalog, GeometryAssetPayload, ProjectRoomScene } from "../shared/types";
import { cloneScene } from "./authoringModel";

/** An editable view is staged independently of project/history until its first edit. */
export function prepareEditableRoom(scene: ProjectRoomScene, catalog: AuthoringCatalog, asset?: GeometryAssetPayload) {
  const authored = cloneScene(scene, catalog, scene.id, scene.name, "replacement", asset);
  const sources = scene.meshes.filter(mesh => mesh.source === "display-list");
  const ids = new Map(authored.meshes.map((mesh, index) => [mesh.id, sources[index].id]));
  authored.meshes = authored.meshes.map(mesh => ({ ...mesh, id: ids.get(mesh.id)! }));
  authored.collision = authored.collision.map(triangle => ({ ...triangle, sourceMeshId: triangle.sourceMeshId ? ids.get(triangle.sourceMeshId) : undefined }));
  // Keep native selection/event aliases stable across first edit, Undo and reload.
  authored.actors = authored.actors.map((actor, index) => ({ ...actor, id: scene.actors[index].id }));
  return { authored, scene: { ...scene, authoredMeshes: authored.meshes } };
}
