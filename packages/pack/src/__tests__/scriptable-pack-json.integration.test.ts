import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  createScriptablePackModuleExecutorPool,
  createScriptablePackSourceSnapshot,
  inventoryScriptablePackSource,
  loadScriptablePack,
} from '../scriptable-pack-node.js';

it('loads JSON as data in the isolated Worker and inventories the original bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pack-json-'));
  try {
    const source = join(root, 'owner.pack.ts');
    const json = '{"__proto__":{"safe":true},"name":"fixture","list":[1,null,false]}';
    await writeFile(join(root, 'data.json'), json);
    await writeFile(
      source,
      `import config from './data.json';
      export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(1),
        build: () => ({ ok: true, value: { 'plugin/test': {
          kind: 'plugin', module: { specifier: './unused.ts' }, config
        } } }) };`,
    );
    const loaded = await loadScriptablePack(source);
    if (!loaded.ok) throw loaded.error;
    const output = await loaded.value.build({
      packageId: loaded.value.packageId,
      values: {},
      readByGuid: async () => {
        throw new Error('unexpected read');
      },
    });
    if (!output.ok) throw output.error;
    expect(output.value['plugin/test']).toMatchObject({ config: JSON.parse(json) });
    const inventory = await inventoryScriptablePackSource(source);
    const before = inventory.find((item) => item.path.endsWith('data.json'));
    expect(before?.digest).toBeTruthy();
    await writeFile(join(root, 'data.json'), '{"changed":true}');
    const after = (await inventoryScriptablePackSource(source)).find((item) =>
      item.path.endsWith('data.json'),
    );
    expect(after?.digest).not.toEqual(before?.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  'single',
  'reusable',
] as const)('keeps delayed JSON imports on captured bytes and cleans their %s Worker artifacts', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'pack-json-delayed-'));
  const source = join(root, 'owner.pack.ts');
  const data = join(root, 'data.json');
  const pool =
    mode === 'reusable'
      ? createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 2 })
      : undefined;
  const directories = new Set<string>();
  try {
    await writeFile(
      source,
      `export default { schemaVersion: '2.0.0', packageId: new Uint8Array(16).fill(1),
          async build() {
            const { default: config } = await import('./data.json');
            return { ok: true, value: { scene: { kind: 'scene', entities: {},
              config, negativeZero: Object.is(config.zero, -0), compiledFrom: import.meta.url,
            } } };
          } };`,
    );
    for (const name of ['first', 'second']) {
      await writeFile(
        data,
        `{"name":"${name}","__proto__":{"safe":true},"zero":-0,"overflow":1e400}`,
      );
      const loaded = await loadScriptablePack(source, {
        sourceSnapshot: createScriptablePackSourceSnapshot(),
        ...(pool === undefined ? {} : { executor: await pool.acquire() }),
      });
      if (!loaded.ok) throw loaded.error;
      await writeFile(data, '{"name":"changed after capture"}');
      const built = await loaded.value.build({
        packageId: loaded.value.packageId,
        readByGuid: async () => {
          throw new Error('unexpected asset read');
        },
      } as never);
      if (!built.ok) throw built.error;
      const scene = built.value.scene as unknown as {
        config: Record<string, unknown>;
        negativeZero: boolean;
        compiledFrom: string;
      };
      expect(scene.config).toEqual(
        JSON.parse(`{"name":"${name}","__proto__":{"safe":true},"zero":0,"overflow":null}`),
      );
      expect(scene.negativeZero).toBe(false);
      expect(Object.hasOwn(scene.config, '__proto__')).toBe(true);
      directories.add(dirname(fileURLToPath(scene.compiledFrom)));
    }
  } finally {
    await pool?.dispose();
    await rm(root, { recursive: true, force: true });
  }
  for (const directory of directories)
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
