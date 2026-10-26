import { runtimeAssets } from '@forgeax/engine-assets-runtime/internal';

import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { createRenderFeatureGpuWorkOwner } from '../../../render/src/features/prepared-gpu-work';
import { cookedEffectFixture } from '../../../vfx/src/__tests__/cooked-effect-fixture';
import {
  gpuParticleRenderFeature,
  planPasses,
  planResources,
  vfxTestEmitter,
} from './vfx-frame-fixture';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

it('prepares paused storage and actual NullRHI kernels without a tick, dispatch, draw or reset', async () => {
  const world = new World(),
    player = world.spawn().unwrap();
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: identity(),
  };
  const input = {
    id: 'prepare',
    capacity: 16,
    space: 'world',
    simulationWhenCulled: 'continue',
    bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
    schedule: { rate: 0, bursts: [{ time: 0, count: 4 }] },
    wgsl: '@compute @workgroup_size(1) fn forgeax_vfx_spawn_main() {}\n@compute @workgroup_size(1) fn forgeax_vfx_update_main() {}',
    reflection: {
      entryPoints: ['forgeax_vfx_spawn_main', 'forgeax_vfx_update_main'],
      bindings: [{ entries: [] }],
      dataInterfaces: [],
      stages: [],
    },
    renderers: [{ kind: 'billboard', material: 'material' }],
  };
  const emitter = (await cookedEffectFixture({ program: { emitters: [input] } })).program
    .emitters[0];
  if (emitter === undefined) throw new Error('missing cooked emitter');
  const reference = vfxTestEmitter(world, emitter as never, 'actual-prepare');
  const fingerprint = runtimeAssets(world.assets)
    .resolveAsset<import('@forgeax/engine-vfx').VfxGpuEffectAsset>(
      reference.effect,
      reference.revision,
    )
    .unwrap().program.fingerprint;
  const entry = {
    sourceWorldIndex: 0,
    worldId: 0,
    runtimeId: 0,
    renderGeneration: 0,
    camera,
    views: [{ identity: 'main', camera }],
    intents: [] as unknown[],
    preparationPlayers: [player],
    retained: [],
    materials: new Map(),
    meshes: new Map(),
    emitterState: new Map([
      [
        `${Number(player)}:${emitter.id}`,
        {
          player,
          emitter: reference,

          enabled: true,
          prepareOnly: true,
          preparePipelines: true,
          programFingerprint: fingerprint,
          localToWorld: identity(),
        },
      ],
    ]),
  };
  const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
  const frame = (number: number, generation = 0) =>
    feature
      .plan(
        { worlds: [entry], frameNumber: number } as never,
        {
          generation,
          caps: {},
          targets: [],
          resolveAsset: (_index: number, handle: number, revision: number) =>
            runtimeAssets(world.assets).resolveAsset(handle, revision),
        } as never,
      )
      .unwrap();
  expect(
    feature.requiresPreparation?.(structuredClone({ worlds: [entry], frameNumber: 1 }) as never),
  ).toBe(true);
  const prepared = frame(1);
  expect(entry.intents).toEqual([]);
  expect(planPasses(prepared)).toEqual([]);
  const resources = planResources(prepared),
    program = resources.find((row) => row.kind === 'compute-program');
  expect(program?.kind).toBe('compute-program');
  expect(resources.filter((row) => row.kind === 'buffer').length).toBeGreaterThan(8);
  expect(
    resources.some((row) => row.kind === 'graphics-program' && row.program.preparePipelines),
  ).toBe(true);
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const compute = vi.spyOn(device, 'createComputePipeline'),
    buffer = vi.spyOn(device, 'createBuffer');
  const owner = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({
      createShaderModule: (descriptor) => rhi.createShaderModuleImmediate(device, descriptor),
    }),
  });
  const prepare = (plan: ReturnType<typeof frame>, generation = 0) => {
    const session = owner.beginFeature(feature.identity, generation);
    for (const resource of planResources(plan)) {
      if (resource.kind === 'compute-program')
        session.prepareProgram(resource.name, resource.program).unwrap();
      if (resource.kind === 'buffer')
        session
          .prepareBuffer(resource.name, {
            size: resource.size,
            usage: resource.usage,
            ...(resource.data === undefined ? {} : { data: resource.data }),
          })
          .unwrap();
    }
    session.commitFrame();
  };
  prepare(prepared);
  expect(compute).toHaveBeenCalledTimes(
    program?.kind === 'compute-program' ? program.program.entryPoints.length : 0,
  );
  const createdBuffers = buffer.mock.calls.length;
  expect(createdBuffers).toBeGreaterThan(8);
  prepare(frame(2));
  expect(compute).toHaveBeenCalledTimes(
    program?.kind === 'compute-program' ? program.program.entryPoints.length : 0,
  );
  expect(buffer).toHaveBeenCalledTimes(createdBuffers);
  entry.intents.push({
    sequence: 1,
    player,
    emitter: reference,

    programFingerprint: fingerprint,
    reset: true,
    delta: 1 / 60,
    elapsed: 1 / 60,
    phaseTick: 0,
    tick: 0,
    seed: 1,
    playCycle: 0,
    spawnCount: 4,
    firstParticleId: 0,
    instanceGeneration: 0,
    channelInputs: [],
    eventCounters: {},
    parameterBlock: new Uint8Array(),
  });
  const source = entry.emitterState.values().next().value;
  if (source === undefined) throw new Error('missing emitter source');
  const obsoleteEmitter = { ...emitter, id: 'replaced-emitter' };
  const obsoleteReference = vfxTestEmitter(world, obsoleteEmitter as never, 'obsolete');
  entry.intents.push({
    ...(entry.intents[0] as object),
    sequence: 2,
    programFingerprint: runtimeAssets(world.assets)
      .resolveAsset<import('@forgeax/engine-vfx').VfxGpuEffectAsset>(
        obsoleteReference.effect,
        obsoleteReference.revision,
      )
      .unwrap().program.fingerprint,
    emitter: obsoleteReference,
  });
  const parked = frame(3);
  expect(planPasses(parked)).toEqual([]);
  expect(parked.sourceFeedback).toMatchObject([{ acknowledged: [1, 2], published: [] }]);
  prepare(parked);
  expect(buffer).toHaveBeenCalledTimes(createdBuffers);
  entry.intents.pop();
  source.prepareOnly = false;
  entry.preparationPlayers = [];
  const active = frame(4);
  expect(planPasses(active).some((pass) => pass.kind === 'compute')).toBe(true);
  prepare(active);
  expect(compute).toHaveBeenCalledTimes(
    program?.kind === 'compute-program' ? program.program.entryPoints.length : 0,
  );
  expect(buffer).toHaveBeenCalledTimes(createdBuffers);
  entry.intents.length = 0;
  source.prepareOnly = true;
  source.enabled = false;
  entry.preparationPlayers = [player];
  expect(planPasses(frame(5))).toEqual([]);
  prepare(frame(6, 1), 1);
  expect(compute).toHaveBeenCalledTimes(
    program?.kind === 'compute-program' ? program.program.entryPoints.length * 2 : 0,
  );
  owner.dispose().unwrap();
});
