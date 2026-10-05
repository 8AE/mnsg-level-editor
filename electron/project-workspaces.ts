import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeConfinedBundle } from "./storage";
import { MOD_LIMITS, type ModAttachment } from "../shared/mod-settings";
import { bundleRelativePath } from "./storage";
import type { EditorProjectV2 } from "../shared/types";
import type { ToolchainConfig, PatchExport } from "../core/export";
import { modExportFiles, defaultSymbolKind } from "../core/export/mod-settings";

export async function projectTemplateFiles(project: EditorProjectV2, tools: ToolchainConfig, generated?: PatchExport): Promise<Record<string, string | Uint8Array>> {
  const mod = modExportFiles(project);
  const files: Record<string, string | Uint8Array> = { "mod.toml": mod.toml, "project.mnsgproj": JSON.stringify(project), "mod.ld": "RAMBASE = 0x81000000;\nMEMORY { extram(ARWX) : ORIGIN = RAMBASE, LENGTH = 64M }\nSECTIONS { /DISCARD/ : { *(.got) *(.MIPS.abiflags) *(.reginfo) *(.pdr) *(.comment) } }\n", "mnsg_level_patch.c": "/* Source is generated from the portable project during export. */\n", "mnsg_level_patch.h": "/* Companion header is generated during export. */\n", "build-status.txt": "Source has not been generated for this project snapshot. Export validates the native data and generates current C/H before compiling.\n" };
  for (const [name, bytes] of Object.entries(mod.binaryFiles)) {
    if (Object.hasOwn(files, name) || name.toLowerCase() === "include/modding.h") throw Error(`Mod attachment ${name} collides with an editor-owned template file.`);
    files[name] = bytes;
  }
  files["include/modding.h"] = await readFile(join(tools.templatePath, "include/modding.h"));
  for (const path of [mod.settings.inputs.func_reference_syms_file, ...mod.settings.inputs.data_reference_syms_files]) {
    if (files[path] !== undefined) continue;
    const kind = defaultSymbolKind(path);
    if (!kind) throw Error(`Project reference symbols ${path} have no uploaded snapshot.`);
    files[path] = await readFile(join(tools.templatePath, kind === "functions" ? "Goemon64RecompSyms/mnsg.us.syms.toml" : "Goemon64RecompSyms/mnsg.us.datasyms.toml"));
  }
  if (generated) {
    if (Object.hasOwn(generated.files, "project.mnsgproj") || Object.hasOwn(generated.files, "build-status.txt")) throw Error("Generated files collide with workspace provenance.");
    Object.assign(files, generated.files, generated.binaryFiles);
    files["build-status.txt"] = "Current C/H was generated and validated from the included project snapshot. Gameplay verification remains the user's responsibility.\n";
  }
  return files;
}

export async function invalidateProjectWorkspace(root: string, projectId: string): Promise<void> {
  const target = join(root, projectWorkspaceKey(projectId));
  try {
    const parent = await lstat(root), info = await lstat(target);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !info.isDirectory() || info.isSymbolicLink()) throw Error("Project workspace is not an owned directory.");
    await writeConfinedBundle(target, { "build-status.txt": "The project snapshot changed. Previously generated C/H is outdated until the template is refreshed or exported again.\n" });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export function iconDimensions(bytes: Uint8Array): { width: number; height: number; format: "png" | "jpeg" | "dds" } {
  const data = Buffer.from(bytes); let width = 0, height = 0; let format: "png" | "jpeg" | "dds";
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && data.readUInt32BE(8) === 13 && data.toString("ascii", 12, 16) === "IHDR") { format = "png"; width = data.readUInt32BE(16); height = data.readUInt32BE(20); }
  else if (data.length >= 128 && data.toString("ascii", 0, 4) === "DDS " && data.readUInt32LE(4) === 124 && data.readUInt32LE(76) === 32) { format = "dds"; width = data.readUInt32LE(16); height = data.readUInt32LE(12); if (data.toString("ascii", 84, 88) === "DX10" && data.length < 148) throw Error("DDS icon has a truncated DX10 header."); }
  else if (data[0] === 0xff && data[1] === 0xd8) {
    format = "jpeg"; let at = 2;
    while (at + 4 <= data.length) {
      if (data[at++] !== 0xff) throw Error("Invalid JPEG icon header.");
      while (at < data.length && data[at] === 0xff) at++;
      const marker = data[at++]; if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (at + 2 > data.length) break;
      const length = data.readUInt16BE(at); if (length < 2 || at + length > data.length) throw Error("Truncated JPEG icon header.");
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) { if (length < 8) throw Error("Truncated JPEG dimensions."); height = data.readUInt16BE(at + 3); width = data.readUInt16BE(at + 5); break; }
      at += length;
    }
  } else throw Error("Choose a PNG, JPEG or DDS icon.");
  if (!width || !height || width * height > MOD_LIMITS.iconPixels) throw Error("Icon dimensions exceed the one-megapixel limit.");
  return { width, height, format };
}
export function modAttachment(name: string, bytes: Uint8Array, mediaType: string): ModAttachment {
  bundleRelativePath(name);
  if (bytes.length > MOD_LIMITS.fileBytes) throw Error("Mod attachment exceeds the four-MiB file limit.");
  return { name, base64: Buffer.from(bytes).toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, mediaType };
}

export function projectWorkspaceKey(projectId: string): string {
  // Match the portable project's historical identity contract. The identity is
  // never a path component: only its fixed-length UTF-8 SHA256 is used on disk.
  if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 128 || /[\u0000-\u001f]/.test(projectId)) throw Error("Invalid project workspace identity.");
  return createHash("sha256").update(projectId).digest("hex");
}
/** The portable project is authoritative; never read workspace content back into it. */
export async function materializeProjectWorkspace(root: string, projectId: string, templateVersion: string, files: Record<string, string | Uint8Array>): Promise<{ path: string; templateVersion: string }> {
  const key = projectWorkspaceKey(projectId);
  await mkdir(root, { recursive: true });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw Error("Project workspace root is not an owned directory.");
  const target = join(root, key), staging = join(root, `stage-${key}-${randomUUID()}`), previous = join(root, `old-${key}-${randomUUID()}`);
  let replaced = false;
  try {
    await mkdir(staging);
    await writeConfinedBundle(staging, files);
    try {
      const info = await lstat(target);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Project workspace was replaced by an unsafe path.");
      await rename(target, previous); replaced = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { await rename(staging, target); }
    catch (error) { if (replaced) await rename(previous, target); throw error; }
    if (replaced) await rm(previous, { recursive: true, force: true });
    return { path: target, templateVersion };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
