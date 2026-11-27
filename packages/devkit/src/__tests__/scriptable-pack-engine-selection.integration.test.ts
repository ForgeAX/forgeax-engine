import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScriptablePackSourceSnapshot } from '@forgeax/engine-pack/source-node';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverPluginAssets } from '../build/plugin-assets.js';
import { localEnginePackageRoot } from '../engine-binding.js';
import { readProjectFacts } from '../project.js';
import { scanProjectSources } from '../project-source-scan.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(symbol: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-pack-engine-selection-')));
  roots.push(root);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
  await writeFile(
    join(root, 'forge.json'),
    JSON.stringify({
      schemaVersion: '3.0.0',
      id: 'fixture',
      name: 'Fixture',
      roots: {},
      assetRoots: ['assets'],
    }),
  );
  await writeFile(join(root, 'assets/runtime.ts'), 'export default {apply(){}};');
  await writeFile(
    join(root, 'assets/plugin.pack.ts'),
    `import {${symbol}} from '@forgeax/engine/types';
export default {schemaVersion:'2.0.0',plugins:true,packageId:new Uint8Array(16).fill(7),
build:()=>({ok:true,value:{[${symbol}]:{kind:'plugin',module:{specifier:'./runtime.ts',export:'default'}}}})};`,
  );
  const npm = join(root, 'node_modules/@forgeax/engine');
  const local = join(root, 'selected/packages/engine');
  for (const [path, source] of [
    [npm, "export const commonVersion='npm';"],
    [local, "export const commonVersion='local';export const newApi='new-local-api';"],
  ]) {
    if (!path || !source) throw new Error('missing fixture row');
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine',
        type: 'module',
        exports: { './package.json': './package.json', './types': './types.mjs' },
      }),
    );
    await writeFile(join(path, 'types.mjs'), source);
  }
  const facts = await readProjectFacts(root);
  if (!facts.ok) throw facts.error;
  return { root, local, facts: facts.value };
}

describe('ScriptablePack official Engine selection', () => {
  it('keeps the installed npm package when no local binding exists', async () => {
    const { root, facts } = await fixture('commonVersion');
    expect(await localEnginePackageRoot(root)).toBeUndefined();
    const sources = await discoverPluginAssets(facts);
    expect([...sources.assets.values()].map((row) => row.sourceKey)).toEqual(['npm']);
  });

  it('uses a newly exported local API for both metadata and lazy bootstrap despite an older npm install', async () => {
    const { root, local, facts } = await fixture('newApi');
    expect((await scanProjectSources(facts, [join(root, 'assets')])).ok).toBe(false);
    await mkdir(join(root, '.forgeax'), { recursive: true });
    await writeFile(
      join(root, '.forgeax/engine-binding.json'),
      JSON.stringify({ schemaVersion: '1.0.0', path: join(root, 'selected') }),
    );
    expect(await localEnginePackageRoot(root)).toBe(await realpath(local));
    const snapshot = createScriptablePackSourceSnapshot();
    const scanned = await scanProjectSources(facts, [join(root, 'assets')], {
      sourceSnapshot: snapshot,
    });
    expect(scanned.ok, scanned.ok ? '' : JSON.stringify(scanned.error)).toBe(true);
    if (!scanned.ok) return;
    const sources = await discoverPluginAssets(facts, scanned.value, snapshot);
    expect([...sources.assets.values()].map((row) => row.sourceKey)).toEqual(['new-local-api']);
  });
});
