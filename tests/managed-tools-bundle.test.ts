import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

test('bundled support files match pinned upstream provenance and carry permission', async () => {
  const root = path.resolve('resources/managed-template');
  const provenance = JSON.parse(await readFile(path.join(root, 'provenance.json'), 'utf8'));
  assert.equal(provenance.template.commit, '3f52a0fafdc04429080e3f4d8d072d8025c8cbdb');
  assert.equal(provenance.symbols.commit, '49f4e3269f05c737cb4bf698b9ef7142c92f1ac7');
  for (const file of provenance.files) {
    const bytes = await readFile(path.join(root, file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
  }
  const permission = await readFile(path.join(root, provenance.symbols.permission), 'utf8');
  assert.match(permission, /copy/i);
  const header = await readFile(path.join(root, 'include/modding.h'), 'utf8');
  assert.match(header, /\.recomp_hook\./);
  const symbols = await readFile(path.join(root, 'Goemon64RecompSyms/mnsg.us.syms.toml'), 'utf8');
  assert.match(symbols, /func_8000D3B8_DFB8/);
});
