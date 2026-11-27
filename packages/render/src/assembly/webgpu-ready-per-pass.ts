import type { PerPassResources } from '../record/render-context';

interface ReadyPerPassResourceInputs {
  readonly fxaaPipeline: PerPassResources['fxaaPipeline'];
  readonly fxaaBindGroupLayout: PerPassResources['fxaaBindGroupLayout'];
  readonly fxaaSampler: PerPassResources['fxaaSampler'];
  readonly skyboxPipeline: PerPassResources['skyboxPipeline'];
  readonly skyboxPipelineMsaa: PerPassResources['skyboxPipelineMsaa'];
  readonly skyboxScenePipeline?: PerPassResources['skyboxScenePipeline'];
  readonly skyboxBindGroupLayout: PerPassResources['skyboxBindGroupLayout'];
  readonly skyboxSampler: PerPassResources['skyboxSampler'];
  readonly skyboxRotationBuffer: PerPassResources['skyboxRotationBuffer'];
  readonly shadowSampler: PerPassResources['shadowSampler'];
  readonly bloomHorizontalPipeline: PerPassResources['bloomHorizontalPipeline'];
  readonly bloomVerticalPipeline: PerPassResources['bloomVerticalPipeline'];
  readonly bloomCompositePipeline: PerPassResources['bloomCompositePipeline'];
  readonly bloomHorizontalBindGroupLayout: PerPassResources['bloomHorizontalBindGroupLayout'];
  readonly bloomVerticalBindGroupLayout: PerPassResources['bloomVerticalBindGroupLayout'];
  readonly bloomCompositeBindGroupLayout: PerPassResources['bloomCompositeBindGroupLayout'];
  readonly bloomSampler: PerPassResources['bloomSampler'];
  readonly bloomHorizontalParamsBuffer: PerPassResources['bloomHorizontalParamsBuffer'];
  readonly bloomVerticalParamsBuffer: PerPassResources['bloomVerticalParamsBuffer'];
  readonly bloomCompositeParamsBuffer: PerPassResources['bloomCompositeParamsBuffer'];
  readonly ensureBloomResources: NonNullable<PerPassResources['ensureBloomResources']>;
  readonly getBloomResources: NonNullable<PerPassResources['getBloomResources']>;
  readonly commitBloomResources: NonNullable<PerPassResources['commitBloomResources']>;
  readonly commitBloomFrameReceipts: NonNullable<PerPassResources['commitBloomFrameReceipts']>;
  readonly discardBloomResources: NonNullable<PerPassResources['discardBloomResources']>;
  readonly retireBloomResources: NonNullable<PerPassResources['retireBloomResources']>;
  readonly drainBloomResources: NonNullable<PerPassResources['drainBloomResources']>;
  readonly inspectBloomResources: NonNullable<PerPassResources['inspectBloomResources']>;
  readonly ssaoGBufferPipelines?: PerPassResources['ssaoGBufferPipelines'];
  readonly gtaoGBufferComputePipeline?: PerPassResources['gtaoGBufferComputePipeline'];
  readonly ssaoCalcPipeline: PerPassResources['ssaoCalcPipeline'];
  readonly ssaoBlurPipeline: PerPassResources['ssaoBlurPipeline'];
  readonly ssaoBgl: PerPassResources['ssaoBgl'];
  readonly gtaoComputePipeline?: PerPassResources['gtaoComputePipeline'];
  readonly gtaoComputeBgl?: PerPassResources['gtaoComputeBgl'];
  readonly ssaoDepthCalcPipeline?: PerPassResources['ssaoDepthCalcPipeline'];
  readonly ssaoDepthBlurPipeline?: PerPassResources['ssaoDepthBlurPipeline'];
  readonly ssaoDepthBgl?: PerPassResources['ssaoDepthBgl'];
  readonly gtaoScreenComputePipeline?: PerPassResources['gtaoScreenComputePipeline'];
  readonly ssaoScreenPipeline?: PerPassResources['ssaoScreenPipeline'];
}

/** Creates the mutable per-pass slots owned by one prepared device generation. */
export function createReadyPerPassResources(input: ReadyPerPassResourceInputs): PerPassResources {
  return {
    configured: false,
    fxaaPipeline: input.fxaaPipeline,
    fxaaBindGroupLayout: input.fxaaBindGroupLayout,
    fxaaSampler: input.fxaaSampler,
    skyboxPipeline: input.skyboxPipeline,
    skyboxPipelineMsaa: input.skyboxPipelineMsaa,
    skyboxScenePipeline: input.skyboxScenePipeline,
    skyboxBindGroupLayout: input.skyboxBindGroupLayout,
    skyboxSampler: input.skyboxSampler,
    skyboxRotationBuffer: input.skyboxRotationBuffer,
    shadowTexture: null,
    shadowMapSize: 0,
    shadowCascadeCount: 0,
    shadowSampler: input.shadowSampler,
    bloomHorizontalPipeline: input.bloomHorizontalPipeline,
    bloomVerticalPipeline: input.bloomVerticalPipeline,
    bloomCompositePipeline: input.bloomCompositePipeline,
    bloomHorizontalBindGroupLayout: input.bloomHorizontalBindGroupLayout,
    bloomVerticalBindGroupLayout: input.bloomVerticalBindGroupLayout,
    bloomCompositeBindGroupLayout: input.bloomCompositeBindGroupLayout,
    bloomSampler: input.bloomSampler,
    bloomHorizontalParamsBuffer: input.bloomHorizontalParamsBuffer,
    bloomVerticalParamsBuffer: input.bloomVerticalParamsBuffer,
    bloomCompositeParamsBuffer: input.bloomCompositeParamsBuffer,
    ensureBloomResources: input.ensureBloomResources,
    getBloomResources: input.getBloomResources,
    commitBloomResources: input.commitBloomResources,
    commitBloomFrameReceipts: input.commitBloomFrameReceipts,
    discardBloomResources: input.discardBloomResources,
    retireBloomResources: input.retireBloomResources,
    drainBloomResources: input.drainBloomResources,
    inspectBloomResources: input.inspectBloomResources,
    ssaoGBufferPipelines: input.ssaoGBufferPipelines,
    gtaoGBufferComputePipeline: input.gtaoGBufferComputePipeline,
    ssaoCalcPipeline: input.ssaoCalcPipeline,
    ssaoBlurPipeline: input.ssaoBlurPipeline,
    ssaoBgl: input.ssaoBgl,
    ...(input.gtaoComputePipeline === undefined
      ? {}
      : { gtaoComputePipeline: input.gtaoComputePipeline }),
    ...(input.gtaoComputeBgl === undefined ? {} : { gtaoComputeBgl: input.gtaoComputeBgl }),
    ssaoDepthCalcPipeline: input.ssaoDepthCalcPipeline ?? null,
    ssaoDepthBlurPipeline: input.ssaoDepthBlurPipeline ?? null,
    ssaoDepthBgl: input.ssaoDepthBgl ?? null,
    gtaoScreenComputePipeline: input.gtaoScreenComputePipeline,
    ssaoScreenPipeline: input.ssaoScreenPipeline,
    ssaoFilteringSampler: null,
    ssaoDepthSampler: null,
    ssaoFallbackRawView: null,
  };
}
