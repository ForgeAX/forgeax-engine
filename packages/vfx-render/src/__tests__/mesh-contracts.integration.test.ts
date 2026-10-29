import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { MeshAsset, ParticleEffectAsset } from '@forgeax/engine-types';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import {
  MESH_GEOMETRY_MATERIAL_INSTANCE_VERTEX_BUFFERS,
  particleMaterialInputVertexBuffers,
} from '../../../render/src/assembly/webgpu-vertex-layouts';
import { runtimeEffectFixture } from '../../../vfx/src/__tests__/runtime-effect-fixture';
import {
  gpuParticleRenderFeature,
  planPasses,
  planResources,
  singleViewContext,
  freezeVfxPlan as validateRenderFeaturePlan,
} from './vfx-frame-fixture';

const inputs = [{ name: 'heat', type: 'vec4<f32>', visibility: 'vertex', lane: 0 }] as const;
const modules = {
  'mesh.wgsl': {
    entry: `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
struct VfxCustom { heat: vec4<f32>, order: f32, };
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function,VfxParticle>, custom: ptr<function,VfxCustom>) { (*particle).lifetime = 10.0; (*custom).heat = vec4<f32>(1.0); (*custom).order = 1.0; }
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function,VfxParticle>, custom: ptr<function,VfxCustom>) {}`,
  },
};
function emitter(
  id: string,
  capacity = 4,
  renderer: Record<string, unknown> = { kind: 'billboard', material: 'material' },
) {
  return {
    id,
    capacity,
    backend: { required: 'gpu' },
    space: 'world',
    bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
    schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
    program: { module: 'mesh.wgsl' },
    renderers: [renderer],
  };
}
function mesh(indices = new Uint16Array([0, 1, 2]) as Uint16Array | Uint32Array): MeshAsset {
  return {
    kind: 'mesh',
    vertices: new Float32Array(108),
    attributes: {
      position: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]),
      normal: new Float32Array(18),
      uv: new Float32Array(12),
      tangent: new Float32Array(24),
      color: new Float32Array(Array.from({ length: 24 }, (_, i) => i / 24)),
      uv1: new Float32Array(Array.from({ length: 12 }, (_, i) => i / 12)),
    },
    indices,
    submeshes: [
      {
        indexOffset: 0,
        indexCount: indices.length,
        vertexCount: 6,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'Default' }],
  };
}
async function fixture(
  emitters: ReturnType<typeof emitter>[],
  geometry = mesh(),
  isConsumed = () => true,
) {
  const cooked = (
    await cookParticleCodeProgram({ schemaVersion: 3, emitters }, modules, { material: inputs })
  ).unwrap();
  const asset: ParticleEffectAsset = {
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: cooked.fingerprint,
    emitters: emitters.map(({ id, capacity }) => ({ id, capacity })),
    program: { ...cooked.program, fingerprint: cooked.fingerprint },
  };
  const world = new World({ assets: new AssetRegistry() });
  const handle = runtimeAssetRegistry(world.assets)
    .create(runtimeEffectFixture(world, { ...asset, guid: 'effect' }))
    .unwrap();
  const player = world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
    })
    .unwrap();
  const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const feature = gpuParticleRenderFeature({
    playerConsumption: { isEnabled: isConsumed },
    mesh: { read: () => geometry },
    material: { read: () => ({ kind: 'material', particleInputs: inputs }) },
    camera: {
      read: () => ({
        position: new Float32Array(3),
        right: new Float32Array([1, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      }),
    },
  });
  const targets = [{ name: 'color', kind: 'color', format: 'rgba8unorm', sampleCount: 1 }] as const;
  let frameNumber = 0;
  const frame = (leadingWorld?: World, generation = 0) => {
    const extracted = feature
      .extract({
        worlds: leadingWorld === undefined ? [world] : [leadingWorld, world],
        owner: 0,
        views: [{ identity: 'main', render: true }],
        frameNumber: ++frameNumber,
      })
      .unwrap();
    const plan = feature
      .plan(
        extracted,
        singleViewContext({
          targets,
          caps: {} as never,
          frame: { frameNumber },
          generation,
          sceneData: {} as never,
          ...(leadingWorld === undefined
            ? {}
            : {
                materialShaderBindingContract: () => ({ bindings: 'render-material' as const }),
              }),
        }),
      )
      .unwrap();
    expect(validateRenderFeaturePlan(feature.identity, plan, targets).ok).toBe(true);
    return { plan, submit: () => feature.onFrameSubmitted?.(extracted) };
  };
  world.update(1 / 60).unwrap();
  return { world, player, runtime, frame, dispose: () => context.fiber.dispose() };
}

it('keeps material scope in the original composition when a preceding World has no VFX', async () => {
  const f = await fixture([emitter('world-isolation')]);
  try {
    const { plan } = f.frame(new World({ assets: new AssetRegistry() }));
    const bindings = planResources(plan).filter(
      (resource) => resource.kind === 'graphics-bindings' && resource.values.group === 1,
    );
    expect(bindings.length).toBeGreaterThan(0);
    for (const resource of bindings)
      expect(resource).toMatchObject({ values: { material: { world: 1 } } });
  } finally {
    await f.dispose();
  }
});

it.each([4, 8])('keeps full emitter identities independent at capacity %s', async (capacity) => {
  const f = await fixture([
    emitter('fire-ground.comic-fissure-core'),
    emitter('fire-ground.comic-fissure-glow', capacity),
  ]);
  const names = (frame: ReturnType<typeof f.frame>) =>
    planResources(frame.plan)
      .filter((r) => r.name.endsWith('.particles'))
      .map((r) => r.name);
  try {
    const first = f.frame();
    expect(names(first)).toHaveLength(2);
    expect(new Set(names(first)).size).toBe(2);
    expect(planPasses(first.plan).filter((p) => p.kind === 'raster')).toHaveLength(1);
    expect(
      planPasses(first.plan).flatMap((p) => (p.kind === 'raster' ? p.draws : [])),
    ).toHaveLength(2);
    const retry = f.frame();
    expect(names(retry)).toEqual(names(first));
    retry.submit();
    const retained = f.frame();
    expect(names(retained)).toEqual(names(first));
    retained.submit();
    f.world.update(1 / 60).unwrap();
    const next = f.frame();
    expect(names(next)).toEqual(names(first));
    next.submit();
    f.runtime.replay(f.player);
    f.world.update(1 / 60).unwrap();
    const replay = f.frame();
    expect(names(replay)).toHaveLength(2);
    expect(names(replay)).toEqual(names(first));
    replay.submit();
  } finally {
    await f.dispose();
  }
});

it.each([
  'none',
  'view-depth',
  'view-distance',
  'custom-ascending',
  'custom-descending',
])('cooks and schedules mesh sorting %s', async (sorting) => {
  const f = await fixture([
    emitter('mesh', 4, {
      kind: 'mesh',
      mesh: 'mesh',
      material: 'material',
      sorting,
      attributes: { sort: { source: 'custom', name: 'order' } },
    }),
  ]);
  try {
    const frame = f.frame();
    const uniform = planResources(frame.plan).find(
      (r) => r.kind === 'buffer' && r.name.endsWith('.renderer-0.runtime'),
    );
    if (uniform?.kind !== 'buffer' || !(uniform.data instanceof Uint8Array))
      throw new Error('Missing projection uniform');
    {
      const words = new Uint32Array(
        uniform.data.buffer,
        uniform.data.byteOffset,
        uniform.data.byteLength / 4,
      );
      expect(words[63]).toBe(0);
      expect(words[75]).toBe(
        sorting === 'none'
          ? 0
          : sorting === 'view-depth'
            ? 2
            : sorting === 'view-distance'
              ? 5
              : sorting === 'custom-ascending'
                ? 3
                : 4,
      );
    }
    const entries = planPasses(frame.plan).flatMap((p) =>
      p.kind === 'compute' ? p.dispatches.map((d) => d.entryPoint) : [],
    );
    expect(entries.includes('forgeax_vfx_sort_main')).toBe(sorting !== 'none');
    if (sorting !== 'none')
      expect(entries.indexOf('forgeax_vfx_sort_main')).toBeLessThan(
        entries.indexOf('forgeax_vfx_mesh_main'),
      );
    frame.submit();
  } finally {
    await f.dispose();
  }
});

it.each([
  false,
  true,
])('projects packed source channels independently of custom particle inputs (%s)', async (withInputs) => {
  const geometry = mesh();
  const f = await fixture(
    [
      emitter('mesh', 4, {
        kind: 'mesh',
        mesh: 'mesh',
        material: 'material',
        ...(withInputs ? { materialInputs: ['heat'] } : {}),
      }),
    ],
    geometry,
  );
  try {
    const frame = f.frame();
    const resource = planResources(frame.plan).find(
      (r) => r.kind === 'buffer' && r.name.endsWith('.geometry-buffer'),
    );
    if (resource?.kind !== 'buffer' || !(resource.data instanceof Float32Array))
      throw new Error('Missing vertex upload');
    const buffers = withInputs
      ? particleMaterialInputVertexBuffers('mesh-geometry-material-input-instance', 1)
      : MESH_GEOMETRY_MATERIAL_INSTANCE_VERTEX_BUFFERS;
    const buffer = buffers?.[0];
    if (!buffer) throw new Error('Missing geometry layout');
    expect(resource.data.length).toBe(6 * 18);
    expect(buffer.arrayStride).toBe(18 * 4);
    for (const [location, key, width] of [
      [0, 'position', 3],
      [14, 'color', 4],
      [15, 'uv1', 2],
    ] as const) {
      const attribute = [...buffer.attributes].find((a) => a.shaderLocation === location);
      if (attribute === undefined) throw new Error('Missing attribute');
      for (let vertex = 0; vertex < 6; vertex++)
        expect([
          ...resource.data.slice(
            vertex * 18 + attribute.offset / 4,
            vertex * 18 + attribute.offset / 4 + width,
          ),
        ]).toEqual([
          ...(geometry.attributes[key] as Float32Array).slice(
            vertex * width,
            vertex * width + width,
          ),
        ]);
    }
    for (const lanes of [1, 2, 3, 4]) {
      const locations =
        particleMaterialInputVertexBuffers('mesh-geometry-material-input-instance', lanes)?.flatMap(
          (b) => [...b.attributes].map((a) => a.shaderLocation),
        ) ?? [];
      expect(locations.length).toBeGreaterThan(0);
      expect(new Set(locations).size).toBe(locations.length);
      expect(Math.max(...locations)).toBeLessThan(16);
    }
    frame.submit();
  } finally {
    await f.dispose();
  }
});

it.each([
  new Uint16Array([99, 0, 1, 2, 99]).subarray(1, 4),
  new Uint16Array([0, 1, 2, 2, 1, 0]),
  new Uint32Array([0, 1, 2]),
])('aligns index upload without changing the logical draw', async (indices) => {
  const geometry = mesh(indices);
  const f = await fixture(
    [emitter('mesh', 4, { kind: 'mesh', mesh: 'mesh', material: 'material' })],
    geometry,
  );
  try {
    const frame = f.frame();
    const resource = planResources(frame.plan).find(
      (r) => r.kind === 'buffer' && r.name.endsWith('.index-buffer'),
    );
    expect(resource).toMatchObject({ size: Math.ceil(indices.byteLength / 4) * 4 });
    if (resource?.kind !== 'buffer' || !ArrayBuffer.isView(resource.data))
      throw new Error('Missing index upload');
    expect(resource.data.byteLength % 4).toBe(0);
    const indirect = planResources(frame.plan).find(
      (r) => r.kind === 'buffer' && r.name.endsWith('.indirect-initial'),
    );
    if (indirect?.kind !== 'buffer' || !(indirect.data instanceof Uint32Array))
      throw new Error('Missing indirect arguments');
    expect(indirect.data[0]).toBe(indices.length);
    expect(geometry.indices).toBe(indices);
    frame.submit();
  } finally {
    await f.dispose();
  }
});

it.each([
  false,
  true,
])('masks retained mesh shadows per session with active preparation %s', async (preparePipelines) => {
  let consumed = true;
  const renderer = { kind: 'mesh', mesh: 'mesh', material: 'material', castShadows: true };
  const f = await fixture(
    [emitter('a', 4, renderer), emitter('b', 4, renderer)],
    mesh(),
    () => consumed,
  );
  const frame = (count: number, generation = 0) => {
    const result = f.frame(undefined, generation);
    const passes = planPasses(result.plan);
    for (const suffix of ['.copy', '.project', '.shadow']) {
      expect(passes.filter((pass) => pass.name.endsWith(suffix))).toHaveLength(count);
    }
    expect(
      passes
        .flatMap((pass) => (pass.kind === 'raster' ? pass.draws : []))
        .filter((draw) => draw.enabled !== false),
    ).toHaveLength(count);
    result.submit();
    return result.plan;
  };
  const storage = (plan: ReturnType<typeof frame>) =>
    planResources(plan)
      .filter((resource) => resource.kind === 'buffer')
      .map((resource) => resource.name);
  try {
    frame(2);
    f.world.set(f.player, ParticleEffectPlayer, { playing: false }).unwrap();
    f.world.update(1 / 60).unwrap();
    const paused = frame(2);
    f.runtime.setEmitterSessionEnabled(f.player, 'a', false);
    const masked = frame(1);
    expect(storage(masked)).toEqual(storage(paused));
    expect(planPasses(masked).filter((pass) => pass.kind === 'shadow-caster')).toEqual(
      planPasses(paused)
        .filter((pass) => pass.kind === 'shadow-caster')
        .slice(1),
    );
    f.runtime.setEmitterSessionEnabled(f.player, 'a', true);
    expect(storage(frame(2))).toEqual(storage(paused));
    consumed = false;
    expect(storage(frame(0))).toEqual(storage(paused));
    consumed = true;
    frame(2);

    f.world.set(f.player, ParticleEffectPlayer, { playing: true, preparePipelines }).unwrap();
    f.world.update(1 / 60).unwrap();
    frame(2);
    f.runtime.setEmitterSessionEnabled(f.player, 'a', false);
    frame(1);
    const pausedTick = f.runtime.inspectPlayer(f.player)?.emitters[0]?.phaseTick ?? -1;
    expect(pausedTick).toBeGreaterThanOrEqual(0);
    for (let tick = 0; tick < 3; tick++) {
      f.world.update(1 / 60).unwrap();
      const active = frame(1);
      expect(planPasses(active).filter((pass) => pass.name.endsWith('.simulate'))).toHaveLength(1);
      expect(f.runtime.inspectPlayer(f.player)?.emitters[0]?.phaseTick).toBe(pausedTick);
      expect(f.runtime.inspectPlayer(f.player)?.emitters[1]?.phaseTick).toBe(pausedTick + tick + 1);
      expect(f.runtime.snapshot()).toHaveLength(0);
    }
    f.runtime.setEmitterSessionEnabled(f.player, 'a', true);
    frame(2);
    f.world.update(1 / 60).unwrap();
    frame(2);

    f.world.update(1 / 60).unwrap();
    expect(f.runtime.snapshot().length).toBeGreaterThan(0);
    f.world
      .set(f.player, ParticleEffectPlayer, { playing: false, preparePipelines: true })
      .unwrap();
    expect(planPasses(frame(0))).toEqual([]);
    expect(f.runtime.snapshot()).toHaveLength(0);
    expect(planPasses(frame(0, 1))).toEqual([]);
    f.world.set(f.player, ParticleEffectPlayer, { playing: true }).unwrap();
    f.world.update(1 / 60).unwrap();
    frame(2, 1);
    f.world.removeComponent(f.player, ParticleEffectPlayer).unwrap();
    expect(planResources(frame(0, 1))).toEqual([]);
  } finally {
    await f.dispose();
  }
});

it('keeps offscreen mesh shadows until the emitter session is disabled', async () => {
  const source = emitter('offscreen', 4, {
    kind: 'mesh',
    mesh: 'mesh',
    material: 'material',
    castShadows: true,
  });
  source.bounds.center = [1000, 0, 0];
  const offscreen = { ...source, simulationWhenCulled: 'continue' };
  const f = await fixture([offscreen]);
  try {
    const active = f.frame();
    expect(planPasses(active.plan).filter((pass) => pass.kind === 'shadow-caster')).toHaveLength(1);
    expect(planPasses(active.plan).filter((pass) => pass.kind === 'raster')).toHaveLength(0);
    active.submit();
    f.runtime.setEmitterSessionEnabled(f.player, source.id, false);
    expect(planPasses(f.frame().plan)).toEqual([]);
    f.runtime.setEmitterSessionEnabled(f.player, source.id, true);
    const restored = planPasses(f.frame().plan);
    expect(restored.filter((pass) => pass.name.endsWith('.project'))).toHaveLength(1);
    expect(restored.filter((pass) => pass.kind === 'shadow-caster')).toHaveLength(1);
    expect(restored.filter((pass) => pass.kind === 'raster')).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});
