import { err, ok, type Result } from '@forgeax/engine-types';
import type { RenderPipelineFrame } from '../../../render-pipeline';
import { AUTO_EXPOSURE_PRESET_V1 } from './preset';

export const AUTO_EXPOSURE_GRAPH_PASSES = [
  'auto-exposure-clear',
  'auto-exposure-histogram',
  'auto-exposure-adapt',
] as const;

/** The logical meter stages are encoded inside one physical compute pass. */
export const AUTO_EXPOSURE_FUSED_GRAPH_PASS = 'auto-exposure-meter' as const;

/**
 * The meter keeps one physical compute pass, but separates its ordered
 * clear/histogram/adapt dispatches so the histogram cohort can synchronize
 * across workgroups through the command stream. Histogram uses 32 fixed
 * workgroups of 256 invocations; the dispatch is intentionally independent of
 * output resolution.
 */
export const AUTO_EXPOSURE_HISTOGRAM_WORKGROUP_SIZE = 256 as const;
export const AUTO_EXPOSURE_HISTOGRAM_WORKGROUP_COUNT = 32 as const;
export const AUTO_EXPOSURE_HISTOGRAM_DISPATCH = Object.freeze({
  x: 4,
  y: 8,
  z: 1,
} as const);
export const AUTO_EXPOSURE_ADAPT_WORKGROUP_SIZE = 64 as const;
export const AUTO_EXPOSURE_CLEAR_WORKGROUP_SIZE = 256 as const;

export type AutoExposureGraphPassName = (typeof AUTO_EXPOSURE_GRAPH_PASSES)[number];

/**
 * Built-in auto-exposure work is recorded synchronously during graph
 * execution. Prefer the renderer's handle-first factory so the first frame
 * does not become a false pending shader failure after async warm-up has
 * already supplied a usable module.
 */
export function resolveAutoExposureShaderModuleFactory(
  runtime: Pick<
    RenderPipelineFrame['runtime'],
    'immediateShaderModuleFactory' | 'shaderModuleFactory'
  >,
): NonNullable<RenderPipelineFrame['runtime']['shaderModuleFactory']> | undefined {
  return runtime.immediateShaderModuleFactory ?? runtime.shaderModuleFactory;
}

export interface AutoExposureGraphPass {
  readonly name: AutoExposureGraphPassName;
  readonly kind: 'compute';
  readonly workgroupSize: readonly [number, number, number];
}

export interface AutoExposureGraphPlan {
  readonly resolution: Readonly<{ width: number; height: number }>;
  readonly sampleBounds: Readonly<{ x: 4; y: 4 }>;
  readonly sampleCount: number;
  readonly dispatch: Readonly<{ x: number; y: number; z: 1 }>;
  readonly histogramBytes: 1024;
  readonly stateBytes: 32;
  readonly passes: readonly AutoExposureGraphPass[];
  readonly physicalPass: typeof AUTO_EXPOSURE_FUSED_GRAPH_PASS;
  readonly physicalPassCount: 1;
  readonly resources: readonly ['auto-exposure-histogram', 'auto-exposure-state'];
  readonly cpuReadbackCount: 0;
  readonly cpuUploadCount: 0;
  readonly candidateAvailableSameFrame: true;
}

export class AutoExposureGraphError extends Error {
  readonly code = 'auto-exposure-graph-invalid' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<{ field: string; actual: string }>;

  constructor(field: string, actual: string, expected: string) {
    super(`auto-exposure-graph-invalid: ${field} ${actual}; expected ${expected}`);
    this.name = 'AutoExposureGraphError';
    this.expected = expected;
    this.hint = `repair the ${field} declaration before recording the auto exposure graph`;
    this.detail = Object.freeze({ field, actual });
  }
}

function positiveDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

export function createAutoExposureGraphPlan(input: {
  readonly width: number;
  readonly height: number;
}): AutoExposureGraphPlan {
  if (!positiveDimension(input.width) || !positiveDimension(input.height)) {
    throw new RangeError(
      'Auto exposure graph resolution must contain positive integer dimensions.',
    );
  }
  const block = AUTO_EXPOSURE_PRESET_V1.sampleBlockSize;
  const histogramDispatch = AUTO_EXPOSURE_HISTOGRAM_DISPATCH;
  return {
    resolution: Object.freeze({ width: input.width, height: input.height }),
    sampleBounds: Object.freeze({ x: block, y: block }),
    sampleCount: 1,
    dispatch: histogramDispatch,
    histogramBytes: (256 * 4) as 1024,
    stateBytes: (2 * 16) as 32,
    physicalPass: AUTO_EXPOSURE_FUSED_GRAPH_PASS,
    physicalPassCount: 1,
    passes: Object.freeze([
      {
        name: 'auto-exposure-clear',
        kind: 'compute',
        workgroupSize: [AUTO_EXPOSURE_CLEAR_WORKGROUP_SIZE, 1, 1],
      },
      {
        name: 'auto-exposure-histogram',
        kind: 'compute',
        workgroupSize: [AUTO_EXPOSURE_HISTOGRAM_WORKGROUP_SIZE, 1, 1],
      },
      {
        name: 'auto-exposure-adapt',
        kind: 'compute',
        workgroupSize: [AUTO_EXPOSURE_ADAPT_WORKGROUP_SIZE, 1, 1],
      },
    ]),
    resources: Object.freeze(['auto-exposure-histogram', 'auto-exposure-state']),
    cpuReadbackCount: 0,
    cpuUploadCount: 0,
    candidateAvailableSameFrame: true,
  };
}

export function validateAutoExposureGraphPlan(
  plan: AutoExposureGraphPlan,
): Result<AutoExposureGraphPlan, AutoExposureGraphError> {
  const expectedPasses = [...AUTO_EXPOSURE_GRAPH_PASSES];
  if (
    plan.passes.length !== expectedPasses.length ||
    plan.passes.some(
      (pass, index) => pass.name !== expectedPasses[index] || pass.kind !== 'compute',
    )
  ) {
    return err(
      new AutoExposureGraphError(
        'passes',
        plan.passes.map((pass) => pass.name).join(','),
        expectedPasses.join(','),
      ),
    );
  }
  const expectedDispatch = AUTO_EXPOSURE_HISTOGRAM_DISPATCH;
  if (
    plan.dispatch.x !== expectedDispatch.x ||
    plan.dispatch.y !== expectedDispatch.y ||
    plan.dispatch.z !== expectedDispatch.z ||
    plan.dispatch.x * plan.dispatch.y * plan.dispatch.z !== AUTO_EXPOSURE_HISTOGRAM_WORKGROUP_COUNT
  ) {
    return err(
      new AutoExposureGraphError(
        'dispatch',
        `${plan.dispatch.x}x${plan.dispatch.y}x${plan.dispatch.z}`,
        `${expectedDispatch.x}x${expectedDispatch.y}x${expectedDispatch.z}`,
      ),
    );
  }
  const expectedWorkgroupSizes = [
    [AUTO_EXPOSURE_CLEAR_WORKGROUP_SIZE, 1, 1],
    [AUTO_EXPOSURE_HISTOGRAM_WORKGROUP_SIZE, 1, 1],
    [AUTO_EXPOSURE_ADAPT_WORKGROUP_SIZE, 1, 1],
  ] as const;
  if (
    plan.passes.some((pass, index) => {
      const expected = expectedWorkgroupSizes[index];
      return (
        expected === undefined ||
        pass.workgroupSize.some((value, dimension) => value !== expected[dimension])
      );
    })
  ) {
    return err(
      new AutoExposureGraphError(
        'workgroupSize',
        plan.passes.map((pass) => pass.workgroupSize.join('x')).join(','),
        expectedWorkgroupSizes.map((size) => size.join('x')).join(','),
      ),
    );
  }
  if (plan.histogramBytes !== 1024) {
    return err(new AutoExposureGraphError('histogramBytes', String(plan.histogramBytes), '1024'));
  }
  if (plan.stateBytes !== 32) {
    return err(new AutoExposureGraphError('stateBytes', String(plan.stateBytes), '32'));
  }
  if (plan.physicalPass !== AUTO_EXPOSURE_FUSED_GRAPH_PASS) {
    return err(
      new AutoExposureGraphError(
        'physicalPass',
        String(plan.physicalPass),
        AUTO_EXPOSURE_FUSED_GRAPH_PASS,
      ),
    );
  }
  if (plan.physicalPassCount !== 1) {
    return err(
      new AutoExposureGraphError('physicalPassCount', String(plan.physicalPassCount), '1'),
    );
  }
  if (plan.cpuReadbackCount !== 0 || plan.cpuUploadCount !== 0) {
    return err(
      new AutoExposureGraphError(
        'cpuTransfers',
        `${plan.cpuReadbackCount}/${plan.cpuUploadCount}`,
        '0/0',
      ),
    );
  }
  if (!plan.candidateAvailableSameFrame) {
    return err(new AutoExposureGraphError('candidateAvailableSameFrame', 'false', 'true'));
  }
  return ok(plan);
}
