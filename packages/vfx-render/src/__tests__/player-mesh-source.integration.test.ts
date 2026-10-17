import { MessageChannel } from 'node:worker_threads';
import {
  AssetRegistry,
  RuntimeMeshVertices,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Materials, MeshFilter } from '@forgeax/engine-render';
import { ShaderRegistry } from '@forgeax/engine-shader';
import {
  describeVfxGpuEffect,
  isVfxGpuEffectAsset,
  ParticleEffectPlayer,
  parseParticleEffectSourceV3,
  vfxGpuEffectPackLoader,
} from '@forgeax/engine-vfx';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { createVfxRuntimeHost } from '../host/vfx-runtime-host';
import { freezeVfxPlan, planPasses, planResources, singleViewContext } from './vfx-frame-fixture';

const source = (mesh: unknown = { source: 'player' }) => ({
  schemaVersion: 3,
  emitters: [
    {
      id: 'surface',
      capacity: 1,
      backend: { required: 'gpu' },
      space: 'local',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
      schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
      program: { module: 'static.wgsl' },
      renderers: [
        { kind: 'mesh', mesh, material: 'material', lighting: 'unlit', castShadows: false },
      ],
    },
  ],
});
const modules = {
  'static.wgsl': {
    entry: `
#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, p: ptr<function, VfxParticle>) {
  (*p).lifetime = 1.0;
  (*p).mesh_scale = vec3<f32>(1.0);
}
fn vfx_update(ctx: VfxUpdateContext, p: ptr<function, VfxParticle>) {}
`,
  },
};

it('cooks an explicit Player mesh source without a synthetic asset GUID', async () => {
  const cooked = (await cookParticleCodeEffect(source(), modules)).unwrap();
  expect(cooked.refs).toEqual(['material']);
  const effect = { ...cooked.asset, guid: 'effect' };
  if (!isVfxGpuEffectAsset(effect)) throw new Error('Expected the ordinary cooked effect');
  expect(effect.program.emitters[0]?.renderers[0]).toMatchObject({ mesh: { source: 'player' } });
  expect(describeVfxGpuEffect(effect).dependencies.filter((row) => row.kind === 'asset')).toEqual([
    expect.objectContaining({ identity: 'material' }),
  ]);
  for (const mesh of [{ source: 'world' }, { source: 'player', guid: 'mesh' }, {}, null]) {
    expect(parseParticleEffectSourceV3(source(mesh)).ok).toBe(false);
  }
});

async function fixture(programSource: 'raw' | 'loaded' = 'raw') {
  const world = new World();
  const leases = [MeshFilter, RuntimeMeshVertices].map((component) =>
    world.components.register(component).unwrap(),
  );
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  assets.catalog('material', Materials.unlit([1, 0.3, 0.1, 0.7])).unwrap();
  const host = createVfxRuntimeHost({
    camera: {
      read: () => ({
        position: new Float32Array(3),
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      }),
    },
  });
  (await host.attachWorld({ world, assets })).unwrap();
  const cooked = (await cookParticleCodeEffect(source(), modules)).unwrap();
  const definition =
    programSource === 'loaded'
      ? (
          await vfxGpuEffectPackLoader.load(
            {
              guid: 'effect',
              kind: 'particle-effect',
              payload: { ...cooked.asset },
              artifacts: {
                [cooked.artifact.artifactKey]: {
                  descriptor: { path: 'program.json', mediaType: cooked.artifact.mimeType },
                  bytes: cooked.artifact.bytes,
                },
              },
            },
            {} as never,
          )
        ).unwrap()
      : { ...cooked.asset, guid: 'effect' };
  const effect = world.allocSharedRef('ParticleEffectAsset', definition);
  const meshes = [createBoxGeometry(1, 1, 1).unwrap(), createBoxGeometry(3, 2, 1).unwrap()];
  const handles = meshes.map((mesh) => world.allocSharedRef('MeshAsset', mesh));
  const players = handles.map((assetHandle) =>
    world
      .spawn(
        { component: MeshFilter, data: { assetHandle } },
        { component: ParticleEffectPlayer, data: { effect, playing: true, timeScale: 0 } },
      )
      .unwrap(),
  );
  const [firstMesh] = meshes,
    [firstHandle] = handles,
    [firstPlayer] = players;
  if (firstMesh === undefined || firstHandle === undefined || firstPlayer === undefined)
    throw new Error('Expected the first fixture Player');
  const targets = [{ name: 'color', kind: 'color', format: 'rgba8unorm', sampleCount: 1 }] as const;
  let frameNumber = 0;
  const extract = () =>
    host.feature.extract({
      worlds: [world],
      owner: 0,
      views: [{ identity: 'main', render: true }],
      frameNumber: ++frameNumber,
    });
  const plan = (frame: Parameters<typeof host.feature.plan>[0]) =>
    host.feature.plan(
      frame,
      singleViewContext({
        targets,
        resolveAsset: (_index, handle) => resolveAssetHandle(world, handle),
        caps: {} as never,
        frame: { frameNumber },
        generation: 0,
        sceneData: {} as never,
      }),
    );
  return {
    first: { mesh: firstMesh, handle: firstHandle, player: firstPlayer },
    world,
    host,
    meshes,
    handles,
    players,
    targets,
    extract,
    plan,
    async dispose() {
      for (const player of players)
        if (world.hasComponent(player, ParticleEffectPlayer)) world.despawn(player).unwrap();
      (await host.detachWorld({ world })).unwrap();
      for (const handle of [...handles, effect]) world.sharedRefs.release(handle).unwrap();
      for (const lease of leases) lease.dispose();
      assets.clearCatalogSource();
    },
  };
}

async function transfer<T>(value: T): Promise<T> {
  const { port1, port2 } = new MessageChannel();
  try {
    return await new Promise<T>((resolve, reject) => {
      port2.once('message', resolve);
      port2.once('messageerror', reject);
      port1.postMessage(value);
    });
  } finally {
    port1.close();
    port2.close();
  }
}

it.each([
  'raw',
  'loaded',
] as const)('keeps two Player meshes independent through source transport and managed content replacement (%s program)', async (programSource) => {
  const f = await fixture(programSource);
  try {
    const first = f.extract().unwrap();
    const intent = first.worlds[0]?.intents[0];
    if (intent === undefined) throw new Error('Expected the first fixture intent');
    if (programSource === 'loaded') {
      expect(intent.inline).toBeUndefined();
      expect(intent.emitter.effect).toBeTypeOf('number');
      expect(f.host.feature.assetDependencies?.(first)).toEqual([
        'material',
        intent.emitter.effect,
      ]);
    } else {
      expect(intent).toMatchObject({ inline: true, emitter: { wgsl: expect.any(String) } });
      expect(f.host.feature.assetDependencies?.(first)).toEqual(['material']);
    }
    const initial = f.plan(await transfer(first)).unwrap();
    const programs = (plan: typeof initial) =>
      planResources(plan)
        .filter((resource) => resource.kind === 'compute-program')
        .map((resource) => resource.program);
    const initialPrograms = programs(initial);
    expect(initialPrograms).toHaveLength(programSource === 'loaded' ? 1 : 2);
    const repeatedPrograms = programs(f.plan(await transfer(f.extract().unwrap())).unwrap());
    expect(repeatedPrograms).toEqual(initialPrograms);
    for (let index = 0; index < initialPrograms.length; index++)
      expect(repeatedPrograms[index] === initialPrograms[index]).toBe(programSource === 'loaded');
    const programNames = planResources(initial)
      .filter((resource) => resource.kind === 'compute-program')
      .map((resource) => resource.name);
    const projections = planPasses(initial).flatMap((pass) =>
      pass.kind === 'compute'
        ? pass.dispatches.flatMap((dispatch) =>
            dispatch.entryPoint === 'forgeax_vfx_mesh_main'
              ? [{ program: pass.program, bindings: dispatch.bindings ?? pass.bindings }]
              : [],
          )
        : [],
    );
    const projectPrograms = projections.map((projection) => projection.program);
    expect(projectPrograms).toHaveLength(2);
    expect(new Set(projections.map((projection) => projection.bindings)).size).toBe(2);
    expect(projectPrograms.every((name) => programNames.includes(name))).toBe(true);
    expect(projectPrograms[0] === projectPrograms[1]).toBe(programSource === 'loaded');
    expect(freezeVfxPlan(f.host.feature.identity, initial, f.targets).ok).toBe(true);
    expect(planPasses(initial).filter((pass) => pass.kind === 'raster')).toHaveLength(1);
    expect(
      planPasses(initial).flatMap((pass) => (pass.kind === 'raster' ? pass.draws : [])),
    ).toHaveLength(2);
    const geometry = (plan: typeof initial) =>
      planResources(plan)
        .filter((resource) => resource.kind === 'buffer')
        .filter((resource) => resource.name.endsWith('.geometry-buffer'));
    const before = geometry(initial);
    expect(before).toHaveLength(2);
    expect(before[0]?.data).toBeInstanceOf(Float32Array);
    expect(before[0]?.data).not.toEqual(before[1]?.data);
    const vertices = new Float32Array(f.first.mesh.vertices);
    const firstX = vertices[0];
    if (firstX === undefined) throw new Error('Expected non-empty geometry');
    vertices[0] = firstX + 0.2;
    const content = f.world
      .spawn({
        component: RuntimeMeshVertices,
        data: { asset: f.first.handle, vertices: Array.from(vertices) },
      })
      .unwrap();
    const replacement = geometry(f.plan(await transfer(f.extract().unwrap())).unwrap());
    expect(replacement[0]?.data).not.toEqual(before[0]?.data);
    expect(replacement[1]).toEqual(before[1]);
    f.world.despawn(content).unwrap();
    expect(geometry(f.plan(await transfer(f.extract().unwrap())).unwrap())).toEqual(before);
    f.world.despawn(f.first.player).unwrap();
    expect(
      planPasses(f.plan(await transfer(f.extract().unwrap())).unwrap()).filter(
        (pass) => pass.kind === 'raster',
      ),
    ).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

it('reports a missing Player MeshFilter at the owning extraction boundary', async () => {
  const f = await fixture();
  try {
    f.world.removeComponent(f.first.player, MeshFilter).unwrap();
    const result = f.extract();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatchObject({
        detail: {
          stage: 'extract',
          cause: expect.objectContaining({ code: 'component-not-present' }),
        },
      });
    f.world
      .addComponent(f.first.player, {
        component: MeshFilter,
        data: { assetHandle: f.first.handle },
      })
      .unwrap();
    expect(
      planPasses(f.plan(f.extract().unwrap()).unwrap()).flatMap((pass) =>
        pass.kind === 'raster' ? pass.draws : [],
      ),
    ).toHaveLength(2);
  } finally {
    await f.dispose();
  }
});
