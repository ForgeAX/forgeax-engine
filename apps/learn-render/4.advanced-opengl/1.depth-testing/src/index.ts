// apps/learn-render/4.advanced-opengl/1.depth-testing/src/index.ts
// LearnOpenGL section 4.1 - Depth Testing (pixel-level replica).
//
// Two rendering paths, toggled by the USE_DEPTH_VIZ constant:
//   (A) Normal path: metal.png floor + two marble.jpg cubes with PBR
//       shading. Camera at (0,0,3), Zoom=45 deg, near=0.1 far=100.
//       The scene matches LO 4.1 exactly -- floor Y=-0.5, 10x10 quad;
//       cube 1 at (-1,0,-1), cube 2 at (2,0,0).
//   (B) Depth-viz path: same geometry, but all entities use a custom
//       depth-viz material shader that outputs linearizeDepth(depth) as
//       grayscale (near=dark, far=light). The shader uses
//       @builtin(position).z to read
//       the fragment's clip-space depth.
//
// Textures are loaded through the scoped GUID asset pipeline:
//   configureRuntimeAssetCatalog(assets, runtimeBinding) + assets.load(guid, 'texture').
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 4.1 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import type { App } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';

import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';




import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

// 2. example glue

import './depth-viz.wgsl';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const DEPTH_VIZ_SHADER_ID = 'learn_render::depth_viz';

// Toggle: set to true to render depth visualization (grayscale near=dark
// far=light). When false, the scene renders with PBR textured materials.
const USE_DEPTH_VIZ = false;

// Texture GUIDs from forgeax-engine-assets/learn-opengl/textures/*.meta.json
const METAL_GUID_STR = '019e3969-1d47-760f-982e-7bad1ffd969c';
const MARBLE_GUID_STR = '019e3969-1d46-7933-b14d-4faee5635ad6';

// Scene geometry: LO 4.1 exact parameters.
// Floor: Y=-0.5, XZ 10x10 quad (HANDLE_QUAD is 1x1 in XY, scaled 5x in XY
// then rotated -90 deg around X to lie flat on XZ plane). The texcoords
// remain [0,1], so the metal.png texture tiles once across the 5x5 surface
// (mirrors LO 10x10 floor with texcoord=2.0 REPEAT tiling frequency).
const FLOOR_Y = -0.5;
const FLOOR_SCALE = 5;
const SIN_NEG_90 = Math.sin(-Math.PI / 4); // quaternion X component for -90 deg
const COS_NEG_90 = Math.cos(-Math.PI / 4); // quaternion W component for -90 deg

// Cube world positions (LO 4.1 verbatim).
const CUBE1_POS = [-1.0, 0.0, -1.0] as const;
const CUBE2_POS = [2.0, 0.0, 0.0] as const;

// Camera: (0,0,3), Zoom=45 deg, near=0.1, far=100.0, aspect=1 (512x512 canvas).
const CAMERA_POS_Z = 3;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// Light direction pointing down-left-forward.
const LIGHT_DIR_X = -0.5;
const LIGHT_DIR_Y = -1.0;
const LIGHT_DIR_Z = -0.3;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 4.1 depth-testing] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[learn-render 4.1 depth-testing] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
if (app.assets === undefined) throw new Error('This scene requires the App asset owner');

  const world = app.world;
const primitiveQuad = app.assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();

const primitiveCube = app.assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

  app.onError((error) => {
    console.error('[learn-render 4.1 depth-testing] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 4.1 depth-testing] asset owner is unavailable');
    return;
  }

  // Wire the scoped dev catalog for GUID-based texture loading.
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Parse texture GUIDs.
  const metalGuidRes = AssetGuid.parse(METAL_GUID_STR);
  const marbleGuidRes = AssetGuid.parse(MARBLE_GUID_STR);
  if (!metalGuidRes.ok || !marbleGuidRes.ok) {
    console.error('[learn-render 4.1 depth-testing] GUID parse failed');
    return;
  }

  // Load textures through the GUID asset pipeline.
  const metalHandleRes = await assets.load(metalGuidRes.value, 'texture');
  const marbleHandleRes = await assets.load(marbleGuidRes.value, 'texture');
  if (!metalHandleRes.ok || !marbleHandleRes.ok) {
    console.error(
      '[learn-render 4.1 depth-testing] load failed:',
      metalHandleRes.ok ? null : metalHandleRes.error.code,
      marbleHandleRes.ok ? null : marbleHandleRes.error.code,
    );
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) {
      if (!metalHandleRes.ok) bus.push({ code: metalHandleRes.error.code, hint: metalHandleRes.error.hint });
      if (!marbleHandleRes.ok) bus.push({ code: marbleHandleRes.error.code, hint: marbleHandleRes.error.hint });
    }
    return;
  }
  const metalTex = Number(metalHandleRes.value);
  const marbleTex = Number(marbleHandleRes.value);

  // Create materials. When USE_DEPTH_VIZ is true, all entities share the
  // depth-viz shader material (single grayscale output). When false, PBR
  // materials with LO textures are used.
  let floorMat;
  let cubeMat;
  if (USE_DEPTH_VIZ) {
    const vizMat = assets.create({
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: DEPTH_VIZ_SHADER_ID }, renderState: { tags: { LightMode: 'Forward' } } },
      ],
      values: {
        baseColor: [1.0, 1.0, 1.0, 1.0],
        metallic: 0.0,
        roughness: 1.0,
      },
    }).unwrap();
    floorMat = vizMat;
    cubeMat = vizMat;
  } else {
    // Normal path: PBR materials with LO textures (raw MaterialAsset POJO
    // because Materials.standard factory does not expose baseColorTexture).
    const metalFloorMat = assets.create({
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' } } },
      ],
      values: {
        baseColor: [1.0, 1.0, 1.0, 1.0],
        metallic: 0.0,
        roughness: 0.9,
        baseColorTexture: metalTex,
      },
    }).unwrap();
    const marbleCubeMat = assets.create({
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { tags: { LightMode: 'Forward' } } },
      ],
      values: {
        baseColor: [1.0, 1.0, 1.0, 1.0],
        metallic: 0.0,
        roughness: 0.5,
        baseColorTexture: marbleTex,
      },
    }).unwrap();
    floorMat = metalFloorMat;
    cubeMat = marbleCubeMat;
  }

  // Spawn floor: HANDLE_QUAD is 1x1 in XY plane, rotated -90 deg around X
  // to lie flat (XZ plane, normal +Y), scaled 5x5, positioned at Y=-0.5.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, FLOOR_Y, 0], quat: [SIN_NEG_90, 0, 0, COS_NEG_90], scale: [FLOOR_SCALE, FLOOR_SCALE, FLOOR_SCALE],},
    },
    { component: MeshFilter, data: { assetHandle: primitiveQuad } },
    { component: MeshRenderer, data: { materials: [floorMat] } },
  ).unwrap();

  // Spawn cube 1 at (-1, 0, -1).
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [CUBE1_POS[0], CUBE1_POS[1], CUBE1_POS[2]],},
    },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
  ).unwrap();

  // Spawn cube 2 at (2, 0, 0).
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [CUBE2_POS[0], CUBE2_POS[1], CUBE2_POS[2]],},
    },
    { component: MeshFilter, data: { assetHandle: primitiveCube } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
  ).unwrap();

  // Directional light.
  world.spawn({
    component: DirectionalLight,
    data: { castShadow: true,
      direction: [LIGHT_DIR_X, LIGHT_DIR_Y, LIGHT_DIR_Z],
      color: [1.0, 1.0, 1.0],
      intensity: 1.0,
    },
  });

  // Camera at (0, 0, 3), Zoom=45 deg. First-person system drives
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
    name: 'learn-render-4.1-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 4.1 depth-testing] app.start failed:', startRes.error);
    return;
  }

  installCaptureHook(target, world);

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  const modeLabel = USE_DEPTH_VIZ ? 'depth-viz' : 'normal';
  console.warn(`[learn-render 4.1 depth-testing] Standard pipeline active mode=${modeLabel}`);
}

// Canvas capture hook for the capture smoke harness (pixel mode). Advances the
// World before reading the Host-owned presentation surface.
function installCaptureHook(target: HTMLCanvasElement, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureDepthTesting?: CaptureHook };
  win.__captureDepthTesting = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const r = await captureCanvasPixels(target);
    if (!r.ok) {
      throw new Error(
        `[learn-render 4.1 depth-testing] canvas capture failed: ${r.error.code} -- ${r.error.hint}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __captureDepthTesting?: () => Promise<Uint8Array>;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
