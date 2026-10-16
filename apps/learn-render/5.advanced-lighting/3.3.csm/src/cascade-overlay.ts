// apps/learn-render/5.advanced-lighting/3.3.csm/src/cascade-overlay.ts
// LearnOpenGL section 5.3 cascaded shadow maps -- demo-local cascade overlay
// debug-viz post-process.
//
// feat-20260702-postprocess-camera-depth-read M4 w17: rewrite from 5-variant
// regex-swap + re-installPipeline to single shader with structured reads
// ({key, sampleType:'depth'}) + uniform params (PostProcessParams ECS
// component). Mode switching goes from "re-install whole URP" to "write 32 B
// UBO" (D-8: params@2, always present for fullscreen-post-with-scene-depth).
//
// The overlay is wired through the engine M4' post-URP post-process hook:
// URP renders the full lit scene (shadow cascades + tonemap + bloom + fxaa)
// into the swap-chain, then composites the cascade-tint effect over the final
// image. The overlay pass is always active (installed once); 'off' mode
// writes tintMode=-1 to params, which the shader detects and passthroughs.

import { createFullscreenRenderFeature } from '@forgeax/engine-app';
import { PostProcessParams } from '@forgeax/engine-render';
import overlayShader from './cascade-overlay.wgsl';

const POSTPROCESS_ID = 'learn-render-5-3-3-csm::overlay';
const PARAMS_BYTE_SIZE = 32;

/**
 * PSSM split config for the demo overlay. The engine PSSM range is [camera
 * near, DirectionalLight.shadowDistance], so the active scene's shadow
 * distance must be supplied to the overlay params rather than baked into its
 * shader source.
 */
const CSM_NEAR = 0.1;
const CSM_FAR = 50;
const CSM_CASCADE_COUNT = 4;
const CSM_SPLIT_LAMBDA = 0.75;

/** TINT_MODE numeric value baked per mode (matches cascade-overlay.wgsl doc). */
const TINT_MODE_BY_MODE = {
  off: -1,
  all: 0,
  c1: 1,
  c2: 2,
  c3: 3,
  c4: 4,
} satisfies Readonly<Record<string, number>>;

/** Closed roster of overlay tint modes. */
export type CsmOverlayMode = keyof typeof TINT_MODE_BY_MODE;

/** Map a keyboard digit to an overlay mode (key '0' = off, '1'..'4' = single). */
export function csmOverlayModeForKey(key: string): CsmOverlayMode | null {
  if (key === '0') return 'off';
  if (key === '1') return 'c1';
  if (key === '2') return 'c2';
  if (key === '3') return 'c3';
  if (key === '4') return 'c4';
  return null;
}

/**
 * Recompute the PSSM cascade split distances demo-side with the SAME formula
 * the engine uses (render-system-extract.ts pssmSplit, not re-exported from
 * the runtime barrel -- research F6). The active shadow distance is carried in
 * PostProcessParams so the overlay follows the selected MVD scene.
 *
 *   C_i = lambda * n * (f/n)^(i/m) + (1 - lambda) * (n + (i/m)(f - n)),  i=1..m
 */
export function computeCsmSplits(shadowDistance = CSM_FAR): Float32Array {
  const m = CSM_CASCADE_COUNT;
  const n = CSM_NEAR;
  const f = shadowDistance;
  const lambda = CSM_SPLIT_LAMBDA;
  const ratio = f / n;
  const out = new Float32Array(m);
  for (let i = 1; i <= m; i++) {
    const t = i / m;
    const logPart = n * ratio ** t;
    const uniformPart = n + t * (f - n);
    out[i - 1] = lambda * logPart + (1 - lambda) * uniformPart;
  }
  return out;
}

/**
 * Pack overlay mode and active PSSM splits into the PostProcessParams struct
 * (tintMode/fakeDepth at 0/4, padding at 8, splits at 16).
 */
function packModeBytes(mode: CsmOverlayMode, splits: Float32Array): Uint8Array {
  const buf = new ArrayBuffer(PARAMS_BYTE_SIZE);
  const f32 = new Float32Array(buf);
  f32[0] = TINT_MODE_BY_MODE[mode];
  f32[1] = 0; // fakeDepth: 0 = real depth from engine channel
  f32[2] = 0; // pad
  f32[3] = 0; // pad
  f32.set(splits, 4);
  return new Uint8Array(buf);
}

/**
 * The feature declaration is the only producer surface. The renderer host
 * registers it and composes it into the Standard graph.
 */
export const csmOverlayFeature = createFullscreenRenderFeature({
  identity: POSTPROCESS_ID,
  source: overlayShader.wgsl,
  reads: [{ key: 'sceneColor' }, { key: 'depth', sampleType: 'depth' }],
  params: { byteSize: PARAMS_BYTE_SIZE, defaultValue: packModeBytes('all', computeCsmSplits()) },
});

type WorldLike = {
  spawn: (...args: any[]) => { unwrap(): any };
  set: (...args: any[]) => void;
};

let activeWorld: WorldLike | null = null;
let activeParamsEntity: unknown = null;
let activeSplits = computeCsmSplits();
let activeMode: CsmOverlayMode = 'all';

/**
 * Spawn the parameter entity for per-frame mode switching. The feature itself
 * is supplied at app construction, so there is no late registry mutation.
 */
export function installCsmOverlay(world: WorldLike, shadowDistance = CSM_FAR): Float32Array {
  activeSplits = computeCsmSplits(shadowDistance);
  activeMode = 'all';
  // Spawn PostProcessParams entity so the engine writes params UBO per-frame.
  // tintMode changes via world.set() in setCsmOverlayMode (D-8: UBO write
  // replaces re-installPipeline).
  activeParamsEntity = world.spawn({
    component: PostProcessParams,
    data: { shader: POSTPROCESS_ID, data: packModeBytes('all', activeSplits) },
  }).unwrap();

  activeWorld = world;
  return activeSplits;
}

/** Update the demo overlay's split facts when the active MVD scene changes. */
export function setCsmOverlaySplits(shadowDistance: number): boolean {
  if (activeWorld === null || activeParamsEntity === null) return false;
  activeSplits = computeCsmSplits(shadowDistance);
  activeWorld.set(activeParamsEntity, PostProcessParams, {
    data: packModeBytes(activeMode, activeSplits),
  });
  return true;
}

/**
 * Hot-swap the overlay tint mode by writing to the PostProcessParams UBO.
 * No pipeline re-install -- the shader pass is always active (D-8).
 */
export function setCsmOverlayMode(mode: CsmOverlayMode): boolean {
  if (activeWorld === null || activeParamsEntity === null) return false;
  activeMode = mode;
  activeWorld.set(activeParamsEntity, PostProcessParams, {
    data: packModeBytes(mode, activeSplits),
  });
  return true;
}
