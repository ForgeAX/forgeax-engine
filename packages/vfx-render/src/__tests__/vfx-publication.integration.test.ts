import { serialize } from 'node:v8';
import { AssetRegistry, type MaterialRenderProjection } from '@forgeax/engine-assets-runtime';
import {
  runtimeAssetReference,
  runtimeAssetRegistry,
  runtimeAssets,
} from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { serializeCookedMaterialRecord } from '@forgeax/engine-pack';
import { MeshFilter } from '@forgeax/engine-render';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import {
  ParticleEffectPlayer,
  particleEffectContribution,
  prepareVfxGpuEffect,
  VFX_GPU_PROGRAM_ARTIFACT_KEY,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  VFX_PARTICLE_CORE_LAYOUT,
  type VfxGpuEffectAsset,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { expect, it, vi } from 'vitest';
import { materialRecordFixture } from '../../../assets-runtime/src/__tests__/fixtures/material-publication';
import { publishRuntimeAssets } from '../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { isOwnedRenderFeatureProgramData } from '../../../render/src/features/prepared-gpu-work';
import { Materials } from '../../../render/src/materials';
import type { RenderPublication } from '../../../render/src/publication/contract';
import { createRenderPublisher } from '../../../render/src/publication/publisher';
import { RenderPublicationReceiver } from '../../../render/src/publication/receiver';
import {
  encodeRenderPublication,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '../../../render/src/publication/record';
import type { RenderResourceScope } from '../../../render/src/publication/resource-scope';
import { cookedEffectFixture } from '../../../vfx/src/__tests__/cooked-effect-fixture';
import {
  effectFixtureReference,
  runtimeEffectFixture,
} from '../../../vfx/src/__tests__/runtime-effect-fixture';
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
const seedEffect = {
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
          bindings: [{ label: '@group(0)', entries: [] }],
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
  if (
    input.program.emitters.some(
      (emitter) =>
        emitter.renderers.length !== emitter.reflection.renderers.length ||
        emitter.renderers.some(
          (renderer, index) => renderer.kind !== emitter.reflection.renderers[index]?.topology,
        ),
    )
  )
    input = await cookedEffectFixture(input);
  const bytes = new TextEncoder().encode(JSON.stringify(input.program));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const fingerprint = `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return prepareVfxGpuEffect({
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
  }).then((result) => result.unwrap()) as Promise<VfxGpuEffectAsset>;
}

const rawEffect = await cookedEffectFixture(seedEffect);
const effect = await loadEffect(rawEffect);

it('captures stock material GUIDs once per World extraction and refreshes every candidate', async () => {
  const guid = '019e9c00-0000-7000-8000-000000000045';
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  assets.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
  const world = new World({ assets });

  const material = {
    kind: 'material',
    passes: [{ name: 'particle-billboard', program: { module: 'game::particle' } }],
    values: { baseColor: [1, 0, 0, 1] },
  } satisfies MaterialAsset;
  publishRuntimeAssets(assets, [{ guid, asset: material }]);
  (await assets.load(guid, 'material')).unwrap();
  const renderedEffect = {
    ...effect,
    program: {
      ...effect.program,
      emitters: effect.program.emitters.map((emitter) => ({
        ...emitter,
        renderers: [0, 1].map(() => ({ kind: 'billboard', material: guid })),
      })),
    },
  } as VfxGpuEffectAsset;
  const handle = runtimeAssetRegistry(world.assets)
    .create(runtimeEffectFixture(world, await cookedEffectFixture(renderedEffect)))
    .unwrap();
  for (let index = 0; index < 3; index++)
    world.spawn({ component: ParticleEffectPlayer, data: { effect: handle } }).unwrap();
  const host = createVfxRuntimeHost({ camera: { read: () => camera } });
  const materialHandle = (await assets.load(guid, 'material')).unwrap();
  let references = 0;
  const extract = () =>
    host.feature
      .extract({
        worlds: [world],
        owner: 0,
        // Repeated or discarded candidates still capture current author values.
        frameNumber: 1,
        views: [{ identity: 'main', render: true }],
        referenceAsset: (_worldIndex, identity, captured) => {
          expect(identity).toBe(materialHandle);
          expect(captured).toBe(runtimeAssets(assets).borrow(materialHandle).unwrap());
          references++;
          return materialHandle;
        },
      })
      .unwrap() as Parameters<ReturnType<typeof gpuParticleRenderFeature>['plan']>[0];
  try {
    (await host.attachWorld({ world, assets })).unwrap();
    world.update(1 / 60).unwrap();
    const first = extract();
    expect(references).toBe(1);
    expect(
      first.worlds[0]?.materials.get(effectFixtureReference(world, guid, 'material'))?.asset.values,
    ).toEqual(material.values);
    assets.update(materialHandle, { values: { baseColor: [1, 0.5, 0, 1] } }).unwrap();
    const second = extract();
    expect(references).toBe(2);
    expect(
      second.worlds[0]?.materials.get(effectFixtureReference(world, guid, 'material'))?.asset.values
        ?.baseColor,
    ).toEqual([1, 0.5, 0, 1]);
    const replacement = { ...material, values: { baseColor: [0, 0, 1, 1] } };
    assets.replace(materialHandle, replacement).unwrap();
    const third = extract();
    expect(references).toBe(3);
    expect(
      third.worlds[0]?.materials.get(effectFixtureReference(world, guid, 'material'))?.asset.values,
    ).toEqual(replacement.values);
  } finally {
    (await host.detachWorld({ world })).unwrap();
  }
});

it.each([
  'instance',
  'prototype',
  'accessor',
] as const)('retains a replaced %s material projection provider through the VFX host', async (replacement) => {
  const guid = '019e9c00-0000-7000-8000-000000000044';
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  assets.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
  const world = new World({ assets });
  const renderedEffect = {
    ...effect,
    program: {
      ...effect.program,
      emitters: effect.program.emitters.map((emitter) => ({
        ...emitter,
        renderers: [0, 1].map(() => ({ kind: 'billboard', material: guid })),
      })),
    },
  } as VfxGpuEffectAsset;
  publishRuntimeAssets(assets, [
    {
      guid,
      asset: {
        kind: 'material',
        passes: [{ name: 'forward', program: { module: 'game::custom-raster' } }],
      },
    },
  ]);
  (await assets.load(guid, 'material')).unwrap();
  world
    .spawn({
      component: ParticleEffectPlayer,
      data: {
        effect: runtimeAssetRegistry(world.assets)
          .create(runtimeEffectFixture(world, await cookedEffectFixture(renderedEffect)))
          .unwrap(),
      },
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
  const provider =
    replacement === 'accessor'
      ? vi.fn((_material: MaterialAsset) => projection)
      : vi
          .spyOn(
            replacement === 'instance' ? assets : AssetRegistry.prototype,
            'getMaterialProjectionForPayload',
          )
          .mockReturnValue(projection);
  let propertyReads = 0;
  if (replacement === 'accessor')
    Object.defineProperty(assets, 'getMaterialProjectionForPayload', {
      configurable: true,
      get: () => {
        propertyReads++;
        return provider;
      },
    });
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
    expect(provider).toHaveBeenCalledTimes(4);
    if (replacement === 'accessor') expect(propertyReads).toBe(4);
    expect(
      required(
        required(frame.worlds[0]).materials.get(effectFixtureReference(world, guid, 'material')),
      ).projection,
    ).toBe(projection);
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
  { kinds: ['billboard'], pass: 'particle-billboard', mixed: true },
  { kinds: ['billboard'], pass: 'particle-billboard', mixed: true, legacyBoundary: true },
] as const)('omits stock raster-only material projections: $kinds / $pass', async (testCase) => {
  const { kinds, pass } = testCase;
  const disabled = 'disabled' in testCase ? testCase.disabled : undefined;
  const materialGuid = '019e9c00-0000-7000-8000-000000000041';
  const meshGuid = '019e9c00-0000-7000-8000-000000000042';
  const material: MaterialAsset = {
    kind: 'material',
    passes: [
      { name: pass, program: { module: 'game::particle' } },
      ...('mixed' in testCase
        ? [
            { name: 'forward', program: { module: 'game::unused-forward' } },
            { name: 'shadow-caster', program: { module: 'game::unused-shadow' } },
          ]
        : []),
    ],
  };
  let record = materialRecordFixture({
    guid: materialGuid,
    passes: required(material.passes),
    contexts: [materialContext],
  });
  if ('legacyBoundary' in testCase)
    record = {
      ...record,
      programs: record.programs.map((program) => ({
        ...program,
        selections: program.selections.map((selection) =>
          selection.pass.startsWith('particle-')
            ? selection
            : { ...selection, address: 'direct' as const },
        ),
      })),
    };
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
              ...(baseEmitter.reflection.renderers?.[0] ?? {}),
              topology: kind,
              resource: kind === 'mesh' ? 'meshInstances' : 'billboardInstances',
            })),
          },
        },
      ],
    },
  } as VfxGpuEffectAsset;
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  assets.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
  const world = new World({ assets });
  const source = createVfxRuntimeHost({ camera: { read: () => camera } });
  const consumer = gpuParticleRenderFeature({ camera: { read: () => undefined } });

  publishRuntimeAssets(assets, [
    {
      guid: materialGuid,
      asset: {
        ...material,
        cooked: JSON.parse(serializeCookedMaterialRecord(record)),
      } as MaterialAsset,
    },
    { guid: meshGuid, asset: geometry },
  ]);
  (await assets.load(meshGuid, 'mesh')).unwrap();
  const loadedMaterial = await assets.load(materialGuid, 'material');
  if ('legacyBoundary' in testCase) {
    // Invalid cooked address metadata is rejected before a runtime identity exists.
    expect(loadedMaterial.ok).toBe(false);
    return;
  }
  const materialHandle = loadedMaterial.unwrap();
  const projection = required(
    assets.getMaterialProjectionForPayload(
      runtimeAssets(assets).borrow<MaterialAsset>(materialHandle).unwrap(),
    ),
  );
  const handle = runtimeAssetRegistry(world.assets)
    .create(runtimeEffectFixture(world, await cookedEffectFixture(renderedEffect)))
    .unwrap();
  world.spawn({ component: ParticleEffectPlayer, data: { effect: handle } }).unwrap();
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
      const packet = structuredClone(candidate.message, {
        transfer: renderPublicationTransfers(candidate.message),
      });
      candidate.accept();
      const accepted = receiver.accept(packet).unwrap();
      const frame = required(accepted.packet.features[0]).data as Parameters<
        typeof consumer.plan
      >[0];
      const row = required(required(frame.worlds[0]).materials.get(materialHandle));
      const enabledKinds = kinds.filter((kind) => kind !== disabled);
      const used = pass.startsWith('particle-');
      if (used)
        expect(row.projection).toEqual(
          'mixed' in testCase && !('legacyBoundary' in testCase)
            ? {
                ...projection,
                passes: projection.passes.filter((pass) => pass.name.startsWith('particle-')),
              }
            : projection,
        );
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
      const planned = consumer.plan(
        frame,
        singleViewContext({
          resolveAsset: (_index, reference, revision) =>
            accepted.resources.resolveAsset(reference, revision),
          materialContext,
          caps: {} as never,
          frame: { frameNumber: packet.revision },
          generation: 0,
        }),
      );
      expect(
        planResources(planned.unwrap())
          .filter((resource) => resource.kind === 'graphics-program')
          .map((resource) => resource.program.shader),
      ).toEqual(
        enabledKinds.map((kind) =>
          pass === `particle-${kind}`
            ? required(required(projection.passes[0]).programs[0]).specializationKey
            : `forgeax::vfx-render.particles.${kind}`,
        ),
      );
      if (iteration === 1) expect(accepted.packet.assets).toHaveLength(0);
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
  const world = new World({ assets: new AssetRegistry() });
  runtimeAssetRegistry(world.assets).installDecoder(
    particleEffectContribution.kind,
    particleEffectContribution.decoder,
  );
  world
    .spawn({
      component: ParticleEffectPlayer,
      data: {
        effect: runtimeAssetRegistry(world.assets)
          .create(runtimeEffectFixture(world, await cookedEffectFixture(renderedEffect)))
          .unwrap(),
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
      const row = required(
        required(frame.worlds[0]).materials.get(effectFixtureReference(world, guid, 'material')),
      );
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
  const world = new World({ assets: new AssetRegistry() });
  runtimeAssetRegistry(world.assets).installDecoder(
    particleEffectContribution.kind,
    particleEffectContribution.decoder,
  );
  const handle = runtimeAssetRegistry(world.assets).create(effect).unwrap();
  world.spawn({ component: ParticleEffectPlayer, data: { effect: handle } }).unwrap();
  const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const identity = { source: 'vfx-publication', epoch: 1 };
  const publisher = createRenderPublisher(
    world,
    runtimeAssetRegistry(world.assets),
    identity,
    undefined,
    [feature],
  );
  const receiver = new RenderPublicationReceiver(identity);
  const seal = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    return receiver.accept(packet).unwrap().packet;
  };
  try {
    world.update(1 / 60).unwrap();
    const original = runtime.snapshot()[0];
    expect(original).toBeDefined();
    const first = seal();
    expect(first.assetVersions?.filter((row) => row.value.kind === 'particle-effect')).toHaveLength(
      1,
    );
    const inspect = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      expect(value).not.toHaveProperty('wgsl');
      for (const child of value instanceof Map ? value.values() : Object.values(value))
        inspect(child);
    };
    inspect(first.features);
    const second = seal();
    expect(
      second.assetVersions?.filter((row) => row.value.kind === 'particle-effect'),
    ).toHaveLength(0);
    inspect(second.features);
    expect(original?.parameterBlock.buffer.byteLength).toBe(original?.parameterBlock.byteLength);
    expect(publisher.prepare(0).ok).toBe(false);
    publisher
      .recycle(first.revision, renderPublicationTransfers(encodeRenderPublication(first)))
      .unwrap();
    publisher
      .recycle(second.revision, renderPublicationTransfers(encodeRenderPublication(second)))
      .unwrap();
  } finally {
    publisher.dispose();
    receiver.dispose();
    await ctx.fiber.dispose();
  }
});

async function publicationFixture(effectAsset = effect) {
  const effect = effectAsset;
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  assets.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
  const world = new World({ assets });
  const handle = runtimeAssetRegistry(world.assets).create(effect).unwrap();
  const player = world
    .spawn({ component: ParticleEffectPlayer, data: { effect: handle } })
    .unwrap();
  runtimeAssetRegistry(world.assets).release(handle).unwrap();
  const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const source = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const consumer = gpuParticleRenderFeature({ camera: { read: () => undefined } });

  const identity = { source: 'vfx-exact-effect', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [source]);
  const receiver = new RenderPublicationReceiver(identity);
  let resources: RenderResourceScope | undefined;
  type Frame = Parameters<typeof consumer.plan>[0];
  const data = (packet: RenderPublication) => required(packet.features[0]).data as Frame;
  const seal = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const accepted = receiver.accept(packet).unwrap();
    resources = accepted.resources;
    return accepted.packet;
  };
  const plan = (packet: RenderPublication, generation = 0) =>
    consumer.plan(
      data(packet),
      singleViewContext({
        resolveAsset: (_index, effectHandle, revision) =>
          required(resources).resolveAsset(effectHandle, revision),
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
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
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
          wgsl: `${required(effect.program.emitters[0]).wgsl}\n// replacement effect definition`,
        })),
      },
    };
    const loadedEffect = await loadEffect(newEffect);
    assets.replace(handle, loadedEffect).unwrap();
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
  new Map([['value', 1.25]]),
  new Date(1000),
])('rejects non-data effect content before changing the current version (%s)', async (customData) => {
  const f = await publicationFixture();
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const before = runtimeAssets(f.assets).version(f.handle).unwrap();
    expect(f.assets.update(f.handle, { customData } as never).ok).toBe(false);
    expect(runtimeAssets(f.assets).version(f.handle).unwrap()).toBe(before);
    expect(programSources(f.plan(first))).toEqual([required(effect.program.emitters[0]).wgsl]);
  } finally {
    await f.close();
  }
});

it('preserves the accepted effect and revision when adopting a replacement throws', async () => {
  const f = await publicationFixture();
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const row = required(first.assetVersions?.find((row) => row.value.kind === 'particle-effect'));
    const accepted = f.resources.resolveAsset(row.handle, row.revision).unwrap();
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
      assetVersions: [{ ...row, revision: row.revision + 1, value: replacement }],
    };
    expect(() => f.receiver.accept(encodeRenderPublication(second))).toThrow(failure);
    expect(f.resources.revision).toBe(first.revision);
    expect(f.resources.resolveAsset(row.handle, row.revision).unwrap()).toBe(accepted);
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
    const row = required(first.assetVersions?.find((row) => row.value.kind === 'particle-effect'));
    const borrowed = row.value as VfxGpuEffectAsset;
    const accepted = f.resources.resolveAsset<VfxGpuEffectAsset>(row.handle, row.revision).unwrap();
    expect(accepted).not.toBe(borrowed);
    expect(Object.isFrozen(borrowed)).toBe(false);
    expect(Object.isFrozen(accepted.program.emitters[0]?.reflection)).toBe(true);
    const initial = programs(first);
    expect(initial.length).toBeGreaterThan(0);
    const original = required(borrowed.program.emitters[0]);
    const originalWgsl = original.wgsl;
    Object.assign(original, {
      wgsl: `${required(effect.program.emitters[0]).wgsl}\n// borrowed packet mutation`,
    });
    const repeated = programs(first);
    expect(repeated[0]).toBe(initial[0]);
    expect(repeated[0]?.wgsl).toBe(originalWgsl);
    // Replacement is a new publication authority, even if an upstream producer
    // reused a fingerprint. Do not use that string as an identity-only proof.
    const replacement = structuredClone(accepted);
    Object.assign(required(replacement.program.emitters[0]), {
      wgsl: `${required(effect.program.emitters[0]).wgsl}\n// accepted replacement`,
    });
    f.submit(first, f.plan(first));
    f.assets.replace(f.handle, replacement).unwrap();
    f.world.update(1 / 60).unwrap();
    const second = f.seal();
    const changed = programs(second);
    expect(changed[0]).not.toBe(initial[0]);
    expect(changed[0]?.wgsl).toContain('// accepted replacement');
    const recovered = planResources(f.plan(second, 1).unwrap()).flatMap((row) =>
      row.kind === 'compute-program' ? [row.program] : [],
    );
    expect(recovered[0]?.wgsl).toContain('// accepted replacement');
  } finally {
    await f.close();
  }
});

it.each([
  'immutable',
  'raw',
] as const)('retains only immutable provider-free compute layouts across retry, tick, and device recovery (%s)', async (ownership) => {
  const loaded = await loadEffect(rawEffect);
  const f = await publicationFixture(ownership === 'raw' ? structuredClone(loaded) : loaded);
  const bindings = (plan: ReturnType<typeof f.plan>) =>
    planResources(plan.unwrap()).filter((row) => row.kind === 'compute-bindings');
  const runtimeBytes = (plan: ReturnType<typeof f.plan>) =>
    required(
      planResources(plan.unwrap()).find(
        (row) => row.kind === 'buffer' && row.name.endsWith('.tick-0.runtime'),
      ),
    );
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const initial = f.plan(first);
    const layout = required(bindings(initial)[0]);
    expect(layout.entries).toContainEqual({
      binding: 0,
      resource: layout.name.replace('.tick-0.simulation-bindings', '.particles'),
    });
    expect(layout.entries.length).toBeGreaterThan(1);
    expect(isOwnedRenderFeatureProgramData(layout)).toBe(true);
    const retry = f.plan(first);
    expect(bindings(retry)[0]).toBe(layout);
    f.consumer.onFrameAborted?.(f.data(first));
    const afterAbort = f.plan(first);
    expect(bindings(afterAbort)).toEqual(bindings(initial));
    f.submit(first, afterAbort);
    f.world.update(1 / 60).unwrap();
    const second = f.seal();
    const advanced = f.plan(second);
    expect(bindings(advanced)[0]).toBe(layout);
    // Logical layouts are retained; the exact current tick upload is not.
    expect(runtimeBytes(advanced)).not.toEqual(runtimeBytes(initial));
    const recovered = f.plan(second, 1);
    expect(bindings(recovered)[0]).toEqual(layout);
    expect(bindings(recovered)[0]).toBe(layout);
    if (ownership === 'immutable') {
      f.submit(second, recovered);
      f.world.removeComponent(f.player, ParticleEffectPlayer).unwrap();
      const empty = f.seal();
      const emptyPlan = f.plan(empty);
      expect(bindings(emptyPlan)).toEqual([]);
      f.submit(empty, emptyPlan);
      const handle = runtimeAssetRegistry(f.world.assets).create(loaded).unwrap();
      f.world
        .addComponent(f.player, { component: ParticleEffectPlayer, data: { effect: handle } })
        .unwrap();
      runtimeAssetRegistry(f.world.assets).release(handle).unwrap();
      f.world.update(1 / 60).unwrap();
      const reentered = f.seal();
      expect(bindings(f.plan(reentered))[0]).not.toBe(layout);
    }
  } finally {
    await f.close();
  }
});

it('rebuilds compute binding metadata after a managed definition edit', async () => {
  const f = await publicationFixture(structuredClone(effect));
  const binding = (plan: ReturnType<typeof f.plan>) => {
    const program = planResources(plan.unwrap()).find((row) => row.kind === 'compute-program');
    if (program?.kind !== 'compute-program') throw new Error('missing compute program');
    return required(required(program.program.bindings?.[0]).entries[0]);
  };
  try {
    f.world.update(1 / 60).unwrap();
    const packet = f.seal();
    const first = binding(f.plan(packet));
    f.submit(packet, f.plan(packet));
    const updated = f.assets.read(f.handle).unwrap() as VfxGpuEffectAsset;
    Object.assign(
      required(required(required(updated.program.emitters[0]).reflection.bindings[0]).entries[0]),
      { visibility: 7 },
    );
    f.assets.replace(f.handle, updated).unwrap();
    f.world.update(1 / 60).unwrap();
    const changed = binding(f.plan(f.seal()));
    expect(changed).not.toBe(first);
    expect(first.visibility).toBe(4);
    expect(changed.visibility).toBe(7);
  } finally {
    await f.close();
  }
});

it.each([
  'immutable',
  'raw',
] as const)('shares only an immutable compute program while keeping independent player storage and preparation (%s)', async (ownership) => {
  const f = await publicationFixture(ownership === 'immutable' ? effect : structuredClone(effect));
  const secondPlayer = f.world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect: f.handle, preparePipelines: true },
    })
    .unwrap();
  const resources = (plan: ReturnType<typeof f.plan>) => planResources(plan.unwrap());
  const programs = (plan: ReturnType<typeof f.plan>) =>
    resources(plan).filter((row) => row.kind === 'compute-program');
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const initial = f.plan(first);
    const declarations = programs(initial);
    expect(declarations).toHaveLength(1);
    expect(declarations.filter((row) => row.preparePipelines === true)).toHaveLength(1);
    const particles = resources(initial).filter(
      (row) => row.kind === 'buffer' && row.name.endsWith('.particles'),
    );
    const bindings = resources(initial).filter((row) => row.kind === 'compute-bindings');
    expect(new Set(particles.map((row) => row.name)).size).toBe(2);
    expect(new Set(bindings.map((row) => row.name)).size).toBe(2);
    expect(new Set(bindings.map((row) => row.program)).size).toBe(1);
    f.submit(first, initial);
    f.world.removeComponent(f.player, ParticleEffectPlayer).unwrap();
    f.world.update(1 / 60).unwrap();
    const second = f.seal();
    const surviving = f.plan(second);
    expect(programs(surviving)).toHaveLength(1);
    expect(programs(surviving)[0]?.preparePipelines).toBe(true);
    expect(programs(surviving)[0]?.name).toBe(declarations[0]?.name);
    expect(
      resources(surviving).filter(
        (row) => row.kind === 'buffer' && row.name.endsWith('.particles'),
      ),
    ).toHaveLength(1);
    f.submit(second, surviving);
    f.world.set(secondPlayer, ParticleEffectPlayer, { preparePipelines: false }).unwrap();
    f.world.update(1 / 60).unwrap();
    const third = f.seal();
    expect(programs(f.plan(third))[0]?.preparePipelines).toBeUndefined();
  } finally {
    await f.close();
  }
});

it.each([
  'immutable',
  'raw',
] as const)('retains generated buffer metadata but keeps uploads and raw capacity live (%s)', async (ownership) => {
  const f = await publicationFixture(ownership === 'immutable' ? effect : structuredClone(effect));
  const resources = (packet: ReturnType<typeof f.seal>) => planResources(f.plan(packet).unwrap());
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const initial = resources(first);
    const particles = required(
      initial.find((row) => row.kind === 'buffer' && row.name.endsWith('.particles')),
    );
    const upload = required(
      initial.find((row) => row.kind === 'buffer' && row.name.endsWith('.tick-0.runtime')),
    );
    expect(isOwnedRenderFeatureProgramData(particles)).toBe(true);
    const retry = resources(first);
    expect(retry.find((row) => row.name === particles.name)).toBe(particles);
    expect(retry.find((row) => row.name === upload.name)).not.toBe(upload);
    f.consumer.onFrameAborted?.(f.data(first));
    expect(resources(first).find((row) => row.name === particles.name)).toBe(particles);
    expect(
      planResources(f.plan(first, 1).unwrap()).find((row) => row.name === particles.name),
    ).toBe(particles);
    if (ownership === 'raw') {
      f.submit(first, f.plan(first));
      const updated = f.assets.read(f.handle).unwrap() as VfxGpuEffectAsset;
      const emitter = required(updated.program.emitters[0]);
      Object.assign(emitter, { capacity: emitter.capacity * 2 });
      f.assets.replace(f.handle, updated).unwrap();
      f.world.update(1 / 60).unwrap();
      const changed = required(
        resources(f.seal()).find((row) => row.kind === 'buffer' && row.name.endsWith('.particles')),
      );
      expect(changed).not.toBe(particles);
      expect(changed.kind === 'buffer' && changed.size).toBe(
        particles.kind === 'buffer' ? particles.size * 2 : undefined,
      );
    } else {
      f.submit(first, f.plan(first));
      f.world.removeComponent(f.player, ParticleEffectPlayer).unwrap();
      const empty = f.seal();
      const emptyPlan = f.plan(empty);
      expect(planResources(emptyPlan.unwrap()).filter((row) => row.kind === 'buffer')).toEqual([]);
      f.submit(empty, emptyPlan);
      const handle = runtimeAssetRegistry(f.world.assets).create(effect).unwrap();
      f.world
        .addComponent(f.player, { component: ParticleEffectPlayer, data: { effect: handle } })
        .unwrap();
      runtimeAssetRegistry(f.world.assets).release(handle).unwrap();
      f.world.update(1 / 60).unwrap();
      expect(
        resources(f.seal()).find((row) => row.kind === 'buffer' && row.name.endsWith('.particles')),
      ).not.toBe(particles);
    }
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
    expect(f.assets.read(f.handle).ok).toBe(true);
    expect(oldIntent.effect).toEqual(effect);
    const second = f.seal();
    expect(
      second.assetVersions?.filter((row) => row.value.kind === 'particle-effect'),
    ).toHaveLength(1);
    expect(
      second.assetVersions?.find((row) => row.value.kind === 'particle-effect')?.value,
    ).toEqual(updated);
    const oldReference = required(f.data(first).worlds[0]?.intents[0]).emitter;
    const current = required(f.data(second).worlds[0]?.intents.at(-1)).emitter;
    expect(current.id).toBe(oldReference.id);
    expect(current.effect).toBe(oldReference.effect);
    expect(current).not.toEqual(oldReference);
    expect(
      f.resources
        .resolveAsset(required(oldReference.effect), required(oldReference.revision))
        .unwrap(),
    ).toEqual(effect);
    expect(
      f.resources.resolveAsset(required(current.effect), required(current.revision)).unwrap(),
    ).toEqual(updated);
    expect(
      f.publisher.recycle(
        second.revision,
        renderPublicationTransfers(encodeRenderPublication(second)),
      ).ok,
    ).toBe(false);
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
    expect(f.runtime.lastCommitted(f.player)?.effect).toEqual(updated);
    const third = f.seal();
    expect(third.assetVersions?.filter((row) => row.value.kind === 'particle-effect')).toHaveLength(
      0,
    );
    expect(third.retiredAssetVersions).toContainEqual({
      handle: oldReference.effect,
      revision: required(oldReference.revision),
    });
    expect(
      f.resources.resolveAsset(required(oldReference.effect), required(oldReference.revision)).ok,
    ).toBe(false);
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
    expect(
      discarded.packet.assetVersions?.some((row) => row.value.kind === 'particle-effect'),
    ).toBe(true);
    discarded.discard();
    const second = f.seal();
    expect(second.assetVersions?.some((row) => row.value.kind === 'particle-effect')).toBe(true);
    f.submit(second, f.plan(second));
    f.publisher.dispose();
    const identity = { source: 'vfx-exact-effect', epoch: 2 };
    const publisher = createRenderPublisher(f.world, f.assets, identity, undefined, [f.source]);
    const receiver = new RenderPublicationReceiver(identity);
    try {
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.message, {
        transfer: renderPublicationTransfers(candidate.message),
      });
      candidate.accept();
      const accepted = receiver.accept(packet).unwrap();
      expect(accepted.packet.baseline).toBe(true);
      expect(
        accepted.packet.assetVersions?.some((row) => row.value.kind === 'particle-effect'),
      ).toBe(true);
      const consumer = gpuParticleRenderFeature({ camera: { read: () => undefined } });
      const plan = consumer.plan(
        f.data(accepted.packet),
        singleViewContext({
          resolveAsset: (_index, handle, revision) =>
            accepted.resources.resolveAsset(handle, revision),
          caps: {} as never,
          frame: { frameNumber: packet.revision },
          generation: 1,
        }),
      );
      expect(programSources(plan)).toEqual([required(updated.program.emitters[0]).wgsl]);
      const broken = structuredClone(f.data(accepted.packet));
      const retained = required(broken.worlds[0]?.retained[0]);
      Object.assign(retained.intent, { programFingerprint: 'sha256:wrong-version' });
      expect(
        consumer.plan(
          broken,
          singleViewContext({
            resolveAsset: (_index, handle, revision) =>
              accepted.resources.resolveAsset(handle, revision),
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

it('releases fixed versions on recovery, re-entry, despawn and runtime detach', async () => {
  const f = await publicationFixture();
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const original = required(required(f.data(first).worlds[0]?.intents[0]).emitter.effect);
    expect(original).toBe(f.handle);
    expect(runtimeAssets(f.assets).inspect().snapshots).toBe(1);
    f.submit(first, f.plan(first));
    f.runtime.recover();
    expect(runtimeAssets(f.assets).inspect().snapshots).toBe(0);
    expect(f.assets.read(f.handle).ok).toBe(true);
    const recovered = f.seal();
    expect(required(f.data(recovered).worlds[0]?.intents[0]).emitter.effect).toBe(f.handle);
    expect(runtimeAssets(f.assets).inspect().snapshots).toBe(1);
    f.submit(recovered, f.plan(recovered, 1));
    f.world.despawn(f.player).unwrap();
    const empty = f.seal();
    expect(runtimeAssets(f.assets).inspect().snapshots).toBe(0);
    expect(f.assets.read(f.handle).ok).toBe(false);
    expect(empty.retiredAssetVersions).toHaveLength(1);
    f.submit(empty, f.plan(empty, 1));
    const handle = f.assets.create(effect).unwrap();
    f.world.spawn({ component: ParticleEffectPlayer, data: { effect: handle } }).unwrap();
    f.assets.release(handle).unwrap();
    const reentered = f.seal();
    expect(required(f.data(reentered).worlds[0]?.intents[0]).emitter.effect).toBe(handle);
    expect(handle).not.toBe(original);
    expect(runtimeAssets(f.assets).inspect().snapshots).toBe(1);
  } finally {
    await f.close();
  }
  expect(runtimeAssets(f.assets).inspect().snapshots).toBe(0);
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
    expect(runtimeAssets(f.assets).inspect().snapshots).toBe(2);
    const second = f.seal();
    expect(f.data(second).worlds[0]?.intents.map((intent) => intent.emitter.id)).toContain(old.id);
    f.submit(second, f.plan(second));
    expect(f.runtime.lastCommittedEmitter(f.player, old.id)).toBeUndefined();
    expect(runtimeAssets(f.assets).inspect().snapshots).toBe(1);
    const third = f.seal();
    expect(third.retiredAssetVersions).toContainEqual({
      handle: old.effect,
      revision: old.revision,
    });
  } finally {
    await f.close();
  }
});

it('isolates creator input and adopts explicit WGSL program replacement with the same fingerprint', async () => {
  const input = structuredClone(rawEffect);
  const f = await publicationFixture(input);
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    f.submit(first, f.plan(first));
    Object.assign(required(input.program.emitters[0]), {
      wgsl: `${required(effect.program.emitters[0]).wgsl}\n// changed input`,
    });
    f.world.update(1 / 60).unwrap();
    const unchanged = f.seal();
    expect(programSources(f.plan(unchanged))).toEqual([
      required(rawEffect.program.emitters[0]).wgsl,
    ]);
    f.submit(unchanged, f.plan(unchanged));
    f.assets.replace(f.handle, input).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(programSources(f.plan(f.seal()))).toEqual([expect.stringContaining('// changed input')]);
  } finally {
    await f.close();
  }
});

it('rejects effect accessors without invoking them during asset capture', () => {
  const mutable = structuredClone(rawEffect);
  const getter = vi.fn(() => {
    throw new Error('must not invoke');
  });
  Object.defineProperty(mutable, 'unused', { enumerable: true, get: getter });
  const assets = new AssetRegistry();
  expect(assets.create(mutable).ok).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  expect(runtimeAssets(assets).inspect().assets).toBe(0);
});

it('rejects a candidate WGSL accessor while queued work keeps the accepted program', async () => {
  const f = await publicationFixture();
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    const updated = f.assets.read(f.handle).unwrap() as VfxGpuEffectAsset;
    const getter = vi.fn(() => {
      throw new Error('must not invoke');
    });
    Object.defineProperty(required(updated.program.emitters[0]), 'wgsl', {
      enumerable: true,
      get: getter,
    });
    expect(f.assets.replace(f.handle, updated).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(programSources(f.plan(first))).toEqual([required(effect.program.emitters[0]).wgsl]);
  } finally {
    await f.close();
  }
});

it.each([
  effect,
  rawEffect,
])('captures loader and code-created definitions with the same immutable semantics', async (input) => {
  const f = await publicationFixture(input);
  try {
    f.world.update(1 / 60).unwrap();
    const intent = required(f.runtime.snapshot()[0]);
    expect(intent.effect).not.toBe(input);
    expect(Object.isFrozen(intent.effect)).toBe(true);
    expect(Object.isFrozen(intent.emitter.reflection)).toBe(true);
    expect(() =>
      Object.assign(intent.emitter, {
        wgsl: `${required(effect.program.emitters[0]).wgsl}\n// bypass`,
      }),
    ).toThrow();
  } finally {
    await f.close();
  }
});

it('captures typed reflection bytes independently across fixed versions and Worker publication', async () => {
  const input = structuredClone(rawEffect);
  const bytes = new Uint8Array([1, 2, 3, 4]);
  Object.assign(required(input.program.emitters[0]).reflection, { authorBytes: bytes });
  const f = await publicationFixture(input);
  try {
    f.world.update(1 / 60).unwrap();
    const first = f.seal();
    f.submit(first, f.plan(first));
    bytes[2] = 42;
    const previous = required(first.assetVersions?.[0]);
    const read = (row: typeof previous) =>
      required(
        f.resources.resolveAsset<VfxGpuEffectAsset>(row.handle, row.revision).unwrap().program
          .emitters[0],
      ).reflection as unknown as { authorBytes: Uint8Array };
    expect(read(previous).authorBytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    f.assets.replace(f.handle, input).unwrap();
    f.world.update(1 / 60).unwrap();
    const second = f.seal();
    expect(read(required(second.assetVersions?.[0])).authorBytes).toEqual(
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
  const handle = runtimeAssetRegistry(f.world.assets).create(effect).unwrap();
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
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  assets.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
  const world = new World({ assets });

  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  publishRuntimeAssets(assets, [
    { guid: materialGuid, asset: Materials.unlit([1, 1, 1, 1]) },
    { guid: meshGuid, asset: mesh },
  ]);
  const materialHandle = (await assets.load(materialGuid, 'material')).unwrap();
  let sourceMeshHandle: import('@forgeax/engine-types').AssetHandle<'mesh'> | undefined;
  if (kind !== 'player') {
    sourceMeshHandle = (await assets.load(meshGuid, 'mesh')).unwrap();
  }
  const custom = createBoxGeometry(2, 1, 1).unwrap();
  const handle = runtimeAssetRegistry(world.assets).create(mesh).unwrap();
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
          effect: runtimeAssetRegistry(world.assets).create(definition).unwrap(),
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
          material: {
            read: (_world, reference) =>
              runtimeAssets(assets).borrow<MaterialAsset>(Number(reference)).unwrap(),
          },
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
  const publish = (materialBindings = false) => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.message, {
      transfer: [
        ...renderPublicationTransfers(candidate.message),
        ...renderPublicationAssetTransfers(candidate.message),
      ],
    });
    candidate.accept();
    const accepted = receiver.accept(packet).unwrap();
    const view = accepted.packet;
    const planned = consumer
      .plan(
        data(view),
        singleViewContext({
          targets: [{ name: 'color', kind: 'color', format: 'rgba8unorm', sampleCount: 1 }],
          resolveAsset: (_index, assetHandle, revision) =>
            accepted.resources.resolveAsset(assetHandle, revision),
          ...(materialBindings
            ? { materialShaderBindingContract: () => ({ bindings: 'render-material' as const }) }
            : {}),
          caps: {} as never,
          frame: { frameNumber: packet.revision },
          generation: 0,
        }),
      )
      .unwrap();
    const geometry = planResources(planned)
      .filter((resource) => resource.kind === 'buffer')
      .filter((resource) => resource.name.endsWith('.geometry-buffer'));
    consumer.onFrameSubmitted?.(data(view));
    publisher
      .acknowledgeFeatures(packet.revision, [
        { identity: source.identity, feedback: planned.sourceFeedback },
      ])
      .unwrap();
    const returned = structuredClone(renderPublicationTransfers(packet), {
      transfer: renderPublicationTransfers(packet),
    });
    publisher.recycle(packet.revision, returned).unwrap();
    return { packet: view, data: data(view), resources: accepted.resources, geometry, planned };
  };
  return {
    world,
    assets,
    mesh,
    custom,
    handle,
    player,
    meshGuid,
    definition,
    materialGuid,
    materialHandle,
    sourceMeshHandle,
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

function materialColor(planned: Parameters<typeof planResources>[0]) {
  const runtime = planResources(planned).find(
    (resource) => resource.kind === 'buffer' && resource.name.endsWith('.renderer-0.runtime'),
  );
  if (runtime?.kind !== 'buffer' || !(runtime.data instanceof Uint8Array))
    throw new Error('Expected the actual particle projection runtime buffer');
  return [...new Float32Array(runtime.data.buffer, runtime.data.byteOffset, 76).slice(32, 36)];
}

it('omits duplicated cooked records while keeping mutable authored VFX material values current', async () => {
  const f = await meshPublicationFixture();
  const color: [number, number, number, number] = [0.25, 0.5, 0.75, 1];
  const material = {
    ...Materials.unlit(color),
    values: { baseColor: color },
    cooked: { program: 'exact asset closure'.repeat(1024) },
  };
  try {
    f.assets.replace(f.materialHandle, material).unwrap();
    const first = f.publish();
    expect(
      required(first.data.worlds[0]?.materials.get(f.materialHandle)).asset,
    ).not.toHaveProperty('cooked');
    // Registry-admitted content never carries Cook records into the receiver.
    const resident = first.resources.lookupAsset<MaterialAsset>(f.materialGuid);
    expect(resident).toBeDefined();
    expect(resident).not.toHaveProperty('cooked');
    expect(materialColor(first.planned)).toEqual([0.25, 0.5, 0.75, 1]);
    color[0] = 0.75;
    f.assets
      .update(f.materialHandle, {
        values: { baseColor: color },
      })
      .unwrap();
    const second = f.publish();
    expect(second.packet.assetPatches).toHaveLength(1);
    expect(materialColor(second.planned)).toEqual([0.75, 0.5, 0.75, 1]);
    const replacement = { ...Materials.unlit([0.5, 0.25, 0.75, 1]), cooked: { program: 'next' } };
    f.assets.replace(f.materialHandle, replacement).unwrap();
    f.publisher.prepare(0).unwrap().discard();
    const third = f.publish();
    expect(third.packet.assets.filter((row) => row.value.kind === 'material')).toHaveLength(1);
    expect(third.resources.lookupAsset(f.materialGuid)).not.toHaveProperty('cooked');
    expect(materialColor(third.planned)).toEqual([0.5, 0.25, 0.75, 1]);
    f.assets.replace(f.materialHandle, material).unwrap();
    expect(materialColor(f.publish().planned)).toEqual([0.75, 0.5, 0.75, 1]);
    expect(material.cooked.program.length).toBeGreaterThan(1024);
  } finally {
    await f.close();
  }
});

it('extracts admitted material content without cooked data with or without a resource witness', async () => {
  const f = await meshPublicationFixture();
  const material = { ...Materials.unlit([1, 1, 1, 1]), cooked: { program: 'custom or direct' } };
  try {
    f.assets.replace(f.materialHandle, material).unwrap();
    const admitted = f.assets.read(f.materialHandle).unwrap();
    expect(admitted).not.toHaveProperty('cooked');
    for (const referenceAsset of [undefined, () => undefined]) {
      const frame = f.source
        .extract({
          worlds: [f.world],
          owner: 0,
          frameNumber: 1,
          views: [],
          ...(referenceAsset === undefined ? {} : { referenceAsset }),
        })
        .unwrap();
      expect(required(frame.worlds[0]?.materials.get(f.materialHandle)).asset).toEqual(admitted);
    }
  } finally {
    await f.close();
  }
});

it('rejects material cooked accessors before replacing the accepted runtime content', async () => {
  const f = await meshPublicationFixture();
  const getter = vi.fn(() => {
    throw new Error('must not invoke');
  });
  const material = Materials.unlit([1, 1, 1, 1]);
  Object.defineProperty(material, 'cooked', { enumerable: true, get: getter });
  try {
    const reference = f.materialHandle;
    const prior = f.assets.read(reference).unwrap();
    expect(f.assets.replace(reference, material).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(f.assets.read(reference).unwrap()).toEqual(prior);
    expect(f.publish().data.worlds[0]?.materials.get(f.materialHandle)).toBeDefined();
  } finally {
    await f.close();
  }
});

it('publishes a stock VFX mesh once through asset residency across steady frames and discarded replacement', async () => {
  const f = await meshPublicationFixture();
  try {
    const first = f.publish();
    const reference = required(first.data.worlds[0]?.meshes.get(required(f.sourceMeshHandle)));
    expect(reference).toBeTypeOf('number');
    expect(first.packet.assets.filter((row) => row.value.kind === 'mesh')).toHaveLength(1);
    expect(first.resources.lookupAsset(f.meshGuid)).toEqual(
      f.assets.read(required(runtimeAssetReference(f.assets, f.meshGuid))).unwrap(),
    );
    expect(first.geometry).toHaveLength(1);
    const second = f.publish();
    expect(second.packet.assets.filter((row) => row.value.kind === 'mesh')).toHaveLength(0);
    expect(second.data.worlds[0]?.meshes.get(required(f.sourceMeshHandle))).toBe(reference);
    expect(second.geometry).toEqual(first.geometry);
    const replacement = createBoxGeometry(3, 1, 1).unwrap();
    f.assets.replace(required(f.sourceMeshHandle), replacement).unwrap();
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
    expect(first.data.worlds[0]?.meshes.get(required(f.sourceMeshHandle))).toMatchObject({
      kind: 'mesh',
    });
    expect(first.packet.assets.filter((row) => row.value.kind === 'mesh')).toHaveLength(0);
    const before = new Float32Array(f.custom.vertices);
    f.custom.vertices[0] = required(before[0]) + 2;
    const positions = f.custom.attributes.position as Float32Array;
    positions[0] = required(positions[0]) + 2;
    const second = f.publish();
    expect(second.geometry[0]?.data).not.toEqual(first.geometry[0]?.data);
    expect(first.data.worlds[0]?.meshes.get(required(f.sourceMeshHandle))).toMatchObject({
      vertices: before,
    });
    expect(f.custom.vertices.byteLength).toBe(before.byteLength);
  } finally {
    await f.close();
  }
});

it('publishes managed replacement and restoration for a Player with only a non-catalogued MeshFilter', async () => {
  const f = await meshPublicationFixture('player');
  try {
    const first = f.publish();
    expect(first.data.worlds[0]?.meshes.get(`player:${f.player}`)).toBe(f.handle);
    expect(first.packet.assets.find((row) => row.handle === f.handle)?.guid).toBeUndefined();
    const vertices = new Float32Array(f.mesh.vertices);
    vertices[0] = required(vertices[0]) + 0.2;
    const position = (f.mesh.attributes.position as Float32Array).slice(0, 3);
    position[0] = required(position[0]) + 0.2;
    f.assets.writeRange(f.handle, { attribute: 'position', first: 0, values: position }).unwrap();
    f.world.update(1 / 60).unwrap();
    const changed = f.publish();
    expect(changed.resources.resolveAsset<MeshAsset>(f.handle).unwrap().vertices).toEqual(vertices);
    expect(changed.geometry[0]?.data).not.toEqual(first.geometry[0]?.data);
    f.assets.replace(f.handle, f.mesh).unwrap();
    f.world.update(1 / 60).unwrap();
    expect(f.publish().geometry[0]?.data).toEqual(first.geometry[0]?.data);
    const replacement = createBoxGeometry(3, 1, 1).unwrap();
    const nextHandle = runtimeAssetRegistry(f.world.assets).create(replacement).unwrap();
    f.world.set(f.player, MeshFilter, { assetHandle: nextHandle }).unwrap();
    f.world.update(1 / 60).unwrap();
    const rebound = f.publish();
    expect(rebound.data.worlds[0]?.meshes.get(`player:${f.player}`)).toBe(nextHandle);
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
        worlds: [new World({ assets: new AssetRegistry() }), f.world],
        owner: 1,
        frameNumber: 1,
        views: [{ identity: 'main', render: true }],
        referenceAsset: (index, identity, captured) => {
          requested.push(index);
          expect([f.handle, f.materialHandle]).toContain(identity);
          expect(runtimeAssets(f.world.assets).resolveAsset(Number(identity)).unwrap()).toBe(
            captured,
          );
          return Number(identity);
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
        resolveAsset: (index, handle, revision) => {
          resolved.push(index);
          return runtimeAssets(f.world.assets).resolveAsset(handle, revision);
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

it('publishes fixed field textures once and keeps large samples out of steady tick messages', async () => {
  const assets = new AssetRegistry();
  assets.installDecoder(particleEffectContribution.kind, particleEffectContribution.decoder);
  const world = new World({ assets });
  const bytes = new Uint8Array(32 * 32 * 32 * 16);
  new DataView(bytes.buffer).setFloat32(0, 1, true);
  const texture = assets
    .create({
      kind: 'texture',
      format: 'rgba32float',
      colorSpace: 'linear',
      mips: { kind: 'none' },
      shape: { viewDimension: '3d', extent: { width: 32, height: 32, depth: 32 } },
      data: bytes,
    })
    .unwrap();
  const base = required(rawEffect.program.emitters[0]);
  const definition = await cookedEffectFixture({
    ...rawEffect,
    program: {
      ...rawEffect.program,
      emitters: [
        {
          ...base,
          forceFields: [
            {
              kind: 'vector',
              texture: '019e9c00-0000-7000-8000-000000000065',
              sampling: 'nearest',
              transform: Array.from(camera.viewProjection),
              strength: 1,
              attenuation: 0,
            },
          ],
        },
      ],
    },
  });
  const fieldEmitter = required(definition.program.emitters[0]);
  const handle = assets
    .create({
      ...definition,
      program: {
        ...definition.program,
        emitters: [
          {
            ...fieldEmitter,
            forceFields: required(fieldEmitter.forceFields).map((field) => ({ ...field, texture })),
          },
        ],
      },
    })
    .unwrap();
  const player = world
    .spawn({ component: ParticleEffectPlayer, data: { effect: handle } })
    .unwrap();
  const ctx = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const source = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const identity = { source: 'fixed-field-wire', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, undefined, [source]);
  const receiver = new RenderPublicationReceiver(identity);
  const publish = () => {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.message, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const accepted = receiver.accept(packet).unwrap();
    return { message: packet, packet: accepted.packet, accepted };
  };
  try {
    world.update(1 / 60).unwrap();
    const first = publish();
    const original = required(
      first.packet.assetVersions?.find((row) => row.value.kind === 'texture'),
    );
    expect(serialize(first.packet.features).byteLength).toBeLessThan(8_192);
    const changed = new Uint8Array(bytes);
    new DataView(changed.buffer).setFloat32(0, 3, true);
    assets.update(texture, { data: changed }).unwrap();
    world.update(1 / 60).unwrap();
    const second = publish();
    expect(second.packet.assetVersions?.filter((row) => row.value.kind === 'texture')).toHaveLength(
      1,
    );
    const fixed = second.accepted.resources
      .resolveAsset(original.handle, original.revision)
      .unwrap();
    if (fixed.kind !== 'texture') throw new Error('Missing held texture');
    expect(new DataView(fixed.data.buffer, fixed.data.byteOffset).getFloat32(0, true)).toBe(1);
    publisher.recycle(first.packet.revision, renderPublicationTransfers(first.message)).unwrap();
    const third = publish();
    expect(third.packet.assetVersions ?? []).toHaveLength(0);
    expect(serialize(third.packet.features).byteLength).toBeLessThan(8_192);
    expect(renderPublicationAssetTransfers(third.message)).toHaveLength(0);
  } finally {
    publisher.dispose();
    receiver.dispose();
    await ctx.fiber.dispose();
    world.despawn(player).unwrap();
    assets.release(handle).unwrap();
    assets.release(texture).unwrap();
    assets.dispose();
  }
});

it('carries the exact published material handle through stock VFX group-one bindings', async () => {
  const f = await meshPublicationFixture();
  try {
    const first = f.publish(true);
    const handle = f.materialHandle;
    const bindings = planResources(first.planned).filter(
      (resource) =>
        resource.kind === 'graphics-bindings' && resource.name.includes('.material-bindings.'),
    );
    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      if (binding.kind !== 'graphics-bindings') throw new Error('Expected material bindings');
      expect(binding.values.material).toEqual({
        world: 0,
        handle,
      });
    }
    expect(f.source.assetDependencies?.(first.data)).toContain(handle);
  } finally {
    await f.close();
  }
});

it('keeps uncooked custom material providers free of redundant reference reads', async () => {
  const f = await meshPublicationFixture('custom');
  try {
    const referenceAsset = vi.fn((_index: number, identity: unknown) => {
      if (identity === f.materialHandle)
        throw new Error('custom material reference was not requested');
      return undefined;
    });
    const frame = f.source
      .extract({
        worlds: [f.world],
        owner: 0,
        frameNumber: 1,
        views: [{ identity: 'main', render: true }],
        referenceAsset,
      })
      .unwrap();
    expect(frame.worlds[0]?.materials.has(f.materialHandle)).toBe(true);
    expect(referenceAsset.mock.calls.some((call) => call[1] === f.materialHandle)).toBe(false);
  } finally {
    await f.close();
  }
});

it.each([
  'paused',
  'disabled',
] as const)('retains exact assets for the submitted emitter when a %s replacement changes materials', async (state) => {
  const f = await meshPublicationFixture();
  try {
    const first = f.publish(true);
    const oldHandle = f.materialHandle;
    expect(first.data.worlds[0]?.materials.has(oldHandle)).toBe(true);
    const nextMaterial = f.assets.create(Materials.unlit([1, 0, 0, 1])).unwrap();
    const replacement = await loadEffect({
      ...f.definition,
      program: {
        ...f.definition.program,
        emitters: f.definition.program.emitters.map((emitter) => ({
          ...emitter,
          renderers: emitter.renderers.map((renderer) => ({ ...renderer, material: nextMaterial })),
        })),
      },
    });
    const effectHandle = f.assets.create(replacement).unwrap();
    const runtime = f.world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
    if (state === 'disabled') runtime.setEmitterSessionEnabled(f.player, 'emitter', false);
    f.world
      .set(f.player, ParticleEffectPlayer, {
        effect: effectHandle,
        playing: state !== 'paused',
        preparePipelines: state === 'disabled',
      })
      .unwrap();
    f.assets.release(effectHandle).unwrap();
    f.world.update(1 / 60).unwrap();
    const retained = f.publish(true);
    expect(retained.data.worlds[0]?.intents).toEqual([]);
    expect(retained.data.worlds[0]?.retained[0]?.emitter.id).toBe('emitter');
    expect(planPasses(retained.planned).some((pass) => pass.kind === 'raster')).toBe(
      state === 'paused',
    );
    expect(retained.data.worlds[0]?.materials.has(oldHandle)).toBe(true);
    expect(f.source.assetDependencies?.(retained.data)).toContain(oldHandle);
    expect(retained.resources.resolveAsset(oldHandle).ok).toBe(true);
    expect(retained.packet.retiredAssets).not.toContain(oldHandle);
    const bindings = planResources(retained.planned).filter(
      (resource) => resource.kind === 'graphics-bindings' && resource.values.group === 1,
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.kind === 'graphics-bindings' && bindings[0].values.material).toEqual({
      world: 0,
      handle: oldHandle,
    });
    runtime.setEmitterSessionEnabled(f.player, 'emitter', true);
    f.world.set(f.player, ParticleEffectPlayer, { playing: true }).unwrap();
    f.world.update(1 / 60).unwrap();
    f.publish(true);
    f.world.update(1 / 60).unwrap();
    const changed = f.publish(true);
    expect(changed.data.worlds[0]?.materials.has(oldHandle)).toBe(false);
    expect(changed.resources.resolveAsset(oldHandle).ok).toBe(false);
  } finally {
    await f.close();
  }
});
