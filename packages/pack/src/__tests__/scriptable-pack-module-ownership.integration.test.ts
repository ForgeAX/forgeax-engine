import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { scanInventory } from '../scanner.js';
import { loadScriptablePack } from '../scriptable-pack-node.js';

it.each([
  {
    name: '@forgeax/engine-domain-owner',
    specifier: '@forgeax/engine-domain-owner/cook',
    subpath: './cook',
  },
  { name: '@forgeax/engine', specifier: '@forgeax/engine/geometry', subpath: './geometry' },
  { name: '@forgeax/engine-water', specifier: '@forgeax/engine-water', subpath: '.' },
])('resolves $specifier from the actual author dependency owner', async ({
  name,
  specifier,
  subpath,
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-domain-owner-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'pack-domain-fixture',
      private: true,
      dependencies: { [name]: '1.0.0' },
    }),
  );
  const owner = join(root, 'node_modules', name);
  await mkdir(owner, { recursive: true });
  await writeFile(
    join(owner, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      type: 'module',
      exports: { [subpath]: { import: './cook.mjs' } },
    }),
  );
  await writeFile(join(owner, 'cook.mjs'), 'export const seed=23;');
  const source = join(root, 'domain.pack.ts');
  await writeFile(
    source,
    `import {seed} from '${specifier}';
   export default {schemaVersion:'2.0.0',packageId:new Uint8Array(16).fill(seed),build:()=>({ok:true,value:{}})};`,
  );
  const loaded = await loadScriptablePack(source, { metadataOnly: true });
  if (!loaded.ok) throw loaded.error;
  expect(Array.from(loaded.value.packageId)).toEqual(Array(16).fill(23));
});

it('does not resolve an undeclared author dependency from the Pack loader installation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-domain-missing-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'missing.pack.ts');
  await writeFile(source, "import 'typescript'; export default {};");
  expect(await loadScriptablePack(source, { metadataOnly: true })).toMatchObject({
    ok: false,
    error: {
      code: 'pack-module-not-found',
      detail: { sourcePath: source, specifier: 'typescript' },
    },
  });
  const scanned = await scanInventory([root]);
  if (scanned.ok) throw new Error('Expected the undeclared module to refuse inventory');
  expect(scanned.error.message).toContain(JSON.stringify(source));
  expect(scanned.error.message).toContain('"typescript"');
});
