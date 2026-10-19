// apps/learn-render/4.advanced-opengl/3.blending/src/index.ts
// LearnOpenGL section 4.3 - Blending (pixel-level replica).
//
// Scene geometry mirrors LO 4.1/4.2 shared scene + LO 4.3 specific:
//   (A) Floor: metal.png at Y=-0.5, 5x5 quad, PBR material.
//   (B) Cube: one marble.jpg cube at (0,0.5,0), PBR material.
//   (C) Grass: 5 grass.png discard quads at LO 4.3 exact positions,
//       alpha-test shader (alpha < 0.1 discard), RenderQueue.Transparent.
//   (D) Windows: 5 window.png semi-transparent quads at the same 5 positions,
//       blend SRC_ALPHA/ONE_MINUS_SRC_ALPHA, depthWriteEnabled=false,
//       RenderQueue.Transparent, presorted back-to-front via
//       TRANSPARENT_SORT_MODE_DISTANCE (mode=3) per-frame distance sort.
//
// Grass/window textures use clamp-to-edge addressMode (set in meta sidecar,
// w20) to prevent bilinear edge artifacts on RGBA transparent borders.
//
// Textures are loaded through the GUID asset pipeline:
//   configureRuntimeAssetCatalog(...) + loadByGuid<TextureAsset>.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 4.3 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_CUBE, HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';

import { TransparentSort } from '@forgeax/engine-render/authoring';

import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { RenderQueue, unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

// 2. example glue

import './alpha-test.wgsl';

const ALPHA_TEST_SHADER_ID = 'learn_render::alpha_test';

type LearnRenderErrorRecord = {
  readonly code: string;
  readonly hint?: string;
  readonly detail?: unknown;
};


// Texture GUIDs from forgeax-engine-assets/learn-opengl/textures/*.meta.json
const METAL_GUID_STR = '019e3969-1d47-760f-982e-7bad1ffd969c';
const MARBLE_GUID_STR = '019e3969-1d46-7933-b14d-4faee5635ad6';
const GRASS_GUID_STR = '019e3969-1d46-73fe-af59-5ce69389b7bb';
const WINDOW_GUID_STR = '019e3969-1d48-75c7-81de-822f424ec949';

// Scene geometry: LO 4.1 shared parameters.
const FLOOR_Y = -0.5;
const FLOOR_SCALE = 5;
const SIN_NEG_90 = Math.sin(-Math.PI / 4);
const COS_NEG_90 = Math.cos(-Math.PI / 4);

// Single marble cube at (0, 0.5, 0) -- LO 4.3 has one cube.
const CUBE_POS = [0.0, 0.5, 0.0] as const;

// Transparent object positions (LO 4.3 verbatim, both grass and window).
const TRANSPARENT_POSITIONS: readonly (readonly [number, number, number])[] = [
  [-1.5, 0.0, -0.48],
  [1.5, 0.0, 0.51],
  [0.0, 0.0, 0.7],
  [-0.3, 0.0, -2.3],
  [0.5, 0.0, -0.6],
];

// Camera: (0,0,3), Zoom=45 deg, near=0.1, far=100.0.
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
  throw new Error("[learn-render 4.3 blending] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[learn-render 4.3 blending] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 4.3 blending] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: LearnRenderErrorRecord[] }).__learnRenderErrors;
    if (bus !== undefined) {
      const detail = 'detail' in error ? error.detail : undefined;
      bus.push({ code: error.code, hint: error.hint, ...(detail === undefined ? {} : { detail }) });
    }
  });
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 4.3 blending] asset owner is unavailable');
    return;
  }

  // Enable mode=3 distance-based transparent sort (back-to-front by camera
  // distance). This is an engine-level feature -- the demo only configures
  // the mode; the engine's record stage performs the per-frame re-sort.
  const sortCfgRes = TransparentSort.configure(world, {
    mode: TransparentSort.distance,
    yzAlpha: 1.0,
  });
  if (!sortCfgRes.ok) {
    console.error('[learn-render 4.3 blending] setTransparentSortConfig failed:', sortCfgRes.error);
    return;
  }

  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Parse texture GUIDs.
  const metalGuidRes = AssetGuid.parse(METAL_GUID_STR);
  const marbleGuidRes = AssetGuid.parse(MARBLE_GUID_STR);
  const grassGuidRes = AssetGuid.parse(GRASS_GUID_STR);
  const windowGuidRes = AssetGuid.parse(WINDOW_GUID_STR);
  if (
    !metalGuidRes.ok ||
    !marbleGuidRes.ok ||
    !grassGuidRes.ok ||
    !windowGuidRes.ok
  ) {
    console.error('[learn-render 4.3 blending] GUID parse failed');
    return;
  }

  // Load textures through the GUID asset pipeline.
  const metalHandleRes = await assets.loadByGuid<TextureAsset>(metalGuidRes.value);
  const marbleHandleRes = await assets.loadByGuid<TextureAsset>(marbleGuidRes.value);
  const grassHandleRes = await assets.loadByGuid<TextureAsset>(grassGuidRes.value);
  const windowHandleRes = await assets.loadByGuid<TextureAsset>(windowGuidRes.value);
  if (
    !metalHandleRes.ok ||
    !marbleHandleRes.ok ||
    !grassHandleRes.ok ||
    !windowHandleRes.ok
  ) {
    console.error(
      '[learn-render 4.3 blending] loadByGuid failed:',
      metalHandleRes.ok ? null : metalHandleRes.error.code,
      marbleHandleRes.ok ? null : marbleHandleRes.error.code,
      grassHandleRes.ok ? null : grassHandleRes.error.code,
      windowHandleRes.ok ? null : windowHandleRes.error.code,
    );
    const bus = (globalThis as unknown as { __learnRenderErrors?: LearnRenderErrorRecord[] }).__learnRenderErrors;
    if (bus !== undefined) {
      if (!metalHandleRes.ok) bus.push({ code: metalHandleRes.error.code, hint: metalHandleRes.error.hint });
      if (!marbleHandleRes.ok) bus.push({ code: marbleHandleRes.error.code, hint: marbleHandleRes.error.hint });
      if (!grassHandleRes.ok) bus.push({ code: grassHandleRes.error.code, hint: grassHandleRes.error.hint });
      if (!windowHandleRes.ok) bus.push({ code: windowHandleRes.error.code, hint: windowHandleRes.error.hint });
    }
    return;
  }
  const metalTex = unwrapHandle(world.allocSharedRef('TextureAsset', metalHandleRes.value));
  const marbleTex = unwrapHandle(world.allocSharedRef('TextureAsset', marbleHandleRes.value));
  const grassTex = unwrapHandle(world.allocSharedRef('TextureAsset', grassHandleRes.value));
  const windowTex = unwrapHandle(world.allocSharedRef('TextureAsset', windowHandleRes.value));

  // ── Floor material: PBR with metal.png texture ───────────────────
  const floorMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
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
  });

  // ── Cube material: PBR with marble.jpg texture ───────────────────
  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
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
  });

  // ── Grass material: alpha-test discard shader, Transparent queue ─
  // Reuses existing alpha-test.wgsl (discard fragments where sampled
  // alpha < 0.1). Grass texture uses clamp-to-edge (meta sidecar, w20)
  // to prevent grey border artifacts from bilinear edge sampling.
  const grassMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: ALPHA_TEST_SHADER_ID }, renderState: { ...{ depthWriteEnabled: false }, tags: { LightMode: 'Forward' }, queue: RenderQueue.Transparent as number } },
    ],
    values: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.5,
      baseColorTexture: grassTex,
    },
  });

  // ── Window material: semi-transparent blend, Transparent queue ───
  // blend SRC_ALPHA / ONE_MINUS_SRC_ALPHA mirrors LO glBlendFunc. Window
  // texture uses clamp-to-edge (meta sidecar, w20) to prevent border
  // artifacts. depthWriteEnabled=false so farther windows are not occluded.
  const windowMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' }, renderState: { ...{
          depthWriteEnabled: false,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }, tags: { LightMode: 'Forward' }, queue: RenderQueue.Transparent as number } },
    ],
    values: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      metallic: 0.0,
      roughness: 0.5,
      baseColorTexture: windowTex,
    },
  });

  // ── Spawn entities ────────────────────────────────────────────────

  // Spawn floor.
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, FLOOR_Y, 0], quat: [SIN_NEG_90, 0, 0, COS_NEG_90], scale: [FLOOR_SCALE, FLOOR_SCALE, FLOOR_SCALE],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [floorMat] } },
  ).unwrap();

  // Spawn single marble cube at (0, 0.5, 0).
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [CUBE_POS[0], CUBE_POS[1], CUBE_POS[2]],},
    },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
  ).unwrap();

  // Spawn 5 grass discard quads at LO 4.3 exact positions.
  for (const p of TRANSPARENT_POSITIONS) {
    world.spawn(
      {
        component: Transform,
        data: { pos: [p[0], p[1], p[2]]},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [grassMat] } },
    ).unwrap();
  }

  // Spawn 5 semi-transparent window quads at the same 5 positions.
  // The engine's distance sort (mode=3) will reorder them back-to-front
  // every frame based on camera distance, so far windows are drawn first
  // and near windows composite on top correctly.
  for (const p of TRANSPARENT_POSITIONS) {
    world.spawn(
      {
        component: Transform,
        data: { pos: [p[0], p[1], p[2]]},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
      { component: MeshRenderer, data: { materials: [windowMat] } },
    ).unwrap();
  }

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
    name: 'learn-render-4.3-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 4.3 blending] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn('[learn-render 4.3 blending] Standard pipeline active');
}

declare global {
  interface Window {
    __learnRenderErrors?: LearnRenderErrorRecord[];
  }
}
