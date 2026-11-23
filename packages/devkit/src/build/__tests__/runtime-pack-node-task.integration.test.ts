import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assembleRuntimePacks, createAssetRuntimeAssembly } from '@forgeax/engine-app';
import { AssetRegistry, createCatalogSource } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { runtimePackTaskKinds } from '@forgeax/engine-import';
import { preparePackProgram } from '@forgeax/engine-pack/runtime';
import { AssetGuid, definePackageId } from '@forgeax/engine-pack/source';
import { createTaskPool } from '@forgeax/engine-platform';
import { expect, it } from 'vitest';
import { createDesktopRuntimePackTasks } from '../desktop-platform.js';
import { createNodePackProgramHost } from '../pack-program-host.js';
import { createNodePackProgramImports } from '../pack-program-imports.js';

it.each([
  'instance',
  'authored',
  'authored-inline',
  'authored-inline-pool',
  'authored-worker-required',
] as const)('routes a native multi-module %s Pack to its selected realm', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-node-task-pack-'));
  const workerModule = new URL(
    `data:text/javascript,${encodeURIComponent(`
      import { parentPort } from 'node:worker_threads';
      import { runtimePackTaskKinds } from ${JSON.stringify(import.meta.resolve('@forgeax/engine-import'))};
      import { serveTaskWorker } from ${JSON.stringify(import.meta.resolve('@forgeax/engine-platform'))};
      serveTaskWorker(parentPort, runtimePackTaskKinds);
    `)}`,
  );
  const useWorker = mode === 'instance' || mode === 'authored';
  const inlinePool = mode === 'authored-inline-pool';
  const tasks = inlinePool
    ? createTaskPool({ kinds: runtimePackTaskKinds })
    : createDesktopRuntimePackTasks(workerModule.href);
  const assets = new AssetRegistry();
  const context = await createWorldContext(new World({ assets }), []);
  const assembly = createAssetRuntimeAssembly(assets, {
    catalogSource: createCatalogSource({ entries: [] }),
  }).unwrap();
  try {
    const imports = await createNodePackProgramImports(
      resolve(import.meta.dirname, '../../../../..'),
      ['@forgeax/engine/geometry', '@forgeax/engine/types', 'node:worker_threads'],
    );
    const generatorId = '01900000-0000-7000-8000-000000000971';
    const instanceId = '01900000-0000-7000-8000-000000000972';
    const artifact = preparePackProgram({
      entry: 'entry.js',
      export: 'build',
      modules: {
        'entry.js': `
          import { isMainThread } from 'node:worker_threads';
          import { ok } from '@forgeax/engine/types';
          import { box } from './shape.js';
          if (isMainThread !== ${!useWorker} || !import.meta.url.startsWith('file:'))
            throw new Error('Expected the native module to load in its selected realm');
          export function build({ values }) { return ok({ box: box(values?.width ?? 4) }); }
        `,
        'shape.js': `
          import { createBoxGeometry } from '@forgeax/engine/geometry';
          export const box = (width) => createBoxGeometry(width, 1, 1).unwrap();
        `,
      },
      imports: Object.fromEntries(
        Object.entries(imports).map(([specifier, binding]) => [specifier, binding.identity]),
      ),
    }).unwrap();
    const source = {
      schemaVersion: '2.0.0',
      kind: 'scriptable-pack-source',
      source: 'entry.js',
      program: 'node-task',
      packageId: generatorId,
    } as const;
    const authored =
      mode !== 'instance'
        ? [
            {
              source: {
                ...source,
                packageId: instanceId,
                runtime: {
                  export: 'build',
                  outputs: { box: 'mesh' },
                  dependencies: [],
                  ...(mode === 'authored-worker-required'
                    ? { execution: 'task-worker' as const }
                    : {}),
                },
              } as const,
              program: artifact,
            },
          ]
        : [];
    const runtime = assembleRuntimePacks(context, assembly, {
      scopeId: 'node-task-pack',
      authored,
      ...(useWorker || inlinePool ? { tasks } : {}),
      imports,
      programHost: createNodePackProgramHost(root),
    });
    if (mode === 'instance') {
      const admitted = (
        await runtime.producer.admit({
          source: {
            ...source,
            parameters: [{ name: 'width', type: 'f32', default: 2, minimum: 1, maximum: 9 }],
            runtime: { execution: 'task-worker', dependencies: [] },
          },
          programs: { 'node-task': { artifact } },
        })
      ).unwrap();
      expect(admitted.rows).toEqual([]);
      const generated = (
        await runtime.producer.generate({
          schemaVersion: '3.0.0',
          parent: generatorId,
          packageId: instanceId,
          values: { width: 4 },
        })
      ).unwrap();
      expect(generated.rows).toHaveLength(1);
    }
    const guid = AssetGuid.format(AssetGuid.derive(definePackageId(instanceId), 'box'));
    if (mode === 'authored-worker-required') {
      expect(await assets.load(guid, 'mesh')).toMatchObject({
        ok: false,
        error: {
          code: 'asset-package-invalid',
          detail: { reason: expect.stringContaining('runtime-pack-execution-failed') },
        },
      });
      expect(runtime.producer.rows()).toEqual([]);
      return;
    }
    const handle = (await assets.load(guid, 'mesh')).unwrap();
    const mesh = assets.read(handle).unwrap();
    expect(mesh.vertices).toBeInstanceOf(Float32Array);
    expect(mesh.aabb).toEqual(new Float32Array([-2, -0.5, -0.5, 2, 0.5, 0.5]));
    assets.release(handle).unwrap();
  } finally {
    tasks.dispose();
    assets.clearCatalogSource();
    await context.fiber.dispose();
    assembly.dispose();
    assets.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
