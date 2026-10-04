/** All ROM access is checked before DataView reads; pointers never wrap. */
export class RomReader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  check(offset: number, size: number, end = this.bytes.length): number {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > end || end > this.bytes.length)
      throw new Error(`ROM bounds violation at 0x${offset.toString(16)} (${size} bytes)`);
    return offset;
  }
  u16(offset: number) { return this.view.getUint16(this.check(offset, 2)); }
  i16(offset: number) { return this.view.getInt16(this.check(offset, 2)); }
  u32(offset: number) { return this.view.getUint32(this.check(offset, 4)); }
  hex(offset: number, size: number) { this.check(offset, size); return Buffer.from(this.bytes.subarray(offset, offset + size)).toString("hex"); }
}

export function normalizeRomByteOrder(input: Uint8Array): Uint8Array {
  if (input.length < 64 || input.length > 64 * 1024 * 1024 || input.length % 4)
    throw new Error("ROM must contain a complete N64 header and aligned data, at most 64 MiB.");
  const magic = new RomReader(input).u32(0);
  const bytes = Uint8Array.from(input);
  if (magic === 0x80371240) return bytes;
  if (magic === 0x37804012) {
    for (let i = 0; i < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]];
  } else if (magic === 0x40123780) {
    for (let i = 0; i < bytes.length; i += 4) {
      [bytes[i], bytes[i + 3]] = [bytes[i + 3], bytes[i]];
      [bytes[i + 1], bytes[i + 2]] = [bytes[i + 2], bytes[i + 1]];
    }
  } else throw new Error("Unknown N64 byte order. Select a .z64, .v64, or .n64 ROM.");
  return bytes;
}
