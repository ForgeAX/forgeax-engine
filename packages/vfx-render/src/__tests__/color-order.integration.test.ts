import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { runtimeAssetRegistry, runtimeAssets } from '@forgeax/engine-assets-runtime/internal';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import type { MaterialAsset, ParticleEffectAsset } from '@forgeax/engine-types';
import { ParticleEffectPlayer, vfxGpuRuntimePlugin } from '@forgeax/engine-vfx';
import { cookParticleCodeProgram } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { resolveFeatureWorkResources } from '../../../render/src/features/frame-plan';
import { renderFeaturePlanSignature } from '../../../render/src/features/plan';
import {
  effectFixtureReference,
  runtimeEffectFixture,
} from '../../../vfx/src/__tests__/runtime-effect-fixture';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature';
import { freezeVfxPlan } from './vfx-frame-fixture';

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
const hiddenCamera = {
  ...camera,
  position: new Float32Array([500, 0, 5]),
  viewProjection: new Float32Array(camera.viewProjection),
};
hiddenCamera.viewProjection[12] = -500;
const blend = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;

it.each([
  'forward',
  'particle-mesh',
])('retains opaque-before-blended %s color order across Players, views and visibility changes', async (passName) => {
  const emitters = ['first', 'second'].map((id) => ({
    id,
    capacity: 1,
    backend: { required: 'gpu' },
    space: 'local',
    bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
    schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
    program: { module: 'particle.wgsl' },
    renderers: [
      { kind: 'mesh', mesh: 'mesh', material: 'flash' },
      { kind: 'billboard', material: 'billboard' },
      { kind: 'mesh', mesh: 'mesh', material: 'smoke', castShadows: true },
      { kind: 'billboard', material: 'cutout', blend: 'opaque-cutout' },
    ],
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
  const geometry = createBoxGeometry(1, 1, 1).unwrap();
  const material = (guid: string | number): MaterialAsset => ({
    kind: 'material',
    ...(guid === effectFixtureReference(world, 'flash', 'material') ||
    guid === effectFixtureReference(world, 'smoke', 'material')
      ? {
          passes: [
            {
              name: passName,
              program: { module: 'test::mesh' },
              renderState:
                guid === effectFixtureReference(world, 'flash', 'material')
                  ? { blend, depthWriteEnabled: false }
                  : { depthWriteEnabled: true },
            },
          ],
        }
      : {}),
  });
  const source = gpuParticleRenderFeature({
    camera: { read: () => camera },
    mesh: { read: () => geometry },
    material: { read: (_world, guid) => material(guid) },
  });
  // The receiver plans a structured-cloned source, as in the Render Worker.
  const receiver = gpuParticleRenderFeature({ camera: { read: () => undefined } });
  const signatures = new Map<string, string>();
  try {
    world.update(0).unwrap();
    for (let frameNumber = 1; frameNumber <= 5; frameNumber++) {
      const hidden = (identity: string) =>
        frameNumber === 4 || (frameNumber === 3 && identity === 'left');
      const views = ['left', 'right'].map((identity) => ({
        identity,
        render: true,
        targets,
        selectedView: hidden(identity) ? hiddenCamera : camera,
        generation: 0,
        frame: { frameNumber },
        sceneData: {} as never,
      }));
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
      const plan = receiver
        .plan(structuredClone(extracted), {
          views,
          resolveAsset: (_index, handle, revision) =>
            runtimeAssets(world.assets).resolveAsset(handle, revision),
          caps: {} as never,
          frame: { frameNumber },
          generation: 0,
        })
        .unwrap();
      expect(freezeVfxPlan(receiver.identity, plan, targets).ok).toBe(true);
      for (const { work, closure } of resolveFeatureWorkResources(plan.work)) {
        if (work.scope === 'frame') continue;
        const signature = renderFeaturePlanSignature(closure);
        const previous = signatures.get(work.scope.view);
        if (previous !== undefined) expect(signature).toBe(previous);
        signatures.set(work.scope.view, signature);
      }
      for (const work of plan.work.filter((work) => work.scope !== 'frame')) {
        if (work.scope === 'frame') throw new Error('expected view work');
        const visible = !hidden(work.scope.view);
        const programs = new Map(
          work.resources
            .filter((r) => r.kind === 'graphics-program')
            .map((r) => [r.name, r.program]),
        );
        const raster = work.passes.filter((pass) => pass.kind === 'raster');
        expect(raster).toHaveLength(2);
        const draws = raster.flatMap((pass) => pass.draws);
        expect(draws).toHaveLength(16);
        expect(draws.every((draw) => (draw.enabled !== false) === visible)).toBe(true);
        expect(raster.map((pass) => pass.enabled)).toEqual(Array(2).fill(visible));
        const copies = work.passes.flatMap((pass) =>
          pass.kind === 'copy'
            ? pass.copies.map((copy) => ({
                ...copy,
                enabled: pass.enabled !== false && copy.enabled !== false,
              }))
            : [],
        );
        // Every renderer still gets its own indirect state inside the coalesced copy pass.
        const indirectCopies = copies.filter((copy) => copy.destination.endsWith('.indirect'));
        expect(indirectCopies).toHaveLength(16);
        expect(indirectCopies.filter((copy) => copy.enabled)).toHaveLength(visible ? 16 : 4);
        const blended = draws.map((draw) => {
          const program = draw === undefined ? undefined : programs.get(draw.program);
          if (program === undefined) throw new Error('Missing particle graphics program');
          return program.renderState?.blend !== undefined;
        });
        expect(blended).toEqual([...Array(8).fill(false), ...Array(8).fill(true)]);
        // Preserve renderer order within each group; no per-particle sort or draw is lost.
        // Programs are shared by content; each draw's own instance stream names its renderer.
        const rendererOf = (draw: (typeof draws)[number]) =>
          Number(
            draw.vertexData
              .map((row) => row.resource.match(/renderer-(\d+)\.vertex-data$/)?.[1])
              .find((index) => index !== undefined),
          );
        expect(draws.map(rendererOf)).toEqual([2, 3, 2, 3, 2, 3, 2, 3, 0, 1, 0, 1, 0, 1, 0, 1]);
        const firstRaster = work.passes.findIndex((pass) => pass.kind === 'raster');
        expect(work.passes.slice(firstRaster).every((pass) => pass.kind === 'raster')).toBe(true);
        const shadows = work.passes.filter((pass) => pass.kind === 'shadow-caster');
        expect(shadows).toHaveLength(4);
        expect(
          shadows.every(
            (pass) => pass.enabled !== false && pass.draws.every((draw) => draw.enabled !== false),
          ),
        ).toBe(true);
      }
      receiver.onFrameSubmitted?.(extracted);
      source.onSourceFrameSubmitted?.(extracted, structuredClone(plan.sourceFeedback));
    }
  } finally {
    await context.fiber.dispose();
  }
});
