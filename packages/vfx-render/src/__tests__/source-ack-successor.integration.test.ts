import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { ParticleEffectAsset } from '@forgeax/engine-types';
import {
  ParticleEffectPlayer,
  VFX_GPU_RUNTIME_RESOURCE_KEY,
  type VfxGpuRuntime,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { runtimeEffectFixture } from '../../../vfx/src/__tests__/runtime-effect-fixture';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';

it.each(
  [1, 2].flatMap((steps) => [false, true].map((events) => ({ steps, events }))),
)('holds actual VFX source ACK across $steps unpublished updates (events=$events)', async ({
  steps,
  events,
}) => {
  const result = await cookParticleCodeProgram(
    {
      schemaVersion: 3,
      emitters: [
        {
          id: 'persistent',
          capacity: 4,
          backend: { required: 'gpu' },
          space: 'world',
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
          schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
          program: { module: 'persistent.wgsl' },
          renderers: [{ kind: 'billboard', material: 'material' }],
          ...(events
            ? {
                channels: [{ id: 'hit', capacity: 2, overflow: 'drop-newest' }],
                events: [
                  {
                    id: 'hit',
                    channel: 'hit',
                    subEmitter: 'persistent',
                    fanOut: 2,
                    recursionDepth: 1,
                  },
                ],
              }
            : {}),
        },
      ],
    },
    {
      'persistent.wgsl': {
        entry: `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) { (*particle).lifetime = 86400.0; }
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) { (*particle).position.x += ctx.delta; }`,
      },
    },
  );
  if (!result.ok) throw result.error;
  const asset: ParticleEffectAsset = {
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: result.value.fingerprint,
    emitters: [{ id: 'persistent', capacity: 4 }],
    program: { ...result.value.program, fingerprint: result.value.fingerprint },
  };
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const handle = assets.create(runtimeEffectFixture(world, { ...asset, guid: 'effect' })).unwrap();
  const player = world
    .spawn({
      component: ParticleEffectPlayer,
      data: { effect: handle, playing: true, seed: 1, timeScale: 1 },
    })
    .unwrap();
  const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const runtime = world.getResource<VfxGpuRuntime>(VFX_GPU_RUNTIME_RESOURCE_KEY);
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  };
  const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
  try {
    const frames = [];
    for (let frameNumber = 1; frameNumber <= 3; frameNumber++) {
      world.update(1 / 60).unwrap();
      frames.push(
        feature
          .extract({
            worlds: [world],
            owner: 0,
            views: [{ identity: 'main', render: true }],
            frameNumber,
          })
          .unwrap(),
      );
    }
    const held = frames[2];
    if (held === undefined) throw new Error('Missing held source frame');
    const source = held.worlds[0];
    if (source === undefined) throw new Error('Missing held source World');
    const before = structuredClone(held);
    const exactCounters = source.intents.map((intent) => intent.eventCounters);
    const published = source.intents.map((intent) => intent.sequence);
    expect(published).toHaveLength(3);
    for (const intent of runtime.snapshot()) {
      expect(Object.isFrozen(intent)).toBe(true);
      expect(Object.isFrozen(intent.eventCounters)).toBe(true);
    }
    for (let tick = 0; tick < steps; tick++) world.update(1 / 60).unwrap();
    expect(runtime.snapshot()).toHaveLength(3 + steps);
    expect(held).toEqual(before);
    expect(source.intents.map((intent) => intent.eventCounters)).toEqual(exactCounters);
    feature.onSourceFrameSubmitted?.(held, [
      {
        runtimeId: source.runtimeId,
        renderGeneration: source.renderGeneration,
        acknowledged: published,
        published,
        visibility: [],
      },
    ]);
    expect(held).toEqual(before);
    expect(runtime.snapshot()).toHaveLength(steps);
    expect(runtime.snapshot().every((intent) => !published.includes(intent.sequence))).toBe(true);
    expect(runtime.lastCommittedEmitter(player, 'persistent')?.sequence).toBe(published.at(-1));
  } finally {
    await context.fiber.dispose();
    assets.dispose();
  }
});
