import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createScriptablePackProductCache,
  createStandardAssetOutputProducerRegistry,
  produceScriptablePackProducts,
} from '@forgeax/engine-import';
import { scanInventory } from '@forgeax/engine-pack/scanner';
import {
  createScriptablePackSourceSnapshot,
  loadScriptablePack,
} from '@forgeax/engine-pack/source-node';
import { expect, it } from 'vitest';
import { discoverPluginAssets } from '../build/plugin-assets.js';

async function fixture(failure: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'plugin-bootstrap-batch-'));
  await mkdir(join(root, '.forgeax'));
  const events = join(root, '.forgeax', 'events.log');
  await writeFile(events, '');
  await writeFile(join(root, 'runtime.ts'), 'export default { apply() {} };');
  const sources = Array.from({ length: failure ? 4 : 8 }, (_, index) =>
    join(root, `${index}.pack.ts`),
  );
  for (const [index, path] of sources.entries()) {
    await writeFile(
      path,
      `import { appendFileSync, readFileSync } from 'node:fs';
      const events = ${JSON.stringify(events)};
      const index = ${index};
      globalThis.bootstrapVisits = (globalThis.bootstrapVisits ?? 0) + 1;
      const delay = () => new Promise(resolve => setTimeout(resolve, 5));
      export default {
        schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(index + 1),
        async build(context) {
          appendFileSync(events, JSON.stringify({ stage: 'begin', index, visits: globalThis.bootstrapVisits }) + '\\n');
          const entries = () => readFileSync(events, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse);
          while (entries().filter(row => row.stage === 'begin' && Math.floor(row.index / 4) === Math.floor(index / 4)).length < 4) await delay();
          while (index % 4 < 3 && !entries().some(row => row.stage === 'end' && row.index === index + 1)) await delay();
          appendFileSync(events, JSON.stringify({ stage: 'end', index }) + '\\n');
          ${failure ? "if (index === 3) throw new Error('later-build-failure');" : ''}
          if (index === 2) {
            await context.readByGuid(new Uint8Array(16).fill(9));
            return { ok: false, error: 'blocked-input' };
          }
          return { ok: true, value: { plugin: {
            kind: 'plugin', module: ${failure ? "index === 0 ? {} : { specifier: './runtime.ts' }" : "{ specifier: './runtime.ts' }"}, config: { index }
          } } };
        }
      };`,
    );
  }
  return { root, sources, events };
}

it('settles bounded isolated bootstrap work before committing source order and deferred reads', async () => {
  const f = await fixture(false);
  try {
    const inventory = await discoverPluginAssets({ root: f.root, assetRoots: f.sources });
    expect([...inventory.assets.values()].map((record) => record.sourcePath)).toEqual([
      f.sources[0],
      f.sources[1],
      f.sources[3],
      ...f.sources.slice(4),
    ]);
    expect(inventory.deferred).toEqual(['2.pack.ts']);
    const events = (await readFile(f.events, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.filter((row) => row.stage === 'end').map((row) => row.index)).toEqual([
      3, 2, 1, 0, 7, 6, 5, 4,
    ]);
    let active = 0;
    let peak = 0;
    for (const row of events) {
      active += row.stage === 'begin' ? 1 : -1;
      peak = Math.max(peak, active);
    }
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(events.filter((row) => row.stage === 'begin').every((row) => row.visits === 1)).toBe(
      true,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);

it('discovers plugin sources from the verified Pack product without executing build again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-bootstrap-ddc-'));
  const sourcePath = join(root, 'plugin.pack.ts');
  const events = join(root, '.forgeax', 'builds.log');
  try {
    await mkdir(join(root, '.forgeax'));
    await writeFile(events, '');
    await writeFile(join(root, 'package.json'), '{"name":"plugin-bootstrap-ddc","type":"module"}');
    await writeFile(join(root, 'runtime.ts'), 'export default { apply() {} };');
    const writeSource = async (value: number) =>
      writeFile(
        sourcePath,
        `import { appendFileSync } from 'node:fs';
         export default {
           schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(1),
           build() {
             appendFileSync(${JSON.stringify(events)}, 'build\\n');
             return { ok: true, value: { 'plugin/main': {
               kind: 'plugin', module: { specifier: './runtime.ts' }, config: { value: ${value} }
             } } };
           }
         };`,
      );
    const scan = async () => {
      const sourceSnapshot = createScriptablePackSourceSnapshot();
      const inventory = await scanInventory([sourcePath], {
        scriptablePack: { metadataOnly: true, sourceSnapshot },
      });
      if (!inventory.ok) throw inventory.error;
      return { inventory: inventory.value, sourceSnapshot };
    };
    await writeSource(1);
    const first = await scan();
    const declaration = first.inventory.declarations.get(sourcePath);
    if (declaration?.format !== 'pack.ts') throw new Error('Pack source required');
    const outputVersions = createStandardAssetOutputProducerRegistry().versions();
    const cacheRoot = join(root, '.forgeax', 'ddc');
    const produced = await produceScriptablePackProducts({
      sources: [
        {
          definition: (await loadScriptablePack(sourcePath)).unwrap(),
          sourcePath,
          displaySourcePath: sourcePath,
          sourceClosure: declaration.sourceClosure,
          publicationGeneration: 1,
          policy: {
            base: '/',
            packagePath: 'plugin.pack.json',
            artifactPath: (guid, key) => `${guid}/${key}`,
          },
        },
      ],
      buildCacheRoot: cacheRoot,
    });
    expect(produced.ok, produced.ok ? '' : JSON.stringify(produced.error)).toBe(true);
    const productCache = await createScriptablePackProductCache({
      root: cacheRoot,
      outputVersions,
      cookers: [],
    });
    const facts = { root, assetRoots: [sourcePath] };
    const warm = await discoverPluginAssets(
      facts,
      first.inventory,
      first.sourceSnapshot,
      productCache,
    );
    expect([...warm.assets.values()][0]?.source.config).toEqual({ value: 1 });
    expect(await readFile(events, 'utf8')).toBe('build\n');
    await writeSource(2);
    const changed = await scan();
    const refreshed = await discoverPluginAssets(
      facts,
      changed.inventory,
      changed.sourceSnapshot,
      productCache,
    );
    expect([...refreshed.assets.values()][0]?.source.config).toEqual({ value: 2 });
    expect(await readFile(events, 'utf8')).toBe('build\nbuild\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it('retains the earlier source validation failure after later parallel builds reject', async () => {
  const f = await fixture(true);
  try {
    await expect(
      discoverPluginAssets({ root: f.root, assetRoots: f.sources }),
    ).rejects.toMatchObject({
      code: 'plugin-source-invalid',
      detail: { path: '$.module.specifier' },
    });
    const events = (await readFile(f.events, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.filter((row) => row.stage === 'end').map((row) => row.index)).toEqual([
      3, 2, 1, 0,
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 30_000);
