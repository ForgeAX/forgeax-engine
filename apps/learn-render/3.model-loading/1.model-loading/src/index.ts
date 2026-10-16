// apps/learn-render/3.model-loading/1.model-loading/src/main.ts
// LearnOpenGL section 3.1 model-loading - Sponza atrium with multi-light +
// DirectionalLight + Skylight IBL. The whole gltf -> mesh / material /
// scene / texture asset graph flows through the build-time gltfImporter +
// vite-plugin-pack pipeline; the demo body stays at the 4-step idiom
// (charter P4 / requirements AC-17 / plan section 9.1):
//
//   (1) createApp({ canvas, ... }, { importTransport: createRuntimeAssetImportTransport(runtimeBinding) })
//   (2) configureRuntimeAssetCatalog(assets, runtimeBinding)
//   (3) const scene = await assets.loadByGuid<SceneAsset>(SPONZA_SCENE_GUID);
//       assets.instantiate<SceneAsset>(scene.value, world)
//   (4) app.start()
//
// No manual parseGltf, no walk-images-by-filename, no manual mesh / material /
// scene register loop. The gltfImporter (engine) handles all of that
// transparently: it parses the .gltf, extracts the texture bytes from the
// three image-source paths, decodes them via the ImportContext seam, and
// emits one ImportedAsset per declared sub-asset (103 meshes + 25 materials +
// 69 textures + 1 scene for Sponza). The dev path uses the shared runtime
// import transport, so a DDC miss for an unimported sub-asset GUID triggers an on-demand
// POST /__import import against the dev server.
//
// Lights / Skylight / camera / first-person controls remain example-specific
// glue: they are part of the LearnOpenGL teaching surface, not gltf wiring.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import type { App, CanvasAppError } from '@forgeax/engine-app';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Skylight } from '@forgeax/engine-render';
import { PointLight } from '@forgeax/engine-render';

import type { EquirectAsset, SceneAsset } from '@forgeax/engine-types';

import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

const SPONZA_SCENE_GUID = '019e4fe2-523b-7506-99e5-ccd39795ecda';
const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';


const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 3.1] missing <canvas id='app'> in index.html");
}

function resizeCanvas(c: HTMLCanvasElement): void {
  c.width = window.innerWidth * devicePixelRatio;
  c.height = window.innerHeight * devicePixelRatio;
}
resizeCanvas(canvas);

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step (1): createApp - explicitly inject the shared runtime transport so a
  // DDC miss on an unimported sub-asset GUID falls through to a dev-server
  // POST /__import (vite-plugin-pack's per-meta lock dedupes 122-way
  // concurrent loads down to a single gltfImporter pass per meta sidecar).
  const appRes = await createApp(
    target,
    import.meta.env.DEV && runtimeBinding !== undefined ? { assetRuntimeBinding: runtimeBinding } : {},
    // Host-explicit dev transport (OOS-1): a DDC miss for an unimported Sponza
    // texture triggers an on-demand POST /__import import against the dev server.
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    reportBootstrapError(appRes.error);
    return;
  }
  const app = appRes.value;
  const renderer = app.renderer;
  const world = app.world;

  app.onError((e) => {
    console.error('[learn-render 3.1] app.onError:', e.code, e.hint);
    const bus = (globalThis as unknown as {
      __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
  });

  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 3.1] asset owner unavailable');
    return;
  }

  // Step (2): configure the scoped dev or static build catalog.
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Step (3): loadByGuid<SceneAsset> + instantiate.
  // The gltfImporter has already produced the SceneAsset + every referenced
  // mesh / material / texture sub-asset POD; the runtime resolves the cross-
  // refs transparently when the scene instantiates.
  const sceneGuidRes = AssetGuid.parse(SPONZA_SCENE_GUID);
  if (!sceneGuidRes.ok) {
    console.error('[learn-render 3.1] SPONZA_SCENE_GUID parse failed:', sceneGuidRes.error);
    return;
  }
  const sceneRes = await assets.loadByGuid<SceneAsset>(sceneGuidRes.value);
  if (!sceneRes.ok) {
    console.error('[learn-render 3.1] loadByGuid<SceneAsset> failed:', sceneRes.error);
    const bus = (globalThis as unknown as {
      __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    }).__learnRenderErrors;
    if (bus !== undefined)
      bus.push({
        code: sceneRes.error.code,
        ...(sceneRes.error.hint !== undefined ? { hint: sceneRes.error.hint } : {}),
      });
    return;
  }
  // loadByGuid returns the payload (D-17); mint a user-tier column handle.
  const sceneHandle = world.allocSharedRef('SceneAsset', sceneRes.value);
  const instRes = assets.instantiate<SceneAsset>(sceneHandle, world);
  if (!instRes.ok) {
    const errAny = instRes.error as { code: string; hint?: string };
    console.error('[learn-render 3.1] scene instantiate failed:', errAny.code);
    const bus = (globalThis as unknown as {
      __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    }).__learnRenderErrors;
    if (bus !== undefined)
      bus.push({
        code: errAny.code,
        ...(errAny.hint !== undefined ? { hint: errAny.hint } : {}),
      });
    return;
  }

  // Lights / Skylight / camera / first-person controls (example-specific glue,
  // not gltf wiring -- this is the LearnOpenGL teaching surface).
  spawnLights(world);
  await spawnSkylight(app);
  const cameraEntity = spawnCamera(world);
  if (cameraEntity === undefined) return;

  addFirstPersonSystem(app.world, {
    name: 'sponza-first-person',
    overrideBackend: undefined,
    moveSpeed: 4.8,
  });

  // Step (4): app.start().
  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 3.1] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    resizeCanvas(target);
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn(`[learn-render 3.1] backend=${renderer.inspect().capabilities.backendKind} scene loaded via loadByGuid<SceneAsset>`);

  // Expose scene-ready hook for visual tests (M4 playwright visual sentinel).
  (window as unknown as Record<string, unknown>).__sponzaSceneReady = true;

  // createApp now auto-wires app.remote in dev mode (feat-20260629-inspector-two-layer-model M4).
  // The remote eval server exposes world/renderer/assets/rhiCapture (when
  // FORGEAX_ENGINE_RHI_DEBUG=1) as eval-scope roots — client.eval(script) replaces
  // the old Registry/wireDefaultInspectors/startConsoleServer manual assembly.
  // Per M5 w23: the manual console wiring block is deleted; the eval channel
  // is zero-cost present through app.remote.
  if (app.remote) {
    console.warn(`[learn-render 3.1] remote eval on ws://localhost:${app.remote.port}/inspector`);
  }
}

// === Lights + Skylight + Camera ===========================================

function spawnLights(world: World): void {
  // DirectionalLight with merged shadow fields (warm sun, plan D-7).
  const d: [number, number, number] = [-0.3, -1.0, -0.3];
  const invLen = 1 / Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  world.spawn(
    {
      component: DirectionalLight,
      data: {
        direction: [d[0] * invLen, d[1] * invLen, d[2] * invLen],
        color: [1.0, 0.95, 0.85],
        intensity: 3.0,
        mapSize: 1024,
        // feat-20260613-csm M6 / w23: explicit 4-cascade Sponza baseline.
        // cascadeCount=4 + splitLambda=0.75 + cascadeBlend=0.2 are the
        // component defaults; declared explicitly here so the demo source
        // documents the CSM regime AI users should compare against.
        cascadeCount: 4,
        splitLambda: 0.75,
        cascadeBlend: 0.2,
        // Scaled by 0.008 to match Sponza root scale (was cm-space
        // 4500/2200; world-space after gltf root transform applies).
        shadowDistance: 36,
        depthBias: 0.00001,
      },
    },
  );

  // 4 PointLight (plan D-8): warm-yellow, cool-cyan, magenta, neutral-white.
  // Light positions and intensities scaled by Sponza's 0.008 root scale
  // (range ~ length * scale; intensity ~ scale^2 for inverse-square fall-off
  // to keep mid-room luminance equivalent).
  const pointDefs: Array<{
    pos: [number, number, number];
    color: [number, number, number];
    intensity: number;
    range: number;
  }> = [
    { pos: [-6.4, 1.6, 0], color: [1.0, 0.85, 0.5], intensity: 32, range: 20 },
    { pos: [6.4, 1.6, 0], color: [0.4, 0.85, 1.0], intensity: 32, range: 20 },
    { pos: [0, 1.6, -3.2], color: [0.95, 0.4, 0.85], intensity: 32, range: 20 },
    { pos: [0, 1.6, 3.2], color: [1.0, 1.0, 1.0], intensity: 32, range: 20 },
  ];
  for (const pd of pointDefs) {
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [pd.pos[0], pd.pos[1], pd.pos[2]], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
      },
      {
        component: PointLight,
        data: {
          color: [pd.color[0], pd.color[1], pd.color[2]],
          intensity: pd.intensity,
          range: pd.range,
        },
      },
    );
  }
}

async function spawnSkylight(app: App): Promise<void> {
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 3.1] skylight asset owner unavailable');
    return;
  }

  const guidRes = AssetGuid.parse(NEWPORT_LOFT_GUID);
  if (!guidRes.ok) {
    console.error('[learn-render 3.1] NEWPORT_LOFT_GUID parse failed:', guidRes.error);
    return;
  }

  const hdrHandleRes = await assets.loadByGuid<EquirectAsset>(guidRes.value);
  if (!hdrHandleRes.ok) {
    console.error(
      `[learn-render 3.1] loadByGuid(newport_loft.hdr) failed: ${hdrHandleRes.error.code}`,
    );
    const bus = (globalThis as unknown as {
      __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    }).__learnRenderErrors;
    if (bus !== undefined)
      bus.push({
        code: hdrHandleRes.error.code,
        ...(hdrHandleRes.error.hint !== undefined ? { hint: hdrHandleRes.error.hint } : {}),
      });
    return;
  }

  // loadByGuid returns the EquirectAsset PAYLOAD (D-17); mint a user-tier source
  // handle. The equirect->cubemap + IBL (diffuse + specular split-sum) is now
  // INTERNAL to the engine (lazy, in the render record arm) -- no manual
  // cubemap upload call; the Skylight holds the equirect handle.
  const equirect = app.world.allocSharedRef('EquirectAsset', hdrHandleRes.value);

  app.world.spawn({
    component: Skylight,
    data: { equirect, intensity: 1.0 },
  });
  console.warn('[learn-render 3.1] Skylight active: IBL diffuse + specular split-sum');
}

function spawnCamera(world: World): import('@forgeax/engine-ecs').EntityHandle | undefined {
  const aspect = window.innerWidth / window.innerHeight;
  // Sponza root carries scale=0.008 in its glTF; the gltfImporter now
  // correctly applies that transform, so the world-space size is ~40x28
  // (down from 5000-cm raw). Camera distances scale accordingly: the
  // earlier (pre-feat-20260608-#316) demo path manually registered
  // assets and silently dropped the root TRS, leaving Sponza in cm.
  // Start at the -X end of the nave (long axis = X) looking +X toward the
  // lion-head wall; first-person controls derive their yaw from this pose.
  const res = world.spawn(
    {
      component: Transform,
      data: {
        pos: [-11, 1.6, -0.4], quat: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], scale: [1, 1, 1],},
    },
    {
      component: Camera,
      data: {
        fov: Math.PI / 3,
        aspect,
        near: 0.08,
        far: 120,
      },
    },
  );
  if (!res.ok) {
    console.error('[learn-render 3.1] spawnCamera failed:', res.error);
    return undefined;
  }
  return res.value;
}

function reportBootstrapError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 3.1] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 3.1] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __sponzaSceneReady?: boolean;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
