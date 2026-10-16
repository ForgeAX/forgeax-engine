import { describe, expect, it } from 'vitest';
import { SCENE_DATA_TEMPORAL_V1_SCHEMA } from '../../../temporal/scene-data';
import { createSceneDataCatalog } from '../../../temporal/scene-data-catalog';
import { freezeRenderFeaturePlan } from '../../plan';
import { MOTION_BLUR_COMPUTE_WGSL, planMotionBlur } from '../motion-blur-feature';
import { DEFAULT_MOTION_BLUR_PARAMS } from '../motion-blur-params';

const caps = {
  rgba16floatRenderable: true,
  compute: true,
  storageBuffer: true,
} as never;

describe('Motion Blur feature plan', () => {
  it('declares one projected fullscreen draw with semantic reads', () => {
    const catalog = createSceneDataCatalog({
      featureIdentity: 'forgeax.motion-blur',
      generation: 4,
      planIdentity: 'forgeax.motion-blur:4',
      rgba16floatRenderable: true,
    });
    const planned = planMotionBlur(DEFAULT_MOTION_BLUR_PARAMS, {
      caps,
      frame: { frameNumber: 7 },
      identity: 'main',
      render: true,
      targets: [
        { name: 'motion-input', kind: 'color', format: 'rgba16float', sampleCount: 1 },
        { name: 'motion-output', kind: 'color', format: 'rgba16float', sampleCount: 1 },
      ],
      sceneData: catalog,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const frozen = freezeRenderFeaturePlan('forgeax.motion-blur', planned.value, [
      { name: 'motion-input', kind: 'color', format: 'rgba16float', sampleCount: 1 },
      { name: 'motion-output', kind: 'color', format: 'rgba16float', sampleCount: 1 },
    ]);
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const bindings = frozen.value.resources.find(
      (resource) => resource.kind === 'graphics-bindings',
    );
    expect(bindings?.kind).toBe('graphics-bindings');
    const program = frozen.value.resources.find(
      (resource) => resource.kind === 'fullscreen-program',
    );
    expect(program?.kind).toBe('fullscreen-program');
    if (program?.kind === 'fullscreen-program') {
      expect(program.reads).toEqual(['scene-color', 'scene-temporal']);
      expect(program.reads).not.toContainEqual({ key: 'scene-depth', sampleType: 'depth' });
    }
    if (bindings?.kind === 'graphics-bindings') {
      expect(bindings.values).not.toHaveProperty('depth');
      expect(bindings.logicalTargets).toEqual({ input: 'motion-input' });
    }
    expect(frozen.value.passes).toHaveLength(1);
    const pass = frozen.value.passes[0];
    expect(pass?.kind).toBe('raster');
    if (pass?.kind !== 'raster') return;
    expect(pass.draws[0]?.vertexLayout).toBe('none');
    expect(pass.sampledTargets).toEqual(
      expect.arrayContaining(['motion-input', catalog.require(SCENE_DATA_TEMPORAL_V1_SCHEMA)]),
    );
    expect(pass.sampledTargets).not.toContain('motion-depth');
    expect(catalog.schema).toBe(SCENE_DATA_TEMPORAL_V1_SCHEMA);
  });

  it('selects one tile summary and one fused reconstruction on compute-capable targets', () => {
    const computeCaps = {
      rgba16floatRenderable: true,
      compute: true,
      storageBuffer: true,
      storageTexture: true,
    } as never;
    const catalog = createSceneDataCatalog({
      featureIdentity: 'forgeax.motion-blur',
      generation: 4,
      planIdentity: 'forgeax.motion-blur:4',
      rgba16floatRenderable: true,
    });
    const targets = [
      {
        name: 'motion-input',
        kind: 'color' as const,
        format: 'rgba16float' as const,
        sampleCount: 1 as const,
      },
      {
        name: 'motion-output',
        kind: 'color' as const,
        format: 'rgba16float' as const,
        sampleCount: 1 as const,
      },
    ];
    const planned = planMotionBlur(
      DEFAULT_MOTION_BLUR_PARAMS,
      {
        caps: computeCaps,
        frame: { frameNumber: 7, width: 1920, height: 1080 },
        identity: 'main',
        render: true,
        targets,
        sceneData: catalog,
      },
      { frameDeltaSeconds: 1 / 60, reset: false },
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const frozen = freezeRenderFeaturePlan('forgeax.motion-blur', planned.value, targets);
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;

    const computeProgram = frozen.value.resources.find(
      (resource) => resource.kind === 'compute-program',
    );
    const tileSummary = frozen.value.resources.find(
      (resource) => resource.kind === 'buffer' && resource.name === 'motion-blur-tile-summary',
    );
    expect(computeProgram?.kind).toBe('compute-program');
    expect(tileSummary).toMatchObject({
      kind: 'buffer',
      size: Math.ceil(1920 / 16) * Math.ceil(1080 / 16) * 32,
      usage: ['storage'],
    });
    expect(frozen.value.passes.map((pass) => pass.name)).toEqual([
      'motion-blur-tile-summary',
      'motion-blur',
    ]);
    expect(frozen.value.passes).toHaveLength(2);
    expect(frozen.value.passes[0]).toMatchObject({
      kind: 'compute',
      dispatches: [{ entryPoint: 'tile_summary', workgroups: [120, 68, 1] }],
    });
    expect(frozen.value.passes[1]).toMatchObject({
      kind: 'compute',
      dispatches: [{ entryPoint: 'reconstruct', workgroups: [240, 135, 1] }],
    });
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('2.0 * (f32(index) + 0.5) / denominator - 1.0');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('let sourcePixel = workgroupBase');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('halfFilteredColor');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('workgroupBarrier()');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('if (!inBounds) {');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('depthReject');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('sourceVelocitySegmentCovers');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('TILE_NEIGHBORHOOD_COUNT');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('tileIntersectsWorkgroupSupport');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('tileNeighborhoodOffset');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('const EDGE_FILL_FACTOR : f32 = 0.99;');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('let acceptedColor');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('let acceptedAlpha');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('let emptyReceiver');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('let sourceScale');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('let sourceContribution');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('let trailScale');
    expect(MOTION_BLUR_COMPUTE_WGSL).toContain('let outputAlpha');
    expect(MOTION_BLUR_COMPUTE_WGSL).not.toContain('TILE_CANDIDATE_OFFSETS');
    expect(MOTION_BLUR_COMPUTE_WGSL).not.toContain('atomic');
    expect(MOTION_BLUR_COMPUTE_WGSL).not.toContain('textureSampleLevel');
    if (computeProgram?.kind === 'compute-program') {
      const entries = computeProgram.program.bindings?.[0]?.entries ?? [];
      expect(entries.find((entry) => entry.binding === 2)?.buffer?.type).toBe('storage');
      expect(entries.find((entry) => entry.binding === 3)?.storageTexture?.access).toBe(
        'write-only',
      );
    }
  });

  it('compiles the compute lane WGSL before it reaches a backend', async () => {
    const { compileShader } = await import(
      /* @vite-ignore */
      new URL('../../../../../shader-compiler/dist/index.mjs', import.meta.url).href
    );
    const compiled = await compileShader(MOTION_BLUR_COMPUTE_WGSL, {
      id: 'forgeax::motion-blur-compute',
    });
    expect(compiled.ok, compiled.ok ? undefined : String(compiled.error)).toBe(true);
  });
});
