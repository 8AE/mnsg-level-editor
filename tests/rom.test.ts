import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeRomByteOrder, decompressLzkn64, importRomBytes } from "../core/rom";

test("normalizes all N64 byte orders without changing caller bytes", () => {
  const z64 = new Uint8Array(64); z64.set([0x80, 0x37, 0x12, 0x40]); z64.set([1, 2, 3, 4], 4);
  const v64 = z64.slice(), n64 = z64.slice();
  for (let i = 0; i < 64; i += 2) [v64[i], v64[i + 1]] = [v64[i + 1], v64[i]];
  for (let i = 0; i < 64; i += 4) n64.set(z64.subarray(i, i + 4).slice().reverse(), i);
  assert.deepEqual(normalizeRomByteOrder(v64), z64);
  assert.deepEqual(normalizeRomByteOrder(n64), z64);
  assert.deepEqual(v64.subarray(0, 4), Uint8Array.from([0x37, 0x80, 0x40, 0x12]));
  assert.throws(() => normalizeRomByteOrder(new Uint8Array(63)));
  assert.throws(() => importRomBytes(z64), /checksum/);
});

const stream = (...commands: number[]) => {
  const bytes = Uint8Array.from([0, 0, 0, 4 + commands.length, ...commands]); return bytes;
};
test("LZKN64 literal, overlapping copy and all repeat encodings", () => {
  assert.deepEqual([...decompressLzkn64(stream(0x81, 65, 0x08, 1, 0xa0, 66, 0xe0, 0xff, 1))],
    [65, 65, 65, 65, 65, 66, 66, 0, 0, 0, 0, 0]);
  assert.deepEqual([...decompressLzkn64(stream(0xc0, 255))], [255, 255]);
});
test("LZKN64 rejects truncation, invalid history and oversized output", () => {
  assert.throws(() => decompressLzkn64(stream(0x81)), /Truncated/);
  assert.throws(() => decompressLzkn64(stream(0x00, 1)), /back-reference/);
  assert.throws(() => decompressLzkn64(stream(0xa0, 1), 1), /limit/);
  assert.throws(() => decompressLzkn64(Uint8Array.from([0, 0, 0, 99])), /length/);
});

test("local user ROM reproduces the documented full placement inventory", { skip: !process.env.MNSG_TEST_ROM }, () => {
  const rom = importRomBytes(readFileSync(process.env.MNSG_TEST_ROM!));
  assert.equal(rom.identity.normalizedSha256, "e40bee20508c2e29e651dca4e47504e40f908f0a2186e34a582784bf5a64be4c");
  const rooms = rom.listRooms();
  assert.equal(rooms.length, 383);
  const actors = rooms.flatMap(room => rom.loadRoom(room.id).actors);
  assert.equal(new Set(actors.map(actor => actor.id)).size, 3888);
  assert.equal(actors.filter(actor => actor.sourceKind === "resident").length, 7);
  assert.equal(rooms.filter(room => room.actorCount > 0).length, 292);
  assert.equal(rooms.filter(room => room.geometryAvailable).length, 378);
  assert.ok(rooms.every(room => !room.warnings.some(warning => warning.startsWith("Partial geometry:"))));
  const events = rooms.flatMap(room => rom.loadRoom(room.id).events);
  assert.equal(events.length, 180);
  assert.ok(events.every(event => !event.editable && actors.some(actor => actor.id === event.actorRef)));
  for (const actor of actors) {
    assert.equal(Buffer.from(rom.bytes.subarray(actor.source.romOffset, actor.source.romOffset + 20)).toString("hex"), actor.source.expectedHex);
    assert.equal(actor.parameters.length, 3);
  }
  assert.throws(() => rom.loadRoom(-1), /room ID/);
  assert.throws(() => rom.loadRoom(800), /room ID/);
});
