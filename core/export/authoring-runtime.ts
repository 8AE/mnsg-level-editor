import type { CompiledAuthoredRoom } from "./authoring";
import { nativeActorPlacementMatrix } from "../rom/actors-pose";
const word = (value: number) => `0x${(value >>> 0).toString(16).padStart(8, "0")}u`;
function byteArray(name: string, bytes: Uint8Array): string {
    const rows = Array.from({ length: Math.ceil(bytes.length / 24) }, (_, index) => `    ${[...bytes.slice(index * 24, index * 24 + 24)].map(value => `0x${value.toString(16).padStart(2, "0")}`).join(", ")}`);
    return `static unsigned char ${name}[] __attribute__((aligned(16), used)) = {\n${rows.length ? rows.join(",\n") : "    0"}\n};\n`;
}
function nativeFloat(value: number): string {
    if (!Number.isFinite(value))
        throw new Error("Nonfinite authored native float.");
    return `${Math.fround(value).toExponential(9)}f`;
}
/** Data remains alive in the mod allocation throughout native teardown/revisit. */
export function authoringDataSource(rooms: readonly CompiledAuthoredRoom[]): string {
    const declarations = rooms.map((compiled, index) => {
        const base = `authored_${index}`;
        const vertices = byteArray(`${base}_vertices`, compiled.geometry.vertices);
        const geometryRelocations = new Map(compiled.geometry.relocations.map(relocation => [relocation.offset, relocation.addend]));
        const view = new DataView(compiled.geometry.displayList.buffer);
        const commands: string[] = [];
        for (let offset = 0; offset < compiled.geometry.displayList.length; offset += 8) {
            const addend = geometryRelocations.get(offset + 4);
            commands.push(`    { ${word(view.getUint32(offset))}, ${addend === undefined ? word(view.getUint32(offset + 4)) : `(u32)(${base}_vertices + ${addend}u)`} }`);
        }
        const pointers = compiled.materialRelocations.map(relocation => `    { ${relocation.offset >>> 3}u, ${relocation.fileId}u, ${word(relocation.segmentedAddress)} }`);
        const definitions = compiled.actors.map(actor => `    { ${word(actor.prototype.actorId * 65536 + actor.prototype.unknownHalfword)}, ${actor.prototype.parameters.map(word).join(", ")} }`);
        const instance = (actorIndex: number) => {
            const actor = compiled.actors[actorIndex];
            return `    { { ${[actor.position.x, actor.position.y, actor.position.z, actor.rotation.x, actor.rotation.y, actor.rotation.z].join(", ")} }, (u32)${base}_definitions[${actorIndex}], ${word(actor.spawnPolicy === "proximity" ? actor.prototype.placementWord & 0x00ffffff : actor.prototype.placementWord)} }`;
        };
        const instances = compiled.actors.flatMap((actor, actorIndex) => actor.spawnPolicy === "resident" ? [instance(actorIndex)] : []);
        const partitionDeclarations = [...(compiled.proximity?.cells ?? [])].map(([cell, indices]) => `static AuthoredInstance ${base}_cell_${cell}[] = {\n${indices.map(instance).join(",\n")},\n    { {0,0,0,0,0,0}, 0, 0 }\n};\n`).join("");
        const grid = compiled.proximity ? byteArray(`${base}_config`, compiled.proximity.configuration) + partitionDeclarations +
            `static AuthoredInstance *${base}_grid[${compiled.proximity.cellCount}];\n` : "";
        const doorData = compiled.doors.map((door, doorIndex) => {
            if (!door.arrival)
                throw new Error("Resolve every custom door's destination before generating native data.");
            const name = `${base}_door_${doorIndex}`;
            const vertexRelocations = new Map(door.geometry.relocations.map(relocation => [relocation.offset, relocation.addend]));
            const data = new DataView(door.geometry.displayList.buffer);
            const rows: string[] = [];
            for (let offset = 0; offset < data.byteLength; offset += 8) {
                const addend = vertexRelocations.get(offset + 4);
                const pointer = addend !== undefined ? `(u32)(${name}_vertices + ${addend}u)` :
                    door.textureCommand === offset / 8 ? `(u32)${name}_texture` : word(data.getUint32(offset + 4));
                rows.push(`    { ${word(data.getUint32(offset))}, ${pointer} }`);
            }
            const pointers = door.materialRelocations.map(relocation => `    { ${relocation.offset >>> 3}u, ${relocation.fileId}u, ${word(relocation.segmentedAddress)} }`);
            return byteArray(`${name}_vertices`, door.geometry.vertices) +
                (door.texture ? byteArray(`${name}_texture`, door.texture) : "") +
                `static AuthoredCommand ${name}_model[] __attribute__((aligned(16))) = {\n${rows.join(",\n")}\n};\n` +
                `static AuthoredMaterialPointer ${name}_pointers[] = {\n${pointers.length ? pointers.join(",\n") : "    { 0, 0, 0 }"}\n};\n`;
        }).join("\n");
        const doorRows = compiled.doors.map((door, doorIndex) => {
            const name = `${base}_door_${doorIndex}`, arrival = door.arrival!;
            const matrix = nativeActorPlacementMatrix({ x: 0, y: 0, z: 0 }, door.door.rotation);
            const inverse = [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9], matrix[10]];
            const center = [door.door.position.x, door.door.position.y, door.door.position.z].map((value, axis) => Math.fround(value + matrix[4 + axis] * door.door.dimensions.y / 2));
            const visualPosition = door.texture ? center : [door.door.position.x, door.door.position.y, door.door.position.z];
            return `    { ${compiled.room.id}u, ${arrival.roomId}u, ${name}_model, ${name}_pointers, ${door.materialRelocations.length}u,\n` +
                `      { ${visualPosition.map(nativeFloat).join(", ")} },\n` +
                `      { ${center.map(nativeFloat).join(", ")} },\n` +
                `      { ${[door.door.rotation.x, door.door.rotation.y, door.door.rotation.z].map(value => value & 1023).join(", ")} },\n` +
                `      { ${[door.scale.x, door.scale.y, door.scale.z].map(nativeFloat).join(", ")} },\n` +
                `      { ${[door.door.dimensions.x, door.door.dimensions.y, door.door.dimensions.z].map(value => nativeFloat(value / 2)).join(", ")} },\n` +
                `      { ${inverse.map(nativeFloat).join(", ")} },\n` +
                `      { ${[arrival.position.x, arrival.position.y, arrival.position.z, arrival.baseYaw, arrival.entryParameter].join(", ")} }, ${door.door.activation === "touch" ? "1" : "0"}u }`;
        });
        return vertices + doorData +
            `static AuthoredDoorRegistry ${base}_doors[] __attribute__((used)) = {\n${doorRows.length ? doorRows.join(",\n") : "    { 0 }"}\n};\n` +
            `static u32 ${base}_definitions[][4] __attribute__((used)) = {\n${definitions.length ? definitions.join(",\n") : "    { 0, 0, 0, 0 }"}\n};\n` + grid +
            `static AuthoredCommand ${base}_model[] __attribute__((aligned(16))) = {\n${commands.join(",\n")}\n};\n` +
            `static AuthoredMaterialPointer ${base}_pointers[] = {\n${pointers.length ? pointers.join(",\n") : "    { 0, 0, 0 }"}\n};\n` +
            byteArray(`${base}_planes`, compiled.collision.planes) + byteArray(`${base}_tree`, compiled.collision.tree) +
            `static AuthoredInstance ${base}_instances[] = {\n${instances.length ? `${instances.join(",\n")},\n` : ""}    { { 0, 0, 0, 0, 0, 0 }, 0, 0 }\n};\n` +
            `static u16 ${base}_resources[] = { ${[...compiled.resources, 0].join(", ")} };\n` +
            `static u32 ${base}_resource_extents[] = { ${[...compiled.resourceAllocations.map(file => file.byteLength), 0].join(", ")} };\n` +
            `static void ${base}_load(void);\n` +
            `static AuthoredMetadata ${base}_metadata = { ${base}_instances, 0, 0, ${compiled.proximity ? `(u32)${base}_grid, (u32)${base}_config` : "0, 0"}, 0, 0, ${base}_load };\n`;
    }).join("\n");
    const gridSetup = rooms.map((compiled, index) => {
        if (!compiled.proximity)
            return "";
        const base = `authored_${index}`;
        const cells = [...compiled.proximity.cells];
        return `static void ${base}_reset_grid(void) {\n    unsigned int i, j;\n    for (i = 0; i < ${compiled.proximity.cellCount}u; ++i) ${base}_grid[i] = authored_empty_instances;\n${cells.map(([cell, indices]) => `    ${base}_grid[${cell}] = ${base}_cell_${cell};\n    for (j = 0; j < ${indices.length}u; ++j) ((unsigned char *)&${base}_cell_${cell}[j])[0x10] = 0;`).join("\n")}\n}\n`;
    }).join("\n");
    const registry = rooms.map((compiled, index) => {
        const base = `authored_${index}`;
        return `    { ${compiled.room.id}u, ${compiled.room.templateRoomId}u, ${compiled.skybox.nativeIndex}u, ${compiled.skybox.fileId}u, ${base}_model, ${base}_pointers, ${compiled.materialRelocations.length}u, ${compiled.collision.planes.length ? `${base}_planes` : "0"}, ${compiled.collision.tree.length ? `${base}_tree` : "0"}, ${base}_instances, ${base}_resources, ${base}_resource_extents, &${base}_metadata, 0u, 0u, ${base}_doors, ${compiled.doors.length}u, 0u, 0u, 0u }`;
    }).join(",\n");
    return `
typedef struct { u32 w0, w1; } AuthoredCommand;
typedef struct { u32 command, file, pointer; } AuthoredMaterialPointer;
typedef struct {
    u16 room, destination;
    AuthoredCommand *model;
    AuthoredMaterialPointer *pointers;
    u32 pointer_count;
    float position[3], volume_center[3];
    s16 rotation[3];
    float scale[3], half_size[3], inverse_rotation[9];
    s16 arrival[5];
    u32 touch;
} AuthoredDoorRegistry;
typedef struct { s16 transform[6]; u32 definition, placement_word; } AuthoredInstance;
typedef struct {
    AuthoredInstance *resident;
    u32 names, normal, partition, partition_config;
    u16 source_wave, reserved;
    void (*load)(void);
} AuthoredMetadata;
typedef struct {
    u16 room, donor, skybox, skybox_file;
    AuthoredCommand *model;
    AuthoredMaterialPointer *pointers;
    u32 pointer_count;
    unsigned char *planes, *tree;
    AuthoredInstance *instances;
    u16 *resources;
    u32 *resource_extents;
    AuthoredMetadata *metadata;
    u32 ready, sky_started;
    AuthoredDoorRegistry *doors;
    u32 door_count, doors_started;
    u32 sky_texture, sky_palette;
} AuthoredRoomRegistry;
static void authored_stage(AuthoredRoomRegistry *room);
static void authored_install(AuthoredRoomRegistry *room);
static void authored_spawn_sky(void *parent, AuthoredRoomRegistry *room);
static void authored_spawn_doors(void *parent, AuthoredRoomRegistry *room);
static AuthoredInstance authored_empty_instances[] __attribute__((used)) = { { {0,0,0,0,0,0}, 0, 0 } };
${declarations}
${gridSetup}
static AuthoredRoomRegistry authored_rooms[] = {
${registry}
};
#define AUTHORED_ROOM_COUNT (sizeof(authored_rooms) / sizeof(authored_rooms[0]))
static AuthoredRoomRegistry *authored_find(u16 room) {
    unsigned int i;
    for (i = 0; i < AUTHORED_ROOM_COUNT; ++i)
        if (authored_rooms[i].room == room) return &authored_rooms[i];
    return 0;
}
${rooms.map((compiled, index) => `static void authored_${index}_load(void) { ${compiled.proximity ? `authored_${index}_reset_grid(); ` : ""}authored_stage(&authored_rooms[${index}]); }`).join("\n")}
`;
}
/** Exact void(void) mapper ABI. The room identity stays untouched. */
export function authoringMapperSource(): string {
    return `
extern unsigned char *D_8015C5C8_15D1C8;
extern u16 D_8005BA10_5C610[];
RECOMP_PATCH void func_8000B3E4_BFE4(void) {
    unsigned char *system = D_8015C5C8_15D1C8;
    AuthoredRoomRegistry *custom;
    u16 room;
    unsigned int i;
    if (!system) return;
    room = *(u16 *)(system + 0x3adf2);
    custom = authored_find(room);
    if (custom) { authored_install(custom); room = custom->donor; }
    system[0x3ade4] = 0;
    *(u16 *)(system + 0x3adf4) = 0;
    /* The original uses the FIRST upper boundary, not a lower/upper search. */
    for (i = 1; i <= 13; ++i) {
        if (room < D_8005BA10_5C610[i]) {
            system[0x3ade4] = (unsigned char)(i - 1);
            *(u16 *)(system + 0x3adf4) = (u16)(room - D_8005BA10_5C610[i - 1]);
            return;
        }
    }
}
RECOMP_PATCH void func_801F8F0C_5B4E1C(void) {
    unsigned char *system = D_8015C5C8_15D1C8;
    AuthoredRoomRegistry *custom;
    u16 room, index;
    unsigned char stage, group;
    if (!system) return;
    room = *(u16 *)(system + 0x3adf2);
    custom = authored_find(room);
    if (custom) room = custom->donor;
    stage = system[0x3ade4];
    group = stage;
    index = *(u16 *)(system + 0x3adf4);
    if (stage == 0 && room > 89) {
        if (room > 127) { group = 5; index = (u16)(index - 128); }
        else { group = 4; index = (u16)(index - 90); }
    }
    system[0x3adf6] = group;
    *(u16 *)(system + 0x3adf8) = index;
}
`;
}
/** Extended mode precedes the OUTER G_DL submission, including direct VTX/TIMG. */
export function authoringAddressModeSource(): string {
    return `
extern u32 *D_8015C5CC_15D1CC;
static unsigned int authored_draw_depth;
static unsigned int authored_draw_overflow;
static unsigned char authored_draw_modes[64];
static unsigned char authored_extended_enabled;
static void authored_address_mode(unsigned int enable) {
    u32 *head = D_8015C5CC_15D1CC;
    if (!head) return;
    /* rt64_extended_gbi.h: G_EX_SETRDRAMEXTENDED_V1=2C, opcode64. */
    head[0] = 0x6400002cu;
    head[1] = enable & 1u;
    D_8015C5CC_15D1CC = head + 2;
}
static void authored_begin_extended_draw(unsigned int custom);
RECOMP_HOOK("func_80016C44_17844")
void mnsg_authored_before_draw(void *object_pointer) {
    unsigned char *object = object_pointer;
    unsigned int i, j, custom = 0;
    if (object) {
        u32 model = *(u32 *)(object + 0x2c) & 0x8ffffffeu;
        for (i = 0; i < AUTHORED_ROOM_COUNT; ++i) {
            if (model == (u32)authored_rooms[i].model) { custom = 1; break; }
            for (j = 0; j < authored_rooms[i].door_count; ++j)
                if (model == (u32)authored_rooms[i].doors[j].model) { custom = 1; break; }
            if (custom) break;
        }
    }
    authored_begin_extended_draw(custom);
}
static void authored_begin_extended_draw(unsigned int custom) {
    if (authored_draw_depth >= 64u) { ++authored_draw_overflow; return; }
    authored_draw_modes[authored_draw_depth++] = authored_extended_enabled;
    if (custom && !authored_extended_enabled) {
        authored_address_mode(1);
        authored_extended_enabled = 1;
    }
}
static void authored_end_extended_draw(void) {
    unsigned char previous;
    if (authored_draw_overflow) { --authored_draw_overflow; return; }
    if (!authored_draw_depth) return;
    previous = authored_draw_modes[--authored_draw_depth];
    if (authored_extended_enabled && !previous) {
        authored_address_mode(0);
        authored_extended_enabled = 0;
    }
}
RECOMP_HOOK_RETURN("func_80016C44_17844")
void mnsg_authored_after_draw(void) { authored_end_extended_draw(); }
RECOMP_HOOK("func_80022A74_23674")
void mnsg_authored_before_background(void *object_pointer) {
    unsigned char *system = D_8015C5C8_15D1C8;
    unsigned char *object = object_pointer;
    AuthoredRoomRegistry *room = system ? authored_find(*(u16 *)(system + 0x3adf2)) : 0;
    unsigned int custom = 0;
    if (room && room->ready && room->skybox && object && room->sky_texture &&
        *(u32 *)(object + 0x38) == room->sky_texture && *(u32 *)(object + 0x3c) == room->sky_palette) custom = 1;
    authored_begin_extended_draw(custom);
}
RECOMP_HOOK_RETURN("func_80022A74_23674")
void mnsg_authored_after_background(void) { authored_end_extended_draw(); }
`;
}
/** Admission happens before metadata dereference and every queued constructor. */
export function authoringAdmissionSource(rooms: readonly CompiledAuthoredRoom[]): string {
    const environmentCases = rooms.map((compiled, index) => {
        const writes = compiled.actors.filter(actor => actor.spawnPolicy === "resident" && actor.prototype.actorId === 0x8e).map(definition => {
            const p = definition.prototype.parameters;
            const signed = (value: number) => (value & 0x8000) ? (value & 65535) - 65536 : value & 65535;
            return `        *(s16 *)(D_8015C54D_15D14D + 1) = ${definition.position.x < 0 ? -1 : definition.position.x};
        D_8015C550 = ${definition.position.y};
        *(s16 *)(D_800C7B00 + 0) = ${signed(p[0] >>> 16)};
        *(s16 *)(D_800C7B00 + 4) = ${signed(p[0])};
        *(s16 *)(D_800C7B00 + 8) = ${signed(p[1] >>> 16)};
        *(s16 *)(D_800C7B00 + 12) = ${signed(p[1])};
        func_801FA3FC_5B630C(${definition.rotation.x & 255}, ${definition.rotation.y & 255}, ${definition.rotation.z & 255});`;
        }).join("\n");
        return `    case ${index}:\n${writes}\n        break;`;
    }).join("\n");
    const arrivalCases = rooms.map((compiled, index) => {
        const entrance = compiled.room.entrances[0];
        // A blank authored room has an explicit origin / ordinary startup policy.
        const fields = entrance ? [entrance.entryParameter, entrance.position.x, entrance.position.y, entrance.position.z, entrance.baseYaw] : [16, 0, 0, 0, 0];
        return `    case ${index}: ${fields.map((value, field) => `saved[${field}] = ${value};`).join(" ")} return;`;
    }).join("\n");
    return `
extern void *D_80231300_5EC7D0[];
extern s16 D_8006B780_6C380[];
extern unsigned char D_8015C80C_15D40C[];
extern unsigned char D_8015C54D_15D14D[];
extern s16 D_8015C550;
extern unsigned char D_800C7B00[];
extern u32 D_80168F60_169B60, D_80168F64_169B64;
extern u32 func_80013B14_14714(s16 file);
extern u32 func_80001DF4_29F4(u32 file);
extern unsigned char D_80167FC0_168BC0[];
extern u32 D_80054ACC_556CC[];
extern signed int func_800141C4_14DC4(unsigned int file);
extern signed int func_80014840_15440(signed int pointer, unsigned int file);
extern void func_801F97D4_5B56E4(void);
extern void func_801FA3FC_5B630C(unsigned char red, unsigned char green, unsigned char blue);
RECOMP_IMPORT("*", int recomp_printf(const char *format, ...));
static unsigned int authored_failed;
static unsigned int authored_failed_room, authored_failed_file;
static void authored_failure_mask(void) {
    if (authored_failed && D_8015C5C8_15D1C8)
        *(u16 *)(D_8015C5C8_15D1C8 + 0x3ae24) = 7;
}
static void authored_fail(AuthoredRoomRegistry *room, unsigned int file) {
    room->ready = 0;
    room->sky_texture = room->sky_palette = 0;
    room->metadata->resident = authored_empty_instances;
    room->metadata->normal = 0;
    room->metadata->partition = 0;
    room->metadata->partition_config = 0;
    D_80168F60_169B60 = 0;
    D_80168F64_169B64 = 0;
    if (!authored_failed) {
        authored_failed = 1;
        authored_failed_room = room->room;
        authored_failed_file = file;
        recomp_printf("MNSG authored room %u stopped: resource %u unavailable. Restart or disable this mod.\\n", authored_failed_room, authored_failed_file);
    }
    authored_failure_mask();
}
static void authored_install(AuthoredRoomRegistry *room) {
    D_80231300_5EC7D0[room->room] = room->metadata;
}
static void authored_environment(AuthoredRoomRegistry *room) {
    /* These are explicit generated defaults; they are not inferred ROM defaults. */
    func_801F97D4_5B56E4();
    *(s16 *)(D_8015C54D_15D14D + 1) = 0;
    D_8015C550 = -32768;
    func_801FA3FC_5B630C(255, 255, 255);
    switch ((unsigned int)(room - authored_rooms)) {
${environmentCases}
    default: break;
    }
}
/* The world bank reuses boot File10. Player reservations occupy its prefix.
 * 0x80594000 is our conservative bank-end policy, not a generic heap promise. */
static int authored_resource_append_fits(unsigned int file, u32 extent) {
    unsigned int slot;
    u32 cursor, aligned, end;
    u32 *allocation;
    if (!file) return 0;
    allocation = D_80054ACC_556CC + (file - 1u) * 2u;
    if (allocation[1] < allocation[0] || allocation[1] - allocation[0] != extent) return 0;
    for (slot = 0; slot < 48u; ++slot) {
        unsigned char *entry = D_80167FC0_168BC0 + slot * 8u;
        unsigned int id = *(u16 *)entry;
        if (id == file) return 1;
        if (id) continue;
        cursor = *(u32 *)(entry + 4);
        if (cursor < 0x80321500u || cursor > 0x80594000u || !extent) return 0;
        aligned = func_80001DF4_29F4(file) ? (cursor + 4095u) & ~4095u : cursor;
        if (aligned < cursor || aligned > 0x80594000u || extent > 0x80594000u - aligned) return 0;
        end = (aligned + extent + 63u) & ~63u;
        return end >= aligned && end <= 0x80594000u;
    }
    return 0;
}
static void authored_stage(AuthoredRoomRegistry *room) {
    unsigned int i;
    room->ready = 0;
    room->sky_started = 0;
    room->doors_started = 0;
    room->sky_texture = room->sky_palette = 0;
    if (authored_failed) { authored_fail(room, authored_failed_file); return; }
    for (i = 0; room->resources[i]; ++i) {
        unsigned int file = room->resources[i];
        signed int handle;
        if (!authored_resource_append_fits(file, room->resource_extents[i])) { authored_fail(room, file); return; }
        if (!func_80013B14_14714((s16)file)) { authored_fail(room, file); return; }
        handle = func_800141C4_14DC4(file);
        if (handle == 0 || handle == -1) { authored_fail(room, file); return; }
    }
    for (i = 0; i < room->pointer_count; ++i) {
        AuthoredMaterialPointer *relocation = &room->pointers[i];
        signed int pointer = func_80014840_15440((signed int)relocation->pointer, relocation->file);
        if (!pointer) { authored_fail(room, relocation->file); return; }
        room->model[relocation->command].w1 = (u32)pointer;
    }
    room->metadata->resident = room->instances;
    for (i = 0; i < room->door_count; ++i) {
        AuthoredDoorRegistry *door = &room->doors[i];
        unsigned int j;
        for (j = 0; j < door->pointer_count; ++j) {
            AuthoredMaterialPointer *relocation = &door->pointers[j];
            signed int pointer = func_80014840_15440((signed int)relocation->pointer, relocation->file);
            if (!pointer) { authored_fail(room, relocation->file); return; }
            door->model[relocation->command].w1 = (u32)pointer;
        }
    }
    authored_environment(room);
    room->ready = 1;
}
RECOMP_PATCH int func_8020D670_5C8B40(void) {
    unsigned char *system = D_8015C5C8_15D1C8;
    AuthoredRoomRegistry *room;
    AuthoredMetadata *metadata;
    if (!system) return 0;
    room = authored_find(*(u16 *)(system + 0x3adf2));
    if (room) {
        authored_install(room);
        /* Re-stage after native cache trimming, even on same-room re-entry. */
        return 1;
    }
    metadata = (AuthoredMetadata *)D_80231300_5EC7D0[*(u16 *)(system + 0x3adf2)];
    return (u32)metadata->load != *(u32 *)(system + 0x3b03c);
}
RECOMP_HOOK("func_8020D6BC_5C8B8C")
void mnsg_authored_install_before_metadata_load(void) {
    unsigned char *system = D_8015C5C8_15D1C8;
    AuthoredRoomRegistry *room;
    if (!system) return;
    room = authored_find(*(u16 *)(system + 0x3adf2));
    if (room) authored_install(room);
}
RECOMP_HOOK_RETURN("func_801F728C_5B319C")
void mnsg_authored_guard_cold_setup(void) { authored_failure_mask(); }
RECOMP_HOOK_RETURN("func_801F7F78_5B3E88")
void mnsg_authored_guard_transition_setup(void) { authored_failure_mask(); }
RECOMP_HOOK("func_80034734_35334")
void mnsg_authored_guard_scheduler(void) { authored_failure_mask(); }
RECOMP_PATCH void func_800214E4_220E4(void) {
    unsigned char *system = D_8015C5C8_15D1C8;
    AuthoredRoomRegistry *room;
    s16 *saved = (s16 *)(D_8015C80C_15D40C + 4);
    s16 *original;
    unsigned int i;
    if (!system) return;
    room = authored_find(*(u16 *)(system + 0x3adf2));
    if (room) {
        switch ((unsigned int)(room - authored_rooms)) {
${arrivalCases}
        default: return;
        }
    }
    original = D_8006B780_6C380 + *(u16 *)(system + 0x3adf2) * 5u;
    if (!original[0] && !original[1] && !original[2]) {
        for (i = 0; i < 5; ++i) saved[i] = 0;
    } else {
        saved[0] = original[4];
        saved[1] = original[0]; saved[2] = original[1]; saved[3] = original[2];
        saved[4] = original[3];
    }
}
`;
}
/** Owned geometry avoids the donor's secondary object and collision pointers. */
export function authoringGeometryRuntimeSource(): string {
    return `
extern unsigned char *D_802098DC_5C57EC[];
extern unsigned char *D_802098F4_5C5804[];
extern u32 *D_80209924_5C5834[];
extern u32 *D_8020993C_5C584C[];
extern int func_80035A5C_3665C(void *task, u32 model, u32 material,
    float x, float y, float z, s16 rx, s16 ry, s16 rz,
    float sx, float sy, float sz, s16 primary, s16 secondary, s16 material_file);
extern void *func_80035EEC_36AEC(void *task, s16 kind, unsigned char count);
extern void func_80035044_35C44(void);
static int authored_resources_ready(AuthoredRoomRegistry *room) {
    unsigned int i;
    if (!room->ready || authored_failed) return 0;
    for (i = 0; room->resources[i]; ++i) {
        signed int handle = func_800141C4_14DC4(room->resources[i]);
        if (handle == 0 || handle == -1) { authored_fail(room, room->resources[i]); return 0; }
    }
    return 1;
}
RECOMP_PATCH void func_801F8C4C_5B4B5C(void) {
    unsigned char *system = D_8015C5C8_15D1C8;
    AuthoredRoomRegistry *room;
    unsigned int group, index;
    u32 plane, file;
    D_80168F60_169B60 = 0;
    D_80168F64_169B64 = 0;
    if (!system) return;
    room = authored_find(*(u16 *)(system + 0x3adf2));
    if (room) {
        if (authored_resources_ready(room)) {
            D_80168F60_169B60 = (u32)room->planes;
            D_80168F64_169B64 = (u32)room->tree;
        }
        return;
    }
    /* Original vanilla table selection and resource arithmetic. */
    group = system[0x3adf6];
    index = *(u16 *)(system + 0x3adf8);
    plane = D_80209924_5C5834[group][index];
    if (plane) {
        file = *(u32 *)(D_802098DC_5C57EC[group] + index * 20u + 8u);
        D_80168F60_169B60 = (u32)func_800141C4_14DC4(file) + plane - 0x08000000u;
        D_80168F64_169B64 = (u32)func_800141C4_14DC4(file) + D_8020993C_5C584C[group][index] - 0x08000000u;
    }
}
RECOMP_PATCH void func_801F95D8_5B54E8(void *task_pointer, void *object_pointer) {
    unsigned char *task = task_pointer, *object = object_pointer;
    unsigned char *system = D_8015C5C8_15D1C8;
    AuthoredRoomRegistry *room;
    u32 *primary, *secondary;
    unsigned int group, index;
    if (!system || !task || !object) return;
    room = authored_find(*(u16 *)(system + 0x3adf2));
    if (room) {
        if (!authored_resources_ready(room)) {
            *(u32 *)(object + 0x2c) = 0;
            *(u32 *)(object + 0x30) = 0;
            if (!authored_failed) authored_fail(room, 0);
            return;
        }
        func_80035A5C_3665C(task, (u32)room->model | 0x40000000u, 0,
            0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0);
        object[5] = 1;
        object[0x65] = 0;
        *(u16 *)(object + 6) = 1;
        authored_spawn_sky(task, room);
        authored_spawn_doors(task, room);
        return;
    }
    /* The original secondary path remains intact for vanilla rooms. */
    group = system[0x3adf6];
    index = *(u16 *)(system + 0x3adf8);
    primary = (u32 *)(D_802098DC_5C57EC[group] + index * 20u);
    func_80035A5C_3665C(task, primary[0], primary[1] | 0x40000000u,
        0, 0, 0, 0, 0, 0, 1, 1, 1, primary[2], primary[3], primary[4]);
    object[5] = 1;
    object[0x65] = 0;
    secondary = (u32 *)(D_802098F4_5C5804[group] + index * 8u);
    if (secondary[0]) {
        if (!func_80035EEC_36AEC(task, 2, 1)) { func_80035044_35C44(); return; }
        object = *(unsigned char **)(task + 0x1c);
        func_80035A5C_3665C(task, secondary[0], secondary[1],
            0, 0, 0, 0, 0, 0, 1, 1, 1, primary[2], primary[3], primary[4]);
        object[5] = 1;
        object[0x65] = 0;
    }
    *(u16 *)(object + 6) = 1;
}
`;
}
/** The owned background is parented to the room renderer and removed with it. */
export function authoringSkySource(): string {
    return `
extern u32 D_802098BC_5C57CC[], D_802098CC_5C57DC[];
extern unsigned char *D_8020990C_5C581C[];
extern u16 *D_8020996C_5C587C[];
extern float D_8020C688_5C8598;
extern void *func_80034B58_35758(void *parent, void (*callback)(void *, void *), u16 resource);
extern void *func_80034D24_35924(void *task);
extern void *func_80035DFC_369FC(void *task, s16 kind, unsigned char count);
extern void func_8003521C_35E1C(void (*callback)(void *, void *));
extern void func_801F8644_5B4554(void *task, void *object);
static int authored_bind_background(void *task_pointer, u16 selector, u16 file) {
    unsigned char *task = task_pointer, *object;
    signed int handle;
    u32 texture, palette;
    if (selector < 1 || selector > 4 || !file) return 0;
    handle = func_800141C4_14DC4(file);
    if (handle == 0 || handle == -1) return 0;
    texture = (u32)func_80014840_15440((signed int)D_802098BC_5C57CC[selector - 1u], file);
    palette = (u32)func_80014840_15440((signed int)D_802098CC_5C57DC[selector - 1u], file);
    if (!texture || !palette || !func_80035DFC_369FC(task, 5, 1)) return 0;
    object = *(unsigned char **)(task + 0x18);
    if (!object) return 0;
    *(u32 *)(object + 0x38) = texture;
    *(u32 *)(object + 0x3c) = palette;
    *(u16 *)(object + 0x2e) = 0;
    *(u16 *)(object + 0x30) = 16;
    *(u16 *)(object + 0x32) = 319;
    *(u16 *)(object + 0x34) = 224;
    *(u16 *)(object + 0x10) = 640;
    *(u16 *)(object + 0x12) = 240;
    *(u16 *)(object + 0x0e) = 0x2009;
    object[5] = 0;
    *(u16 *)(object + 6) = 8;
    *(float *)(object + 0x14) = 0;
    *(float *)(object + 0x18) = 0;
    *(float *)(object + 0x24) = D_8020C688_5C8598;
    *(u32 *)(object + 0x28) = 0x436f0000u;
    return 1;
}
static void authored_sky_update(void *task, void *object) {
    unsigned char *system = D_8015C5C8_15D1C8;
    AuthoredRoomRegistry *room;
    if (!system) return;
    room = authored_find(*(u16 *)(system + 0x3adf2));
    if (!room || !authored_resources_ready(room)) return;
    func_801F8644_5B4554(task, object);
}
static void authored_sky_init(void *task, void *object) {
    unsigned char *system = D_8015C5C8_15D1C8;
    AuthoredRoomRegistry *room;
    (void)object;
    if (!system) { func_80035044_35C44(); return; }
    room = authored_find(*(u16 *)(system + 0x3adf2));
    if (!room || !authored_resources_ready(room)) { func_80035044_35C44(); return; }
    if (!authored_bind_background(task, room->skybox, room->skybox_file)) {
        authored_fail(room, room->skybox_file);
        func_80035044_35C44();
        return;
    }
    {
        unsigned char *background = *(unsigned char **)((unsigned char *)task + 0x18);
        room->sky_texture = *(u32 *)(background + 0x38);
        room->sky_palette = *(u32 *)(background + 0x3c);
    }
    func_8003521C_35E1C(authored_sky_update);
}
static void authored_spawn_sky(void *parent, AuthoredRoomRegistry *room) {
    void *task;
    if (!room->skybox || room->sky_started || !authored_resources_ready(room)) return;
    task = func_80034B58_35758(parent, authored_sky_init, 0);
    if (!task) { authored_fail(room, room->skybox_file); return; }
    func_80034D24_35924(task);
    room->sky_started = 1;
}
RECOMP_PATCH void func_801F8494_5B43A4(void *task) {
    unsigned char *system = D_8015C5C8_15D1C8;
    unsigned int group, index;
    u16 selector, file;
    if (!system) { func_80035044_35C44(); return; }
    /* The donor's scheduled background is replaced by the owned renderer child. */
    if (authored_find(*(u16 *)(system + 0x3adf2))) { func_80035044_35C44(); return; }
    group = system[0x3adf6];
    index = *(u16 *)(system + 0x3adf8);
    selector = D_8020996C_5C587C[group][index];
    file = *(u16 *)(D_8020990C_5C581C[group] + index * 8u + 6u);
    if (!authored_bind_background(task, selector, file)) { func_80035044_35C44(); return; }
    func_8003521C_35E1C(func_801F8644_5B4554);
}
`;
}
/** The custom type owns only its volume, input latch, and ordinary room queue. */
export function authoringDoorSource(): string {
    return `
#define AUTHORED_DOOR_TYPE 0x4d444f52u
extern unsigned char *D_801FC600_5B8510;
extern unsigned char *D_801FC604_5B8514;
extern unsigned char *D_801FC60C_5B851C;
extern unsigned char D_800C7DB0_C89B0[];
extern void func_8000607C_6C7C(u16 room, s16 x, s16 y, s16 z, s16 base_yaw, s16 camera_start, s16 queued_script_file, signed int queued_script_address);
extern void *func_800358E8_364E8(void *parent, void (*callback)(void *, void *), u32 model, u32 material,
    float x, float y, float z, s16 rx, s16 ry, s16 rz, float sx, float sy, float sz, s16 graphics_file, s16 material_file);
static int authored_door_inside(const AuthoredDoorRegistry *door, const float position[3]) {
    float delta[3];
    unsigned int axis;
    for (axis = 0; axis < 3; ++axis) delta[axis] = position[axis] - door->volume_center[axis];
    for (axis = 0; axis < 3; ++axis) {
        const float *row = door->inverse_rotation + axis * 3u;
        float value = row[0] * delta[0] + row[1] * delta[1] + row[2] * delta[2];
        if (value < -door->half_size[axis] || value > door->half_size[axis]) return 0;
    }
    return 1;
}
static int authored_door_live(const AuthoredDoorRegistry *door) {
    unsigned char *system = D_8015C5C8_15D1C8;
    if (!system || authored_failed || system[0x3add4] != 13 || system[0x3adde] != 1) return 0;
    if (*(u16 *)(system + 0x3adf2) != door->room) return 0;
    if (!D_801FC600_5B8510 || (u32)D_801FC600_5B8510 == 0x80000000u ||
        !D_801FC604_5B8514 || (u32)D_801FC604_5B8514 == 0x80000000u ||
        !D_801FC60C_5B851C || (u32)D_801FC60C_5B851C == 0x80000000u) return 0;
    return *(u16 *)(system + 0x3ae26) == 0 && system[0x3ae29] == 0 &&
        system[0x3ae22] == 0 && system[0x3ae23] == 0 && system[0xcf8a2] == 0 &&
        *(s16 *)(system + 0x3ae16) == 0 && D_8015C54D_15D14D[0] == 0;
}
static unsigned int authored_door_pressed_a(void) {
    unsigned int controller;
    if (!D_801FC604_5B8514 || (u32)D_801FC604_5B8514 == 0x80000000u) return 0;
    controller = D_801FC604_5B8514[0x90];
    return controller < 4 && (*(u16 *)(D_800C7DB0_C89B0 + controller * 0x18u + 4u) & 0x8000u);
}
static unsigned int authored_door_activation(const AuthoredDoorRegistry *door, u32 state[3], unsigned int inside, unsigned int pressed, unsigned int live) {
    unsigned int activate = 0;
    if (!state[2]) { state[2] = 1; state[1] = !inside; state[0] = inside; }
    if (!inside) state[1] = 1;
    if (live) activate = door->touch ? inside && !state[0] && state[1] : inside && pressed;
    state[0] = inside;
    if (activate) state[1] = 0;
    return activate;
}
static void authored_door_queue(const AuthoredDoorRegistry *door) {
    unsigned char *system = D_8015C5C8_15D1C8;
    /* Explicit ordinary-entry policy: discard stale scripted camera offsets. */
    *(u32 *)(system + 0x3ae2c) = 0;
    *(u16 *)(system + 0x3ae30) = 0;
    /* Zero queued script fields preserve the existing player/controller/form. */
    func_8000607C_6C7C(door->destination, door->arrival[0], door->arrival[1], door->arrival[2],
        door->arrival[3], door->arrival[4], 0, 0);
}
static void authored_door_update(void *task_pointer, void *object_pointer) {
    unsigned char *task = task_pointer;
    AuthoredDoorRegistry *door = *(AuthoredDoorRegistry **)(task + 0xd0);
    unsigned char *system = D_8015C5C8_15D1C8;
    unsigned int inside, activate;
    (void)object_pointer;
    if (!door || !system || !D_801FC60C_5B851C || (u32)D_801FC60C_5B851C == 0x80000000u) return;
    inside = authored_door_inside(door, (float *)(D_801FC60C_5B851C + 8));
    activate = authored_door_activation(door, (u32 *)(task + 0xd4), inside, authored_door_pressed_a(), authored_door_live(door));
    if (!activate) return;
    authored_door_queue(door);
}
static void authored_spawn_doors(void *parent, AuthoredRoomRegistry *room) {
    unsigned int i;
    if (room->doors_started || !authored_resources_ready(room)) return;
    for (i = 0; i < room->door_count; ++i) {
        AuthoredDoorRegistry *door = &room->doors[i];
        unsigned char *task = func_800358E8_364E8(parent, authored_door_update,
            (u32)door->model | 0x40000000u, 0,
            door->position[0], door->position[1], door->position[2],
            door->rotation[0], door->rotation[1], door->rotation[2],
            door->scale[0], door->scale[1], door->scale[2], 0, 0);
        unsigned char *object;
        if (!task) { authored_fail(room, 0); return; }
        object = *(unsigned char **)(task + 0x18);
        if (!object) { authored_fail(room, 0); return; }
        /* This flattened root has absolute resource references and no segments. */
        *(u16 *)(object + 0x34) = 0; *(u16 *)(object + 0x3c) = 0; *(u16 *)(object + 0x44) = 0;
        *(AuthoredDoorRegistry **)(task + 0xd0) = door;
        *(u32 *)(task + 0xd4) = 0;
        *(u32 *)(task + 0xd8) = 0;
        *(u32 *)(task + 0xdc) = 0;
        *(u32 *)(task + 0xe0) = AUTHORED_DOOR_TYPE;
    }
    room->doors_started = 1;
}
`;
}
