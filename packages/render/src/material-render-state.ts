import type { MaterialRenderState } from '@forgeax/engine-types';

/** Affine model parity, independent of translation and nonuniform scale magnitude. */
export function isReflectedTransform(world: Float32Array): boolean {
  const a = world[0] ?? 0,
    b = world[4] ?? 0,
    c = world[8] ?? 0;
  const d = world[1] ?? 0,
    e = world[5] ?? 0,
    f = world[9] ?? 0;
  const g = world[2] ?? 0,
    h = world[6] ?? 0,
    i = world[10] ?? 0;
  return a * (e * i - h * f) - b * (d * i - g * f) + c * (d * h - g * e) < 0;
}

const reflectedStates = new WeakMap<MaterialRenderState, MaterialRenderState>();
const REFLECTED_DEFAULT: MaterialRenderState = Object.freeze({ frontFace: 'cw' as const });

/** Model and view reflections compose by parity; authored material state stays immutable. */
export function reflectedRenderState(
  state: MaterialRenderState | undefined,
  reflected: boolean,
): MaterialRenderState | undefined {
  if (!reflected) return state;
  if (state === undefined) return REFLECTED_DEFAULT;
  // One stable reflected identity per authored state lets per-view caches compare by reference.
  // In-place authored edits are observed by a shallow field check before reuse.
  const frontFace = state.frontFace === 'cw' ? 'ccw' : 'cw';
  let mirrored = reflectedStates.get(state);
  if (mirrored === undefined || !sameReflection(state, mirrored, frontFace)) {
    mirrored = { ...state, frontFace };
    reflectedStates.set(state, mirrored);
  }
  return mirrored;
}

function sameReflection(
  state: MaterialRenderState,
  mirrored: MaterialRenderState,
  frontFace: 'cw' | 'ccw',
): boolean {
  if (mirrored.frontFace !== frontFace) return false;
  const source = state as Record<string, unknown>,
    target = mirrored as Record<string, unknown>;
  let count = 0;
  for (const key in source) {
    count++;
    if (key !== 'frontFace' && source[key] !== target[key]) return false;
  }
  return Object.keys(target).length === count + (source.frontFace === undefined ? 1 : 0);
}

export function transformRenderState(
  state: MaterialRenderState | undefined,
  world: Float32Array,
): MaterialRenderState | undefined {
  return reflectedRenderState(state, isReflectedTransform(world));
}

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

/** Like Three's non-VSM shadow side, generated casters render the opposite
 * face of a single-sided surface. Closed meshes avoid self-shadow acne;
 * explicitly double-sided surfaces keep both faces. Custom passes own their state. */
export function shadowCasterRenderState(state: MaterialRenderState = {}): MaterialRenderState {
  return {
    cullMode: state.cullMode === 'none' ? 'none' : state.cullMode === 'front' ? 'back' : 'front',
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
