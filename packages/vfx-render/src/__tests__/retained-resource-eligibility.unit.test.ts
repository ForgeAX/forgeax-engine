import { ownRenderFeatureProgramData } from '@forgeax/engine-render/internal';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';

function plan(kind: 'owned' | 'mutable' | 'camera' | 'force-fields' | 'events' | 'parameters') {
  const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: matrix,
  };
  const emitter = {
    id: 'stock',
    capacity: 4,
    space: 'world',
    simulationWhenCulled: 'continue',
    bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
    wgsl: 'synthetic',
    schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
    renderers: [],
    ...(kind === 'force-fields' ? { forceFields: {} } : {}),
    reflection: {
      entryPoints: [
        'forgeax_vfx_spawn_main',
        'forgeax_vfx_update_compact_main',
        ...(kind === 'events' ? ['forgeax_vfx_event_main'] : []),
      ],
      resources: kind === 'events' ? ['eventBuffer'] : [],
      layout: { parameters: { size: kind === 'parameters' ? 16 : 0 }, customLayout: { stride: 0 } },
      bindings: [
        {
          entries: [0, 2, 3, 4, 5, 6]
            .map((binding) => ({ binding, buffer: { type: 'storage' }, visibility: 4 }))
            .concat(
              [{ binding: 1, buffer: { type: 'uniform' }, visibility: 4 }],
              kind === 'camera'
                ? [{ binding: 12, buffer: { type: 'uniform' }, visibility: 4 }]
                : [],
              kind === 'events' ? [{ binding: 8, buffer: { type: 'storage' }, visibility: 4 }] : [],
              kind === 'parameters'
                ? [{ binding: 10, buffer: { type: 'uniform' }, visibility: 4 }]
                : [],
            ),
        },
      ],
      dataInterfaces: kind === 'camera' ? [{ kind: 'camera', token: 'camera', binding: 12 }] : [],
      stages: [],
    },
  };
  const effect = {
    kind: 'particle-effect',
    schemaVersion: 3,
    guid: 'fixture',
    program: { fingerprint: 'fixture', emitters: [emitter] },
  };
  const owned = kind === 'mutable' ? effect : ownRenderFeatureProgramData(effect);
  const reference = { effect: {} as never, id: 'stock' };
  const intent = {
    sequence: 1,
    player: 1,
    emitter: reference,
    programFingerprint: 'fixture',
    reset: true,
    fixedDelta: 1 / 60,
    phaseTick: 0,
    tick: 0,
    seed: 1,
    playCycle: 0,
    spawnCount: 1,
    firstParticleId: 0,
    instanceGeneration: 0,
    channelInputs: [],
    eventCounters: {},
    parameterBlock: new Uint8Array(kind === 'parameters' ? 16 : 0),
  };
  const api = {
    program: vi.fn((..._arguments: readonly unknown[]) => {}),
    retain: vi.fn(() => false),
    admit: vi.fn(() => ({})),
    upload: vi.fn(),
  };
  const scope = () => ({ scope: 'frame', resources: [], passes: [] });
  const createNativePlan = vi.fn(() => ({
    scope,
    resourceAdmission: api,
    finish: (work: unknown, sourceFeedback: unknown) => ({ work, sourceFeedback }),
  }));
  const feature = gpuParticleRenderFeature({
    camera: { read: () => camera },
    instanceArenas: true,
    nativePlanning: true,
    retainedResources: true,
  });
  const execute = () =>
    feature.plan(
      {
        frameNumber: 1,
        worlds: [
          {
            sourceWorldIndex: 0,
            worldId: 0,
            runtimeId: 0,
            renderGeneration: 0,
            camera,
            views: [{ identity: 'main', camera }],
            intents: [intent],
            retained: [],
            materials: new Map(),
            meshes: new Map(),
            emitterState: new Map([
              ['1:stock', { enabled: true, localToWorld: matrix, player: 1, emitter: reference }],
            ]),
          },
        ],
      } as never,
      {
        views: [{ identity: 'main', render: true, targets: [], frame: { frameNumber: 1 } }],
        generation: 0,
        frame: { frameNumber: 1 },
        caps: {},
        resolveAsset: () => ok(owned),
        createNativePlan,
      } as never,
    );
  return { result: execute(), api, createNativePlan, emitter, execute };
}

it('admits the owned stock resource domain before declarations', () => {
  const f = plan('owned');
  expect(f.result.ok).toBe(true);
  expect(f.createNativePlan).toHaveBeenCalledOnce();
  expect(f.api.admit).toHaveBeenCalledOnce();
  expect(f.api.upload).toHaveBeenCalledTimes(2);
});

it('owns a mutable emitter once before native admission and ignores later external mutation', () => {
  const f = plan('mutable');
  expect(f.result.ok).toBe(true);
  expect(f.createNativePlan).toHaveBeenCalledOnce();
  expect(f.api.admit).toHaveBeenCalledOnce();
  const program = f.api.program.mock.calls[0]?.[2];
  expect(program).toMatchObject({
    wgsl: 'synthetic',
    entryPoints: ['forgeax_vfx_spawn_main', 'forgeax_vfx_update_compact_main'],
  });
  expect(Object.isFrozen(f.emitter)).toBe(false);
  f.emitter.wgsl = 'externally changed';
  f.emitter.reflection.entryPoints.push('externally_added_entry');
  expect(f.execute().ok).toBe(true);
  expect(f.api.program.mock.calls.at(-1)?.[2]).toBe(program);
  expect(program).toMatchObject({
    wgsl: 'synthetic',
    entryPoints: ['forgeax_vfx_spawn_main', 'forgeax_vfx_update_compact_main'],
  });
});

it.each([
  'camera',
  'force-fields',
] as const)('keeps %s effects on the original declaration owner', (kind) => {
  const f = plan(kind);
  expect(f.result.ok).toBe(true);
  expect(f.createNativePlan).not.toHaveBeenCalled();
  expect(f.api.admit).not.toHaveBeenCalled();
  if (kind === 'camera' && f.result.ok)
    expect(
      f.result.value.work
        .flatMap((work) => work.resources)
        .some((resource) => resource.name === 'vfx.a-0.di-camera'),
    ).toBe(true);
});

it.each([
  'events',
  'parameters',
] as const)('keeps %s uploads and bindings in the ordinary preparation path', (kind) => {
  const f = plan(kind);
  expect(f.result.ok).toBe(true);
  expect(f.createNativePlan).toHaveBeenCalledOnce();
  expect(f.api.admit).not.toHaveBeenCalled();
  if (f.result.ok)
    expect(
      f.result.value.work
        .flatMap((work) => work.resources)
        .some((resource) => resource.kind === 'buffer'),
    ).toBe(true);
});
