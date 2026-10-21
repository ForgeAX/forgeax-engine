import type { AssetHandle } from '@forgeax/engine-types';
// apps/learn-render/6.pbr/3.ibl-specular/src/index.ts
// LearnOpenGL section 6.2 IBL -- full split-sum (diffuse + specular).
//
// Demonstrates complete image-based lighting via split-sum approximation:
// diffuse irradiance convolution + specular prefilter mip chain + BRDF LUT.
// Same vendor newport_loft.hdr Skylight input + loadByGuid path as
// sibling 2.ibl-irradiance; see that file's header for the rationale.
//
// AC-06 three-section marker convention:
//   // 1. engine usage            -> public engine API consumed.
//   // 2. example-specific glue   -> demo constants and setup.
//   // 3. bootstrap               -> entry point that wires (1)+(2).

// 1. engine usage
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import type { App, CanvasAppError } from '@forgeax/engine-app';
import type { InputBackend } from '@forgeax/engine-input';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective, TONEMAP_REINHARD_EXTENDED } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { Materials, SKYBOX_MODE_CUBEMAP, SkyboxBackground, Skylight } from '@forgeax/engine-render';

import { createSphereGeometry } from '@forgeax/engine-geometry';


import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import {
  addFirstPersonSystem,
  createFirstPersonControls,
} from '../../../../shared/src/learn-render-first-person';
import {
  exposeLearnRenderTestApp,
  trackLearnRenderTestBootstrap,
} from '../../../../shared/src/learn-render-test-lifecycle';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';


// 2. example-specific glue

const GRID_COLS = 3;
const GRID_ROWS = 3;
const SPACING = 2.5;
const SPHERE_SCALE = 0.9;

const NEWPORT_LOFT_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';


const CAMERA_FOV = Math.PI / 3;
const CAMERA_POS_X = 0;
const CAMERA_POS_Y = 0;
const CAMERA_POS_Z = 8;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;


async function setupIblSkylight(
  app: App,
  world: World,
): Promise<AssetHandle<'equirect'> | null> {
const sceneAssets = world.assets;
if (!(sceneAssets instanceof AssetRegistry)) throw new Error('Scene requires its runtime asset owner');

  const assets = app.assets;
  if (assets === undefined) {
    console.error('[ibl-specular skylight] App asset owner is unavailable');
    return null;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  const guidRes = AssetGuid.parse(NEWPORT_LOFT_GUID);
  if (!guidRes.ok) {
    console.error(
      `[ibl-specular skylight] NEWPORT_LOFT_GUID parse failed: ${guidRes.error.code}`,
    );
    return null;
  }

  const hdrHandleRes = await assets.load(guidRes.value, 'equirect');
  if (!hdrHandleRes.ok) {
    console.error(
      `[ibl-specular skylight] load(newport_loft.hdr) failed: ${hdrHandleRes.error.code} hint=${hdrHandleRes.error.hint}`,
    );
    return null;
  }

  // loadByGuid returns the EquirectAsset PAYLOAD (D-17); mint a user-tier source
  // handle. The equirect->cubemap + prefilter + BRDF LUT (specular split-sum) is
  // now INTERNAL to the engine (lazy, in the render record arm) -- no manual
  // cubemap upload call; the Skylight holds the equirect handle directly.
  return hdrHandleRes.value;
}

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 6.pbr 3.ibl-specular] missing <canvas id='app'> in index.html");
}

trackLearnRenderTestBootstrap(bootstrap(canvas), canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const winExt = window as unknown as {
    __iblSpecularInputBackend?: () => InputBackend;
  };
  const overrideBackend = winExt.__iblSpecularInputBackend?.();

  const bundler = {
    ...forgeaxBundlerAdapter(),
    importTransport: createRuntimeAssetImportTransport(runtimeBinding),
  };
  const appRes: { ok: true; value: App } | { ok: false; error: CanvasAppError } =
    overrideBackend === undefined
      ? await createApp(target, {}, bundler)
      : await createFirstPersonControls(target, overrideBackend, bundler);
  if (!appRes.ok) {
    reportBootstrapError(appRes.error);
    return;
  }
  const app = appRes.value;
if (app.assets === undefined) throw new Error('This scene requires the App asset owner');

  exposeLearnRenderTestApp(app, target);
  const renderer = app.renderer;
  const world = app.world;

  app.onError((e) => {
    console.error('[learn-render 6.pbr 3.ibl-specular] app.onError:', e.code, e.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
  });

  const equirectHandle = await setupIblSkylight(app, world);
  if (equirectHandle !== null) {
    world.spawn({
      component: Skylight,
      data: { equirect: equirectHandle, intensity: 1.0 },
    });
    world.spawn({
      component: SkyboxBackground,
      data: { equirect: equirectHandle, mode: SKYBOX_MODE_CUBEMAP },
    });
    console.warn('[learn-render 6.pbr 3.ibl-specular] Skylight + SkyboxBackground active: IBL diffuse + specular split-sum with visible cubemap background');
  }

  const sphereRes = createSphereGeometry(1.0, 32, 16);
  if (!sphereRes.ok) {
    console.error('[learn-render 6.pbr 3.ibl-specular] createSphereGeometry failed:', sphereRes.error);
    return;
  }
  const sphereAssetHandle = app.assets.create(sphereRes.value).unwrap();

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const roughness = 0.1 + row * 0.4;
      const metallic = col * 0.5;

      const matHandle = app.assets.create(Materials.standard({
          baseColor: [0.5, 0.5, 0.5, 1],
          metallic,
          roughness,
        })).unwrap();

      const cx = (col - (GRID_COLS - 1) / 2) * SPACING;
      const cy = ((GRID_ROWS - 1) / 2 - row) * SPACING;

      world
        .spawn(
          {
            component: Transform,
            data: {
              pos: [cx, cy, 0], scale: [SPHERE_SCALE, SPHERE_SCALE, SPHERE_SCALE],},
          },
          { component: MeshFilter, data: { assetHandle: sphereAssetHandle } },
          { component: MeshRenderer, data: { materials: [matHandle] } },
        )
        .unwrap();
    }
  }

  const cameraAspect = target.width / target.height;
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [CAMERA_POS_X, CAMERA_POS_Y, CAMERA_POS_Z],},
    },
    {
      component: Camera,
      data: {
        ...perspective({
          fov: CAMERA_FOV,
          aspect: cameraAspect,
          near: CAMERA_NEAR,
          far: CAMERA_FAR,
        }),
        tonemap: TONEMAP_REINHARD_EXTENDED,
      },
    },
  ).unwrap();

  addFirstPersonSystem(world, {
    name: 'learn-render-ibl-specular-first-person',
    overrideBackend,
  });

  installCaptureHook(target, app, world);

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 6.pbr 3.ibl-specular] app.start failed:', startRes.error);
    return;
  }
  console.warn(`[learn-render 6.pbr 3.ibl-specular] backend=${renderer.inspect().capabilities.backendKind}`);
}

function installCaptureHook(
  _target: HTMLCanvasElement,
  app: App,
  world: World,
): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureIblSpecular?: CaptureHook };
  const renderer = app.renderer;
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  win.__captureIblSpecular = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const drawn = renderer.draw({
      leases: [lease],
      camera: { lease },
      environment: { lease },
    });
    if (!drawn.ok) throw drawn.error;
    const bitmap = await createImageBitmap(_target);
    const captureCanvas = new OffscreenCanvas(_target.width, _target.height);
    const captureContext = captureCanvas.getContext('2d');
    if (captureContext === null) throw new Error('[learn-render 6.pbr 3.ibl-specular] capture context missing');
    captureContext.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Uint8Array(captureContext.getImageData(0, 0, _target.width, _target.height).data);
  };
}

function reportBootstrapError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[learn-render 6.pbr 3.ibl-specular] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[learn-render 6.pbr 3.ibl-specular] ${err.code}: ${err.hint}`);
}

declare global {
  interface Window {
    __captureIblSpecular?: () => Promise<Uint8Array>;
    __iblSpecularInputBackend?: () => InputBackend;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
