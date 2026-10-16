// apps/learn-render/5.advanced-lighting/4.normal-mapping/src/index.ts
// LearnOpenGL section 5.4 - Normal Mapping.
// Side-by-side tangent-space normal and height-map bump lighting.
//
// Textures loaded through GUID asset pipeline:
//   configureRuntimeAssetCatalog(...) + loadByGuid<TextureAsset>.
//
// Both panels use the engine's Standard material authoring surface.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 5.4 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';

import { PointLight } from '@forgeax/engine-render';

import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';

// 2. example glue



// Texture GUIDs from forgeax-engine-assets/learn-opengl/textures/*.meta.json
const BRICKWALL_GUID_STR = '019e3969-1d45-744f-8269-e1b1c6e6a8cf';
const BRICKWALL_NORMAL_GUID_STR = '019e3969-1d45-7020-8756-675a0f885532';
const BRICKWALL_HEIGHT_GUID_STR = '019e3969-1d45-7d3e-9bc8-55fcdc87beab';
const NORMAL_SCALE = [2, 0.35] as const;
// LearnOpenGL's bricks2_disp is a depth map (inverse height): the mortar is
// bright/deep and the bricks are dark/shallow. A negative scale converts its
// gradient to height for bump lighting and keeps relief visible at this distance.
const BUMP_SCALE = -6;

// Point light position, lifted toward the camera to reveal surface shading.
const LIGHT_POS_X = 0.5;
const LIGHT_POS_Y = 1.0;
const LIGHT_POS_Z = 1.2;

// Camera centered on both comparison panels, Zoom=45 deg.
const CAMERA_POS_Z = 3.4;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.4 normal-mapping] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    // Bind the dev Catalog during App assembly. Installing it only after
    // createApp would let startup probe the deliberately disabled global route.
    import.meta.env.DEV && runtimeBinding !== undefined
      ? { assetRuntimeBinding: runtimeBinding }
      : {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.4 normal-mapping] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 5.4 normal-mapping] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 5.4 normal-mapping] asset owner is unavailable');
    return;
  }

  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Parse texture GUIDs.
  const brickwallGuidRes = AssetGuid.parse(BRICKWALL_GUID_STR);
  const brickwallNormalGuidRes = AssetGuid.parse(BRICKWALL_NORMAL_GUID_STR);
  const brickwallHeightGuidRes = AssetGuid.parse(BRICKWALL_HEIGHT_GUID_STR);
  if (!brickwallGuidRes.ok || !brickwallNormalGuidRes.ok || !brickwallHeightGuidRes.ok) {
    console.error('[learn-render 5.4 normal-mapping] GUID parse failed');
    return;
  }

  // Load textures through the GUID asset pipeline.
  const baseColorRes = await assets.loadByGuid<TextureAsset>(brickwallGuidRes.value);
  const normalRes = await assets.loadByGuid<TextureAsset>(brickwallNormalGuidRes.value);
  const heightRes = await assets.loadByGuid<TextureAsset>(brickwallHeightGuidRes.value);
  if (!baseColorRes.ok || !normalRes.ok || !heightRes.ok) {
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) {
      if (!baseColorRes.ok) bus.push({ code: baseColorRes.error.code, hint: baseColorRes.error.hint });
      if (!normalRes.ok) bus.push({ code: normalRes.error.code, hint: normalRes.error.hint });
      if (!heightRes.ok) bus.push({ code: heightRes.error.code, hint: heightRes.error.hint });
    }
    console.error(
      '[learn-render 5.4 normal-mapping] loadByGuid failed:',
      baseColorRes.ok ? null : baseColorRes.error.code,
      normalRes.ok ? null : normalRes.error.code,
      heightRes.ok ? null : heightRes.error.code,
    );
    return;
  }
  const baseColorTex = baseColorRes.value;
  const normalTex = normalRes.value;
  const heightTex = heightRes.value;

  const baseColorTexture = unwrapHandle(world.allocSharedRef('TextureAsset', baseColorTex));
  const normalTexture = unwrapHandle(world.allocSharedRef('TextureAsset', normalTex));
  const bumpTexture = unwrapHandle(world.allocSharedRef('TextureAsset', heightTex));
  const normalMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1.0, 1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.8,
      baseColorTexture,
      normalTexture,
      normalScale: NORMAL_SCALE,
    }),
  );
  const bumpMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1.0, 1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.8,
      baseColorTexture,
      bumpTexture,
      bumpScale: BUMP_SCALE,
    }),
  );

  // HANDLE_QUAD faces +Z. Equal geometry/albedo keeps the normal input
  // (left) and height-gradient input (right) as the only material difference.
  world.spawn(
    { component: Transform, data: { pos: [-0.68, 0, 0], scale: [1.2, 1.2, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [normalMat] } },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0.68, 0, 0], scale: [1.2, 1.2, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [bumpMat] } },
  ).unwrap();

  // Off-axis light makes changes to the surface normal visible.
  world.spawn(
    {
      component: Transform,
      data: { pos: [LIGHT_POS_X, LIGHT_POS_Y, LIGHT_POS_Z]},
    },
    { component: PointLight, data: { intensity: 8, range: 10 } },
  );

  // Camera at (0, 0, 3.4), Zoom=45 deg. First-person system drives
  // WASD/mouse/scroll on top of this spawn.
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
    name: 'learn-render-5.4-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.4 normal-mapping] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn('[learn-render 5.4 normal-mapping] Standard pipeline active');

  installCaptureHook(target);
}

// Read back the presented frame without advancing simulation during RHI capture.
function installCaptureHook(target: HTMLCanvasElement): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureNormalMapping?: CaptureHook };
  win.__captureNormalMapping = async (): Promise<Uint8Array> => {
    const r = await captureCanvasPixels(target);
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.4 normal-mapping] canvas capture failed: ${r.error.code} -- ${r.error.hint}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureNormalMapping?: () => Promise<Uint8Array>;
  }
}
