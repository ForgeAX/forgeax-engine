import type { MaterialRenderState } from '@forgeax/engine-types';

// Material comparisons describe forward distance, as in Three.js. Only this
// projection converts them to the renderer's native Reverse-Z representation.
const REVERSED_DEPTH_COMPARE: Record<GPUCompareFunction, GPUCompareFunction> = {
  never: 'never',
  less: 'greater',
  equal: 'equal',
  'less-equal': 'greater-equal',
  greater: 'less',
  'not-equal': 'not-equal',
  'greater-equal': 'less-equal',
  always: 'always',
};

/** One material-to-RHI projection for ordinary, prepared and GPU-driven pipelines. */
export function materialColorTarget(
  format: GPUTextureFormat,
  state?: MaterialRenderState,
  index = 0,
): GPUColorTargetState {
  const output = state?.outputs?.[index];
  const blend = state?.outputs === undefined ? state?.blend : output?.blend;
  const writeMask =
    state?.colorWriteMask === undefined
      ? output?.writeMask
      : state.colorWriteMask & (output?.writeMask ?? 15);
  return {
    format,
    ...(blend === undefined ? {} : { blend }),
    ...(writeMask === undefined ? {} : { writeMask }),
  };
}

export function materialDepthStencil(
  format: GPUTextureFormat,
  state?: MaterialRenderState,
): GPUDepthStencilState {
  return {
    format,
    depthWriteEnabled: state?.depthWriteEnabled ?? true,
    depthCompare: REVERSED_DEPTH_COMPARE[state?.depthCompare ?? 'less'],
    ...(state?.depthBias === undefined ? {} : { depthBias: -state.depthBias }),
    ...(state?.depthBiasSlopeScale === undefined
      ? {}
      : { depthBiasSlopeScale: -state.depthBiasSlopeScale }),
    ...(state?.depthBiasClamp === undefined ? {} : { depthBiasClamp: -state.depthBiasClamp }),
    ...(state?.stencil === undefined
      ? {}
      : { stencilFront: state.stencil, stencilBack: state.stencil }),
    ...(state?.stencilReadMask === undefined ? {} : { stencilReadMask: state.stencilReadMask }),
    ...(state?.stencilWriteMask === undefined ? {} : { stencilWriteMask: state.stencilWriteMask }),
  };
}

/** Generated shadow passes share raster geometry, but own their depth writes. */
export function shadowCasterRenderState(
  state?: MaterialRenderState,
): MaterialRenderState | undefined {
  if (state === undefined) return undefined;
  return {
    ...(state.cullMode === undefined ? {} : { cullMode: state.cullMode }),
    ...(state.frontFace === undefined ? {} : { frontFace: state.frontFace }),
    ...(state.depthBias === undefined ? {} : { depthBias: state.depthBias }),
    ...(state.depthBiasSlopeScale === undefined
      ? {}
      : { depthBiasSlopeScale: state.depthBiasSlopeScale }),
    ...(state.depthBiasClamp === undefined ? {} : { depthBiasClamp: state.depthBiasClamp }),
  };
}

/** GPU shadow batches preserve the same raster-only state as generated casters. */
export function supportsGpuShadowRenderState(state?: MaterialRenderState): boolean {
  if (state === undefined) return true;
  const raster = shadowCasterRenderState(state) ?? {};
  return Object.entries(state).every(([key, value]) => value === undefined || key in raster);
}
