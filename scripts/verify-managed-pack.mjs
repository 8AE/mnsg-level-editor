import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBundle } from './managed-tools-contract.mjs';

// electron-builder's public Arch enum is ia32=0, x64=1, armv7l=2, arm64=3.
// Reject cross-packaging unless the staged executables match the target.
export default async function verifyManagedPack(context) {
  const arch = ({ 1: 'x64', 3: 'arm64' })[context.arch];
  const platform = context.electronPlatformName;
  if (!arch || !['darwin', 'win32'].includes(platform)) throw new Error('Unsupported managed-tool package target');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = await validateBundle(path.join(root, 'resources/managed-tools'), { platform, arch });
  console.log(`Packaging verified ${manifest.bundleId} for ${platform}/${arch}`);
}
