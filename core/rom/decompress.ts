import { RomReader } from "./binary";

export const FILE_TABLE_OFFSET = 0x57fd8;
export const FILE_ID_BASE = FILE_TABLE_OFFSET - 4;
const MAX_ROM = 0x4000000;
export interface RomFile { id: number; start: number; end: number; compressed: boolean }

/** US file ids are one-based: native id 1 is the first entry after the signature. */
export function readFileTable(bytes: Uint8Array): RomFile[] {
  const r = new RomReader(bytes);
  if (r.hex(FILE_TABLE_OFFSET - 16, 16) !== Buffer.from("Nisitenma-Ichigo").toString("hex"))
    throw new Error("US ROM file-table signature is missing.");
  const files: RomFile[] = [];
  let previous = r.u32(FILE_TABLE_OFFSET);
  for (let id = 1; id <= 8192; id++) {
    const next = r.u32(FILE_ID_BASE + (id + 1) * 4);
    if (next === 0) return files;
    const start = previous & 0x7fffffff, end = next & 0x7fffffff;
    r.check(start, end - start);
    if (start < FILE_TABLE_OFFSET || start > end) throw new Error(`Invalid file ${id} offsets.`);
    files.push({ id, start, end, compressed: Boolean(previous & 0x80000000) });
    previous = next;
  }
  throw new Error("ROM file table has no bounded terminator.");
}

/** Checked translation of Goemon64Recomp/src/game/rom_decompression.cpp. */
export function decompressLzkn64(input: Uint8Array, maxOutput = MAX_ROM): Uint8Array {
  const r = new RomReader(input);
  const size = r.u32(0);
  if (size < 4 || size > input.length || !Number.isInteger(maxOutput) || maxOutput < 0 || maxOutput > MAX_ROM)
    throw new Error("Invalid LZKN64 stream length or output limit.");
  // Grow only as needed; a malformed stream cannot allocate beyond the limit.
  let output = new Uint8Array(Math.min(4096, maxOutput)), pos = 0, cursor = 4;
  const get = () => { if (cursor >= size) throw new Error("Truncated LZKN64 command."); return input[cursor++]; };
  const reserve = (count: number) => {
    if (pos + count > maxOutput) throw new Error("LZKN64 output exceeds its bounded limit.");
    if (pos + count > output.length) {
      const grown = new Uint8Array(Math.min(maxOutput, Math.max(pos + count, output.length * 2)));
      grown.set(output); output = grown;
    }
  };
  while (cursor < size) {
    const command = get();
    if (command <= 0x7f) {
      const count = ((command & 0x7c) >> 2) + 2, distance = ((command & 3) << 8) | get();
      if (distance === 0 || distance > pos) throw new Error("Invalid LZKN64 back-reference.");
      reserve(count);
      for (let i = 0; i < count; i++) { output[pos] = output[pos - distance]; pos++; }
    } else if (command <= 0x9f) {
      const count = command & 31; reserve(count);
      for (let i = 0; i < count; i++) output[pos++] = get();
    } else {
      const count = command === 0xff ? get() + 2 : (command & 31) + 2;
      const value = command <= 0xdf ? get() : 0;
      reserve(count); output.fill(value, pos, pos + count); pos += count;
    }
  }
  return output.slice(0, pos);
}

export function decompressUsRom(input: Uint8Array): Uint8Array {
  const files = readFileTable(input);
  if (!files.length) throw new Error("ROM file table is empty.");
  const output = new Uint8Array(MAX_ROM), view = new DataView(output.buffer);
  output.set(input);
  let cursor = files[0].start;
  for (const file of files) {
    const data = file.compressed ? decompressLzkn64(input.subarray(file.start, file.end), MAX_ROM - cursor)
      : input.subarray(file.start, file.end);
    const alignedSize = Math.ceil(data.length / 16) * 16;
    if (cursor + alignedSize > MAX_ROM) throw new Error("Decompressed ROM exceeds 64 MiB.");
    output.set(data, cursor);
    // Match recomp's initial full-ROM copy, including existing alignment bytes.
    view.setUint32(FILE_ID_BASE + file.id * 4, cursor);
    cursor += alignedSize;
    view.setUint32(FILE_ID_BASE + (file.id + 1) * 4, cursor);
  }
  const size = 2 ** Math.ceil(Math.log2(cursor));
  view.setUint32(0x10, 0x9cc11f4b); view.setUint32(0x14, 0xabaa8538);
  return output.slice(0, size);
}
