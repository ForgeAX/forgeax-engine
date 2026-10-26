import { writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { constants, setPriority } from 'node:os';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { type MeshAsset, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import {
  ParticleEffectPlayer,
  particleEffectContribution,
  prepareVfxGpuEffect,
  vfxGpuRuntimePlugin,
} from '@forgeax/engine-vfx';
import { cookParticleCodeEffect } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { createRenderFeatureHost } from '../../../render/src/features/host';
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
// VFX_PLAN_BENCH_SHAPE=collapse mirrors a game debris effect: three local-space
// burst emitters (two sorted alpha billboards and one mesh renderer).
const shape = process.env.VFX_PLAN_BENCH_SHAPE ?? 'mixed';
// VFX_PLAN_BENCH_LIFE=<ticks> retires and respawns each player on a
// staggered cycle (remove, then add the component one tick later).
const life = Number(process.env.VFX_PLAN_BENCH_LIFE ?? 0);
const geometry: MeshAsset = Object.freeze({
  kind: 'mesh',
  vertices: new Float32Array(48),
  attributes: {
    position: new Float32Array(18),
    normal: new Float32Array(18),
    uv: new Float32Array(12),
  },
  indices: new Uint16Array([0, 1, 2, 3, 4, 5]),
  submeshes: [
    { indexOffset: 0, indexCount: 6, vertexCount: 6, topology: 'triangle-list', materialSlot: 0 },
  ],
  materialSlots: [{ slotName: 'Default' }],
});

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
      const collapse = shape === 'collapse';
      const emitter = (
        id: string,
        capacity: number,
        blend?: 'additive',
        renderer?: Record<string, unknown>,
      ) => ({
        id,
        capacity,
        backend: { required: 'gpu' as const },
        space: collapse ? ('local' as const) : ('world' as const),
        ...(collapse ? { simulationWhenCulled: 'continue' as const } : {}),
        schedule: collapse ? { rate: 0, bursts: [{ time: 0, count: capacity }] } : { rate: 60 },
        bounds: {
          kind: 'sphere' as const,
          center: [0, 0, 0] as [number, number, number],
          radius: 1,
        },
        program: { module: 'body' },
        renderers: [
          renderer ?? {
            kind: 'billboard' as const,
            material: 'material',
            ...(blend === undefined ? {} : { blend }),
            ...(collapse ? { blend: 'alpha' as const, sorting: 'view-depth' as const } : {}),
          },
        ],
      });
      const emitters = collapse
        ? [
            emitter('dust', 24),
            emitter('chips', 8, undefined, {
              kind: 'mesh',
              mesh: 'mesh',
              material: 'material',
              lighting: 'standard',
              castShadows: false,
            }),
            emitter('settle', 12),
          ]
        : [emitter('spark', 64), emitter('glow', 32, 'additive')];
      const cooked = (
        await cookParticleCodeEffect(
          { schemaVersion: 3, emitters: emitters as never },
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
      // Game collapse programs all carry custom per-particle state.
      await prepare('019e2cc6-0c86-79da-aa76-b0984c86d45e', shape === 'collapse'),
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
    const meshHandle = assets.create(geometry).unwrap();
    const world = new World({ assets });
    const handles = effects.map((effect) =>
      assets
        .create({
          ...effect,
          program: {
            ...effect.program,
            emitters: effect.program.emitters.map((emitter) => ({
              ...emitter,
              renderers: emitter.renderers.map((renderer) => ({
                ...renderer,
                material,
                ...(renderer.kind === 'mesh' ? { mesh: meshHandle } : {}),
              })),
            })),
          },
        })
        .unwrap(),
    );
    const playerData = (seed: number) => ({
      effect: handles[seed % handles.length] as (typeof handles)[number],
      seed,
    });
    const entities = Array.from({ length: players }, (_, seed) =>
      shape === 'collapse'
        ? // Local-space game players carry a Scene transform.
          world
            .spawn(
              { component: Transform, data: {} },
              { component: ParticleEffectPlayer, data: playerData(seed) },
            )
            .unwrap()
        : world.spawn({ component: ParticleEffectPlayer, data: playerData(seed) }).unwrap(),
    );
    let nextSeed = players;
    const live = entities.map(() => true);
    const churn = (frameNumber: number) => {
      if (life <= 0) return;
      for (let index = 0; index < entities.length; index++) {
        const phase = (frameNumber + Math.floor((index * life) / entities.length)) % life;
        const entity = entities[index] as (typeof entities)[number];
        if (phase === 0 && live[index]) {
          world.removeComponent(entity, ParticleEffectPlayer).unwrap();
          live[index] = false;
        } else if (phase === 1 && !live[index]) {
          live[index] = true;
          world
            .addComponent(entity, {
              component: ParticleEffectPlayer,
              data: playerData(nextSeed++),
            })
            .unwrap();
        }
      }
    };
    const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
    const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
    const shader = (await rhi.createShaderModule(device, { code: 'structural' })).unwrap();
    const gpu = createRenderFeatureGpuWorkOwner({
      getDevice: () => device,
      getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
    });
    const raw = gpuParticleRenderFeature({
      camera: { read: () => camera },
      // Runtime asset publications are frozen snapshots.
      ...(shape === 'collapse' ? { mesh: { read: () => geometry } } : {}),
      instanceArenas: true,
      nativePlanning: true,
      retainedResources: true,
      isolateViewGraph: true,
    });
    const samples: number[] = [];
    const frameSamples: number[] = [];
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
    // VFX_PLAN_BENCH_HEAP=1 samples allocations (including collected objects)
    // over the same measured window and prints bytes per Renderer frame.
    const heap = process.env.VFX_PLAN_BENCH_HEAP === '1';
    const session = profile === undefined && !heap ? undefined : new Session();
    let heapFrames = 0;
    try {
      for (let frameNumber = 1; frameNumber <= frames; frameNumber++) {
        if (session !== undefined && frameNumber === Math.floor(frames / 3)) {
          session.connect();
          if (profile !== undefined) {
            await session.post('Profiler.enable');
            await session.post('Profiler.setSamplingInterval', { interval: 100 });
            await session.post('Profiler.start');
          }
          if (heap) {
            await session.post('HeapProfiler.enable');
            await session.post('HeapProfiler.startSampling', {
              samplingInterval: 1024,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
        }
        if (session !== undefined && frameNumber >= Math.floor(frames / 3)) heapFrames += 2;
        churn(frameNumber);
        world.update(1 / 60).unwrap();
        // Render-only frames between ticks keep a mix of queued and retained frames.
        for (const _repeat of [0, 1]) {
          const frameStart = performance.now();
          const batch = host.runFrame([
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
          frameSamples.push(performance.now() - frameStart);
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
      }
      if (session !== undefined && heap) {
        const { profile: data } = await session.post('HeapProfiler.stopSampling');
        const self = new Map<string, number>();
        let total = 0;
        const walk = (node: typeof data.head, parent: string) => {
          const frame = node.callFrame;
          const own = frame.url
            ? `${frame.url.replace(/^.*packages\//, '')}:${frame.lineNumber + 1} ${frame.functionName}`
            : `${parent} <${frame.functionName || '(native)'}>`;
          total += node.selfSize;
          if (node.selfSize > 0) self.set(own, (self.get(own) ?? 0) + node.selfSize);
          for (const child of node.children) walk(child, frame.url ? own : parent);
        };
        walk(data.head, '');
        const rows = [...self]
          .sort((a, b) => b[1] - a[1])
          .slice(0, Number(process.env.VFX_PLAN_BENCH_HEAP_TOP ?? 30));
        process.stdout.write(
          `[vfx-plan-bench] heap ${(total / heapFrames / 1024).toFixed(1)} KB/frame over ${heapFrames} frames\n${rows
            .map(
              ([key, bytes]) =>
                `  ${(bytes / heapFrames / 1024).toFixed(2).padStart(8)} KB  ${key}`,
            )
            .join('\n')}\n`,
        );
      }
      session?.disconnect();
      const measured = samples.slice(Math.floor(samples.length / 3)).sort((a, b) => a - b);
      const mean = measured.reduce((sum, value) => sum + value, 0) / measured.length;
      const at = (q: number) =>
        measured[Math.min(measured.length - 1, Math.floor(measured.length * q))];
      const frameMeasured = frameSamples
        .slice(Math.floor(frameSamples.length / 3))
        .sort((a, b) => a - b);
      const frameMean = frameMeasured.reduce((sum, value) => sum + value, 0) / frameMeasured.length;
      process.stdout.write(
        `[vfx-plan-bench] frame mean=${frameMean.toFixed(3)}ms p50=${frameMeasured[Math.floor(frameMeasured.length / 2)]?.toFixed(3)}ms\n`,
      );
      process.stdout.write(
        `[vfx-plan-bench] shape=${shape} life=${life} players=${players} plans=${measured.length} mean=${mean.toFixed(3)}ms p50=${at(0.5)?.toFixed(3)}ms p95=${at(0.95)?.toFixed(3)}ms
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
