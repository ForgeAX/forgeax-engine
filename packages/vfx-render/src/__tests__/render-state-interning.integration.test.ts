import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { MaterialAsset, ParticleEffectAsset } from '@forgeax/engine-types';
import { ParticleEffectPlayer, vfxGpuRuntimePlugin } from '@forgeax/engine-vfx';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import {
  effectFixtureReference,
  runtimeEffectFixture,
} from '../../../vfx/src/__tests__/runtime-effect-fixture';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';
import { particleRendererRenderState } from '../feature/particle-resources';

const camera = {
  position: new Float32Array([0, 0, 5]),
  right: new Float32Array([1, 0, 0]),
  up: new Float32Array([0, 1, 0]),
  viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
};
const targets = [
  { name: 'color', kind: 'color', format: 'rgba8unorm', sampleCount: 1 },
  { name: 'depth', kind: 'depth', format: 'depth32float', sampleCount: 1 },
] as const;

/** Exact canonical text: key order, undefined members, -0 and NaN all stay distinct. */
function canonical(value: unknown): string {
  if (value === undefined) return 'u';
  if (typeof value === 'number') return Object.is(value, -0) ? 'n-0' : `n${String(value)}`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const factors = ['one', 'src-alpha', 'one-minus-src-alpha', 'zero'] as const;
/** A random authored particle pass state, with shuffled keys and optional undefined members. */
function randomState(next: () => number): Record<string, unknown> {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
  const entries: [string, unknown][] = [
    ['cullMode', pick(['none', 'back', undefined])],
    ['depthCompare', pick(['always', 'less-equal'])],
    ['depthWriteEnabled', pick([false, true])],
    ['queue', pick([3000, 3001])],
  ];
  if (next() < 0.7)
    entries.push([
      'blend',
      {
        color: { srcFactor: pick(factors), dstFactor: pick(factors), operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: pick(factors), operation: 'add' },
      },
    ]);
  for (let index = entries.length - 1; index > 0; index--) {
    const swap = Math.floor(next() * (index + 1));
    [entries[index], entries[swap]] = [entries[swap] as [string, unknown], entries[index] as never];
  }
  return Object.fromEntries(entries);
}

/** Every draw's complete graphics program content, by its own instance stream. */
function drawPrograms(plan: {
  readonly work: readonly {
    readonly scope: unknown;
    readonly resources: readonly unknown[];
    readonly passes: readonly unknown[];
  }[];
}): Map<string, { readonly text: string; readonly program: object }> {
  type Row = { kind: string; name: string; program?: object };
  const programs = new Map<string, object>();
  for (const work of plan.work)
    for (const resource of work.resources as Row[])
      if (resource.kind === 'graphics-program' && resource.program !== undefined)
        programs.set(resource.name, resource.program);
  const draws = new Map<string, { readonly text: string; readonly program: object }>();
  for (const work of plan.work) {
    if (work.scope === 'frame') continue;
    for (const pass of work.passes as {
      kind: string;
      draws?: { program: string; vertexData: { resource: string }[] }[];
    }[]) {
      if (pass.kind !== 'raster') continue;
      for (const draw of pass.draws ?? []) {
        const program = programs.get(draw.program);
        if (program === undefined) throw new Error(`Missing program ${draw.program}`);
        const stream = draw.vertexData.map((row) => row.resource).join('|');
        draws.set(`${canonical(work.scope)}:${stream}`, { text: canonical(program), program });
      }
    }
  }
  return draws;
}

it.each([
  7, 19, 101,
])('plans Worker-cloned authored states exactly and keeps steady descriptors (seed %i)', async (seed) => {
  const next = random(seed);
  const materials = ['a', 'b', 'c'];
  const emitters = ['first', 'second'].map((id) => ({
    id,
    capacity: 1,
    backend: { required: 'gpu' },
    space: 'local',
    bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
    schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
    program: { module: 'particle.wgsl' },
    renderers: materials.map((material) => ({ kind: 'billboard', material })),
  }));
  const cooked = (
    await cookParticleCodeProgram(
      { schemaVersion: 3, emitters },
      {
        'particle.wgsl': {
          entry: `#import forgeax_vfx::prelude::{VfxParticle, VfxSpawnContext, VfxUpdateContext}
fn vfx_spawn(ctx: VfxSpawnContext, particle: ptr<function, VfxParticle>) { (*particle).lifetime = 10.0; }
fn vfx_update(ctx: VfxUpdateContext, particle: ptr<function, VfxParticle>) {}`,
        },
      },
    )
  ).unwrap();
  const asset: ParticleEffectAsset = {
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: cooked.fingerprint,
    emitters: emitters.map(({ id, capacity }) => ({ id, capacity })),
    program: { ...cooked.program, fingerprint: cooked.fingerprint },
  };
  const world = new World({ assets: new AssetRegistry() });
  const effect = runtimeAssetRegistry(world.assets)
    .create(runtimeEffectFixture(world, asset))
    .unwrap();
  for (let i = 0; i < 2; i++)
    world
      .spawn({
        component: ParticleEffectPlayer,
        data: { effect, playing: true, seed: i, timeScale: 0 },
      })
      .unwrap();
  const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  // Authored state per material for the current frame; each read is a new object.
  let states = new Map<string, Record<string, unknown>>();
  const material = (guid: string | number): MaterialAsset => {
    const name = materials.find((id) => guid === effectFixtureReference(world, id, 'material'));
    const state = name === undefined ? undefined : states.get(name);
    return {
      kind: 'material',
      passes: [
        {
          name: 'particle-billboard',
          program: { module: 'test::billboard' },
          ...(state === undefined ? {} : { renderState: structuredClone(state) as never }),
        },
      ],
    };
  };
  const source = gpuParticleRenderFeature({
    camera: { read: () => camera },
    material: { read: (_world, guid) => material(guid) },
  });
  const warm = gpuParticleRenderFeature({ camera: { read: () => undefined } });
  const views = ['left', 'right'].map((identity) => ({
    identity,
    render: true,
    targets,
    selectedView: camera,
    generation: 0,
    sceneData: {} as never,
  }));
  const input = (frameNumber: number) => ({
    views: views.map((view) => ({ ...view, frame: { frameNumber } })),
    resolveAsset: (_index: number, handle: number, revision: number) =>
      runtimeAssets(world.assets).resolveAsset(handle, revision),
    caps: {} as never,
    frame: { frameNumber },
    generation: 0,
  });
  let previous = new Map<string, { readonly text: string; readonly program: object }>();
  let changedFrames = 0;
  let steadyFrames = 0;
  try {
    world.update(0).unwrap();
    for (let frameNumber = 1; frameNumber <= 24; frameNumber++) {
      // Mostly content-identical new objects, sometimes a new state or none.
      const nextStates = new Map<string, Record<string, unknown>>();
      for (const id of materials) {
        const prior = states.get(id);
        const roll = next();
        if (prior !== undefined && roll < 0.6) nextStates.set(id, structuredClone(prior));
        else if (roll < 0.9) nextStates.set(id, randomState(next));
      }
      states = nextStates;
      const extracted = source
        .extract({
          worlds: [world],
          owner: 0,
          frameNumber,
          views: views.map(({ identity, render, selectedView }) => ({
            identity,
            render,
            selectedView,
          })),
        })
        .unwrap();
      const plan = warm.plan(structuredClone(extracted), input(frameNumber)).unwrap();
      const warmDraws = drawPrograms(plan);
      expect(warmDraws.size).toBe(2 * 2 * 2 * materials.length);
      // Cold-path oracle: each draw carries exactly this frame's authored state.
      for (const [key, row] of warmDraws) {
        const renderer = Number(key.match(/renderer-(\d+)\.vertex-data$/)?.[1]);
        const authored = states.get(materials[renderer] as string);
        const expected = particleRendererRenderState('billboard', undefined, authored as never);
        expect(canonical((row.program as { renderState?: unknown }).renderState)).toBe(
          canonical(expected),
        );
        expect(Object.isFrozen(row.program)).toBe(true);
      }
      for (const [key, row] of warmDraws) {
        const prior = previous.get(key);
        if (prior === undefined) continue;
        if (prior.text === row.text) {
          // A steady view keeps its descriptor across content-identical clones.
          expect(row.program).toBe(prior.program);
          steadyFrames += 1;
        } else {
          expect(row.program).not.toBe(prior.program);
          changedFrames += 1;
        }
      }
      previous = warmDraws;
      warm.onFrameSubmitted?.(extracted);
      source.onSourceFrameSubmitted?.(extracted, structuredClone(plan.sourceFeedback));
    }
  } finally {
    await context.fiber.dispose();
  }
  expect(steadyFrames).toBeGreaterThan(0);
  expect(changedFrames).toBeGreaterThan(0);
});
