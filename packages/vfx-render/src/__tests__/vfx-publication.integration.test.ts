import { serialize } from 'node:v8';
import {
  AssetRegistry,
  type MaterialRenderProjection,
  RuntimeMeshVertices,
  resolveAssetHandle,
} from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { MeshFilter } from '@forgeax/engine-render';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import {
  isImmutableVfxGpuEffect,
  ParticleEffectPlayer,
  VFX_GPU_PROGRAM_ARTIFACT_KEY,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  VFX_PARTICLE_CORE_LAYOUT,
  type VfxGpuEffectAsset,
  type VfxGpuRuntime,
  vfxGpuEffectPackLoader,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { expect, it, vi } from 'vitest';
import { materialRecordFixture } from '../../../assets-runtime/src/__tests__/fixtures/material-publication';
import { Materials } from '../../../render/src/materials';
import {
  type RenderPublication,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '../../../render/src/publication/contract';
import { createRenderPublisher } from '../../../render/src/publication/publisher';
import { RenderPublicationReceiver } from '../../../render/src/publication/receiver';
import type { PublishedRenderResources } from '../../../render/src/publication/resource-scope';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';
import { createVfxRuntimeHost } from '../host/vfx-runtime-host';
import { planPasses, planResources, singleViewContext } from './vfx-frame-fixture';

const camera = {
  position: new Float32Array(3),
  right: new Float32Array([1, 0, 0]),
  up: new Float32Array([0, 1, 0]),
  viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
};
const layout = {
  version: 3,
  parameters: { name: 'VfxParameters', fields: [], size: 0, alignment: 1 },
  custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
  core: VFX_PARTICLE_CORE_LAYOUT,
  customLayout: { name: 'VfxCustom', fields: [], size: 0, alignment: 1, stride: 0, lanes: 0 },
  fingerprint: 'sha256:controlled-layout',
};
const rawEffect = {
  guid: 'controlled-layout',
  kind: 'particle-effect',
  schemaVersion: 3,
  programFingerprint: 'sha256:controlled-layout',
  emitters: [{ id: 'emitter', capacity: 4 }],
  program: {
    format: 'forgeax-vfx-program-4',
    fingerprint: 'sha256:controlled-layout',
    emitters: [
      {
        id: 'emitter',
        module: 'controlled-layout.vfx.wgsl',
        capacity: 4,
        backend: { required: 'gpu' },
        space: 'world',
        simulationWhenCulled: 'continue',
        schedule: { rate: 1, bursts: [] },
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: '// controlled layout, not a native shader compilation test',
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: [],
          resources: [],
          entryPoints: [
            'forgeax_vfx_compact_main',
            'forgeax_vfx_mesh_main',
            'forgeax_vfx_ribbon_main',
            'forgeax_vfx_trail_main',
            'forgeax_vfx_beam_main',
            'forgeax_vfx_spawn_main',
            'forgeax_vfx_update_main',
            'forgeax_vfx_billboard_main',
          ],
          bindings: [{ entries: [] }],
          layout,
          dataInterfaces: [],
          eventChannels: [],
          events: [],
          eventEntryPoint: 'forgeax_vfx_event_main',
          stages: [],
          renderers: [
            {
              topology: 'billboard',
              resource: 'billboardInstances',
              capacity: 4,
              overflow: 'drop-newest',
              enabled: true,
              shaderInputs: [],
              attributes: {},
              materialInputs: [],
            },
          ],
        },
        renderers: [],
      },
    ],
  },
} as unknown as VfxGpuEffectAsset;

async function loadEffect(input: VfxGpuEffectAsset): Promise<VfxGpuEffectAsset> {
  const bytes = new TextEncoder().encode(JSON.stringify(input.program));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const fingerprint = `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return vfxGpuEffectPackLoader
    .load(
      {
        guid: input.guid,
        kind: 'particle-effect',
        payload: {
          ...input,
          programFingerprint: fingerprint,
          program: { ...input.program, fingerprint },
        },
        artifacts: {
          [VFX_GPU_PROGRAM_ARTIFACT_KEY]: {
            descriptor: { path: 'program.json', mediaType: 'application/json' },
            bytes,
          },
        },
      },
      {} as never,
    )
    .then((result) => result.unwrap()) as Promise<VfxGpuEffectAsset>;
}

const effect = await loadEffect(rawEffect);

it.each([
  'instance',
  'prototype',
] as const)('retains a replaced %s material projection provider through the VFX host', async (replacement) => {
  const guid = '019e9c00-0000-7000-8000-000000000044';
  const world = new World();
  const renderedEffect = {
    ...effect,
    program: {
      ...effect.program,
      emitters: effect.program.emitters.map((emitter) => ({
        ...emitter,
        renderers: [{ kind: 'billboard', material: guid }],
      })),
    },
  } as VfxGpuEffectAsset;
  world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect: world.allocSharedRef('ParticleEffectAsset', renderedEffect) },
    })
    .unwrap();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  assets
    .catalog(guid, {
      kind: 'material',
      passes: [{ name: 'forward', program: { module: 'game::custom-raster' } }],
    })
    .unwrap();
  const projection: MaterialRenderProjection = {
    materialGuid: guid,
    publicationGeneration: 1,
    specializationKey: 'custom-projection',
    artifactHash: 'custom-artifact',
    runtimeValues: {},
    staticSelection: [],
    passes: [{ name: 'forward', module: 'game::custom-raster', programs: [] }],
  };
  const provider = vi
    .spyOn(
      replacement === 'instance' ? assets : AssetRegistry.prototype,
      'getMaterialProjectionForPayload',
    )
    .mockReturnValue(projection);
  const host = createVfxRuntimeHost({ camera: { read: () => camera } });
  try {
    (await host.attachWorld({ world, assets })).unwrap();
    world.update(1 / 60).unwrap();
    const frame = host.feature
      .extract({
        worlds: [world],
        owner: 0,
        frameNumber: 1,
        views: [{ identity: 'main', render: true }],
      })
      .unwrap() as Parameters<ReturnType<typeof gpuParticleRenderFeature>['plan']>[0];
    expect(provider).toHaveBeenCalled();
    expect(required(required(frame.worlds[0]).materials.get(guid)).projection).toBe(projection);
  } finally {
    (await host.detachWorld({ world })).unwrap();
    provider.mockRestore();
  }
});

const materialContext = {
  backend: 'webgpu',
  capability: 'storage-buffer',
  pipeline: 'forward',
  geometry: 'mesh',
  pass: 'forward',
  profile: 'forgeax-material-wgsl-v1',
  toolchain: 'naga-oil',
  instrumentation: 'none',
} as const;

it.each([
  { kinds: ['billboard'], pass: 'forward' },
  { kinds: ['mesh'], pass: 'forward' },
  { kinds: ['billboard', 'mesh'], pass: 'forward' },
  { kinds: ['mesh', 'billboard'], pass: 'particle-mesh' },
  { kinds: ['billboard', 'mesh'], pass: 'particle-mesh' },
  { kinds: ['billboard', 'mesh'], pass: 'particle-billboard' },
  { kinds: ['mesh', 'billboard'], pass: 'particle-billboard' },
  { kinds: ['billboard'], pass: 'particle-mesh' },
  { kinds: ['billboard', 'mesh'], pass: 'particle-mesh', disabled: 'mesh' },
] as const)('omits stock raster-only material projections: $kinds / $pass', async (testCase) => {
  const { kinds, pass } = testCase;
  const disabled = 'disabled' in testCase ? testCase.disabled : undefined;
  const materialGuid = '019e9c00-0000-7000-8000-000000000041';
  const meshGuid = '019e9c00-0000-7000-8000-000000000042';
  const material: MaterialAsset = {
    kind: 'material',
    passes: [{ name: pass, program: { module: 'game::particle' } }],
  };
  const record = materialRecordFixture({
    guid: materialGuid,
    passes: [{ name: pass, program: { module: 'game::particle' } }],
    contexts: [materialContext],
  });
  const geometry = createBoxGeometry(1, 1, 1).unwrap();
  const renderers = kinds.map((kind) => ({
    kind,
    material: materialGuid,
    ...(kind === disabled ? { enabled: false } : {}),
    ...(kind === 'mesh' ? { mesh: meshGuid } : {}),
  }));
  const baseEmitter = required(effect.program.emitters[0]);
  const renderedEffect = {
    ...effect,
    program: {
      ...effect.program,
      emitters: [
        {
          ...baseEmitter,
          renderers,
          reflection: {
            ...baseEmitter.reflection,
            renderers: kinds.map((kind) => ({
              ...required(baseEmitter.reflection.renderers?.[0]),
              topology: kind,
              resource: kind === 'mesh' ? 'meshInstances' : 'billboardInstances',
            })),
          },
        },
      ],
    },
  } as VfxGpuEffectAsset;
  const world = new World();
  const handle = world.allocSharedRef('ParticleEffectAsset', renderedEffect);
  world.spawn({ component: ParticleEffectPlayer, data: { effect: handle } }).unwrap();
  const source = createVfxRuntimeHost({ camera: { read: () => camera } });
  const consumer = gpuParticleRenderFeature({ camera: { read: () => undefined } });
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  assets.catalog(materialGuid, material).unwrap();
  assets.catalog(meshGuid, geometry).unwrap();
  assets.recordMaterialReadiness(materialGuid, { status: 'Ready', record });
  const projection = required(assets.getMaterialProjection(materialGuid));
  (await source.attachWorld({ world, assets })).unwrap();
  const identity = { source: 'particle-material-publication', epoch: 1 };
  const publisher = createRenderPublisher(
    world,
    assets,
    identity,
    { backendKind: 'webgpu', storageBuffer: true } as never,
    [source.feature],
  );
  const receiver = new RenderPublicationReceiver(identity);
  try {
    world.update(1 / 60).unwrap();
    for (let iteration = 0; iteration < 2; iteration++) {
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet, {
        transfer: renderPublicationTransfers(candidate.packet),
      });
      candidate.accept();
      const accepted = receiver.accept(packet).unwrap();
      const frame = required(packet.features[0]).data as Parameters<typeof consumer.plan>[0];
      const row = required(required(frame.worlds[0]).materials.get(materialGuid));
      const enabledKinds = kinds.filter((kind) => kind !== disabled);
      const used = pass.startsWith('particle-');
      if (used) expect(row.projection).toEqual(projection);
      else {
        expect(row).not.toHaveProperty('projection');
        const redundant = {
          ...frame,
          worlds: frame.worlds.map((world) => ({
            ...world,
            materials: new Map(world.materials).set(materialGuid, { ...row, projection }),
          })),
        };
        expect(serialize(redundant).byteLength - serialize(frame).byteLength).toBeGreaterThan(
          serialize(projection).byteLength * 0.8,
        );
      }
      const planned = consumer
        .plan(
          frame,
          singleViewContext({
            resolveAsset: (_index, reference) => accepted.resources.resolveAsset(reference),
            materialContext,
            caps: {} as never,
            frame: { frameNumber: packet.revision },
            generation: 0,
          }),
        )
        .unwrap();
      expect(
        planResources(planned)
          .filter((resource) => resource.kind === 'graphics-program')
          .map((resource) => resource.program.shader),
      ).toEqual(
        enabledKinds.map((kind) =>
          pass === `particle-${kind}`
            ? required(required(projection.passes[0]).programs[0]).specializationKey
            : `forgeax::vfx-render.particles.${kind}`,
        ),
      );
      if (iteration === 1) expect(packet.assets).toHaveLength(0);
      publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    }
  } finally {
    publisher.dispose();
    receiver.dispose();
    (await source.detachWorld({ world })).unwrap();
  }
});

it.each([
  'replacement',
  'provider-error',
  'projection-getter',
] as const)('preserves custom material provider behavior: %s', async (behavior) => {
  const guid = '019e9c00-0000-7000-8000-000000000043';
  const base = required(effect.program.emitters[0]);
  const renderedEffect = {
    ...effect,
    program: {
      ...effect.program,
      emitters: [{ ...base, renderers: [0, 1].map(() => ({ kind: 'billboard', material: guid })) }],
    },
  } as VfxGpuEffectAsset;
  const world = new World();
  world
    .spawn({
      component: ParticleEffectPlayer,
      data: {
        effect: world.allocSharedRef('ParticleEffectAsset', renderedEffect),
      },
    })
    .unwrap();
  const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const failure = new Error('custom material provider failure');
  let reads = 0;
  let projections = 0;
  let lastMaterial: MaterialAsset | undefined;
  let lastProjection: MaterialRenderProjection | undefined;
  const source = gpuParticleRenderFeature({
    camera: { read: () => camera },
    material: {
      read: () => {
        reads++;
        lastMaterial = {
          kind: 'material',
          passes: [{ name: 'particle-billboard', program: { module: `game::particle-${reads}` } }],
        };
        return lastMaterial;
      },
      projection: (_world, material) => {
        projections++;
        expect(material).toBe(lastMaterial);
        if (behavior === 'provider-error' && projections === 2) throw failure;
        lastProjection = {
          materialGuid: guid,
          publicationGeneration: projections,
          specializationKey: `projection-${projections}`,
          artifactHash: 'custom',
          runtimeValues: {},
          staticSelection: [],
          passes: [{ name: 'particle-billboard', module: 'game::particle', programs: [] }],
        };
        if (behavior === 'projection-getter')
          Object.defineProperty(lastProjection, 'passes', {
            enumerable: true,
            get: () => {
              throw failure;
            },
          });
        return lastProjection;
      },
    },
  });
  try {
    world.update(1 / 60).unwrap();
    const extract = () =>
      source
        .extract({
          worlds: [world],
          owner: 0,
          frameNumber: 1,
          views: [{ identity: 'main', render: true }],
        })
        .unwrap();
    if (behavior === 'provider-error') expect(extract).toThrow(failure);
    else {
      const frame = extract();
      const row = required(required(frame.worlds[0]).materials.get(guid));
      expect(projections).toBe(reads);
      expect(projections).toBeGreaterThanOrEqual(2);
      expect(row.asset).toBe(lastMaterial);
      expect(row.projection).toBe(lastProjection);
      if (behavior === 'projection-getter') expect(() => structuredClone(frame)).toThrow(failure);
    }
  } finally {
    await ctx.fiber.dispose();
  }
});

it('publishes immutable VFX definitions once and keeps them out of frame feature data', async () => {
  const world = new World();
  const handle = world.allocSharedRef('ParticleEffectAsset', effect);
  world.spawn({ component: ParticleEffectPlayer, data: { effect: handle } }).unwrap();
  const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const identity = { source: 'vfx-publication', epoch: 1 };
  const publisher = createRenderPublisher(
    world,
    new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined })),
    identity,
    undefined,
    [feature],
  );
  const receiver = new RenderPublicationReceiver(identity);
  const seal = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    receiver.accept(packet).unwrap();
    return packet;
  };
  try {
    world.update(1 / 60).unwrap();
    const original = runtime.snapshot()[0];
    expect(original).toBeDefined();
    const first = seal();
    expect(first.assets.filter((row) => row.value.kind === 'particle-effect')).toHaveLength(1);
    const inspect = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      expect(value).not.toHaveProperty('wgsl');
      for (const child of value instanceof Map ? value.values() : Object.values(value))
        inspect(child);
    };
    inspect(first.features);
    const second = seal();
    expect(second.assets.filter((row) => row.value.kind === 'particle-effect')).toHaveLength(0);
    inspect(second.features);
    expect(original?.parameterBlock.buffer.byteLength).toBe(original?.parameterBlock.byteLength);
    expect(publisher.prepare(0).ok).toBe(false);
    publisher.recycle(first.revision, renderPublicationTransfers(first)).unwrap();
    publisher.recycle(second.revision, renderPublicationTransfers(second)).unwrap();
  } finally {
    publisher.dispose();
    receiver.dispose();
    await ctx.fiber.dispose();
  }
});

async function publicationFixture(effectAsset = effect) {
  const effect = effectAsset;
  const world = new World();
  const handle = world.allocSharedRef('ParticleEffectAsset', effect);
  const player = world
    .spawn({ component: ParticleEffectPlayer, data: { effect: handle } })
    .unwrap();
  world.sharedRefs.release(handle).unwrap();
  const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const source = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const consumer = gpuParticleRenderFeature({ camera: { read: () => undefined } });
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const identity = { source: 'vfx-exact-effect', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [source]);
  const receiver = new RenderPublicationReceiver(identity);
  let resources: PublishedRenderResources | undefined;
  type Frame = Parameters<typeof consumer.plan>[0];
  const data = (packet: RenderPublication) => required(packet.features[0]).data as Frame;
  const seal = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    resources = receiver.accept(packet).unwrap().resources;
    return packet;
  };
  const plan = (packet: RenderPublication, generation = 0) =>
    consumer.plan(
      data(packet),
      singleViewContext({
        resolveAsset: (_index, effectHandle) => required(resources).resolveAsset(effectHandle),
        caps: {} as never,
        frame: { frameNumber: packet.revision },
        generation,
      }),
    );
  const submit = (packet: RenderPublication, planned: ReturnType<typeof plan>) => {
    const work = planned.unwrap();
    consumer.onFrameSubmitted?.(data(packet));
    publisher
      .acknowledgeFeatures(packet.revision, [
        { identity: source.identity, feedback: structuredClone(work.sourceFeedback) },
      ])
      .unwrap();
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
  };
  const replace = async (renameEmitter = false) => {
    const updated = structuredClone(effect);
    const newEffect = {
      ...updated,
      emitters: updated.emitters.map((emitter) => ({
        ...emitter,
        id: renameEmitter ? 'replacement' : emitter.id,
      })),
      programFingerprint: 'sha256:replacement',
      program: {
        ...updated.program,
        fingerprint: 'sha256:replacement',
        emitters: updated.program.emitters.map((emitter) => ({
          ...emitter,
          id: renameEmitter ? 'replacement' : emitter.id,
          wgsl: '// replacement effect definition',
        })),
      },
    };
    const loadedEffect = await loadEffect(newEffect);
    const next = world.allocSharedRef('ParticleEffectAsset', loadedEffect);
    world.set(player, ParticleEffectPlayer, { effect: next }).unwrap();
    world.sharedRefs.release(next).unwrap();
    world.update(1 / 60).unwrap();
    return loadedEffect;
  };
  const close = async () => {
    publisher.dispose();
    receiver.dispose();
    await ctx.fiber.dispose();
  };
  return {
    world,
    player,
    handle,
    assets,
    runtime,
    source,
    consumer,
    publisher,
    receiver,
    get resources() {
      return required(resources);
    },
    data,
    seal,
    plan,
    submit,
    replace,
    close,
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing publication fixture value');
  return value;
}

function programSources(plan: ReturnType<ReturnType<typeof gpuParticleRenderFeature>['plan']>) {
  return planResources(plan.unwrap()).flatMap((resource) =>
    resource.kind === 'compute-program' ? [resource.program.wgsl] : [],
  );
}

it.each([
  new Float32Array([1.25, -2.5]),
  new Map([['value', 1.25]]),
  new Date(1000),
])('retains non-JSON effect payload types and exact mutable preparation after Worker admission (%s)', async (customData) => {
  const f = await publicationFixture();
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const row = required(first.assets.find((row) => row.value.kind === 'particle-effect'));
    const replacement = {
      ...structuredClone(row.value),
      customData,
    };
    const second: RenderPublication = {
      ...first,
      base: first.revision,
      revision: first.revision + 1,
      baseline: false,
      assets: [{ ...row, value: replacement }],
    };
    f.receiver.accept(second).unwrap();
    const accepted = f.resources.resolveAsset(row.handle).unwrap() as typeof replacement;
    expect(accepted.customData).toBe(customData);
    expect(accepted.customData.constructor).toBe(customData.constructor);
    const programs = () =>
      planResources(f.plan(second).unwrap()).flatMap((row) =>
        row.kind === 'compute-program' ? [row.program] : [],
      );
    const before = programs();
    expect(before.length).toBeGreaterThan(0);
    expect(programs()[0]).not.toBe(before[0]);
    Object.assign(required((accepted as unknown as VfxGpuEffectAsset).program.emitters[0]), {
      wgsl: '// mutable non-JSON effect',
    });
    expect(programs()[0]?.wgsl).toBe('// mutable non-JSON effect');
  } finally {
    await f.close();
  }
});

it('preserves the accepted effect and revision when adopting a replacement throws', async () => {
  const f = await publicationFixture();
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const row = required(first.assets.find((row) => row.value.kind === 'particle-effect'));
    const accepted = f.resources.resolveAsset(row.handle).unwrap();
    const failure = Error('program adoption getter failed');
    const replacement = { ...row.value };
    Object.defineProperty(replacement, 'program', {
      enumerable: true,
      get() {
        throw failure;
      },
    });
    const second: RenderPublication = {
      ...first,
      base: first.revision,
      revision: first.revision + 1,
      baseline: false,
      assets: [{ ...row, value: replacement }],
    };
    expect(() => f.receiver.accept(second)).toThrow(failure);
    expect(f.resources.revision).toBe(first.revision);
    expect(f.resources.resolveAsset(row.handle).unwrap()).toBe(accepted);
    expect(programSources(f.plan(first))).toEqual([required(effect.program.emitters[0]).wgsl]);
  } finally {
    await f.close();
  }
});

it('owns Worker-cloned effect programs once and invalidates a replaced asset even with the same fingerprint', async () => {
  const f = await publicationFixture();
  const programs = (packet: RenderPublication) =>
    planResources(f.plan(packet).unwrap()).flatMap((row) =>
      row.kind === 'compute-program' ? [row.program] : [],
    );
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const row = required(first.assets.find((row) => row.value.kind === 'particle-effect'));
    const borrowed = row.value as VfxGpuEffectAsset;
    const accepted = f.resources.resolveAsset<VfxGpuEffectAsset>(row.handle).unwrap();
    expect(accepted).not.toBe(borrowed);
    expect(Object.isFrozen(borrowed)).toBe(false);
    expect(Object.isFrozen(accepted.program.emitters[0]?.reflection)).toBe(true);
    const initial = programs(first);
    expect(initial.length).toBeGreaterThan(0);
    const original = required(borrowed.program.emitters[0]);
    const originalWgsl = original.wgsl;
    Object.assign(original, { wgsl: '// borrowed packet mutation' });
    const repeated = programs(first);
    expect(repeated[0]).toBe(initial[0]);
    expect(repeated[0]?.wgsl).toBe(originalWgsl);
    // Replacement is a new publication authority, even if an upstream producer
    // reused a fingerprint. Do not use that string as an identity-only proof.
    const replacement = structuredClone(accepted);
    Object.assign(required(replacement.program.emitters[0]), { wgsl: '// accepted replacement' });
    const second: RenderPublication = {
      ...first,
      base: first.revision,
      revision: first.revision + 1,
      baseline: false,
      assets: [{ ...row, value: replacement }],
    };
    f.receiver.accept(second).unwrap();
    const changed = programs(second);
    expect(changed[0]).not.toBe(initial[0]);
    expect(changed[0]?.wgsl).toBe('// accepted replacement');
    const recovered = planResources(f.plan(second, 1).unwrap()).flatMap((row) =>
      row.kind === 'compute-program' ? [row.program] : [],
    );
    expect(recovered[0]?.wgsl).toBe('// accepted replacement');
  } finally {
    await f.close();
  }
});

it('plans exact old/new effects with one GUID across two sealed frames, abort, ACK and recovery', async () => {
  const f = await publicationFixture();
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const oldIntent = required(f.runtime.snapshot()[0]);
    const updated = await f.replace();
    expect(f.world.sharedRefs.resolve(f.handle).ok).toBe(false);
    expect(oldIntent.effect).toBe(effect);
    const second = f.seal();
    expect(second.assets.filter((row) => row.value.kind === 'particle-effect')).toHaveLength(1);
    expect(second.assets.find((row) => row.value.kind === 'particle-effect')?.value).toEqual(
      updated,
    );
    const oldReference = required(f.data(first).worlds[0]?.intents[0]).emitter;
    const current = required(f.data(second).worlds[0]?.intents.at(-1)).emitter;
    expect(current.id).toBe(oldReference.id);
    expect(current.effect).not.toBe(oldReference.effect);
    expect(f.resources.resolveAsset(required(oldReference.effect)).unwrap()).toEqual(effect);
    expect(f.resources.resolveAsset(required(current.effect)).unwrap()).toEqual(updated);
    expect(f.publisher.recycle(second.revision, renderPublicationTransfers(second)).ok).toBe(false);
    const rejected = f.plan(first);
    expect(programSources(rejected)).toEqual([required(effect.program.emitters[0]).wgsl]);
    f.consumer.onFrameAborted?.(f.data(first));
    expect(f.runtime.snapshot()).toContain(oldIntent);
    const retry = f.plan(first);
    expect(programSources(retry)).toEqual(programSources(rejected));
    f.submit(first, retry);
    const successor = f.plan(second);
    expect(programSources(successor)).toContain(required(updated.program.emitters[0]).wgsl);
    f.submit(second, successor);
    expect(f.runtime.snapshot()).toHaveLength(0);
    expect(f.runtime.lastCommitted(f.player)?.effect).toBe(updated);
    const third = f.seal();
    expect(third.assets.filter((row) => row.value.kind === 'particle-effect')).toHaveLength(0);
    expect(third.retiredAssets).toContain(oldReference.effect);
    expect(f.world.sharedRefs.resolve(required(oldReference.effect)).ok).toBe(false);
    expect(f.resources.resolveAsset(required(oldReference.effect)).ok).toBe(false);
    const recovered = f.plan(third, 1);
    expect(programSources(recovered)).toEqual([required(updated.program.emitters[0]).wgsl]);
    expect(planPasses(recovered.unwrap()).some((pass) => pass.name.endsWith('.simulate'))).toBe(
      true,
    );
    f.submit(third, recovered);
    expect(camera.viewProjection.byteLength).toBe(64);
  } finally {
    await f.close();
  }
});

it('re-publishes discarded definitions and seeds a replacement epoch from current exact resources', async () => {
  const f = await publicationFixture();
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    f.submit(first, f.plan(first));
    const updated = await f.replace();
    const discarded = f.publisher.prepare(0).unwrap();
    expect(discarded.packet.assets.some((row) => row.value.kind === 'particle-effect')).toBe(true);
    discarded.discard();
    const second = f.seal();
    expect(second.assets.some((row) => row.value.kind === 'particle-effect')).toBe(true);
    f.submit(second, f.plan(second));
    f.publisher.dispose();
    const identity = { source: 'vfx-exact-effect', epoch: 2 };
    const publisher = createRenderPublisher(f.world, f.assets, identity, undefined, [f.source]);
    const receiver = new RenderPublicationReceiver(identity);
    try {
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet, {
        transfer: renderPublicationTransfers(candidate.packet),
      });
      candidate.accept();
      const accepted = receiver.accept(packet).unwrap();
      expect(packet.baseline).toBe(true);
      expect(packet.assets.some((row) => row.value.kind === 'particle-effect')).toBe(true);
      const consumer = gpuParticleRenderFeature({ camera: { read: () => undefined } });
      const plan = consumer.plan(
        f.data(packet),
        singleViewContext({
          resolveAsset: (_index, handle) => accepted.resources.resolveAsset(handle),
          caps: {} as never,
          frame: { frameNumber: packet.revision },
          generation: 1,
        }),
      );
      expect(programSources(plan)).toEqual([required(updated.program.emitters[0]).wgsl]);
      const broken = structuredClone(f.data(packet));
      const retained = required(broken.worlds[0]?.retained[0]);
      Object.assign(retained.intent, { programFingerprint: 'sha256:wrong-version' });
      expect(
        consumer.plan(
          broken,
          singleViewContext({
            resolveAsset: (_index, handle) => accepted.resources.resolveAsset(handle),
            caps: {} as never,
            frame: { frameNumber: 2 },
            generation: 1,
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: 'render-feature-stage-failed' } });
    } finally {
      publisher.dispose();
      receiver.dispose();
    }
  } finally {
    await f.close();
  }
});

it('releases source grants on recovery, re-entry, despawn and runtime detach', async () => {
  const f = await publicationFixture();
  let detachedHandle: typeof f.handle | undefined;
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const firstHandle = required(required(f.data(first).worlds[0]?.intents[0]).emitter.effect);
    expect(f.world.sharedRefs.refcount(firstHandle)).toBe(1);
    f.submit(first, f.plan(first));
    f.runtime.recover();
    expect(f.world.sharedRefs.refcount(firstHandle)).toBe(0);
    expect(f.world.sharedRefs.refcount(f.handle)).toBe(1);
    const recovered = f.seal();
    const recoveredHandle = required(
      required(f.data(recovered).worlds[0]?.intents[0]).emitter.effect,
    );
    expect(recoveredHandle).not.toBe(firstHandle);
    expect(recovered.assets.some((row) => row.handle === recoveredHandle)).toBe(true);
    f.submit(recovered, f.plan(recovered, 1));
    f.world.despawn(f.player).unwrap();
    const empty = f.seal();
    expect(f.world.sharedRefs.refcount(recoveredHandle)).toBe(0);
    expect(empty.retiredAssets).toContain(recoveredHandle);
    f.submit(empty, f.plan(empty, 1));
    const handle = f.world.allocSharedRef('ParticleEffectAsset', effect);
    f.world.spawn({ component: ParticleEffectPlayer, data: { effect: handle } }).unwrap();
    f.world.sharedRefs.release(handle).unwrap();
    const reentered = f.seal();
    detachedHandle = required(required(f.data(reentered).worlds[0]?.intents[0]).emitter.effect);
    expect(detachedHandle).not.toBe(recoveredHandle);
    expect(f.world.sharedRefs.refcount(detachedHandle)).toBe(1);
  } finally {
    await f.close();
  }
  expect(detachedHandle).toBeDefined();
  expect(f.world.sharedRefs.refcount(required(detachedHandle))).toBe(0);
});

it('retires removed emitter IDs without dropping their pending old-version ticks', async () => {
  const f = await publicationFixture();
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const old = required(f.data(first).worlds[0]?.intents[0]).emitter;
    f.submit(first, f.plan(first));
    f.world.update(1 / 60).unwrap();
    await f.replace(true);
    expect(f.world.sharedRefs.refcount(required(old.effect))).toBe(1);
    const second = f.seal();
    expect(f.data(second).worlds[0]?.intents.map((intent) => intent.emitter.id)).toContain(old.id);
    f.submit(second, f.plan(second));
    expect(f.runtime.lastCommittedEmitter(f.player, old.id)).toBeUndefined();
    expect(f.world.sharedRefs.refcount(required(old.effect))).toBe(0);
    const third = f.seal();
    expect(third.retiredAssets).toContain(old.effect);
  } finally {
    await f.close();
  }
});

it('observes mutable shared emitter WGSL again after a submitted publication', async () => {
  const mutableEffect = structuredClone(rawEffect);
  const f = await publicationFixture(mutableEffect);
  const emitter = required(mutableEffect.program.emitters[0]);
  const prior = emitter.wgsl;
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    f.submit(first, f.plan(first));
    Object.assign(emitter, { wgsl: '// author changed mutable nested WGSL' });
    f.world.update(1 / 60).unwrap();
    const second = f.seal();
    expect(programSources(f.plan(second))).toEqual(['// author changed mutable nested WGSL']);
  } finally {
    Object.assign(emitter, { wgsl: prior });
    await f.close();
  }
});

it('does not add raw effect getters or Proxy traps while publishing inline definitions', async () => {
  const mutable = structuredClone(rawEffect);
  const marker = new Error('raw effect metadata must remain unobserved');
  Object.defineProperty(mutable, 'unused', {
    enumerable: true,
    get: () => {
      throw marker;
    },
  });
  const f = await publicationFixture(mutable);
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    expect(programSources(f.plan(first))).toEqual([required(rawEffect.program.emitters[0]).wgsl]);
    f.submit(first, f.plan(first));
  } finally {
    await f.close();
  }
});

it('keeps a raw emitter WGSL getter fresh and preserves its exact clone failure', async () => {
  const mutable = structuredClone(rawEffect);
  const emitter = required(mutable.program.emitters[0]);
  const f = await publicationFixture(mutable);
  const marker = new Error('raw WGSL clone failure');
  let reads = 0;
  let armed = false;
  Object.defineProperty(emitter, 'wgsl', {
    enumerable: true,
    configurable: true,
    get: () => {
      reads++;
      if (armed) throw marker;
      return '// raw accessor program';
    },
  });
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    expect(reads).toBe(1);
    f.submit(first, f.plan(first));
    armed = true;
    expect(() => f.seal()).toThrow(marker);
    expect(reads).toBe(2);
  } finally {
    await f.close();
  }
});

it('admits only the loaded immutable JSON owner, not raw, copied or proxied effects', () => {
  expect(isImmutableVfxGpuEffect(effect)).toBe(true);
  expect(Object.getPrototypeOf(effect)).toBe(Object.prototype);
  expect(Object.isFrozen(required(effect.program.emitters[0]).reflection.layout)).toBe(true);
  expect(Object.isFrozen(required(effect.emitters[0]))).toBe(true);
  expect(isImmutableVfxGpuEffect(rawEffect)).toBe(false);
  expect(isImmutableVfxGpuEffect(structuredClone(effect))).toBe(false);
  const marker = new Error('Proxy ownership must not inspect author fields');
  const proxy = new Proxy(effect, {
    get: () => {
      throw marker;
    },
    getPrototypeOf: () => {
      throw marker;
    },
    ownKeys: () => {
      throw marker;
    },
    getOwnPropertyDescriptor: () => {
      throw marker;
    },
  });
  expect(isImmutableVfxGpuEffect(proxy)).toBe(false);
});

it('keeps mutable raw typed reflection bytes in each fresh packet', async () => {
  const mutable = structuredClone(rawEffect);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  Object.assign(required(mutable.program.emitters[0]).reflection, { authorBytes: bytes });
  const f = await publicationFixture(mutable);
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    f.submit(first, f.plan(first));
    bytes[2] = 42;
    f.world.update(1 / 60).unwrap();
    const second = f.seal();
    const emitter = required(f.data(second).worlds[0]?.intents[0])
      .emitter as unknown as VfxGpuEffectAsset['program']['emitters'][number];
    expect(emitter).toBeDefined();
    expect((emitter?.reflection as unknown as { authorBytes: Uint8Array }).authorBytes).toEqual(
      new Uint8Array([1, 2, 42, 4]),
    );
    expect(bytes.byteLength).toBe(4);
  } finally {
    await f.close();
  }
});

it('keeps raw ACK free of newly introduced effect-program reads, including mixed owners', async () => {
  const mutable = structuredClone(rawEffect);
  const f = await publicationFixture(mutable);
  const handle = f.world.allocSharedRef('ParticleEffectAsset', effect);
  f.world.spawn({ component: ParticleEffectPlayer, data: { effect: handle } }).unwrap();
  const marker = new Error('raw ACK program observer');
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const planned = f.plan(first);
    Object.defineProperty(mutable, 'program', {
      configurable: true,
      get: () => {
        throw marker;
      },
    });
    expect(() => f.submit(first, planned)).not.toThrow();
  } finally {
    await f.close();
  }
});

async function meshPublicationFixture(kind: 'catalog' | 'custom' | 'player' = 'catalog') {
  const materialGuid = '019e9c00-0000-7000-8000-000000000091';
  const meshGuid = '019e9c00-0000-7000-8000-000000000092';
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  assets.catalog(materialGuid, Materials.unlit([1, 1, 1, 1])).unwrap();
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  if (kind !== 'player') assets.catalog(meshGuid, mesh).unwrap();
  const custom = createBoxGeometry(2, 1, 1).unwrap();
  const handle = world.allocSharedRef('MeshAsset', mesh);
  const definition = await loadEffect({
    ...rawEffect,
    program: {
      ...rawEffect.program,
      emitters: rawEffect.program.emitters.map((emitter) => ({
        ...emitter,
        renderers: [
          {
            kind: 'mesh',
            material: materialGuid,
            mesh: kind === 'player' ? { source: 'player' } : meshGuid,
          },
        ],
        reflection: {
          ...emitter.reflection,
          renderers: [
            {
              topology: 'mesh',
              resource: 'meshInstances',
              capacity: 4,
              overflow: 'drop-newest',
              enabled: true,
              castShadows: false,
              receiveShadows: false,
              shaderInputs: [],
              attributes: {},
              materialInputs: [],
            },
          ],
        },
      })),
    },
  } as VfxGpuEffectAsset);
  const player = world
    .spawn(
      {
        component: ParticleEffectPlayer,
        data: {
          effect: world.allocSharedRef('ParticleEffectAsset', definition),
          timeScale: 0,
        },
      },
      ...(kind === 'player' ? [{ component: MeshFilter, data: { assetHandle: handle } }] : []),
    )
    .unwrap();
  const host = createVfxRuntimeHost({ camera: { read: () => camera } });
  (await host.attachWorld({ world, assets })).unwrap();
  const source =
    kind === 'custom'
      ? gpuParticleRenderFeature({
          camera: { read: () => camera },
          material: { read: (_world, guid) => assets.lookup<MaterialAsset>(guid) },
          mesh: { read: () => custom },
        })
      : host.feature;
  const identity = { source: 'mesh-publication', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [source]);
  const receiver = new RenderPublicationReceiver(identity);
  const consumer = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const data = (packet: RenderPublication) =>
    required(packet.features[0]).data as Parameters<typeof consumer.plan>[0];
  world.update(1 / 60).unwrap();
  const publish = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: [
        ...renderPublicationTransfers(candidate.packet),
        ...renderPublicationAssetTransfers(candidate.packet),
      ],
    });
    candidate.accept();
    const accepted = receiver.accept(packet).unwrap();
    const planned = consumer
      .plan(
        data(packet),
        singleViewContext({
          targets: [{ name: 'color', kind: 'color', format: 'rgba8unorm', sampleCount: 1 }],
          resolveAsset: (_index, assetHandle) => accepted.resources.resolveAsset(assetHandle),
          caps: {} as never,
          frame: { frameNumber: packet.revision },
          generation: 0,
        }),
      )
      .unwrap();
    const geometry = planResources(planned)
      .filter((resource) => resource.kind === 'buffer')
      .filter((resource) => resource.name.endsWith('.geometry-buffer'));
    consumer.onFrameSubmitted?.(data(packet));
    publisher
      .acknowledgeFeatures(packet.revision, [
        { identity: source.identity, feedback: planned.sourceFeedback },
      ])
      .unwrap();
    const returned = structuredClone(renderPublicationTransfers(packet), {
      transfer: renderPublicationTransfers(packet),
    });
    publisher.recycle(packet.revision, returned).unwrap();
    return { packet, data: data(packet), resources: accepted.resources, geometry };
  };
  return {
    world,
    assets,
    mesh,
    custom,
    handle,
    player,
    meshGuid,
    source,
    publisher,
    consumer,
    publish,
    close: async () => {
      publisher.dispose();
      receiver.dispose();
      (await host.detachWorld({ world })).unwrap();
    },
  };
}

it('publishes a stock VFX mesh once through asset residency across steady frames and discarded replacement', async () => {
  const f = await meshPublicationFixture();
  try {
    const first = f.publish();
    const reference = required(first.data.worlds[0]?.meshes.get(f.meshGuid));
    expect(reference).toBeTypeOf('number');
    expect(first.packet.assets.filter((row) => row.value.kind === 'mesh')).toHaveLength(1);
    expect(first.resources.lookupAsset(f.meshGuid)).toEqual(f.mesh);
    expect(first.geometry).toHaveLength(1);
    const second = f.publish();
    expect(second.packet.assets.filter((row) => row.value.kind === 'mesh')).toHaveLength(0);
    expect(second.data.worlds[0]?.meshes.get(f.meshGuid)).toBe(reference);
    expect(second.geometry).toEqual(first.geometry);
    const replacement = createBoxGeometry(3, 1, 1).unwrap();
    f.assets.catalog(f.meshGuid, replacement).unwrap();
    const discarded = f.publisher.prepare(0).unwrap();
    discarded.discard();
    const third = f.publish();
    expect(third.packet.assets.filter((row) => row.value.kind === 'mesh')).toHaveLength(1);
    expect(third.resources.lookupAsset(f.meshGuid)).toEqual(replacement);
    expect(third.geometry[0]?.data).not.toEqual(first.geometry[0]?.data);
    expect(f.mesh.vertices.byteLength).toBeGreaterThan(0);
    expect(replacement.vertices.byteLength).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

it('keeps a custom mesh provider inline and observes its unmanaged edits without World changes', async () => {
  const f = await meshPublicationFixture('custom');
  try {
    const first = f.publish();
    expect(first.data.worlds[0]?.meshes.get(f.meshGuid)).toMatchObject({ kind: 'mesh' });
    expect(first.packet.assets.filter((row) => row.value.kind === 'mesh')).toHaveLength(0);
    const before = new Float32Array(f.custom.vertices);
    f.custom.vertices[0] = required(before[0]) + 2;
    const positions = f.custom.attributes.position as Float32Array;
    positions[0] = required(positions[0]) + 2;
    const second = f.publish();
    expect(second.geometry[0]?.data).not.toEqual(first.geometry[0]?.data);
    expect(first.data.worlds[0]?.meshes.get(f.meshGuid)).toMatchObject({ vertices: before });
    expect(f.custom.vertices.byteLength).toBe(before.byteLength);
  } finally {
    await f.close();
  }
});

it('publishes managed replacement and restoration for a Player with only a non-catalogued MeshFilter', async () => {
  const f = await meshPublicationFixture('player');
  try {
    const first = f.publish();
    expect(first.data.worlds[0]?.meshes.get(f.player)).toBe(f.handle);
    expect(first.packet.assets.find((row) => row.handle === f.handle)?.guid).toBeUndefined();
    const vertices = new Float32Array(f.mesh.vertices);
    vertices[0] = required(vertices[0]) + 0.2;
    const content = f.world
      .spawn({
        component: RuntimeMeshVertices,
        data: { asset: f.handle, vertices: Array.from(vertices) },
      })
      .unwrap();
    f.world.update(1 / 60).unwrap();
    const changed = f.publish();
    expect(changed.resources.resolveAsset<MeshAsset>(f.handle).unwrap().vertices).toEqual(vertices);
    expect(changed.geometry[0]?.data).not.toEqual(first.geometry[0]?.data);
    f.world.despawn(content).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(f.publish().geometry[0]?.data).toEqual(first.geometry[0]?.data);
    const replacement = createBoxGeometry(3, 1, 1).unwrap();
    const nextHandle = f.world.allocSharedRef('MeshAsset', replacement);
    f.world.set(f.player, MeshFilter, { assetHandle: nextHandle }).unwrap();
    f.world.update(1 / 60).unwrap();
    const rebound = f.publish();
    expect(rebound.data.worlds[0]?.meshes.get(f.player)).toBe(nextHandle);
    expect(rebound.geometry[0]?.data).not.toEqual(first.geometry[0]?.data);
  } finally {
    await f.close();
  }
});

it('resolves published Player mesh references in their source World index', async () => {
  const f = await meshPublicationFixture('player');
  try {
    const requested: number[] = [];
    const frame = f.source
      .extract({
        worlds: [new World(), f.world],
        owner: 1,
        frameNumber: 1,
        views: [{ identity: 'main', render: true }],
        referenceAsset: (index, identity, captured) => {
          requested.push(index);
          expect(identity).toBe(f.handle);
          expect(resolveAssetHandle(f.world, f.handle).unwrap()).toBe(captured);
          return f.handle;
        },
      })
      .unwrap();
    expect(requested.length).toBeGreaterThan(0);
    expect(new Set(requested)).toEqual(new Set([1]));
    const resolved: number[] = [];
    const result = f.consumer.plan(
      structuredClone(frame),
      singleViewContext({
        targets: [{ name: 'color', kind: 'color', format: 'rgba8unorm', sampleCount: 1 }],
        resolveAsset: (index, handle) => {
          resolved.push(index);
          return resolveAssetHandle(f.world, handle);
        },
        caps: {} as never,
        frame: { frameNumber: 1 },
        generation: 0,
      }),
    );
    expect(result.ok).toBe(true);
    expect(new Set(resolved)).toEqual(new Set([1]));
  } finally {
    await f.close();
  }
});
