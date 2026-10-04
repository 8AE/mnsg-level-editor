/** func_8020D2A0_5C8770: sub.S, div.S, div.S(count,2), add.S, trunc.w.S. */
export function nativePartitionCell(position: number, origin: number, width: number, count: number): number {
  return Math.trunc(Math.fround(Math.fround(Math.fround(position - origin) / width) + Math.fround(count / 2)));
}
