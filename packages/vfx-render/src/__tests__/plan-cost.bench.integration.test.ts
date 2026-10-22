import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { constants, setPriority } from 'node:os';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import {
  ParticleEffectPlayer,
  particleEffectContribution,
  prepareVfxGpuEffect,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../../../render/src/features/host';
import { createRenderFeatureGpuWorkOwner } from '../../../render/src/features/prepared-gpu-work';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';

// Opt-in micro-benchmark (skipped by default):
//   VFX_PLAN_BENCH=1 pnpm vitest run plan-cost.bench --silent=false
// Measures the stock production feature configuration (instance arenas, native
// planning, retained resources) with N live players across fixed/render frames.
// VFX_PLAN_BENCH_PLAYERS / _FRAMES size the run; VFX_PLAN_BENCH_PROFILE=<file>
// writes a .cpuprofile of the measured window.
const enabled = process.env.VFX_PLAN_BENCH === '1';
const players = Number(process.env.VFX_PLAN_BENCH_PLAYERS ?? 50);
const frames = Number(process.env.VFX_PLAN_BENCH_FRAMES ?? 300);

const camera = {
  position: new Float32Array(3),
  right: new Float32Array([1, 0, 0]),
  up: new Float32Array([0, 1, 0]),
  viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
};

it.skipIf(!enabled)(
  `plans ${players} live players across ${frames} frames`,
  async () => {
    try {
      setPriority(constants.priority.PRIORITY_HIGH);
    } catch {
      // Priority is a measurement aid only.
    }
    // Two effects: custom per-particle state admits the batched job-table
    // program; the other keeps the ordinary per-tick compute chain.
    const prepare = async (guid: string, custom: boolean) => {
      const emitter = (id: string, capacity: number, blend?: 'additive') => ({
        id,
        capacity,
        backend: { required: 'gpu' as const },
        space: 'world' as const,
        schedule: { rate: 60 },
        bounds: {
          kind: 'sphere' as const,
          center: [0, 0, 0] as [number, number, number],
          radius: 1,
        },
        program: { module: 'body' },
        renderers: [
          {
            kind: 'billboard' as const,
            material: 'material',
            ...(blend === undefined ? {} : { blend }),
          },
        ],
      });
      const cooked = (
        await cookParticleCodeEffect(
          { schemaVersion: 3, emitters: [emitter('spark', 64), emitter('glow', 32, 'additive')] },
          {
            body: {
              entry: custom
                ? `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
struct VfxCustom { heat:f32, }
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>,c:ptr<function,VfxCustom>){(*c).heat=1.0;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>,c:ptr<function,VfxCustom>){(*c).heat+=ctx.delta;}`
                : `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext}
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>){(*p).lifetime=1.0;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>){(*p).age+=ctx.delta;}`,
            },
          },
        )
      ).unwrap();
      return (
        await prepareVfxGpuEffect({
          guid,
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
    };
    const effects = [
      await prepare('019e2cc6-0c86-79da-aa76-b0984c86d45d', true),
      await prepare('019e2cc6-0c86-79da-aa76-b0984c86d45e', false),
    ];
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
    const handles = effects.map((effect) =>
      assets
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
        .unwrap(),
    );
    for (let seed = 0; seed < players; seed++)
      world
        .spawn({
          component: ParticleEffectPlayer,
          data: { effect: handles[seed % handles.length] as (typeof handles)[number], seed },
        })
        .unwrap();
    const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'structural' })).unwrap();
    const gpu = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const raw = gpuParticleRenderFeature({
      camera: { read: () => camera },
      instanceArenas: true,
      nativePlanning: true,
      retainedResources: true,
      isolateViewGraph: true,
    });
    const samples: number[] = [];
    const feature = {
      ...raw,
      plan(source: Parameters<typeof raw.plan>[0], input: Parameters<typeof raw.plan>[1]) {
        const start = performance.now();
        // Match WebGPU devices: eight storage buffers admit the batched job-table path.
        const result = raw.plan(source, {
          ...input,
          limits: { ...input.limits, maxStorageBuffersPerShaderStage: 8 },
        });
        samples.push(performance.now() - start);
        return result;
      },
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const profile = process.env.VFX_PLAN_BENCH_PROFILE;
    const session = profile === undefined ? undefined : new Session();
    try {
      for (let frameNumber = 1; frameNumber <= frames; frameNumber++) {
        if (session !== undefined && frameNumber === Math.floor(frames / 3)) {
          session.connect();
          await session.post('Profiler.enable');
          await session.post('Profiler.setSamplingInterval', { interval: 100 });
          await session.post('Profiler.start');
        }
        world.update(1 / 60).unwrap();
        // Render cadence above the fixed tick keeps a mix of queued and retained frames.
        for (const _repeat of [0, 1]) {
          const batch = runRenderFeatureFrame(host, [
            {
              identity: 'main',
              render: true,
              worlds: [world],
              owner: 0,
              frameNumber: frameNumber * 2 + _repeat,
              generation: 0,
              caps: device.caps,
              gpuWork: gpu,
              selectedView: camera,
            },
          ]);
          expect(batch.frame.errors).toEqual([]);
          batch.frame.onSubmitted();
          for (const view of batch.views.values()) view.onSubmitted();
          batch.onSubmitted();
          for (const lease of batch.preparedResourceBatches) lease.release().unwrap();
        }
      }
      if (session !== undefined && profile !== undefined) {
        const { profile: data } = await session.post('Profiler.stop');
        writeFileSync(profile, JSON.stringify(data));
        session.disconnect();
      }
      const measured = samples.slice(Math.floor(samples.length / 3)).sort((a, b) => a - b);
      const mean = measured.reduce((sum, value) => sum + value, 0) / measured.length;
      const at = (q: number) =>
        measured[Math.min(measured.length - 1, Math.floor(measured.length * q))];
      process.stdout.write(
        `[vfx-plan-bench] players=${players} plans=${measured.length} mean=${mean.toFixed(3)}ms p50=${at(0.5)?.toFixed(3)}ms p95=${at(0.95)?.toFixed(3)}ms
`,
      );
    } finally {
      gpu.dispose().unwrap();
      host.dispose().unwrap();
      await context.fiber.dispose();
      assets.dispose();
    }
  },
  600_000,
);
