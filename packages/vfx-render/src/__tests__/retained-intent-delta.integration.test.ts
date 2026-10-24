import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { ParticleEffectAsset } from '@forgeax/engine-types';
import { ParticleEffectPlayer, vfxGpuRuntimePlugin } from '@forgeax/engine-vfx';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { runtimeEffectFixture } from '../../../vfx/src/__tests__/runtime-effect-fixture';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature.js';
import { planPasses, planResources, singleViewContext } from './vfx-frame-fixture.js';

type Retained = { intentSequence: number; intent?: { sequence: number } };
const retainedRows = (data: unknown): Retained[] =>
  (data as { worlds: { retained: Retained[] }[] }).worlds.flatMap((world) => world.retained);

it('sends a retained intent until the receiver adopted it, then only its sequence', async () => {
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const cooked = (
    await cookParticleCodeProgram(
      {
        schemaVersion: 3,
        emitters: [
          {
            id: 'burst',
            capacity: 4,
            backend: { required: 'gpu' },
            space: 'world',
            bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
            schedule: { rate: 0, bursts: [{ time: 0, count: 4 }] },
            program: { module: 'burst.wgsl' },
            renderers: [{ kind: 'billboard', material: 'material' }],
          },
        ],
      },
      {
        'burst.wgsl': {
          entry: `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext,vfx_integrate}
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>){(*p).lifetime=100.0;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>){vfx_integrate(ctx,p);}`,
        },
      },
    )
  ).unwrap();
  const asset: ParticleEffectAsset = {
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: cooked.fingerprint,
    emitters: [{ id: 'burst', capacity: 4 }],
    program: { ...cooked.program, fingerprint: cooked.fingerprint },
  };
  const world = new World({ assets: new AssetRegistry() });
  world
    .spawn({
      component: ParticleEffectPlayer,
      data: {
        effect: runtimeAssetRegistry(world.assets)
          .create(runtimeEffectFixture(world, { ...asset, guid: 'burst-effect' }))
          .unwrap(),
        playing: true,
        seed: 3,
        timeScale: 1,
      },
    })
    .unwrap();
  const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array(matrix),
  };
  const source = gpuParticleRenderFeature({ camera: { read: () => camera } });
  let consumer = gpuParticleRenderFeature({ camera: { read: () => undefined } });
  const targets = [
    {
      name: 'color',
      kind: 'color' as const,
      format: 'rgba8unorm' as const,
      sampleCount: 1 as const,
    },
  ];
  let frameNumber = 0;
  const frame = () => {
    const data = structuredClone(
      source
        .extract({
          worlds: [world],
          owner: 0,
          views: [{ identity: 'main', render: true }],
          frameNumber: ++frameNumber,
        })
        .unwrap(),
    );
    const plan = consumer
      .plan(
        data,
        singleViewContext({
          targets,
          resolveAsset: (_index, handle, revision) =>
            runtimeAssets(world.assets).resolveAsset(handle, revision),
          caps: {} as never,
          frame: { frameNumber },
          generation: 0,
          sceneData: {} as never,
        }),
      )
      .unwrap();
    consumer.onFrameSubmitted?.(data);
    source.onSourceFrameSubmitted?.(data, structuredClone(plan.sourceFeedback));
    return { data, plan, draws: planPasses(plan).filter((pass) => pass.kind === 'raster').length };
  };
  try {
    // Simulate, commit, and retain the emitter before the delta can apply.
    for (let i = 0; i < 3; i++) {
      world.update(1 / 60).unwrap();
      frame();
    }
    // The last acknowledged tick becomes the retained intent. The receiver already
    // dispatched it as queued work, so it is adopted without carrying it again.
    world.update(0).unwrap();
    const carried = frame();
    expect(retainedRows(carried.data).every((row) => row.intent === undefined)).toBe(true);
    expect(carried.draws).toBeGreaterThan(0);
    world.update(0).unwrap();
    const adopted = frame();
    const rows = retainedRows(adopted.data);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.intent === undefined)).toBe(true);
    expect(adopted.draws).toBeGreaterThan(0);
    expect(planResources(adopted.plan).length).toBeGreaterThan(0);

    // A receiver that lost its cache reports the stream; the source resends it.
    consumer = gpuParticleRenderFeature({ camera: { read: () => undefined } });
    world.update(0).unwrap();
    const missing = frame();
    expect(
      (missing.plan.sourceFeedback as { missingRetained: string[] }[]).flatMap(
        (row) => row.missingRetained,
      ).length,
    ).toBeGreaterThan(0);
    world.update(0).unwrap();
    const resent = frame();
    expect(
      retainedRows(resent.data).every((row) => row.intent?.sequence === row.intentSequence),
    ).toBe(true);
    expect(resent.draws).toBe(adopted.draws);
    // The skipped frame never rebuilt the fresh receiver's device state, so the
    // resent intent replays recovery instead of projecting empty storage.
    const replayed = planPasses(resent.plan).map((pass) => pass.name);
    expect(replayed.some((name) => name.endsWith('.reset'))).toBe(true);
    expect(replayed.some((name) => name.includes('.simulate'))).toBe(true);
  } finally {
    await context.fiber.dispose();
  }
});
