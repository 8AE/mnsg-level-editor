import { createHash } from 'node:crypto';
import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

export const bundleId = 'llvm21-1-8-recompffb39cd-2';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 240
    && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value)
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    && /^[A-Za-z0-9_./-]+$/.test(value);
}
export async function bundleFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!safeRelativePath(relative)) throw new Error(`Unsafe bundle path: ${relative}`);
    if (entry.isSymbolicLink()) throw new Error(`Bundle symlink rejected: ${relative}`);
    if (entry.isDirectory()) files.push(...await bundleFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unsupported bundle entry: ${relative}`);
  }
  return files.sort();
}
export async function validateBundle(root, expected = { platform: process.platform, arch: process.arch }) {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'mnsg-managed-tools' || manifest.version !== 1 || manifest.bundleId !== bundleId
    || manifest.platform !== expected.platform || manifest.arch !== expected.arch || !Array.isArray(manifest.files)) {
    throw new Error('Managed tool manifest identity does not match this native host');
  }
  const names = new Set();
  for (const item of manifest.files) {
    if (!safeRelativePath(item.path) || names.has(item.path) || item.path === 'manifest.json'
      || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1
      || typeof item.executable !== 'boolean') throw new Error('Invalid managed tool file declaration');
    names.add(item.path);
    const target = path.join(root, item.path);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.byteLength) throw new Error(`Invalid bundle file: ${item.path}`);
    if (sha256(await readFile(target)) !== item.sha256) throw new Error(`Bundle checksum mismatch: ${item.path}`);
    if (item.executable && process.platform !== 'win32' && !(stat.mode & 0o111)) throw new Error(`Bundle executable permission missing: ${item.path}`);
  }
  for (const [key, value] of Object.entries(manifest.tools ?? {})) {
    if (!['clang', 'linker', 'modTool'].includes(key) || !names.has(value)
      || !manifest.files.find((item) => item.path === value)?.executable) throw new Error('Invalid bundle executable reference');
  }
  if (Object.keys(manifest.tools ?? {}).length !== 3 || Object.keys(manifest.support ?? {}).length !== 3) throw new Error('Missing bundle tool/support references');
  for (const key of ['header', 'functions', 'data']) if (!names.has(manifest.support[key])) throw new Error('Invalid support reference');
  const actual = await bundleFiles(root);
  if (actual.length !== names.size + 1 || actual.some((name) => name !== 'manifest.json' && !names.has(name))) throw new Error('Undeclared bundle file');
  return manifest;
}
