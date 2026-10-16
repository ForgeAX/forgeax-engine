import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { World } from '@forgeax/engine-ecs';
import { createSceneDataCatalog, type RenderFeaturePlan } from '@forgeax/engine-render';
import type { VfxGpuTickIntent } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import {
  freezeVfxPlan as freezeRenderFeaturePlan,
  gpuParticleRenderFeature,
  planPasses,
  planResources,
  singleViewContext,
} from './vfx-frame-fixture';

const stagePlanPath = resolve(import.meta.dirname, '../feature/stage-plan.ts');

describe('VFX managed stage execution seam', () => {
  it('owns readiness and validated-plan execution in the RenderFeature package', () => {
    const source = readFileSync(stagePlanPath, 'utf8');
    expect(source).toContain('validatedStagePlan');
    expect(source).toContain('stageReadiness');
    expect(source).toContain('stageOutput');
    expect(source).toContain('forgeax_vfx_stage_');
    expect(source).not.toContain('authorRawDispatch');
  });

  it('projects a VFX stage into the closed render feature plan surface', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../feature/gpu-particle-feature.ts'),
      'utf8',
    );
    const plan: RenderFeaturePlan = { work: [{ scope: 'frame', resources: [], passes: [] }] };
    expect(source).toContain('RenderFeaturePlan');
    expect(source).not.toMatch(/GPUCommandEncoder|queue\.submit|encoder\.finish/);
    expect(planPasses(plan)).toEqual([]);
  });

  it('declares storage-produced indirect work and dependent raster descriptors', () => {
    const intent = {
      sequence: 1,
      player: 1,
      emitter: {
        id: 'spark',
        capacity: 4,
        space: 'world',
        bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 },
        wgsl: '// cooked VFX program',
        reflection: {
          entryPoints: ['forgeax_vfx_spawn_main', 'forgeax_vfx_billboard_main'],
          bindings: [
            {
              entries: [
                { binding: 0, visibility: 4, buffer: { type: 'storage' } },
                { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
                { binding: 4, visibility: 4, buffer: { type: 'storage' } },
                { binding: 6, visibility: 4, buffer: { type: 'storage' } },
              ],
            },
          ],
          stages: [],
          dataInterfaces: [],
        },
        renderers: [
          {
            kind: 'billboard',
            material: 'material-guid',
            blend: 'additive',
            sorting: 'none',
          },
        ],
      },
      programFingerprint: 'spark-program',
      reset: true,
      fixedDelta: 1 / 60,
      initialFixedDelta: 1 / 60,
      phaseTick: 0,
      tick: 0,
      seed: 1,
      playCycle: 0,
      spawnCount: 1,
      firstParticleId: 0,
      instanceGeneration: 1,
      channelInputs: [],
      eventCounters: {},
    } as unknown as VfxGpuTickIntent;
    const runtime = {
      isEmitterSessionEnabled: () => true,
      setEmitterCameraVisibility: () => {},
      markEventDispatched: () => {},
      commit: () => {},
    };
    const feature = gpuParticleRenderFeature({ camera: { read: () => undefined } });
    const planned = feature.plan(
      {
        worlds: [
          {
            world: new World(),
            runtime,
            camera: {
              position: new Float32Array(3),
              right: new Float32Array([1, 0, 0]),
              up: new Float32Array([0, 1, 0]),
              viewProjection: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            },
            intents: [intent],
          },
        ],
        frameNumber: 1,
      } as never,
      singleViewContext({
        caps: {} as never,
        frame: { frameNumber: 1 },
        generation: 1,
        targets: [
          { name: 'scene-color', kind: 'color', format: 'rgba16float', sampleCount: 1 },
          { name: 'scene-depth', kind: 'depth', format: 'depth24plus', sampleCount: 1 },
        ],
        sceneData: createSceneDataCatalog({
          featureIdentity: feature.identity,
          generation: 1,
          planIdentity: `${feature.identity}:1`,
          rgba16floatRenderable: true,
        }),
      }),
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(
      freezeRenderFeaturePlan(feature.identity, planned.value, [
        { name: 'scene-color', kind: 'color', format: 'rgba16float', sampleCount: 1 },
        { name: 'scene-depth', kind: 'depth', format: 'depth24plus', sampleCount: 1 },
      ]).ok,
    ).toBe(true);
    expect(planResources(planned.value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'buffer',
          name: expect.stringContaining('.indirect'),
          usage: ['storage', 'indirect'],
        }),
        expect.objectContaining({ kind: 'graphics-program' }),
        expect.objectContaining({ kind: 'graphics-bindings' }),
        expect.objectContaining({ kind: 'vertex-data' }),
      ]),
    );
    expect(planPasses(planned.value)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'compute' }),
        expect.objectContaining({
          kind: 'raster',
          draws: [
            expect.objectContaining({
              draw: expect.objectContaining({ kind: 'draw-indirect' }),
            }),
          ],
        }),
      ]),
    );
    const graphicsProgram = planResources(planned.value).find(
      (resource) => resource.kind === 'graphics-program',
    );
    expect(graphicsProgram).toMatchObject({
      program: {
        renderState: {
          cullMode: 'none',
          depthCompare: 'less-equal',
          depthWriteEnabled: false,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      },
    });
  });
});
