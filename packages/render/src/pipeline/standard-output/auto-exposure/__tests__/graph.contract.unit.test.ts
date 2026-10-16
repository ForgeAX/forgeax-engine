import { RhiError } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  AUTO_EXPOSURE_FUSED_GRAPH_PASS,
  AUTO_EXPOSURE_GRAPH_PASSES,
  AUTO_EXPOSURE_HISTOGRAM_DISPATCH,
  AUTO_EXPOSURE_HISTOGRAM_WORKGROUP_COUNT,
  createAutoExposureGraphPlan,
  resolveAutoExposureShaderModuleFactory,
  validateAutoExposureGraphPlan,
} from '../graph';

describe('auto exposure graph contract', () => {
  it('declares exactly clear, histogram, and adapt work', () => {
    const plan = createAutoExposureGraphPlan({ width: 17, height: 9 });
    expect(plan.passes.map((pass) => pass.name)).toEqual([...AUTO_EXPOSURE_GRAPH_PASSES]);
    expect(plan.passes.map((pass) => pass.kind)).toEqual(['compute', 'compute', 'compute']);
    expect(plan.physicalPass).toBe(AUTO_EXPOSURE_FUSED_GRAPH_PASS);
    expect(plan.physicalPassCount).toBe(1);
    expect(plan.histogramBytes).toBe(256 * 4);
    expect(plan.stateBytes).toBe(2 * 16);
    expect(plan.sampleCount).toBe(1);
    expect(plan.cpuReadbackCount).toBe(0);
    expect(plan.cpuUploadCount).toBe(0);
    expect(plan.candidateAvailableSameFrame).toBe(true);
    expect(validateAutoExposureGraphPlan(plan).ok).toBe(true);
  });

  it('keeps the fixed 32-workgroup cohort for non-divisible extents', () => {
    const plan = createAutoExposureGraphPlan({ width: 17, height: 9 });
    expect(plan.dispatch).toEqual(AUTO_EXPOSURE_HISTOGRAM_DISPATCH);
    expect(plan.dispatch.x * plan.dispatch.y).toBe(AUTO_EXPOSURE_HISTOGRAM_WORKGROUP_COUNT);
    expect(plan.sampleCount).toBe(1);
    expect(plan.sampleBounds).toEqual({ x: 4, y: 4 });
    expect(plan.passes.map((pass) => pass.workgroupSize)).toEqual([
      [256, 1, 1],
      [256, 1, 1],
      [64, 1, 1],
    ]);

    const tiled = createAutoExposureGraphPlan({ width: 129, height: 133 });
    expect(tiled.dispatch).toEqual(AUTO_EXPOSURE_HISTOGRAM_DISPATCH);
  });

  it('rejects an incorrectly ordered or duplicated work sequence', () => {
    const plan = createAutoExposureGraphPlan({ width: 8, height: 8 });
    const invalid = {
      ...plan,
      passes: [plan.passes[1], plan.passes[0], plan.passes[2], plan.passes[2]],
    } as typeof plan;
    const result = validateAutoExposureGraphPlan(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('auto-exposure-graph-invalid');
  });

  it('rejects stale dispatch or workgroup declarations', () => {
    const plan = createAutoExposureGraphPlan({ width: 8, height: 8 });
    const invalidDispatch = {
      ...plan,
      dispatch: { x: 1, y: 1, z: 1 },
    } as typeof plan;
    expect(validateAutoExposureGraphPlan(invalidDispatch)).toMatchObject({ ok: false });

    const invalidWorkgroup = {
      ...plan,
      passes: plan.passes.map((pass, index) =>
        index === 1 ? { ...pass, workgroupSize: [128, 1, 1] as const } : pass,
      ),
    } as typeof plan;
    expect(validateAutoExposureGraphPlan(invalidWorkgroup)).toMatchObject({ ok: false });
  });

  it('uses the immediate shader factory for the first non-pending frame', () => {
    const immediate = {
      createShaderModule: () => ok({} as import('@forgeax/engine-rhi').ShaderModule),
    };
    const validated = {
      createShaderModule: () =>
        err(
          new RhiError({
            code: 'rhi-not-available',
            expected: 'an already prepared shader module',
            hint: 'wait for the asynchronous warm-up',
          }),
        ),
    };
    const selected = resolveAutoExposureShaderModuleFactory({
      immediateShaderModuleFactory: immediate,
      shaderModuleFactory: validated,
    });
    expect(selected).toBe(immediate);
  });
});
