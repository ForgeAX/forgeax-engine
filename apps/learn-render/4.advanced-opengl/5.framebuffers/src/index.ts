// apps/learn-render/4.advanced-opengl/5.framebuffers/src/index.ts
// LearnOpenGL section 4.5 — Framebuffers (offscreen render-to-texture +
// fullscreen post-process effects).
//
// Reproduces the LearnOpenGL "framebuffers" tutorial: render the scene into
// an offscreen color target, then re-sample that target through a fullscreen
// post-process pass into the swap-chain. Six effects are exposed (passthrough
// / inversion / grayscale / sharpen / blur / edge-detection); the user
// switches between them at runtime by pressing keys 1..6 (see T-11).
//
// Pipeline shape: the Standard renderer owns the scene and swap-chain graph;
// this example contributes one declarative fullscreen effect and changes its
// ECS-owned PostProcessParams payload when the user presses 1..6.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"   public engine API consumed
//   - "// 2. example glue"   6 fullscreen effects + installPipelineByKey
//   - "// 3. bootstrap"      entry point wiring (1)+(2) + keydown HUD

// 1. engine usage

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createFullscreenRenderFeature, type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';

import { Transform } from '@forgeax/engine-scene';

import { perspective } from '@forgeax/engine-render';

import type { RenderFeature } from '@forgeax/engine-render';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { PostProcessParams } from '@forgeax/engine-render';


import { ok } from '@forgeax/engine-types';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { replayCapturedFrameInBrowser } from '@forgeax/apps-shared/rhi-debug-browser-replay';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

// Six post-process WGSL effects, imported from ./shaders/*.wgsl. The
// vite-plugin-shader transforms each `*.wgsl` module into a `{hash, wgsl}`
// JS module (declared in src/vite-env.d.ts); the `.wgsl` field is the
// post-naga_oil composed source fed to the host-owned fullscreen feature.
import blurShader from './shaders/blur.wgsl';
import edgeShader from './shaders/edge-detection.wgsl';
import grayscaleShader from './shaders/grayscale.wgsl';
import inversionShader from './shaders/inversion.wgsl';
import passthroughShader from './shaders/passthrough.wgsl';
import sharpenShader from './shaders/sharpen.wgsl';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';



// Texture GUIDs from forgeax-engine-assets/learn-opengl/textures/*.meta.json.
const CONTAINER_GUID_STR = '019e3969-1d46-773e-988c-a10e305ff2a4';
const METAL_GUID_STR = '019e3969-1d47-760f-982e-7bad1ffd969c';

// Two cubes + one floor quad (the canonical LearnOpenGL 4.5 scene).
const CUBE1_POS: readonly [number, number, number] = [-1, 0, -1];
const CUBE2_POS: readonly [number, number, number] = [2, 0, 0];
const FLOOR_POS: readonly [number, number, number] = [0, -0.5, 0];
const FLOOR_SCALE: readonly [number, number, number] = [5, 5, 1];
// HANDLE_QUAD lies in the XY plane facing +Z; rotate -90deg around X so it
// faces +Y and becomes a horizontal floor (Y=-0.5). Quaternion form: axis=X,
// angle=-pi/2 -> (sin(-pi/4), 0, 0, cos(-pi/4)).
const FLOOR_QUAT_X: number = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W: number = Math.cos(-Math.PI / 4);

// Camera: (0,0,3) looking along -Z, fov 45deg, near 0.1, far 100.
const CAMERA_POS: readonly [number, number, number] = [0, 0, 3];
const CAMERA_FOV: number = Math.PI / 4;
const CAMERA_NEAR: number = 0.1;
const CAMERA_FAR: number = 100.0;

// 2. example glue

// Closed roster of effect keys: '1' .. '6'. The string keys mirror the
// keyboard digits the user presses; the tutorial chapter introduces effects
// in the documented order (passthrough first as the no-op baseline, then
// inversion / grayscale, then 3x3 kernel filters: sharpen / blur / edge).
type EffectKey = '1' | '2' | '3' | '4' | '5' | '6';

interface EffectSpec {
  readonly key: EffectKey;
  readonly id: string;
  readonly displayName: string;
  readonly source: string;
}

const EFFECTS: readonly EffectSpec[] = [
  {
    key: '1',
    id: 'learn-render-5::passthrough',
    displayName: 'passthrough',
    source: passthroughShader.wgsl,
  },
  {
    key: '2',
    id: 'learn-render-5::inversion',
    displayName: 'inversion',
    source: inversionShader.wgsl,
  },
  {
    key: '3',
    id: 'learn-render-5::grayscale',
    displayName: 'grayscale',
    source: grayscaleShader.wgsl,
  },
  {
    key: '4',
    id: 'learn-render-5::sharpen',
    displayName: 'sharpen',
    source: sharpenShader.wgsl,
  },
  { key: '5', id: 'learn-render-5::blur', displayName: 'blur', source: blurShader.wgsl },
  {
    key: '6',
    id: 'learn-render-5::edge-detection',
    displayName: 'edge-detection',
    source: edgeShader.wgsl,
  },
];

const FRAMEBUFFER_EFFECT_ID = 'learn-render-4-5::framebuffer-effect';
const FRAMEBUFFER_EFFECT_WGSL = `
struct Output { @builtin(position) position : vec4<f32>, @location(0) uv : vec2<f32>, };
struct Params { mode : f32, pad0 : f32, pad1 : f32, pad2 : f32, };
@vertex fn vs_main(@builtin(vertex_index) i : u32) -> Output {
  var x : f32 = -1.0; var y : f32 = -1.0;
  if (i == 1u) { x = 3.0; } if (i == 2u) { y = 3.0; }
  var out : Output; out.position = vec4<f32>(x, y, 0.0, 1.0);
  out.uv = vec2<f32>((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5); return out;
}
@group(1) @binding(0) var sourceTexture : texture_2d<f32>;
@group(1) @binding(1) var sourceSampler : sampler;
@group(1) @binding(2) var<uniform> params : Params;
@fragment fn fs_main(in : Output) -> @location(0) vec4<f32> {
  let uv = in.uv; let px = 1.0 / vec2<f32>(textureDimensions(sourceTexture));
  let center = textureSample(sourceTexture, sourceSampler, uv).rgb;
  let left = textureSample(sourceTexture, sourceSampler, uv - vec2<f32>(px.x, 0.0)).rgb;
  let right = textureSample(sourceTexture, sourceSampler, uv + vec2<f32>(px.x, 0.0)).rgb;
  let up = textureSample(sourceTexture, sourceSampler, uv + vec2<f32>(0.0, px.y)).rgb;
  let down = textureSample(sourceTexture, sourceSampler, uv - vec2<f32>(0.0, px.y)).rgb;
  if (params.mode < 0.5) { return vec4<f32>(center, 1.0); }
  if (params.mode < 1.5) { return vec4<f32>(1.0 - center, 1.0); }
  if (params.mode < 2.5) { let g = dot(center, vec3<f32>(0.299, 0.587, 0.114)); return vec4<f32>(vec3<f32>(g), 1.0); }
  if (params.mode < 3.5) { return vec4<f32>(center * 5.0 - (left + right + up + down), 1.0); }
  if (params.mode < 4.5) { return vec4<f32>((left + right + up + down + center) * 0.2, 1.0); }
  return vec4<f32>(abs(left + right + up + down - 4.0 * center), 1.0);
}
`;
const framebufferEffect = createFullscreenRenderFeature({
  identity: FRAMEBUFFER_EFFECT_ID,
  source: FRAMEBUFFER_EFFECT_WGSL,
  params: { byteSize: 16, defaultValue: new Uint8Array(16) },
});
type RecoveryMode = 'idle' | 'cycle' | 'repaired' | 'invalid-format';
let recoveryMode: RecoveryMode = 'idle';
const CYCLE_PIPELINE_ID = 'learn-render-5-pipeline::cycle';
const REPAIRED_PIPELINE_ID = 'learn-render-5-pipeline::repaired';
const INVALID_FORMAT_PIPELINE_ID = 'learn-render-5-pipeline::invalid-format';

interface FeatureFailureDiagnostic {
  readonly code: 'render-feature-stage-failed';
  readonly mode: 'cycle' | 'invalid-format';
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
}

interface PipelineRecoveryState {
  activePipelineId: string | null;
  cycleDiagnostic: FeatureFailureDiagnostic | null;
  invalidFormatDiagnostic: FeatureFailureDiagnostic | null;
  invalidFormatPreviousPipelineId: string | null;
  lastFrameStatus: 'healthy' | 'feature-failed' | null;
  frameEndCount: number;
  disposed: boolean;
}

const pipelineRecoveryState: PipelineRecoveryState = {
  activePipelineId: null,
  cycleDiagnostic: null,
  invalidFormatDiagnostic: null,
  invalidFormatPreviousPipelineId: null,
  lastFrameStatus: null,
  frameEndCount: 0,
  disposed: false,
};

// Recovery is a feature-stage probe, not a second Renderer/Pipeline API. A
// fault makes this feature fail during plan; the host isolates that feature,
// keeps the Standard scene/post graph last-known-good, and retries next frame
// after the consumer selects the repaired mode.
const recoveryFeature: RenderFeature<undefined> = {
  identity: 'learn-render-4-5::feature-recovery',
  extract: () => ok(undefined),
  plan: () => {
    if (recoveryMode === 'cycle' || recoveryMode === 'invalid-format') {
      throw new Error(`framebuffer recovery probe rejected ${recoveryMode} plan`);
    }
    return ok({ work: [] });
  },
};

function captureExpectedPipelineError(error: {
  readonly code: string;
  readonly hint: string;
  readonly expected?: unknown;
  readonly detail?: unknown;
}): boolean {
  if (recoveryMode !== 'cycle' && recoveryMode !== 'invalid-format') return false;
  const detail =
    error.detail !== null && typeof error.detail === 'object'
      ? (error.detail as { readonly cause?: unknown })
      : undefined;
  const cause =
    detail?.cause !== null && typeof detail?.cause === 'object'
      ? (detail.cause as { readonly code?: unknown })
      : undefined;
  const wrappedFeatureFailure =
    error.code === 'device-operation-failed' && cause?.code === 'render-feature-stage-failed';
  if (error.code !== 'render-feature-stage-failed' && !wrappedFeatureFailure) {
    return false;
  }
  const featureError = wrappedFeatureFailure ? detail?.cause : error;
  const featureErrorRecord =
    featureError !== null && typeof featureError === 'object'
      ? (featureError as {
          readonly expected?: unknown;
          readonly hint?: unknown;
          readonly detail?: unknown;
        })
      : undefined;
  const diagnostic: FeatureFailureDiagnostic = {
    code: 'render-feature-stage-failed',
    mode: recoveryMode,
    expected:
      typeof featureErrorRecord?.expected === 'string'
        ? featureErrorRecord.expected
        : typeof error.expected === 'string'
          ? error.expected
          : 'the recovery probe completes its declarative plan without an error',
    hint:
      typeof featureErrorRecord?.hint === 'string' ? featureErrorRecord.hint : error.hint,
    detail: featureErrorRecord?.detail ?? error.detail,
  };
  if (recoveryMode === 'cycle') {
    pipelineRecoveryState.cycleDiagnostic = diagnostic;
  } else {
    pipelineRecoveryState.invalidFormatDiagnostic = diagnostic;
    pipelineRecoveryState.activePipelineId = pipelineRecoveryState.invalidFormatPreviousPipelineId;
  }
  return true;
}

let activeWorldForEffects: import('@forgeax/engine-ecs').World | null = null;
let effectParamsEntity: EntityHandle | null = null;
let activeAppForRecovery: App | null = null;

type RecoveryInstallResult =
  | { ok: true }
  | { ok: false; error: { code: string; hint: string } };

function recoveryNotReady(): RecoveryInstallResult {
  return {
    ok: false,
    error: {
      code: 'pipelines-not-ready',
      hint: 'await app.start() resolves before installing recovery pipelines',
    },
  };
}

function installRecoveryMode(pipelineId: string, mode: RecoveryMode): RecoveryInstallResult {
  if (activeAppForRecovery === null) return recoveryNotReady();
  recoveryMode = mode;
  pipelineRecoveryState.activePipelineId = pipelineId;
  pipelineRecoveryState.lastFrameStatus = null;
  if (mode === 'cycle') pipelineRecoveryState.cycleDiagnostic = null;
  if (mode === 'invalid-format') pipelineRecoveryState.invalidFormatDiagnostic = null;
  return { ok: true };
}

export function installCyclePipeline(): RecoveryInstallResult {
  return installRecoveryMode(CYCLE_PIPELINE_ID, 'cycle');
}

export function installRepairedPipeline(): RecoveryInstallResult {
  return installRecoveryMode(REPAIRED_PIPELINE_ID, 'repaired');
}

export function installInvalidFormatPipeline(): RecoveryInstallResult {
  pipelineRecoveryState.invalidFormatPreviousPipelineId = pipelineRecoveryState.activePipelineId;
  pipelineRecoveryState.invalidFormatDiagnostic = null;
  return installRecoveryMode(INVALID_FORMAT_PIPELINE_ID, 'invalid-format');
}

export function pipelineRecoveryStateSnapshot(): PipelineRecoveryState {
  return {
    ...pipelineRecoveryState,
    cycleDiagnostic: pipelineRecoveryState.cycleDiagnostic === null
      ? null
      : { ...pipelineRecoveryState.cycleDiagnostic },
    invalidFormatDiagnostic: pipelineRecoveryState.invalidFormatDiagnostic === null
      ? null
      : { ...pipelineRecoveryState.invalidFormatDiagnostic },
  };
}

export function disposePipelineRecovery(): RecoveryInstallResult {
  if (pipelineRecoveryState.disposed) return { ok: true };
  const app = activeAppForRecovery;
  if (app === null) return recoveryNotReady();
  const stopResult = app.stop();
  if (!stopResult.ok && stopResult.error.code !== 'app-not-started') {
    return {
      ok: false,
      error: { code: stopResult.error.code, hint: stopResult.error.hint },
    };
  }
  recoveryMode = 'idle';
  activeAppForRecovery = null;
  pipelineRecoveryState.disposed = true;
  return { ok: true };
}

function transitionRecoveryApp(action: 'pause' | 'resume'): RecoveryInstallResult {
  const app = activeAppForRecovery;
  if (app === null) return recoveryNotReady();
  const result = action === 'pause' ? app.pause() : app.resume();
  if (!result.ok) {
    return { ok: false, error: { code: result.error.code, hint: result.error.hint } };
  }
  return { ok: true };
}

export function pausePipelineRecovery(): RecoveryInstallResult {
  return transitionRecoveryApp('pause');
}

export function resumePipelineRecovery(): RecoveryInstallResult {
  return transitionRecoveryApp('resume');
}

/**
 * Select one of the 6 fullscreen effects by its keyboard digit ('1' .. '6').
 * Returns a Result-shape (ok / err with a code) so callers (M5 smoke, T-11
 * keydown) check `.ok` per R-9. A call before bootstrap completes returns
 * `'pipelines-not-ready'`; an unknown key returns `'unknown-effect-key'`.
 *
 * Named export (plan-strategy D-5): M5 dawn smoke imports this directly to
 * drive effect switching without simulating keydown.
 */
export function installPipelineByKey(
  key: string,
): { ok: true } | { ok: false; error: { code: string; hint: string } } {
  if (activeWorldForEffects === null || effectParamsEntity === null) {
    return {
      ok: false,
      error: {
        code: 'pipelines-not-ready',
        hint: 'await app.start() resolves before selecting a framebuffer effect',
      },
    };
  }
  const effect = EFFECTS.find((entry) => entry.key === key);
  if (effect === undefined) {
    return {
      ok: false,
      error: {
        code: 'unknown-effect-key',
        hint: `expected one of '1'..'6'; received ${JSON.stringify(key)}`,
      },
    };
  }
  activeWorldForEffects.set(effectParamsEntity, PostProcessParams, {
    data: new Uint8Array(new Float32Array([Number(effect.key) - 1, 0, 0, 0]).buffer),
  });
  pipelineRecoveryState.activePipelineId = effect.id;
  return { ok: true };
}

/**
 * Public effect-name lookup mirror of installPipelineByKey: returns the
 * display name for HUD updates ('passthrough' / 'inversion' / ...). The HUD
 * keydown handler in section 3 reads this so the DOM text matches whatever
 * effect was just selected.
 */
export function effectDisplayNameByKey(key: string): string | null {
  for (const e of EFFECTS) if (e.key === key) return e.displayName;
  return null;
}

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 4.5 framebuffers] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {
      features: [framebufferEffect, recoveryFeature],
      ...(runtimeBinding === undefined ? {} : { assetRuntimeBinding: runtimeBinding }),
    },
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[learn-render 4.5 framebuffers] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
if (app.assets === undefined) throw new Error('This scene requires the App asset owner');

  const world = app.world;
const primitiveCube = app.assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

const primitiveQuad = app.assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

  app.onError((error) => {
    if (captureExpectedPipelineError(error)) return;
    console.error('[learn-render 4.5 framebuffers] app.onError:', error.code, error.hint);
    const bus = (
      globalThis as unknown as {
        __learnRenderErrors?: Array<{ code: string; hint?: string }>;
      }
    ).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 4.5 framebuffers] asset host unavailable');
    return;
  }

  // Bind the dev catalog and scoped import transport used by pluginPack.
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Parse + load the two textures (container.jpg for cubes, metal.png for
  // floor). Both routes return Result<...> -- explicit if (!.ok) checks per
  // R-9 (charter P3 fail-fast: every Result consumer reads .ok before .value).
  const containerGuidRes = AssetGuid.parse(CONTAINER_GUID_STR);
  if (!containerGuidRes.ok) {
    console.error(
      '[learn-render 4.5 framebuffers] container GUID parse failed:',
      containerGuidRes.error,
    );
    return;
  }
  const metalGuidRes = AssetGuid.parse(METAL_GUID_STR);
  if (!metalGuidRes.ok) {
    console.error(
      '[learn-render 4.5 framebuffers] metal GUID parse failed:',
      metalGuidRes.error,
    );
    return;
  }
  const containerHandleRes = await assets.load(containerGuidRes.value, 'texture');
  if (!containerHandleRes.ok) {
    console.error(
      '[learn-render 4.5 framebuffers] container loadByGuid failed:',
      containerHandleRes.error.code,
    );
    return;
  }
  const metalHandleRes = await assets.load(metalGuidRes.value, 'texture');
  if (!metalHandleRes.ok) {
    console.error(
      '[learn-render 4.5 framebuffers] metal loadByGuid failed:',
      metalHandleRes.error.code,
    );
    return;
  }
  // loadByGuid returns texture PAYLOADs (M8 D-17); mint user-tier column
  // handles for the baseColorTexture slots below.
  const containerTex = Number(containerHandleRes.value);
  const metalTex = Number(metalHandleRes.value);

  // Cube material: unlit container.jpg. The 4.5 chapter teaches off-screen
  // RT + post-process; the scene shading is intentionally trivial (unlit) so
  // the visual delta between effects is dominated by the post-process pass,
  // not by per-cube lighting.
  const cubeMatHandle = assets.create({
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' } } },
    ],
    values: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: containerTex,
    },
  }).unwrap();

  // Floor material: unlit metal.png. HANDLE_QUAD is a 1x1 quad with a
  // single-tile UV; the 5x5 scale stretches that one tile across the floor
  // (research F-A3 known-difference: unlit has no tiling/offset, so a single
  // wide-tile sample stands in for the LearnOpenGL 25x25 metal-texture floor
  // tiling -- the post-process effect demonstration is unaffected).
  const floorMatHandle = assets.create({
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' } } },
    ],
    values: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: metalTex,
    },
  }).unwrap();

  // Spawn cube #1 at (-1, 0, -1).
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [CUBE1_POS[0], CUBE1_POS[1], CUBE1_POS[2]]},
      },
      { component: MeshFilter, data: { assetHandle: primitiveCube } },
      { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
    )
    .unwrap();

  // Spawn cube #2 at (2, 0, 0).
  world
    .spawn(
      {
        component: Transform,
        data: { pos: [CUBE2_POS[0], CUBE2_POS[1], CUBE2_POS[2]]},
      },
      { component: MeshFilter, data: { assetHandle: primitiveCube } },
      { component: MeshRenderer, data: { materials: [cubeMatHandle] } },
    )
    .unwrap();

  // Spawn floor quad at (0, -0.5, 0), 5x5 in XZ (rotate -90deg around X).
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [FLOOR_POS[0], FLOOR_POS[1], FLOOR_POS[2]], quat: [FLOOR_QUAT_X, 0, 0, FLOOR_QUAT_W], scale: [FLOOR_SCALE[0], FLOOR_SCALE[1], FLOOR_SCALE[2]],},
      },
      { component: MeshFilter, data: { assetHandle: primitiveQuad } },
      { component: MeshRenderer, data: { materials: [floorMatHandle] } },
    )
    .unwrap();

  // Camera at (0, 0, 3) looking along -Z (default Transform identity orientation).
  const cameraEntity = world
    .spawn(
      {
        component: Transform,
        data: { pos: [CAMERA_POS[0], CAMERA_POS[1], CAMERA_POS[2]]},
      },
      {
        component: Camera,
        data: perspective({
          fov: CAMERA_FOV,
          aspect: target.width / target.height,
          near: CAMERA_NEAR,
          far: CAMERA_FAR,
        }),
      },
    )
    .unwrap();

  addFirstPersonSystem(app.world, {
    name: 'learn-render-4.5-first-person',
    overrideBackend: undefined,
  });

  const paramsEntity = world.spawn({
    component: PostProcessParams,
    data: { shader: FRAMEBUFFER_EFFECT_ID, data: new Uint8Array(16) },
  }).unwrap();
  activeWorldForEffects = world;
  effectParamsEntity = paramsEntity;
  activeAppForRecovery = app;

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 4.5 framebuffers] app.start failed:', startRes.error);
    return;
  }

  installCaptureHook(app, world, target);
  window.__learnRenderFramebuffers = {
    installCyclePipeline,
    installRepairedPipeline,
    installInvalidFormatPipeline,
    pause: pausePipelineRecovery,
    resume: resumePipelineRecovery,
    getState: pipelineRecoveryStateSnapshot,
    dispose: disposePipelineRecovery,
  };

  // Install effect 1 (passthrough) as the boot default. Subsequent presses of
  // keys 2..6 (handled in the keydown listener below) update the Standard
  // fullscreen effect via installPipelineByKey.
  const initialInstall = installPipelineByKey('1');
  if (!initialInstall.ok) {
    console.error(
      '[learn-render 4.5 framebuffers] initial installPipelineByKey(1) failed:',
      initialInstall.error,
    );
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  // Dev-mode keyboard handler: digits 1..6 hot-swap between the 6 effects.
  // Skipped under dawn-node smoke (no `window`/`document`); the smoke harness
  // calls `installPipelineByKey(...)` directly per plan-strategy D-5.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    let activeEffectKey: EffectKey = '1';
    const hudElement = document.getElementById('hud');
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      const key = event.key;
      // Repeat keys (already-installed effect): no-op idempotent guard.
      if (key === activeEffectKey) return;
      const installResult = installPipelineByKey(key);
      if (!installResult.ok) {
        // Non-1..6 key (or pre-bootstrap) — silently ignore; only the explicit
        // 1..6 codes are part of this demo's surface. Keys outside the closed
        // set are not errors here (avoids spamming console.error on every
        // arrow-key press).
        if (installResult.error.code === 'unknown-effect-key') return;
        console.error(
          '[learn-render 4.5 framebuffers] installPipelineByKey failed:',
          installResult.error,
        );
        return;
      }
      activeEffectKey = key as EffectKey;
      const displayName = effectDisplayNameByKey(key);
      if (hudElement !== null && displayName !== null) {
        hudElement.innerText = displayName;
      }
    });
  }

}

// RHI-debug live-pixel hook for the capture smoke harness (pixel mode). Drives
// one update + draw + readPixels so the live canvas read is anchored to the same
// frame the capture records. Only meaningful when the page is served with
// FORGEAX_ENGINE_RHI_DEBUG=1; harmless otherwise.
function installCaptureHook(app: App, world: App['world'], canvas: HTMLCanvasElement): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as {
    __captureFramebuffers?: CaptureHook;
    __replayFramebuffersCapture?: typeof replayCapturedFrameInBrowser;
  };
  const renderer = app.renderer;
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  win.__captureFramebuffers = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const frame = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!frame.ok) throw frame.error;
    pipelineRecoveryState.frameEndCount += 1;
    pipelineRecoveryState.lastFrameStatus =
      recoveryMode === 'cycle' || recoveryMode === 'invalid-format'
        ? 'feature-failed'
        : 'healthy';
    const observed = await renderer.observe(frame.value, { include: ['draws'] });
    if (!observed.ok) throw observed.error;
    const r = await captureCanvasPixels(canvas);
    if (!r.ok) {
      throw new Error(
        `[learn-render 4.5 framebuffers] canvas capture failed: ${r.error.code} -- ${r.error.hint ?? ''}`,
      );
    }
    return r.value;
  };
  // Keep pixel ownership in the same browser/WebGPU implementation. Dawn
  // replay remains mandatory diagnostic evidence, but software-GPU
  // rasterization can differ at sparse edge pixels from Chrome's surface.
  win.__replayFramebuffersCapture = replayCapturedFrameInBrowser;
}

declare global {
  interface Window {
    __captureFramebuffers?: () => Promise<Uint8Array>;
    __replayFramebuffersCapture?: typeof replayCapturedFrameInBrowser;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __learnRenderFramebuffers?: {
      installCyclePipeline: typeof installCyclePipeline;
      installRepairedPipeline: typeof installRepairedPipeline;
      installInvalidFormatPipeline: typeof installInvalidFormatPipeline;
      pause: typeof pausePipelineRecovery;
      resume: typeof resumePipelineRecovery;
      getState: typeof pipelineRecoveryStateSnapshot;
      dispose: typeof disposePipelineRecovery;
    };
  }
}
