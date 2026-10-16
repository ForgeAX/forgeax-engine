import type { PerPassResources } from '../record/render-context';

export interface ReadyPerPassResourceInputs {
  readonly fxaaPipeline: PerPassResources['fxaaPipeline'];
  readonly fxaaBindGroupLayout: PerPassResources['fxaaBindGroupLayout'];
  readonly fxaaSampler: PerPassResources['fxaaSampler'];
  readonly skyboxPipeline: PerPassResources['skyboxPipeline'];
  readonly skyboxPipelineMsaa: PerPassResources['skyboxPipelineMsaa'];
  readonly skyboxBindGroupLayout: PerPassResources['skyboxBindGroupLayout'];
  readonly skyboxSampler: PerPassResources['skyboxSampler'];
  readonly skyboxRotationBuffer: PerPassResources['skyboxRotationBuffer'];
  readonly shadowSampler: PerPassResources['shadowSampler'];
  readonly shadowLightSpaceMatrix: PerPassResources['shadowLightSpaceMatrix'];
  readonly shadowCsmLightViewProj: PerPassResources['shadowCsmLightViewProj'];
  readonly shadowCsmSelection: PerPassResources['shadowCsmSelection'];
  readonly bloomDownsamplePipeline: PerPassResources['bloomDownsamplePipeline'];
  readonly bloomUpsamplePipeline: PerPassResources['bloomUpsamplePipeline'];
  readonly bloomCompositePipeline: PerPassResources['bloomCompositePipeline'];
  readonly bloomDownsampleBindGroupLayout: PerPassResources['bloomDownsampleBindGroupLayout'];
  readonly bloomUpsampleBindGroupLayout: PerPassResources['bloomUpsampleBindGroupLayout'];
  readonly bloomCompositeBindGroupLayout: PerPassResources['bloomCompositeBindGroupLayout'];
  readonly bloomSampler: PerPassResources['bloomSampler'];
  readonly bloomDownsampleParamsBuffer: PerPassResources['bloomDownsampleParamsBuffer'];
  readonly bloomUpsampleParamsBuffer: PerPassResources['bloomUpsampleParamsBuffer'];
  readonly bloomCompositeParamsBuffer: PerPassResources['bloomCompositeParamsBuffer'];
  readonly ensureBloomResources: NonNullable<PerPassResources['ensureBloomResources']>;
  readonly getBloomResources: NonNullable<PerPassResources['getBloomResources']>;
  readonly commitBloomResources: NonNullable<PerPassResources['commitBloomResources']>;
  readonly commitBloomFrameReceipts: NonNullable<PerPassResources['commitBloomFrameReceipts']>;
  readonly discardBloomResources: NonNullable<PerPassResources['discardBloomResources']>;
  readonly retireBloomResources: NonNullable<PerPassResources['retireBloomResources']>;
  readonly drainBloomResources: NonNullable<PerPassResources['drainBloomResources']>;
  readonly inspectBloomResources: NonNullable<PerPassResources['inspectBloomResources']>;
  readonly ssaoCalcPipeline: PerPassResources['ssaoCalcPipeline'];
  readonly ssaoBlurPipeline: PerPassResources['ssaoBlurPipeline'];
  readonly ssaoBgl: PerPassResources['ssaoBgl'];
}

/** Creates the mutable per-pass slots owned by one prepared device generation. */
export function createReadyPerPassResources(input: ReadyPerPassResourceInputs): PerPassResources {
  return {
    depthTexture: null,
    depthTextureView: null,
    depthTextureWidth: 0,
    depthTextureHeight: 0,
    configured: false,
    hdrColorTexture: null,
    hdrColorView: null,
    hdrDepthTexture: null,
    hdrDepthView: null,
    hdrTextureWidth: 0,
    hdrTextureHeight: 0,
    hdrDepthSampleCount: 1,
    fxaaPipeline: input.fxaaPipeline,
    fxaaBindGroupLayout: input.fxaaBindGroupLayout,
    fxaaSampler: input.fxaaSampler,
    msaaColorTexture: null,
    msaaColorView: null,
    msaaSpriteColorTexture: null,
    msaaSpriteColorView: null,
    msaaDepthTexture: null,
    msaaDepthView: null,
    msaaTextureWidth: 0,
    msaaTextureHeight: 0,
    hdrColorMsaaTexture: null,
    hdrColorMsaaView: null,
    skyboxPipeline: input.skyboxPipeline,
    skyboxPipelineMsaa: input.skyboxPipelineMsaa,
    skyboxBindGroupLayout: input.skyboxBindGroupLayout,
    skyboxSampler: input.skyboxSampler,
    skyboxRotationBuffer: input.skyboxRotationBuffer,
    shadowTexture: null,
    shadowMapSize: 0,
    shadowCascadeCount: 0,
    shadowSampler: input.shadowSampler,
    shadowLightSpaceMatrix: input.shadowLightSpaceMatrix,
    shadowCsmLightViewProj: input.shadowCsmLightViewProj,
    shadowCsmSelection: input.shadowCsmSelection,
    bloomDownsamplePipeline: input.bloomDownsamplePipeline,
    bloomUpsamplePipeline: input.bloomUpsamplePipeline,
    bloomCompositePipeline: input.bloomCompositePipeline,
    bloomDownsampleBindGroupLayout: input.bloomDownsampleBindGroupLayout,
    bloomUpsampleBindGroupLayout: input.bloomUpsampleBindGroupLayout,
    bloomCompositeBindGroupLayout: input.bloomCompositeBindGroupLayout,
    bloomSampler: input.bloomSampler,
    bloomDownsampleParamsBuffer: input.bloomDownsampleParamsBuffer,
    bloomUpsampleParamsBuffer: input.bloomUpsampleParamsBuffer,
    bloomCompositeParamsBuffer: input.bloomCompositeParamsBuffer,
    ensureBloomResources: input.ensureBloomResources,
    getBloomResources: input.getBloomResources,
    commitBloomResources: input.commitBloomResources,
    commitBloomFrameReceipts: input.commitBloomFrameReceipts,
    discardBloomResources: input.discardBloomResources,
    retireBloomResources: input.retireBloomResources,
    drainBloomResources: input.drainBloomResources,
    inspectBloomResources: input.inspectBloomResources,
    ssaoCalcPipeline: input.ssaoCalcPipeline,
    ssaoBlurPipeline: input.ssaoBlurPipeline,
    ssaoBgl: input.ssaoBgl,
    ssaoFilteringSampler: null,
    ssaoDepthSampler: null,
    ssaoFallbackRawView: null,
  };
}
