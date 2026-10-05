import { modExportFiles } from "./mod-settings";
import type { ActorData, ActorOverride, EditorProject, RoomData, Vec3 } from "../../shared/types";
import { geometryOperation, geometrySource, validateGeometryWrites } from "./geometry";
import type { ExportGeometryOperation, GetGeometryTranslation } from "./geometry";
import {compileAuthoredRoom,resolveAuthoredDoorDestinations,type CompiledAuthoredRoom,type GetAuthoringExportContext} from "./authoring";

import {authoringDataSource,authoringMapperSource,authoringAdmissionSource,authoringGeometryRuntimeSource,authoringSkySource,authoringDoorSource,authoringAddressModeSource} from "./authoring-runtime";

export interface PatchExport { files: Record<string, string>; warnings: string[]; modId: string; binaryFiles: Record<string, Uint8Array>; nativeLibraryFiles: Record<string, Uint8Array> }
function uint(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`${label} must be an integer from 0 to ${max}.`);
  return value;
}
function vector(value: Vec3, label: string): number[] {
  return ["x", "y", "z"].map(axis => {
    const number = value[axis as keyof Vec3];
    if (!Number.isSafeInteger(number) || number < -32768 || number > 32767) throw new Error(`${label}.${axis} must fit a signed 16-bit integer.`);
    return number;
  });
}
function bytes(hex: string, length: number, label: string): DataView {
  if (typeof hex !== "string" || !new RegExp(`^[0-9a-fA-F]{${length * 2}}$`).test(hex)) throw new Error(`${label} has no verified ${length}-byte preimage.`);
  return new DataView(Uint8Array.from(hex.match(/../g)!, pair => parseInt(pair, 16)).buffer);
}
function hex(value: number): string { return `0x${value.toString(16).padStart(8, "0")}u`; }
interface RecordPatch { room: number; file: number; direct: number; address: number; romOffset: number; definition: number; original: number[]; edited: number[]; originalDefinition: number[]; editedDefinition: number[]; definitionChanged: boolean }

function actorPatch(room: number, actor: ActorData, override: ActorOverride): RecordPatch | undefined {
  if (Object.keys(override).some(key => !["actorId", "position", "rotation", "parameters"].includes(key))) throw new Error(`Actor ${actor.id} contains an unsupported edit.`);
  if (!Object.keys(override).length) return undefined;
  if (!actor.editable) throw new Error(`Actor ${actor.id} is read-only because its native source was not verified.`);
  const source = bytes(actor.source.expectedHex, 20, `Actor ${actor.id}`);
  const original = Array.from({ length: 6 }, (_, index) => source.getInt16(index * 2));
  const edited = [...(override.position ? vector(override.position, "position") : original.slice(0, 3)), ...(override.rotation ? vector(override.rotation, "rotation") : original.slice(3, 6))];
  if (actor.sourceKind === "partition" && edited.slice(0, 3).some((value, index) => value !== original[index])) {
    const partition = actor.partition;
    if (!partition) throw new Error("Partition actor positions need verified proximity cells before they can be edited.");
    for (const [index, axis] of ["x", "y", "z"].entries()) {
      const key = axis as keyof Vec3;
      const width = partition.cellSize[key], count = partition.cellCount[key], origin = partition.origin[key];
      if (!Number.isFinite(origin) || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(count) || count < 1) throw new Error("Invalid native proximity cell configuration.");
      // Native sub.S/div.S/add.S/trunc.w.S round at each arithmetic step.
      const cell = Math.trunc(Math.fround(Math.fround(Math.fround(edited[index] - origin) / width) + Math.fround(count / 2)));
      if (cell !== partition.originalCell[key]) throw new Error("Partition actor moves must stay within their original proximity cells; native grid migration is not yet supported.");
    }
  }
  const originalDefinition = actor.definitionSource ? Array.from({ length: 4 }, (_, index) => bytes(actor.definitionSource!.expectedHex, 16, "Actor definition").getUint32(index * 4)) : [0, 0, 0, 0];
  const editedDefinition = [...originalDefinition];
  if (override.actorId !== undefined) editedDefinition[0] = uint(override.actorId, 65535, "actorId") * 65536 + (originalDefinition[0] & 65535);
  if (override.parameters !== undefined) {
    if (!Array.isArray(override.parameters) || override.parameters.length !== 3) throw new Error("Actor parameters must contain exactly three unsigned 32-bit data words.");
    override.parameters.forEach((value, index) => { editedDefinition[index + 1] = uint(value, 0xffffffff, `parameters[${index}]`); });
  }
  const definitionChanged = editedDefinition.some((value, index) => value !== originalDefinition[index]);
  if (definitionChanged && !actor.definitionSource) throw new Error(`Actor ${actor.id} has no verified definition source.`);
  if (!definitionChanged && edited.every((value, index) => value === original[index])) return undefined;
  const address = uint(actor.source.segmentedAddress!, 0xffffffff, "Source address");
  if (!address || address % 4) throw new Error("Actor source must have a nonzero aligned native address.");
  const direct = actor.sourceKind === "resident" ? 1 : 0;
  if (direct && address < 0x80000000) throw new Error("Resident actor sources must be direct native RAM pointers.");
  if (!direct && (address >= 0x80000000 || address < 0x01000000)) throw new Error("Wave actor sources must preserve their native segmented pointer.");
  const file = uint(actor.source.fileId!, 65535, "Actor source file");
  if (!direct && file === 0) throw new Error("Wave actor source requires a nonzero resource file.");
  const definition = source.getUint32(12);
  if (!definition) throw new Error("Cannot edit a native list terminator.");
  if (actor.definitionSource && actor.definitionSource.segmentedAddress !== definition) throw new Error("Actor definition preimage does not match its instance pointer.");
  return { room, file, direct, address, romOffset: actor.source.romOffset, definition, original, edited, originalDefinition, editedDefinition, definitionChanged };
}

export async function generatePatch(project: EditorProject, loadRoom: (id: number) => RoomData | Promise<RoomData>, getTranslation?: GetGeometryTranslation,getAuthoringContext?:GetAuthoringExportContext): Promise<PatchExport> {
  if (project.format !== "mnsg-level-project" || ![1,2].includes(project.version) || project.rom?.region !== "US" || !/^[0-9a-f]{64}$/i.test(project.rom.normalizedSha256)) throw new Error("Export requires a valid US-ROM project with its normalized ROM fingerprint.");
  if (typeof project.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(project.id)) throw new Error("Project id must contain only letters, digits, underscores and hyphens.");
  if (typeof project.name !== "string" || project.name.length < 1 || project.name.length > 200) throw new Error("Project name must contain 1 to 200 characters.");
  const authored: CompiledAuthoredRoom[] = [];
  if(project.version===2&&Object.keys(project.authoredRooms).length){
    if(!getAuthoringContext)throw new Error("Authored room export requires the trusted canonical ROM authoring backend.");
    const context=await getAuthoringContext();
    for(const [key,room] of Object.entries(project.authoredRooms)){
      if(key!==String(room.id)||project.roomOverrides[key])throw new Error("Authored room IDs must be canonical and cannot also contain sparse overrides.");
      authored.push(compileAuthoredRoom(room,context));
    }
    resolveAuthoredDoorDestinations(authored, context);
  }
  const records: RecordPatch[] = [];
  const geometryOperations: ExportGeometryOperation[] = [];
  const seen = new Set<string>();
  for (const [roomKey, edits] of Object.entries(project.roomOverrides)) {
    if (!/^\d+$/.test(roomKey)) throw new Error("Room override key must be a native numeric room id.");
    const roomId = uint(Number(roomKey), 799, "Room id");
    const room = await loadRoom(roomId);
    if (room.id !== roomId) throw new Error("The loaded room does not match its override.");
    if (edits.geometry !== undefined) {
      if (!getTranslation) throw new Error("Geometry export requires the trusted native ROM translation backend.");
      const translation = ["x", "y", "z"].map(axis => {
        const value = edits.geometry!.translation[axis as keyof Vec3];
        if (!Number.isSafeInteger(value) || value < -65535 || value > 65535) throw new Error("Geometry translation must contain integer deltas in -65535..65535; resulting native coordinates must remain in range.");
        return value;
      });
      if (translation.some(value => value !== 0)) {
        const operation = geometryOperation(await getTranslation(roomId, { x: translation[0], y: translation[1], z: translation[2] }), roomId);
        if (!operation.spans.length) throw new Error("Geometry translation has no verified native sources.");
        if (operation.spans.some(span => span.original.some((value, index) => value !== span.replacement[index]))) geometryOperations.push(operation);
      }
    }
    if (Object.values(edits.events).some(edit => Object.keys(edit).length)) throw new Error("Event data export is unavailable until its editable native format and lifecycle are verified.");
    for (const [actorId, override] of Object.entries(edits.actors)) {
      const actor = room.actors.find(value => value.id === actorId);
      if (!actor) throw new Error(`Actor ${actorId} no longer exists in room ${roomId}.`);
      if (override.actorId !== undefined && !room.actors.some(value => value.actorId === override.actorId)) throw new Error(`Actor ID ${override.actorId} is not present in room ${roomId}'s original roster. Adding new actor resource dependencies is not supported.`);
      const record = actorPatch(roomId, actor, override);
      if (!record) continue;
      const key = `${record.room}:${record.file}:${record.address}`;
      if (seen.has(key)) throw new Error("Several overrides target the same native actor source. Remove the duplicate edit.");
      seen.add(key); records.push(record);
    }
  }
  validateGeometryWrites(geometryOperations);
  const actorSourceBytes = new Set<number>();
  for (const record of records) for (let index = 0; index < (record.definitionChanged ? 16 : 12); index++) actorSourceBytes.add(record.romOffset + index);
  for (const operation of geometryOperations) {
    for (const span of operation.spans) for (let index = 0; index < span.original.length; index++) if (actorSourceBytes.has(span.romOffset + index)) throw new Error("Geometry writes overlap edited actor sources. Independent native record types must not share patch bytes.");
    for (const guard of operation.guards) for (let index = 0; index < guard.expected.length; index++) if (actorSourceBytes.has(guard.romOffset + index)) throw new Error("Edited actor sources overlap read-only geometry dependency guards.");
  }
  if (!records.length && !geometryOperations.length && !authored.length) throw new Error("The project has no supported changes to export.");
  if (records.length > 8192) throw new Error("Export exceeds the supported actor edit limit.");
  const nativePayloadEstimate = authored.reduce((sum,room)=>sum+room.nativePayloadBytes,0) + records.length * 80 +
    geometryOperations.reduce((sum,operation)=>sum + 16 + operation.spans.reduce((n,span)=>n+16+span.original.length*2,0) + operation.guards.reduce((n,guard)=>n+16+guard.expected.length,0),0) + 4096;
  if (nativePayloadEstimate > 48 * 1024 * 1024)
    throw new Error("Project exceeds the aggregate 48 MiB native data allocation budget, reserving 16 MiB for code/alignment in the 64 MiB mod linker region. Proximity grid pointer arrays count even though they emit into BSS. Split the rooms across mods or reduce grid extents.");
  const mod = modExportFiles({...project,mod:project.version===2?project.mod:undefined},true), modId = mod.modId;
  const warnings = [...mod.warnings,"Generated patches have been checked against the native loader; verify the exported mod in Goemon64Recomp before distributing it.", "Native event data remains read-only. Sparse actor edits retain existing proximity membership; authored rooms rebuild their own proximity grid."];
  if (geometryOperations.length) {
    warnings.push("Room translation moves static visual geometry and collision only. Actor placements, player entrances, cameras and transitions require separate edits.");
    warnings.push("Geometry edits persist in their loaded resources until unload. Shared geometry sources affect every room using those sources.");
    warnings.push("Geometry assumes the canonical native room roots and resource tables. Mods that rebind these roots or change resource allocations are incompatible and are not detected by record preimages.");
    for (const operation of geometryOperations) {
      const shared = operation.affectedRoomIds.filter(id => id !== operation.roomId);
      if (shared.length) warnings.push(`Room ${operation.roomId} translation also affects shared room sources: ${shared.join(", ")}.`);
    }
  }
  if (records.some(record => (record.editedDefinition[0] >>> 16) !== (record.originalDefinition[0] >>> 16))) warnings.push("Actor substitutions are restricted to the room's original roster. Actor-specific parameter interpretation can differ; verify the new behavior in game.");
  if (records.some(record => record.editedDefinition.slice(1).some((value, index) => value !== record.originalDefinition[index + 1]))) warnings.push("Actor payload words are opaque native data. Some actors interpret them as pointers or resource IDs; verify the edited actor in game.");
  for (const room of authored) warnings.push(...room.warnings.map(warning => `Room ${room.room.id}: ${warning}`));
  const rows = records.map(record => `    { ${record.room}u, ${record.file}u, ${record.direct}u, ${hex(record.address)}, ${hex(record.definition)}, { ${record.original.join(", ")} }, { ${record.edited.join(", ")} }, { ${record.originalDefinition.map(hex).join(", ")} }, { ${record.editedDefinition.map(hex).join(", ")} }, ${record.definitionChanged ? 1 : 0}u }`).join(",\n");
  const header = `/* Generated by MNSG Level Editor. Native pointers and list counts remain intact. */\n#ifndef MNSG_LEVEL_PATCH_H\n#define MNSG_LEVEL_PATCH_H\n${records.length ? "void mnsg_level_apply_room_edits(void);\n" : ""}${geometryOperations.length ? "void mnsg_level_apply_geometry_edits(void);\n" : ""}#endif\n`;
  let source = `/* Generated from project ${project.id}. Normalized US ROM SHA256: ${project.rom.normalizedSha256}. */
#include "modding.h"
#include "mnsg_level_patch.h"
typedef unsigned int u32;
typedef unsigned short u16;
typedef signed short s16;
extern u16 D_800C7AB2;
extern void *D_80231300_5EC7D0[];
extern signed int func_800141C4_14DC4(unsigned int file_id);
extern signed int func_80014840_15440(signed int pointer, unsigned int file_id);
` + (records.length ? `
typedef struct {
    u16 room, file, direct;
    u32 address, definition;
    s16 original[6], edited[6];
    u32 original_definition[4], edited_definition[4];
    u32 definition_changed;
} RoomEdit;
static RoomEdit edits[] = {
${rows}
};
#define EDIT_COUNT (sizeof(edits) / sizeof(edits[0]))
static unsigned char *resolve(RoomEdit *edit) {
    if (edit->direct) return (unsigned char *)edit->address;
    if (func_800141C4_14DC4(edit->file) == -1) return 0;
    return (unsigned char *)func_80014840_15440((signed int)edit->address, edit->file);
}
static int transform_matches(s16 *instance, s16 *expected) {
    unsigned int i;
    for (i = 0; i < 6; ++i) if (instance[i] != expected[i]) return 0;
    return 1;
}
static void write_transform(s16 *instance, s16 *values) {
    unsigned int i;
    for (i = 0; i < 6; ++i) instance[i] = values[i];
}
/* Entry precedes resident/normal spawning; absent waves retry on a later pass.
 * Reset our own previous edits first, so shared wave resources do not carry
 * a room-specific transform or definition into another room.
 * Native source +0x10..13 flags, terminators and partition memberships survive.
 */
RECOMP_HOOK("func_8020D848_5C8D18")
void mnsg_level_apply_room_edits(void) {
    unsigned int i, j;
    u16 room = D_800C7AB2;
    if (room >= 800u || !D_80231300_5EC7D0[room]) return;
    for (i = 0; i < EDIT_COUNT; ++i) {
        RoomEdit *edit = &edits[i];
        unsigned char *instance = resolve(edit);
        u32 *definition_slot;
        if (!instance || !transform_matches((s16 *)instance, edit->edited)) continue;
        definition_slot = (u32 *)(instance + 12);
        if (*definition_slot != (edit->definition_changed ? (u32)edit->edited_definition : edit->definition)) continue;
        write_transform((s16 *)instance, edit->original);
        if (edit->definition_changed) *definition_slot = edit->definition;
    }
    for (i = 0; i < EDIT_COUNT; ++i) {
        RoomEdit *edit = &edits[i];
        unsigned char *instance;
        u32 *definition_slot;
        u32 *definition;
        if (edit->room != room) continue;
        instance = resolve(edit);
        if (!instance || !transform_matches((s16 *)instance, edit->original)) continue;
        definition_slot = (u32 *)(instance + 12);
        if (*definition_slot != edit->definition) continue;
        if (edit->definition_changed) {
            definition = edit->direct ? (u32 *)edit->definition : (u32 *)func_80014840_15440((signed int)edit->definition, edit->file);
            if (!definition) continue;
            for (j = 0; j < 4; ++j) if (definition[j] != edit->original_definition[j]) break;
            if (j != 4) continue;
            /* Mod-owned negative RAM pointers pass the native resolver unchanged.
             * This isolates edits when other placements share the definition. */
            *definition_slot = (u32)edit->edited_definition;
        }
        write_transform((s16 *)instance, edit->edited);
    }
}
` : "") + geometrySource(geometryOperations);
  if (authored.length) source += authoringDataSource(authored) + authoringMapperSource() + authoringAdmissionSource(authored) + authoringGeometryRuntimeSource() + authoringSkySource() + authoringDoorSource() + authoringAddressModeSource();
  if (Buffer.byteLength(source, "utf8") > 32 * 1024 * 1024) throw new Error("Generated source exceeds the 32 MiB project payload budget. Split the authored rooms across mods.");
  const manifest = mod.toml;
  const linker = `RAMBASE = 0x81000000;\nMEMORY { extram(ARWX) : ORIGIN = RAMBASE, LENGTH = 64M }\nSECTIONS { /DISCARD/ : { *(.got) *(.MIPS.abiflags) *(.reginfo) *(.pdr) *(.comment) } }\n`;
  return { modId, warnings, binaryFiles: mod.binaryFiles, nativeLibraryFiles: mod.nativeLibraryFiles, files: { "mnsg_level_patch.c": source, "mnsg_level_patch.h": header, "mod.toml": manifest, "mod.ld": linker, ...(authored.length ? {"authoring-inventory.json": JSON.stringify({format:"mnsg-authored-export-inventory",version:1,rooms:authored.map(compiled=>({room:compiled.room,skyboxPolicy:compiled.room.skyboxId===undefined?"inherit":compiled.room.skyboxId===null?"none":"selected",nativeSkybox:compiled.skybox,environmentPolicy:{mapHeading:0,voidThreshold:-32768,lightRGB:[255,255,255],effectiveResidentDefinitions:compiled.actors.filter(actor=>actor.spawnPolicy==="resident"&&actor.prototype.actorId===0x8e),donorProvenance:compiled.donor.environmentDefinitions},resourceAllocations:compiled.resourceAllocations,nativePayloadBytes:compiled.nativePayloadBytes,warnings:compiled.warnings})),nativeAllocationBudget:{estimateBytes:nativePayloadEstimate,dataBudgetBytes:48*1024*1024,codeAndAlignmentReserveBytes:16*1024*1024,method:"Conservative estimate of persistent data and BSS, including sparse payloads"},cacheEndPolicy:"0x80594000",failureRecovery:"Restart or disable the mod after an authored resource failure."},null,2)} : {}), "README.txt": `Place mnsg_level_patch.c in the mod's source directory and mnsg_level_patch.h beside it. Include the compatible template modding.h. Compile/link using the MNSGRecompModTemplate flags. The manifest and linker script included here build a standalone mod; do not replace another mod's manifest when integrating the C/H pair.\n\n${warnings.join("\n")}\n` } };
}
