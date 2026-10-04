import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

/** A sibling temporary file makes replacement atomic on both supported OSes. */
export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function readJson(path: string, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  if ((await stat(path)).size > maxBytes) throw new Error("Project file is too large.");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
