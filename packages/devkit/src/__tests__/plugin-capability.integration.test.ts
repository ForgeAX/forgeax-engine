import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetOutputProducerRegistry, buildScriptablePack } from '@forgeax/engine-import';
import { loadScriptablePack } from '@forgeax/engine-pack/source-node';
import { expect, it } from 'vitest';
import { discoverPluginAssets } from '../build/plugin-assets.js';

it('does not execute ordinary resource builds while discovering plugins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-capability-resources-'));
  try {
    await writeFile(
      join(root, 'resource.pack.ts'),
      `export default {schemaVersion:'2.0.0',packageId:new Uint8Array(16).fill(1),build(){throw new Error('Resource production must not run during plugin discovery');}};`,
    );
    const result = await discoverPluginAssets({ root, assetRoots: [root] });
    expect(result.assets.size).toBe(0);
    expect(result.deferred).toEqual([]);
    const definition = (await loadScriptablePack(join(root, 'resource.pack.ts'))).unwrap();
    const production = await buildScriptablePack({
      definition,
      sourcePath: join(root, 'resource.pack.ts'),
      outputs: new AssetOutputProducerRegistry(),
    });
    expect(production).toMatchObject({ ok: false, error: { code: 'import-internal-error' } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('executes explicitly declared plugin producers and keeps source-only deferred reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-capability-declared-'));
  try {
    await writeFile(join(root, 'runtime.ts'), 'export default {apply(){}};');
    await writeFile(
      join(root, 'plugin.pack.ts'),
      `export default {schemaVersion:'2.0.0',plugins:true,packageId:new Uint8Array(16).fill(2),build(){return {ok:true,value:{'plugin/main':{kind:'plugin',module:{specifier:'./runtime.ts'}}}};}};`,
    );
    await writeFile(
      join(root, 'deferred.pack.ts'),
      `export default {schemaVersion:'2.0.0',plugins:true,packageId:new Uint8Array(16).fill(3),async build(context){return await context.readByGuid(new Uint8Array(16).fill(4));}};`,
    );
    const result = await discoverPluginAssets({ root, assetRoots: [root] });
    expect(result.assets.size).toBe(1);
    expect(result.deferred).toEqual(['deferred.pack.ts']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
