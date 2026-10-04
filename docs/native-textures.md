# Static room texture evidence

Research date: 2026-10-04. These findings concern the canonical US ROM's static
room textures. No game was launched and no decoded asset was saved in this
repository. This establishes source formats, not pixel-identical emulation of
the game's full renderer.

## Native load and render order

The shared API was checked first: `func_800144E8_150E8` documents synchronous
PIC decoding, and `func_800145B4_151B4`/`func_80014698_15298` document general
and packed resource loading. That reference does not describe the complete
room wave-part reconstruction or indexed PIC4 stream recovered here.

Fresh Ghidra bodies in `mnsg_main_static.elf`, section `.main`:

| Function | Native VRAM / decompressed ROM | Behavior |
| --- | --- | --- |
| `func_80013B14_14714` | `80013B14 / 14714` | Loads a base wave, then expands its parts |
| `func_800142BC_14EBC` | `800142BC / 14EBC` | Walks `(resource,destination)` parts and loads/decodes each |
| `func_800144E8_150E8` | `800144E8 / 150E8` | Loads packed bytes; decodes PIC or copies raw bytes; returns output end |
| `func_80014698_15298` | `80014698 / 15298` | Determines packed resource ROM range |
| `func_800154B0_160B0` | `800154B0 / 160B0` | Reads PIC header and output allocation metadata |
| `func_80014DD8_159D8` | `80014DD8 / 159D8` | Selects indexed4, indexed8 or RGB15/16 decoder |
| `func_800196F0_1A2F0` | `800196F0 / 1A2F0` | Emits resource segment bindings, material state and model display list |

File11 `func_801F95D8_5B54E8(task*,object*)` binds primary/secondary models
and materials at identity transforms through `func_80035A5C_3665C`. Both
models share the primary record's resource IDs at `+8/+C/+10`.
The native renderer establishes segments8..D before running material/model
lists. The twelve canonical resident material roots contain render, fog,
color and combiner state; no vertices, matrices or segment-base changes.
Its material-copy path relocates commands in the frame buffer, not original
room command sources. Animated frame state and room callbacks are separate
from the initial asset reconstruction described here.

## Reconstruct loaded texture waves

Whole-ROM LZKN64 decompression leaves PIC resource parts packed. A segmented
texture address is an offset in the **loaded wave allocation**, which can extend
beyond that wave's stored ROM file. Reading neighboring ROM bytes is incorrect.

Native metadata in decompressed ROM:

| Table | Layout |
| --- | --- |
| `0x556C4 + wave*8` | u32 allocation start/end, native `D_80054AC4`; size is end minus start |
| `0x6A51C + wave*4` | u32 resident pointer to a parts list, native `D_8006991C` |
| Parts list | Repeated u32 resource ID/u32 destination segmented pointer; resource0 terminates |
| `0x64540` | Four-byte packed groups: u16 **lower resource ID**, u16 parent ROM file ID |
| `0x445D4 + resource*4` | Packed resource offset table, for IDs `8000..876F` |

Resident main pointers map to ROM with `pointer - 0x80000000 + 0xC00`.
The first packed group is `(8000,129)`, next `(8023,137)`, then `(8094,160)`.
Select the last nonzero lower bound no greater than the resource ID. The next
group's lower bound is the current group's upper bound; these are not upper-bound
records. Native `80014698` initializes its first upper bound to `8023`.

For a packed resource, let `v` be its offset-table word and `next` the following
word. Start is parent file start plus `(v & 0xFFFFFF)`. End is the parent file
end if `next == 0` or the next resource ID crosses the next group boundary;
otherwise end is `start + next - v`. Validate against the parent file bounds.
IDs below8000 use the ordinary ROM file table and have already undergone whole
ROM LZKN64 decompression.

Create a zeroed wave allocation, copy the stored base file, then load each part
in order into `destination - (nativeSegment(wave) << 24)`. For PIC input, decode
its image representation; otherwise copy the loaded bytes unchanged. Require
each output to fit the allocation. Keep this reconstructed memory read-only
for rendering. Editable display-list/vertex/collision provenance remains in
the original ROM representation, preserving translation/export spans.

## PIC header and decoded layouts

The bit reader is MSB-first. After ASCII `PIC`, the fourth byte is `1A`, or
starts a four-character hexadecimal transparent-color key followed by bytes
up to `1A`. Read a NUL-terminated metadata string, an ignored byte, a mode
nibble and ignored nibble, then u16 bpp, width and height. Native code clamps
height to512; it does not clamp width. Reject oversized dimensions explicitly
in an editor rather than relying on the native decoder's unchecked buffers.

The parsed native structure is nine 32-bit words: width, height, bpp, decoded
byte count, mode class, transparent key, input pointer, output pointer and
palette pointer. Class0 is RGB15/16, class1 indexed, class2 raw indexed without
palette (header mode nibble4). Canonical room assets all have header mode0.

- RGB15/16 emits big-endian RGBA5551 halfwords, two bytes per pixel. RGB15
  supplies alpha1; a transparent-key match clears the entire output pixel.
- Indexed4 rounds width to an even nibble stride, packs the first pixel in the
  high nibble, and places16 RGBA5551 palette entries after pixel bytes aligned
  to8. Indexed8 similarly has256 entries after aligned byte pixels.
- Indexed palette decoder `func_800153B0_15FB0` reads three five-bit values
  `a,b,c` and one flag. The flag forces all three values to1. It writes
  `(b<<11)|(a<<6)|(c<<1)|1`; transparent-key matching clears alpha while
  preserving RGB. This differs from interpreting the packed sixteen bits
  directly as RGBA5551.

RGB15/16 uses a128-node circular color LRU, explicit colors, variable runs and
diagonal propagation. It is not an LZ byte-backreference stream. The existing
read-only reference is `mnsg-recomp-example/tools/extract_flute_icon.py`;
its RGB path was checked against fresh native `1570C/15F58/1605C/16120/
161F0/16254/15870` decompiles. Its width clamp is not native behavior, though
all canonical room widths are small enough that this does not affect the census.

Indexed4 native functions `15118/15AB0/15BB0/15D90/163F8/16480` implement:

1. Zero output, decode the palette, seed valid pixel0 with value0.
2. Start sparse index at-1. Add a variable run: begin with one count bit; a
   leading1 extends the bit count while subsequent bits remain1. Read that many
   value bits and add `2^countBits - 1`. Stop when the index reaches width*height.
3. Read four index bits, OR the nibble into its pixel and mark it valid. Read
   a diagonal flag. For diagonals, two-bit moves1/2/3 mean X-1/X/X+1 with Y+1;
   move0 reads a stop bit, or a sign bit for X±2 with Y+1. Continue until stop.
4. Fill row-major through rounded stride, carrying the latest valid value and
   ORing its nibble into every pixel. Indexed8 has equivalent byte behavior.

Bounds/bitstream/movement budgets are required. Native indexed put allows
`y == height`, potentially touching palette storage; the27 canonical indexed
room streams never perform that write in independent bounded validation.

## Canonical room census

The six verified graphics array lengths `[90,49,40,84,38,70]` select371 unique
slots. They reference148 waves and537 unique parts, each used once across those
unique waves. All537 parts are PIC and decoded successfully in independent
read-only Python validation; every decoded part fits its native wave allocation.

| Stored PIC type/dimensions | Resource count | Decoded bytes each |
| --- | --- | --- |
| RGB15 32×64 | 483 | 4096 |
| RGB15 64×32 | 27 | 4096 |
| Indexed4 32×128 | 8 | 2080 |
| Indexed4 64×64 | 17 | 2080 |
| Indexed4 128×32 | 2 | 2080 |

Drawn texture formats are only RGBA16 and CI4 with RGBA16 TLUT. Across372
nonempty model roots there are109,728 RGBA16-textured triangles and2,448
CI4-textured triangles. Counts refer to unique table slots; special room aliases
produce larger totals when enumerated separately.

All render tiles are tile0, TMEM address0, palette bank0 and shiftS/T0.
LOADBLOCK uses tile7, origin0, and `(lrs,dxt)` values `(2047,128)`,
`(2047,256)`, `(1023,1024)`, `(1023,512)` or `(1023,256)`.
The191 TLUT commands load16 entries at tile7 TMEM256 (byte address800hex).
No LOADTILE appeared. Texture scales are normally `FFFF/FFFF`; two commands
use `8000/8000`. Wrap, mirror and clamp occur in all axis combinations, and
mask periods can be smaller than the declared tile dimensions. Texturegen is
never enabled in these roots.

## Texture state and sampling

SDK `mnsg/libultra/include/PR/gbi.h` is authoritative for command fields:
Vtx `1053-1069`, texture `2557-2572`, tile `3107-3129`, LOADBLOCK `3142-3159`,
TLUT `3162-3173`. UV shorts at vertex+8/+A are signed10.5. RT64
`src/hle/rt64_rsp.cpp:720-725` applies scale when loading the vertex:
`tc * unsignedScale / (65536*32)`. Preserve that scaled UV in the vertex cache.

F5 SETTILE: format `(w0>>21)&7`, size `(w0>>19)&3`, line `(w0>>9)&511`,
TMEM `w0&511`; tile `(w1>>24)&7`, palette `(w1>>20)&15`, T mode/mask/shift
at bits18/14/10 and S mode/mask/shift at bits8/4/0. F2 tile coordinates are
12-bit unsigned10.2 values. FD SETTIMG carries the load format/size/width and
segmented image address. Load format is not necessarily render format: CI4
block loads use sixteen-bit load units before switching render descriptors.

TMEM is4096 bytes; tile address/line are64-bit word units. RT64
`src/hle/rt64_rdp.cpp:405-477` gives the load algorithm: eight-byte source words,
odd-row address XOR4, and LOADBLOCK DXT accumulator carry at800hex. TLUT source
advances two bytes per entry while destination advances eight, replicating each
halfword into four banks. Omit RT64's RDRAM byte XOR3 for a big-endian ROM buffer.

RT64 `src/shaders/TextureDecoder.hlsli:149-209` samples indices from lower
TMEM and palettes at `0x800 + palette*128 + CI4index*8`, or
`0x800 + CI8index*8`. RGBA5551 channels expand with `(n<<3)|(n>>2)` and alpha
bit becomes0/255. Preserve palette alpha. Track texture state and TMEM loads
in display-list order and snapshot materials at each triangle, not once per room.

Sampler order and mask behavior follow RT64
`src/shaders/TextureSampler.hlsli:73-109`: clamp to tile extent, then mask/mirror
with period `2^mask`. Retain negative-coordinate positive modulo. UV origins
subtract tile upper-left/4. A mask period is not automatically the decoded
image width. Canonical shifts are zero; general N64 shifts0..10 divide by2^shift,
while11..15 multiply by2^(16-shift).

## Color, alpha and declared approximations

G_LIGHTING determines whether vertex+12..14 are signed normals or RGB bytes;
alpha is vertex+15. The4,816 NUM_LIGHTS commands specify `80000060`, meaning
two directional lights plus ambient. Model MOVEMEM subtype8A sets ambient
light index2; directional lights originate in frame setup outside the room roots.
Static preview lighting can approximate these globals but must not treat normals
as vertex colors.

The nine drawn combiner pairs simplify as follows. Hex words retain opcodeFC;
`T` is texel0, `P` primitive color and `S` shade color. The two-cycle pass cases
carry COMBINED into cycle2; no second texture is required for these expressions.
SDK mux packing is at `gbi.h:2851-2865`.

| w0 / w1 | RGB | Alpha |
| --- | --- | --- |
| `FC127E24 / FFFFF3F9` | T×S | T.a |
| `FC127FFF / FFFFF238` | T×S | T.a |
| `FC327E64 / FFFFFDFE` | P×S | 1 |
| `FC327FFF / FFFFF638` | P×S | P.a |
| `FCFFFFFF / FFFDFCFE` | P | 1 |
| `FCFFFFFF / FFFDF638` | P | P.a |
| `FCFFFFFF / FFFCF279` | T | T.a |
| `FCFFFFFF / FFFCF238` | T | T.a |
| `FCFF97FF / FF2CFE7F` | T | T.a×P.a |

The last pair occurs in three secondary models (79 triangles), with primitive
alpha127, FORCE_BLEND and alphaCompare1. These surfaces must retain translucency.
No environment-color command occurs in the canonical room/material roots.
Native filters are point or bilerp; cycle types are one or two cycles.

Original bitmap decoding and UV/wrap handling do not establish exact frame
appearance. Three.js linear filtering is bilinear, whereas native N64 bilerp
uses three-point filtering. Fog, directional lighting, native framebuffer
blending, runtime animation and other dynamic state may differ. Label the
viewport a static texture preview with these limits; do not claim pixel parity.

## Research evidence and repository validation

Researchers used a temporary independent Python census to read a local canonical
decompressed US ROM, implement native-derived PIC4 and check the RGB15 reference.
A second researcher reran that census and confirmed its metadata and SHA256
results. That research script is not part of this repository or an application
dependency. Decoded resource 8023 SHA256 is
`076077e4f9ef377a32588fc0ed00d44712af577788c36f81e5e3a6329e05b6fa`;
resource 8024 is
`0eaadce12c735955e2ad9bf6cf23db6b35f534532d7100600ae5eb7f3c25d5a0`.
The researchers did not invoke a native decoder callback.

To run the repository's real-ROM texture checks, supply your own US ROM after
installing dependencies with `npm ci`:

```sh
MNSG_TEST_ROM=/path/to/us-rom.z64 \
  node --import tsx --test tests/rom-textures.test.ts
```

This test checks the room texture census, the independent PIC hashes above and
the unchanged native source inventory through the application's parser. It
accepts the supported compressed or decompressed ROM inputs. Without
`MNSG_TEST_ROM`, the real-ROM check reports a skip; the synthetic texture tests
still run. This command reproduces the repository checks, not the historical
Python research procedure.

Tools actually used: `rg`, `nl`, `sed`, bounded Python ROM tables/command/bitstream
reads; discovered Ghidra MCP metadata before `decompile_function` and
`disassemble_function`. The header width/height and class/byte-count interpretation
were additionally checked in disassembly of `800154B0_160B0`. Remaining work is
runtime animation/light/fog parity and any additional special scene types,
rather than missing canonical room PIC4/RGB15 formats.

## Editor 0.2.2 generated texture coordinates

TEXGEN uses signed native vertex normals, with each component divided by 127 without normalizing
the vector. The renderer retains state from vertex load: generation mode, unsigned texture
scales, LookAt axes and the model/load-root identity. It transforms the axes with the model
matrix transpose, clamps the normal dot products, and computes sphere or linear generated texel
coordinates per vertex. It then applies tile shifts, origin, wrap and image dimensions. Ordinary
stored UVs use signed 10.5 units; generated texels do not divide by 32.

A complete explicit MOVEMEM LookAt pair supplies decoded signed-byte axes. When the preceding
scene LookAt state is unknown, the editor uses a labelled conditional camera basis. That policy
does not establish the preceding in-game draw state. Partial or invalid axes, mixed vertex
modes/scales and unsupported load/draw roots retain the untextured fallback for affected
surfaces.

Slicer's eight preview triangles now use the File384 32 by 64 RGBA16 bitmap. The five decoded
TEXGEN assets contain 448 triangles, 432 generated; seventeen canonical parts contain 1,172
generated-coordinate triangles. Native room coverage remains 383 records and 118,110 triangles,
114,137 textured, with 378 rooms containing visual geometry. The static room corpus contains no
TEXGEN.

Read the [native TEXGEN proof](native-room-authoring.md#native-texgen-presentation-slicer-0x19d)
for LookAt provenance, the per-vertex formula and native command evidence. The implementation
preserves fallback diagnostics and rejects generated actor appearance flattening for custom
doors. This presentation change does not complete timed actor initialization or expand native
export admission.

The fresh census confirmed unchanged status counts and ROM bytes. The analytical/texture/actor
suite passed 16 checks, including raw-normal handling, vertex interpolation and per-draw
matrices. A separate thumbnail GPU check and eight native actor/thumbnail checks passed without
errors. Read the [validation record](../README.md#package-and-validation-status) for build,
package and installed-app results. These checks do not establish native framebuffer or gameplay
parity.
