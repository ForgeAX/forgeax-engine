// apps/learn-render/5.advanced-lighting/5.parallax-mapping/src/index.ts
// LearnOpenGL section 5.5 - Parallax Mapping (basic / steep / POM).
//
// One custom material shader (parallax.wgsl) carries all three LO 5.5
// algorithms; the active path + height scale + texture set are switched at
// runtime through managed World parameters and material bindings, without
// recompiling the shader.
//
// The manifest's cooked material record derives the material bind group from
// the shader's declared texture fields, including the height-map slot.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 5.5 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { createPlaneGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';

import type { MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { replayCapturedFrameInBrowser } from '@forgeax/apps-shared/rhi-debug-browser-replay';

import './parallax.wgsl';

const PARALLAX_SHADER_ID = 'learn_render::5_5_parallax' as const;

// 2. example glue



// Texture GUIDs (forgeax-engine-assets/learn-opengl/textures/*.meta.json).
// Each set is diffuse + normal + displacement(height). depth/disp maps are
// linear-colorspace data textures.
const TEXTURE_SETS = {
  bricks2: {
    label: 'bricks2',
    diffuse: '019e3969-1d45-744f-8269-e1b1c6e6a8cf',
    normal: '019e3969-1d45-7020-8756-675a0f885532',
    height: '019e3969-1d45-7d3e-9bc8-55fcdc87beab',
  },
  toyBox: {
    label: 'toy_box',
    diffuse: '019e3969-1d47-7920-8f00-3d458255d479',
    normal: '019e3969-1d48-77f0-9acb-b5fecfc42a7a',
    height: '019e3969-1d48-7458-aa6b-0e2f42cc46aa',
  },
} as const;

const ALGO_LABELS = ['basic', 'steep', 'parallax-occlusion'] as const;

// Camera: (0, 0, 3), FOV=45 deg (LO 5.5). The quad faces +Z toward the camera;
// WASD/mouse (first-person system) lets the user reach grazing angles where
// the parallax depth cue is strongest.
const CAMERA_POS_Z = 3;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// heightScale tuning bounds (LO 5.5 default 0.1).
const HEIGHT_SCALE_DEFAULT = 0.1;
const HEIGHT_SCALE_STEP = 0.02;
const HEIGHT_SCALE_MIN = 0.0;
const HEIGHT_SCALE_MAX = 0.5;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.5 parallax-mapping] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    import.meta.env.DEV && runtimeBinding !== undefined ? { assetRuntimeBinding: runtimeBinding } : {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.5 parallax-mapping] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 5.5 parallax-mapping] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 5.5 parallax-mapping] asset owner is unavailable');
    return;
  }

  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Prepare both sets once; key events only edit the current material.
  const loadSet = async (
    set: (typeof TEXTURE_SETS)[keyof typeof TEXTURE_SETS],
  ): Promise<{ diffuse: number; normal: number; height: number } | null> => {
    const loaded = await Promise.all(
      [set.diffuse, set.normal, set.height].map((guid) => assets.load(guid, 'texture')),
    );
    for (const result of loaded) {
      if (!result.ok) {
        console.error(`[learn-render 5.5 parallax-mapping] texture load failed for ${set.label}`, result.error);
        return null;
      }
    }
    const [diffuse, normal, height] = loaded.map((result) => result.unwrap());
    if (diffuse === undefined || normal === undefined || height === undefined) return null;
    return { diffuse, normal, height };
  };

  const bricksHandles = await loadSet(TEXTURE_SETS.bricks2);
  const toyBoxHandles = await loadSet(TEXTURE_SETS.toyBox);
  if (bricksHandles === null || toyBoxHandles === null) return;

  const mat = assets.create<MaterialAsset>({
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: PARALLAX_SHADER_ID }, renderState: { tags: { LightMode: 'Forward' } } }],
    values: {
      baseColor: [1, 1, 1, 1], heightScale: HEIGHT_SCALE_DEFAULT, algoMode: 0,
      baseColorTexture: bricksHandles.diffuse, normalTexture: bricksHandles.normal, heightTexture: bricksHandles.height,
    },
  }).unwrap();
  const quad = assets.create(createPlaneGeometry(1, 1).unwrap()).unwrap();

  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0]} },
    { component: MeshFilter, data: { assetHandle: quad } },
    { component: MeshRenderer, data: { materials: [mat] } },
  ).unwrap();

  const cameraEntity = world.spawn(
    { component: Transform, data: { pos: [0, 0, CAMERA_POS_Z]} },
    {
      component: Camera,
      data: perspective({
        fov: CAMERA_FOV,
        aspect: target.width / target.height,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
      }),
    },
  ).unwrap();

  addFirstPersonSystem(app.world, {
    name: 'learn-render-5.5-first-person',
    overrideBackend: undefined,
  });

  // HUD + keyboard switching. algoMode/heightScale/texture-set are discrete
  // events: publish parameters or rebind the material for the next frame.
  const hud = document.querySelector<HTMLPreElement>('#hud');
  let activeSet: 'bricks2' | 'toyBox' = 'bricks2';
  const renderHud = (): void => {
    if (hud === null) return;
    const values = assets.read(mat).unwrap().values;
    const algo = ALGO_LABELS[Math.round(Number(values?.algoMode ?? 0))] ?? '?';
    const setLabel = activeSet === 'bricks2' ? 'bricks2' : 'toy_box';
    hud.textContent = [
      'LearnOpenGL 5.5 — Parallax Mapping',
      `algorithm : ${algo}   [1 basic] [2 steep] [3 POM]`,
      `heightScale: ${Number(values?.heightScale ?? HEIGHT_SCALE_DEFAULT).toFixed(2)}   [-]/[=] adjust`,
      `texture   : ${setLabel}   [T] toggle`,
      'camera    : WASD + mouse drag, scroll = zoom',
    ].join('\n');
  };
  renderHud();

  window.addEventListener('keydown', (ev) => {
    const values = assets.read(mat).unwrap().values;
    switch (ev.key) {
      case '1':
        assets.update(mat, { values: { algoMode: 0 } }).unwrap();
        break;
      case '2':
        assets.update(mat, { values: { algoMode: 1 } }).unwrap();
        break;
      case '3':
        assets.update(mat, { values: { algoMode: 2 } }).unwrap();
        break;
      case '-':
      case '_':
        assets.update(mat, { values: { heightScale: Math.max(
          HEIGHT_SCALE_MIN,
          Number(values?.heightScale ?? HEIGHT_SCALE_DEFAULT) - HEIGHT_SCALE_STEP,
        ) } }).unwrap();
        break;
      case '=':
      case '+':
        assets.update(mat, { values: { heightScale: Math.min(
          HEIGHT_SCALE_MAX,
          Number(values?.heightScale ?? HEIGHT_SCALE_DEFAULT) + HEIGHT_SCALE_STEP,
        ) } }).unwrap();
        break;
      case 't':
      case 'T': {
        activeSet = activeSet === 'bricks2' ? 'toyBox' : 'bricks2';
        const textures = activeSet === 'bricks2' ? bricksHandles : toyBoxHandles;
        assets.update(mat, { values: {
          baseColorTexture: textures.diffuse,
          normalTexture: textures.normal,
          heightTexture: textures.height,
        } }).unwrap();
        break;
      }
      default:
        return;
    }
    renderHud();
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.5 parallax-mapping] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn('[learn-render 5.5 parallax-mapping] Standard pipeline active');

  installCaptureHook(target, world);
}

// Canvas capture hook for the capture smoke harness (pixel mode). Advances the
// World before reading the Host-owned presentation surface.
function installCaptureHook(target: HTMLCanvasElement, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureParallaxMapping?: CaptureHook; __replayParallaxMappingCapture?: typeof replayCapturedFrameInBrowser };
  win.__replayParallaxMappingCapture = replayCapturedFrameInBrowser;
  win.__captureParallaxMapping = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const r = await captureCanvasPixels(target);
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.5 parallax-mapping] canvas capture failed: ${r.error.code} -- ${r.error.hint}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureParallaxMapping?: () => Promise<Uint8Array>;
  }
}
