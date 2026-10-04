import { contextBridge, ipcRenderer } from "electron";
import type { ActorOverride, AppApi, EditorProject } from "../shared/types";
const api: AppApi = Object.freeze({
  getStatus: () => ipcRenderer.invoke("mnsg:get-status"),
  importRom: () => ipcRenderer.invoke("mnsg:import-rom"),
  listRooms: () => ipcRenderer.invoke("mnsg:list-rooms"),
  loadRoom: (id: number) => ipcRenderer.invoke("mnsg:load-room", id),
  loadActorVisuals: (id: number, actorOverrides: Record<string, ActorOverride>) => ipcRenderer.invoke("mnsg:load-actor-visuals", id, actorOverrides),
  newProject: (name: string) => ipcRenderer.invoke("mnsg:new-project", name),
  openProject: () => ipcRenderer.invoke("mnsg:open-project"),
  saveProject: (project: EditorProject) => ipcRenderer.invoke("mnsg:save-project", project),
  exportPatch: (project: EditorProject) => ipcRenderer.invoke("mnsg:export-patch", project),
  exportNrm: (project: EditorProject) => ipcRenderer.invoke("mnsg:export-nrm", project),
  configureToolchain: () => ipcRenderer.invoke("mnsg:configure-toolchain"),
  getToolchainStatus: () => ipcRenderer.invoke("mnsg:toolchain-status"),
});
contextBridge.exposeInMainWorld("mnsg", api);
