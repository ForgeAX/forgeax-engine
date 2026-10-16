import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { ParticleEffectAsset, TextureAsset } from '@forgeax/engine-types';
import { ParticleEffectPlayer, vfxGpuRuntimePlugin } from '@forgeax/engine-vfx';
import { cookParticleCodeProgram, createVfxVectorFieldTexture } from '@forgeax/engine-vfx-compiler';
import { expect, it } from 'vitest';
import { gpuParticleRenderFeature } from '../feature/gpu-particle-feature.js';
import { planPasses, planResources, singleViewContext } from './vfx-frame-fixture.js';

it('publishes prepared POD across realms and uploads on content/generation acceptance only', async () => {
  const guid = '01a11250-0000-7000-8000-000000000001';
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const cooked = (
    await cookParticleCodeProgram(
      {
        schemaVersion: 3,
        emitters: [
          {
            id: 'shared-id',
            capacity: 4,
            backend: { required: 'gpu' },
            space: 'world',
            bounds: { kind: 'sphere', center: [0, 0, 0], radius: 10 },
            schedule: { rate: 0, bursts: [{ time: 0, count: 4 }] },
            program: { module: 'fields.wgsl' },
            renderers: [{ kind: 'billboard', material: 'material' }],
            forceFields: [
              {
                kind: 'vector',
                texture: guid,
                sampling: 'trilinear',
                transform: matrix,
                strength: 1,
                attenuation: 0,
              },
            ],
          },
        ],
      },
      {
        'fields.wgsl': {
          entry: `#import forgeax_vfx::prelude::{VfxParticle,VfxSpawnContext,VfxUpdateContext,vfx_integrate}
#import forgeax_vfx::data::force_fields
fn vfx_spawn(ctx:VfxSpawnContext,p:ptr<function,VfxParticle>){(*p).lifetime=100.0;}
fn vfx_update(ctx:VfxUpdateContext,p:ptr<function,VfxParticle>){vfx_apply_force_fields(ctx,p);vfx_integrate(ctx,p);}`,
        },
      },
    )
  ).unwrap();
  const asset: ParticleEffectAsset = {
    kind: 'particle-effect',
    schemaVersion: 3,
    programFingerprint: cooked.fingerprint,
    emitters: [{ id: 'shared-id', capacity: 4 }],
    program: { ...cooked.program, fingerprint: cooked.fingerprint },
  };
  const world = new World();
  world
    .spawn({
      component: ParticleEffectPlayer,
      data: {
        effect: world.allocSharedRef('ParticleEffectAsset', { ...asset, guid: 'effect' }),
        playing: true,
        seed: 21,
        timeScale: 1,
      },
    })
    .unwrap();
  const context = await createWorldContext(world, [vfxGpuRuntimePlugin()]);
  const make = () =>
    createVfxVectorFieldTexture({
      resolution: [8, 8, 8],
      field: { kind: 'constant', value: [0.5, 0.25, -0.125] },
    }).unwrap();
  let texture: TextureAsset = make();
  const camera = {
    position: new Float32Array(3),
    right: new Float32Array([1, 0, 0]),
    up: new Float32Array([0, 1, 0]),
    viewProjection: new Float32Array(matrix),
  };
  const source = gpuParticleRenderFeature({
    camera: { read: () => camera },
    texture: { read: () => texture },
  });
  const consumer = gpuParticleRenderFeature({ camera: { read: () => undefined } });
  let frameNumber = 0;
  const targets = [
    {
      name: 'color',
      kind: 'color' as const,
      format: 'rgba8unorm' as const,
      sampleCount: 1 as const,
    },
  ];
  const frame = (generation = 0, secondView = false) => {
    const data = structuredClone(
      source
        .extract({
          worlds: [world],
          owner: 0,
          views: [
            { identity: 'main', render: true },
            ...(secondView ? [{ identity: 'held', render: frameNumber % 2 === 0 }] : []),
          ],
          frameNumber: ++frameNumber,
        })
        .unwrap(),
    );
    const plan = consumer
      .plan(
        data,
        singleViewContext({
          targets,
          resolveAsset: (_index, handle) => resolveAssetHandle(world, handle),
          caps: {} as never,
          frame: { frameNumber },
          generation,
          sceneData: {} as never,
          ...(secondView
            ? {
                views: [
                  {
                    identity: 'main',
                    render: true,
                    targets,
                    sceneData: {} as never,
                    frame: { frameNumber },
                  },
                  {
                    identity: 'held',
                    render: frameNumber % 2 === 0,
                    targets,
                    sceneData: {} as never,
                    frame: { frameNumber },
                  },
                ],
              }
            : {}),
        }),
      )
      .unwrap();
    const field = planResources(plan).find((r) => r.name.includes('.force-fields.'));
    expect(field).toBeDefined();
    return { data, plan, field };
  };
  const accept = (candidate: ReturnType<typeof frame>) => {
    consumer.onFrameSubmitted?.(candidate.data);
    source.onSourceFrameSubmitted?.(candidate.data, structuredClone(candidate.plan.sourceFeedback));
  };
  try {
    world.update(1 / 60).unwrap();
    // The receiver must reject malformed f32 transforms in the actual POD
    // publication before any GPU resource or simulation work is admitted.
    for (const diagonal of [
      [1e20, 1e20, 1e-40],
      [1e38, 1e-20, 1e-20],
    ]) {
      const invalid = structuredClone(
        source
          .extract({
            worlds: [world],
            owner: 0,
            views: [{ identity: 'main', render: true }],
            frameNumber: frameNumber + 1,
          })
          .unwrap(),
      );
      for (const entry of invalid.worlds[0]?.emitterState.values() ?? []) {
        entry.localToWorld.set([
          diagonal[0] ?? 1,
          0,
          0,
          0,
          0,
          diagonal[1] ?? 1,
          0,
          0,
          0,
          0,
          diagonal[2] ?? 1,
          0,
          0,
          0,
          0,
          1,
        ]);
      }
      expect(
        consumer.plan(
          invalid,
          singleViewContext({
            targets,
            resolveAsset: (_index, handle) => resolveAssetHandle(world, handle),
            caps: {} as never,
            frame: { frameNumber: frameNumber + 1 },
            generation: 0,
            sceneData: {} as never,
          }),
        ),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'render-feature-stage-failed',
          detail: {
            stage: 'plan',
            cause: { code: 'vfx-field-invalid', detail: { path: 'player.transform' } },
          },
        },
      });
      consumer.onFrameAborted?.(invalid);
    }
    const first = frame();
    expect(first.field).toHaveProperty('data');
    consumer.onFrameAborted?.(first.data);
    const retry = frame();
    expect(retry.field?.name).toBe(first.field?.name);
    expect(retry.field).toHaveProperty('data');
    accept(retry);
    world.update(1 / 60).unwrap();
    const hot = frame();
    expect(hot.field?.name).toBe(first.field?.name);
    expect(hot.field).not.toHaveProperty('data');
    accept(hot);
    texture = make();
    new DataView(texture.data.buffer).setFloat32(0, 2, true);
    world.update(1 / 60).unwrap();
    const replacement = frame();
    expect(replacement.field?.name).not.toBe(first.field?.name);
    expect(replacement.field).toHaveProperty('data');
    accept(replacement);
    world.update(1 / 60).unwrap();
    const recovery = frame(1);
    expect(recovery.field?.name).toBe(replacement.field?.name);
    expect(recovery.field).toHaveProperty('data');
    expect(
      planPasses(recovery.plan).filter((p) => p.name.endsWith('.simulate')).length,
    ).toBeGreaterThan(1);
    accept(recovery);
    const resumed = frame(1);
    expect(resumed.field).not.toHaveProperty('data');
    accept(resumed);
    world
      .spawn({
        component: ParticleEffectPlayer,
        data: {
          effect: world.allocSharedRef('ParticleEffectAsset', { ...asset, guid: 'second-effect' }),
          playing: true,
          seed: 22,
          timeScale: 1,
        },
      })
      .unwrap();
    world.update(3 / 60).unwrap();
    const catchUp = frame(1, true);
    const shared = catchUp.plan.work.find((work) => work.scope === 'frame');
    expect(
      shared?.resources.filter((resource) => resource.name.includes('.force-fields.')),
    ).toHaveLength(2);
    expect(
      shared?.passes.filter((pass) => pass.enabled !== false && pass.name.endsWith('.simulate')),
    ).toHaveLength(6);
    expect(
      catchUp.plan.work
        .filter((work) => work.scope !== 'frame')
        .some((work) => work.passes.some((pass) => pass.name.endsWith('.simulate'))),
    ).toBe(false);
    accept(catchUp);
    const held = frame(1, true);
    expect(planPasses(held.plan).filter((pass) => pass.name.endsWith('.simulate'))).toHaveLength(0);
    expect(
      planResources(held.plan)
        .filter((resource) => resource.name.includes('.force-fields.'))
        .some((resource) => 'data' in resource),
    ).toBe(false);
  } finally {
    await context.fiber.dispose();
  }
});
