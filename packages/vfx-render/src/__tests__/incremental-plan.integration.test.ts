import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import {
  ParticleEffectPlayer,
  particleEffectContribution,
  prepareVfxGpuEffect,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../../../render/src/features/host';
import { createRenderFeatureGpuWorkOwner } from '../../../render/src/features/prepared-gpu-work';
import type { RenderFeatureWork } from '../../../render/src/features/types';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';

type Camera = {
  position: Float32Array;
  right: Float32Array;
  up: Float32Array;
  viewProjection: Float32Array;
};
const camera = (x = 0): Camera => ({
  position: new Float32Array(3),
  right: new Float32Array([1, 0, 0]),
  up: new Float32Array([0, 1, 0]),
  viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]),
});

/** Real cooked effect, real runtime and Host; ordinary plans stay inspectable. */
async function fixture(players = 4) {
  const cooked = (
    await cookParticleCodeEffect(
      {
        schemaVersion: 3,
        emitters: ['spark', 'glow'].map((id) => ({
          id,
          capacity: 16,
          backend: { required: 'gpu' as const },
          space: 'world' as const,
          schedule: { rate: 60 },
          bounds: {
            kind: 'sphere' as const,
            center: [0, 0, 0] as [number, number, number],
            radius: 1,
          },
          program: { module: 'body' },
          renderers: [{ kind: 'billboard' as const, material: 'material' }],
        })),
      },
      {
        body: {
          entry: `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>){(*p).lifetime=1.0;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>){(*p).age+=ctx.delta;}`,
        },
      },
    )
  ).unwrap();
  const effect = (
    await prepareVfxGpuEffect({
      guid: '019e2cc6-0c86-79da-aa76-b0984c86d460',
      kind: 'particle-effect',
      payload: cooked.asset as unknown as Record<string, unknown>,
      artifacts: {
        'particle-effect/program.json': {
          descriptor: {
            path: 'program.json',
            mediaType: 'application/vnd.forgeax.vfx-program+json',
          },
          bytes: cooked.artifact.bytes,
        },
      },
    })
  ).unwrap();
  const assets = new AssetRegistry();
  assets.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
  const material = assets
    .create({
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'forgeax::unlit' } }],
      values: { baseColor: [1, 1, 1, 1] },
    })
    .unwrap();
  const world = new World({ assets });
  const handle = assets
    .create({
      ...effect,
      program: {
        ...effect.program,
        emitters: effect.program.emitters.map((emitter) => ({
          ...emitter,
          renderers: emitter.renderers.map((renderer) => ({ ...renderer, material })),
        })),
      },
    })
    .unwrap();
  const spawned = Array.from({ length: players }, (_, seed) =>
    world.spawn({ component: ParticleEffectPlayer, data: { effect: handle, seed } }).unwrap(),
  );
  const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const shader = (await rhi.createShaderModule(device, { code: 'structural' })).unwrap();
  const gpu = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  let current = camera();
  const raw = gpuParticleRenderFeature({ camera: { read: () => current } });
  let work: readonly RenderFeatureWork[] = [];
  const feature = {
    ...raw,
    plan(source: Parameters<typeof raw.plan>[0], input: Parameters<typeof raw.plan>[1]) {
      const planned = raw.plan(source, input);
      if (planned.ok) work = planned.value.work;
      return planned;
    },
  };
  const host = createRenderFeatureHost([feature]).unwrap();
  const resolved: number[] = [];
  /** Optional replacement object for the effect version the resolver returns. */
  let replacement: object | undefined;
  let frameNumber = 0;
  const frame = (options: { camera?: Camera; generation?: number } = {}) => {
    current = options.camera ?? current;
    world.update(1 / 60).unwrap();
    resolved.length = 0;
    const batch = runRenderFeatureFrame(host, [
      {
        identity: 'main',
        render: true,
        worlds: [world],
        owner: 0,
        frameNumber: ++frameNumber,
        generation: options.generation ?? 0,
        caps: device.caps,
        gpuWork: gpu,
        selectedView: current,
        resolveAsset: (_index, asset, revision) => {
          resolved.push(Number(asset));
          const result = runtimeAssets(world.assets).resolveAsset(asset, revision);
          return Number(asset) === Number(handle) && replacement !== undefined && result.ok
            ? ok(replacement as typeof result.value)
            : result;
        },
      },
    ]);
    expect(batch.frame.errors).toEqual([]);
    for (const view of batch.views.values()) expect(view.errors).toEqual([]);
    batch.frame.onSubmitted();
    for (const view of batch.views.values()) view.onSubmitted();
    batch.onSubmitted();
    for (const lease of batch.preparedResourceBatches) lease.release().unwrap();
    return work;
  };
  return {
    world,
    runtime,
    handle,
    spawned,
    resolved,
    frame,
    replace(next: object | undefined) {
      replacement = next;
    },
    effect: () => runtimeAssets(world.assets).resolveAsset(handle).unwrap(),
    async close() {
      gpu.dispose().unwrap();
      host.dispose().unwrap();
      await context.fiber.dispose();
      assets.dispose();
    },
  };
}

const computePrograms = (work: readonly RenderFeatureWork[]) =>
  [
    ...new Set(
      work.flatMap((row) =>
        row.resources.filter((r) => r.kind === 'compute-program').map((r) => r.name),
      ),
    ),
  ].sort();
const visibleDraws = (work: readonly RenderFeatureWork[]) =>
  work
    .flatMap((row) => row.passes)
    .filter((pass) => pass.kind === 'raster' && pass.enabled !== false)
    .flatMap((pass) => (pass.kind === 'raster' ? pass.draws : []))
    .filter((draw) => draw.enabled !== false).length;
const groupNames = (work: readonly RenderFeatureWork[]) =>
  [
    ...new Set(
      work.flatMap((row) =>
        row.resources.flatMap((r) => {
          const match = /^vfx\.w-[^.]+\.a-[^.]+\.r-\d+\.p-[^.]+\.e-[^.]+/.exec(r.name);
          return match === null ? [] : [match[0]];
        }),
      ),
    ),
  ].sort();

it('resolves each exact effect version once per plan, independent of live rows', async () => {
  const f = await fixture(6);
  try {
    f.frame();
    f.frame();
    // 6 players x 2 emitters of live state, queued ticks and retained rows.
    f.frame();
    expect(f.resolved.filter((asset) => asset === Number(f.handle))).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it('re-derives emitters when the resolver returns a different object for the same version', async () => {
  const f = await fixture();
  try {
    f.frame();
    const before = computePrograms(f.frame());
    expect(before.length).toBeGreaterThan(0);
    expect(computePrograms(f.frame())).toEqual(before);
    // Same handle and revision, new immutable owner: every derived row is rebuilt.
    f.replace(structuredClone(f.effect()));
    const replaced = computePrograms(f.frame());
    expect(replaced).not.toEqual(before);
    expect(computePrograms(f.frame())).toEqual(replaced);
  } finally {
    await f.close();
  }
});

it('recomputes visibility from each frame camera while reusing resolution', async () => {
  const f = await fixture();
  try {
    f.frame({ camera: camera() });
    expect(visibleDraws(f.frame({ camera: camera() }))).toBeGreaterThan(0);
    // Translate the frustum far from the origin-bounded emitters.
    expect(visibleDraws(f.frame({ camera: camera(100) }))).toBe(0);
    expect(visibleDraws(f.frame({ camera: camera(100) }))).toBe(0);
    expect(visibleDraws(f.frame({ camera: camera() }))).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

it('renames stream storage for a new render generation and keeps it stable within one', async () => {
  const f = await fixture();
  try {
    f.frame();
    const first = groupNames(f.frame());
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((name) => name.includes('.r-0.'))).toBe(true);
    expect(groupNames(f.frame())).toEqual(first);
    f.runtime.recover();
    f.frame({ generation: 1 });
    const recovered = groupNames(f.frame({ generation: 1 }));
    expect(recovered.length).toBeGreaterThan(0);
    expect(recovered.every((name) => name.includes('.r-1.'))).toBe(true);
    expect(groupNames(f.frame({ generation: 1 }))).toEqual(recovered);
  } finally {
    await f.close();
  }
});

it('keeps live stream names while retiring departed players', async () => {
  const f = await fixture(3);
  try {
    f.frame();
    const all = groupNames(f.frame());
    const [gone] = f.spawned;
    if (gone === undefined) throw new Error('Missing fixture player');
    f.world.despawn(gone).unwrap();
    for (let index = 0; index < 12; index++) f.frame();
    const live = groupNames(f.frame());
    expect(live.length).toBeLessThan(all.length);
    // Surviving players keep their exact storage names across retirement.
    expect(live.every((name) => all.includes(name))).toBe(true);
  } finally {
    await f.close();
  }
});
