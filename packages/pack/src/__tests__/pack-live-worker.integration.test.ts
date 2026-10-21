import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePackageId, resolvePackParameterValues } from '../pack-authoring';
import { executePackBuild } from '../pack-parameter-bindings';
import {
  createScriptablePackModuleExecutorPool,
  loadScriptablePack,
} from '../scriptable-pack-node';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const source = (body: string, imports = '') => `
import { definePack, definePackageId } from '@forgeax/engine-pack/source';
import { ok } from '@forgeax/engine-types';
${imports}
export default definePack({
  schemaVersion: '2.0.0', packageId: definePackageId('01900000-0000-7000-8000-000000000077'),
  parameters: [
    { name: 'radius', type: 'f32', default: 1 },
    { name: 'color', type: 'vec3', default: [0.123, 0.456, 0.789], apply: { asset: 'scene/main', path: ['entities','sun','components','DirectionalLight','color'] } },
  ],
  build(context) { ${body} }
});`;
const output = (intensity: string) =>
  `return ok({ 'scene/main': { kind: 'scene', entities: { sun: { components: { DirectionalLight: { intensity: ${intensity} } } } } } });`;
async function file(text: string) {
  const directory = await mkdtemp(join(tmpdir(), 'forgeax-live-worker-'));
  directories.push(directory);
  const path = join(directory, 'example.pack.ts');
  await writeFile(path, text);
  return path;
}

describe('live Pack generation isolation in the actual Worker', () => {
  it('cold-builds the Game3D scene with its schema imports and live defaults', async () => {
    const path = fileURLToPath(
      new URL('../../../../templates/game-3d/assets/scene.pack.ts', import.meta.url),
    );
    expect((await loadScriptablePack(path, { metadataOnly: true })).ok).toBe(true);
    const definition = (await loadScriptablePack(path)).unwrap();
    const result = await executePackBuild(definition, {
      packageId: definition.packageId,
      values: resolvePackParameterValues(definition, {}).unwrap(),
      readByGuid: vi.fn(),
    });
    expect(result.unwrap()['scene/showcase']).toMatchObject({
      kind: 'scene',
      entities: {
        sun: {
          components: {
            DirectionalLight: { color: [1, 0.98, 0.93], intensity: 3.2, castShadow: true },
          },
        },
      },
    });
  });

  it('keeps live values out of generation across reused Worker leases', async () => {
    const path = await file(
      source(
        output('Object.keys(context.values).length + ownPack.parameters.length'),
        "import ownPack from './example.pack.ts';",
      ),
    );
    const pool = createScriptablePackModuleExecutorPool({ maxWorkers: 1, maxTasksPerWorker: 2 });
    try {
      for (const color of [
        [0.2, 0.3, 0.4],
        [0.7, 0.8, 0.9],
      ]) {
        const definition = (
          await loadScriptablePack(path, { executor: await pool.acquire() })
        ).unwrap();
        const values = resolvePackParameterValues(definition, { color }).unwrap();
        const result = await executePackBuild(definition, {
          packageId: definition.packageId,
          values,
          readByGuid: vi.fn(),
        });
        expect(result.unwrap()['scene/main']).toMatchObject({
          entities: {
            sun: { components: { DirectionalLight: { intensity: 2, color } } },
          },
        });
      }
    } finally {
      await pool.dispose();
    }
  });

  it('removes live defaults from both the build context and self-imported module metadata', async () => {
    const path = await file(
      source(
        output('Object.keys(context.values).length + ownPack.parameters.length'),
        "import ownPack from './example.pack.ts';",
      ),
    );
    const definition = (await loadScriptablePack(path)).unwrap();
    const values = resolvePackParameterValues(definition, { color: [0.2, 0.3, 0.4] }).unwrap();
    const result = await executePackBuild(definition, {
      packageId: definePackageId('01900000-0000-7000-8000-000000000077'),
      values,
      readByGuid: vi.fn(),
    });
    expect(result.unwrap()['scene/main']).toMatchObject({
      entities: {
        sun: { components: { DirectionalLight: { intensity: 2, color: [0.2, 0.3, 0.4] } } },
      },
    });
  });

  it.each([
    ['filesystem', "import { readFileSync } from 'node:fs';", "readFileSync('example.pack.ts');"],
    ['raw module source', "import raw from './example.pack.ts?raw';", 'String(raw);'],
    ['ambient source loader', '', "globalThis.process.getBuiltinModule('fs');"],
    ['destructured constructor', '', 'const { constructor: escape } = () => {};'],
    ['reflection', '', 'Object.getPrototypeOf(() => {});'],
    [
      'runtime physics service',
      "import { registerPhysicsComponents } from '@forgeax/engine/physics';",
      'registerPhysicsComponents();',
    ],
    [
      'runtime skinning plugin',
      "import { skinningPlugin } from '@forgeax/engine/skinning';",
      'skinningPlugin();',
    ],
  ])('rejects %s before executing opted-in code', async (_name, imports, body) => {
    const path = await file(source(body + output('1'), imports));
    const loaded = await loadScriptablePack(path);
    expect(loaded.ok).toBe(false);
  });

  it('blocks computed constructor escapes and retains numeric array loops', async () => {
    const escaped = await file(
      source(
        `const key = ['con', 'structor'].join(''); const fn = (() => {})[key]; return fn('return process')();`,
      ),
    );
    const bad = (await loadScriptablePack(escaped)).unwrap();
    await expect(
      bad.build({ packageId: bad.packageId, values: { radius: 1 }, readByGuid: vi.fn() } as never),
    ).rejects.toThrow(/numeric dynamic indices/);
    const indexed = await file(
      source(
        `const array = new Float32Array(4); for (let index = 0; index < array.length; index++) array[index] = index; ${output('array[3]')}`,
      ),
    );
    const good = (await loadScriptablePack(indexed)).unwrap();
    expect(
      await good.build({
        packageId: good.packageId,
        values: { radius: 1 },
        readByGuid: vi.fn(),
      } as never),
    ).toMatchObject({
      ok: true,
      value: {
        'scene/main': { entities: { sun: { components: { DirectionalLight: { intensity: 3 } } } } },
      },
    });
  });

  it('terminates cancelled generation without waiting for its full build timeout', async () => {
    const path = await file(source('while (true) {}'));
    const controller = new AbortController();
    const definition = (
      await loadScriptablePack(path, { signal: controller.signal, buildTimeoutMs: 30_000 })
    ).unwrap();
    const running = definition.build({
      packageId: definition.packageId,
      values: { radius: 1 },
      readByGuid: vi.fn(),
    } as never);
    controller.abort(new Error('author input changed'));
    await expect(running).rejects.toThrow('author input changed');
  }, 5_000);
});
