// apps/learn-render/5.advanced-lighting/1.advanced-lighting/src/index.ts
// LearnOpenGL section 5.1 - Blinn-Phong.
// Per-fragment Blinn-Phong shading via custom WGSL shader.
//
// Custom shader path: the manifest registers the WGSL module at boot.
//
// MaterialAsset is constructed as a POJO directly (no Materials.standard())
// to demonstrate the raw asset shape for AI users.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 5.1 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { createPlaneGeometry } from '@forgeax/engine-geometry';

import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';

import './blinn-phong.wgsl';

const BLINN_PHONG_SHADER_ID = 'learn_render::5_1_blinn_phong' as const;

// 2. example glue

// LO 5.1 renders a wood FLOOR plane lit from above. The whole point of the
// chapter is the grazing-angle floor where Blinn-Phong's half-vector
// specular visibly differs from Phong's reflect-vector specular. Texture
// GUID from forgeax-engine-assets/learn-opengl/textures/wood.png.meta.json.
const WOOD_GUID_STR = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// Floor geometry: LO uses a 20x20 plane on the XZ plane at y=-0.5 with
// normal +Y. createPlaneGeometry produces an XY plane facing +Z, so we
// rotate it -90deg about X to lay it flat (normal -> +Y) so the floor
// normal faces the overhead light at the origin.
const FLOOR_SIZE = 20;
const FLOOR_Y = -0.5;
// quat for -90deg about X: (sin(-pi/4), 0, 0, cos(-pi/4)).
const FLOOR_QUAT_X = Math.sin(-Math.PI / 4);
const FLOOR_QUAT_W = Math.cos(-Math.PI / 4);

// Blinn-Phong constants (lightPos, lightColor, shininess) are baked into
// `blinn-phong.wgsl` as `const` because LO 5.1 never animates them.
// LIGHT_POS is (0,0,0) — above the floor (FLOOR_Y=-0.5), so the floor's
// +Y normal faces the light and the surface lights up (cube-at-origin
// placed the light INSIDE the geometry, back-facing every visible face).
// `viewPos` is read from the engine View UBO (`view.cameraPos`), which
// the engine fills from the active Camera transform every frame. User
// shaders cannot allocate additional @group(1) bindings above 6 — the
// engine reserves binding 7..17 for Skylight + emissive/AO (see
// `pbr-pipeline.ts buildPbrPipelineLayouts`).
const CAMERA_POS_Z = 3;
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 5.1 blinn-phong] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[learn-render 5.1 blinn-phong] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 5.1 blinn-phong] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 5.1 blinn-phong] asset owner is unavailable');
    return;
  }

  // Bind the scoped catalog for GUID-based texture loading.
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Parse texture GUID.
  const woodGuidRes = AssetGuid.parse(WOOD_GUID_STR);
  if (!woodGuidRes.ok) {
    console.error('[learn-render 5.1 blinn-phong] GUID parse failed');
    return;
  }

  // Load texture through the GUID asset pipeline.
  const texRes = await assets.loadByGuid<TextureAsset>(woodGuidRes.value);
  if (!texRes.ok) {
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: texRes.error.code, hint: texRes.error.hint });
    console.error('[learn-render 5.1 blinn-phong] loadByGuid failed:', texRes.error.code);
    return;
  }
  const woodTex = texRes.value;

  // Construct MaterialAsset POJO directly.
  const mat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: BLINN_PHONG_SHADER_ID }, renderState: { tags: { LightMode: 'Forward' } } },
    ],
    values: {
      baseColorTexture: unwrapHandle(world.allocSharedRef('TextureAsset', woodTex)),
    },
  });

  // Floor plane: 20x20 on the XZ plane at y=-0.5, normal +Y facing the
  // overhead light at the origin (LIGHT_POS in blinn-phong.wgsl). The
  // procedural plane faces +Z, so rotate -90deg about X to lay it flat.
  const floorRes = createPlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
  if (!floorRes.ok) {
    console.error('[learn-render 5.1 blinn-phong] createPlaneGeometry failed:', floorRes.error);
    return;
  }
  const floorMesh = world.allocSharedRef('MeshAsset', floorRes.value);
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, FLOOR_Y, 0], quat: [FLOOR_QUAT_X, 0, 0, FLOOR_QUAT_W]},
    },
    { component: MeshFilter, data: { assetHandle: floorMesh } },
    { component: MeshRenderer, data: { materials: [mat] } },
  ).unwrap();

  // Camera at (0, 0, 3), FOV=45 deg.
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
    name: 'learn-render-5.1-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 5.1 blinn-phong] app.start failed:', startRes.error);
    return;
  }

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn('[learn-render 5.1 blinn-phong] Standard pipeline active');

  installCaptureHook(target, world);
}

// Canvas capture hook for the capture smoke harness (pixel mode). Advances the
// World before reading the Host-owned presentation surface.
function installCaptureHook(target: HTMLCanvasElement, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureAdvancedLighting?: CaptureHook };
  win.__captureAdvancedLighting = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const r = await captureCanvasPixels(target);
    if (!r.ok) {
      throw new Error(
        `[learn-render 5.1 blinn-phong] canvas capture failed: ${r.error.code} -- ${r.error.hint}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
    __captureAdvancedLighting?: () => Promise<Uint8Array>;
  }
}
