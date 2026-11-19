import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { RenderFeaturePlan } from '@forgeax/engine-render';
import type { ParticleEffectAsset } from '@forgeax/engine-types';
import { ParticleEffectPlayer, vfxGpuRuntimePlugin } from '@forgeax/engine-vfx';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { runtimeEffectFixture } from '../../../vfx/src/__tests__/runtime-effect-fixture';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature.js';
import { TICK_CAPACITY_RETENTION_PLANS } from '../feature/tick-capacity.js';
import { singleViewContext } from './vfx-frame-fixture.js';

interface SlotPass {
  readonly kind: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly bindings?: string;
  readonly dispatches?: readonly {
    readonly bindings?: string;
    readonly workgroups?: readonly number[];
  }[];
}

/** Declared and dispatched simulation tick slots, read through coalesced batches. */
function tickSlots(plan: RenderFeaturePlan) {
  const declared = new Set<number>();
  const dispatched = new Set<number>();
  let resets = 0;
  let draws = 0;
  for (const pass of plan.work.flatMap((work) => work.passes) as readonly SlotPass[]) {
    if (pass.kind === 'copy' && pass.enabled !== false && pass.name.endsWith('.reset')) resets++;
    if (pass.kind === 'raster' && pass.enabled !== false) draws++;
    if (pass.kind !== 'compute') continue;
    for (const dispatch of pass.dispatches ?? []) {
      const tick = /\.tick-(\d+)\.simulation-bindings$/.exec(
        dispatch.bindings ?? pass.bindings ?? '',
      );
      if (tick === null) continue;
      declared.add(Number(tick[1]));
      if (pass.enabled !== false && dispatch.workgroups?.[0] !== 0) dispatched.add(Number(tick[1]));
    }
  }
  return { declared: declared.size, dispatched: dispatched.size, resets, draws };
}

async function tickCapacityFixture() {
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const cooked = (
    await cookParticleCodeProgram(
      {
        schemaVersion: 3,
        emitters: [
          {
            id: 'stream',
            capacity: 512,
            backend: { required: 'gpu' },
            space: 'world',
            bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
            schedule: { rate: 30 },
            program: { module: 'stream.wgsl' },
            renderers: [{ kind: 'billboard', material: 'material' }],
          },
        ],
      },
      {
        'stream.wgsl': {
          entry: `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext,vfx_integrate}
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>){(*p).lifetime=0.5;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>){vfx_integrate(ctx,p);}`,
        },
      },
    )
  ).unwrap();
  const asset: ParticleEffectAsset = {
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: cooked.fingerprint,
    emitters: [{ id: 'stream', capacity: 512 }],
    program: { ...cooked.program, fingerprint: cooked.fingerprint },
  };
  const world = new World({ assets: new AssetRegistry() });
  world
    .spawn({
      component: ParticleEffectPlayer,
      data: {
        effect: runtimeAssetRegistry(world.assets)
          .create(runtimeEffectFixture(world, { ...asset, guid: 'stream-effect' }))
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
  const consumer = gpuParticleRenderFeature({ camera: { read: () => undefined } });
  const targets = [
    {
      name: 'color',
      kind: 'color' as const,
      format: 'rgba8unorm' as const,
      sampleCount: 1 as const,
    },
  ];
  let frameNumber = 0;
  /** Advance the world `ticks` times, then extract, plan and acknowledge one frame. */
  const frame = (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) world.update(1 / 60).unwrap();
    const data = structuredClone(
      source
        .extract({
          world,
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
          resolveAsset: (handle, revision) =>
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
    return tickSlots(plan);
  };
  return { frame, dispose: () => context.fiber.dispose() };
}

it('releases catch-up tick slots after a full window of single-tick frames', async () => {
  const { frame, dispose } = await tickCapacityFixture();
  try {
    const first = frame(1);
    expect(first).toEqual({ declared: 1, dispatched: 1, resets: 1, draws: first.draws });
    expect(first.draws).toBeGreaterThan(0);
    const draws = first.draws;
    const steady = { declared: 1, dispatched: 1, resets: 0, draws };
    for (let i = 0; i < 4; i++) expect(frame(1)).toEqual(steady);
    // One hitch: three simulation ticks reach the receiver in one frame.
    expect(frame(3)).toEqual({ declared: 3, dispatched: 3, resets: 0, draws });
    // The slots stay declared after the hitch, so a second one costs no graph change.
    // Releasing them later never resets the stream and it keeps drawing.
    const retained = { declared: 3, dispatched: 1, resets: 0, draws };
    let released = 0;
    for (let i = 0; i <= TICK_CAPACITY_RETENTION_PLANS; i++) {
      const slots = frame(1);
      if (slots.declared === 1) released++;
      else expect(slots).toEqual(retained);
      if (released > 0) expect(slots).toEqual(steady);
    }
    // A full window without catch-up work returns the stream to one slot, not sooner.
    expect(released).toBeGreaterThan(0);
    expect(released).toBeLessThanOrEqual(2);
    // Capacity grows again in the frame that needs it.
    expect(frame(2)).toEqual({ declared: 2, dispatched: 2, resets: 0, draws });
  } finally {
    await dispose();
  }
});

it('keeps the slots of a steady multi-tick stream', async () => {
  const { frame, dispose } = await tickCapacityFixture();
  try {
    const { draws } = frame(1);
    for (let i = 0; i < TICK_CAPACITY_RETENTION_PLANS * 2 + 8; i++)
      expect(frame(2)).toEqual({ declared: 2, dispatched: 2, resets: 0, draws });
    // Alternating demand never spends a whole window below the retained capacity.
    for (let i = 0; i < TICK_CAPACITY_RETENTION_PLANS * 2 + 8; i++)
      expect(frame(1 + (i % 2)).declared).toBe(2);
  } finally {
    await dispose();
  }
});
