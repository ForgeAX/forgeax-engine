// apps/learn-render/4.advanced-opengl/4.face-culling/src/index.ts
// LearnOpenGL section 4.4 - Face Culling (pixel-level replica).
//
// Demonstrates frontFace='cw' + cullMode='back' with camera inside the cube.
// Winding semantics:
//   - HANDLE_CUBE triangles are CCW-wound with normals pointing outward.
//   - When the camera is inside the cube looking at an inner face, the
//     visible face is the back side of an outward-facing triangle. From
//     the camera's viewpoint, that back side appears CW-wound.
//   - frontFace='cw' declares CW-wound triangles as front-facing (the GPU
//     default is 'ccw'). This means the inner faces (CW-appearing from
//     inside) are front-facing, and the outer faces (originally CCW) are
//     back-facing.
//   - cullMode='back' culls back-facing triangles, removing the outer
//     faces from view. The camera at (0,0,0) inside the [-0.5,0.5]^3 cube
//     sees only the inner faces with unlit marble.jpg texturing.
//
// Equivalent LearnOpenGL recipe: CW-winding cube + glFrontFace(GL_CW)
// + glEnable(GL_CULL_FACE) + glCullFace(GL_BACK) + camera inside cube.
//
// AC-09 verifiable: switch cullMode to 'front' and the inner faces disappear
// (outer faces render but point away from the camera and rasterize zero area,
// producing a clear-color-only view), proving the culling semantics.
//
// Textures are loaded through the scoped GUID asset pipeline:
//   configureRuntimeAssetCatalog(assets, runtimeBinding) + loadByGuid<TextureAsset>.
//
// GREP anchors for AI users:
//   - "// 1. engine usage"    public engine API consumed
//   - "// 2. example glue"    LO 4.4 scene-specific constants + GUIDs
//   - "// 3. bootstrap"       entry point wiring (1)+(2)

// 1. engine usage
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import type { App } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';

import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { addFirstPersonSystem } from '../../../../shared/src/learn-render-first-person';

// 2. example glue

// Marble GUID from forgeax-engine-assets/learn-opengl/textures/marble.jpg.meta.json
const MARBLE_GUID_STR = '019e3969-1d46-7933-b14d-4faee5635ad6';

// Camera inside the cube (origin). The cube spans [-0.5, 0.5]^3;
// position (0,0,0) places the camera exactly at the center, looking
// along -Z via default Transform identity orientation.
const CAMERA_POS: readonly [number, number, number] = [0, 0, 0];

// Camera projection: fov=45 deg, aspect from canvas, near=0.1, far=100.0.
const CAMERA_FOV = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100.0;

// 3. bootstrap

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 4.4 face-culling] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    console.error('[learn-render 4.4 face-culling] createApp failed:', appRes.error);
    return;
  }
  const app = appRes.value;
  const world = app.world;
  app.onError((error) => {
    console.error('[learn-render 4.4 face-culling] app.onError:', error.code, error.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: error.code, hint: error.hint });
  });
  const assets = app.assets;
  if (assets === undefined) {
    console.error('[learn-render 4.4 face-culling] asset owner is unavailable');
    return;
  }

  // Wire the scoped dev catalog for GUID-based texture loading.
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Parse marble GUID.
  const marbleGuidRes = AssetGuid.parse(MARBLE_GUID_STR);
  if (!marbleGuidRes.ok) {
    console.error('[learn-render 4.4 face-culling] GUID parse failed:', marbleGuidRes.error);
    return;
  }

  // Load marble texture through the GUID asset pipeline.
  const marbleHandleRes = await assets.loadByGuid<TextureAsset>(marbleGuidRes.value);
  if (!marbleHandleRes.ok) {
    console.error('[learn-render 4.4 face-culling] loadByGuid failed:', marbleHandleRes.error.code);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: marbleHandleRes.error.code, hint: marbleHandleRes.error.hint });
    return;
  }
  const marbleTex = unwrapHandle(world.allocSharedRef('TextureAsset', marbleHandleRes.value));

  // Cube material: unlit marble.jpg texture (LO 4.4 renders the marble cube at
  // full texture brightness with no lighting -- the chapter teaches culling,
  // not shading). Unlit shows the inner walls at their texture color so the
  // frontFace/cullMode result is unmistakable.
  //
  // Winding and culling relationship for interior-face visibility:
  //
  //   HANDLE_CUBE has CCW outward-facing triangles. Viewed from inside the
  //   cube, the inner faces appear CW (back side of an outward CCW face).
  //
  //   frontFace: 'cw' => the GPU treats CW-wound triangles as front-facing.
  //     So from the camera's perspective inside the cube, the inner faces
  //     (CW-appearing) are front-facing, while the outer faces (originally
  //     CCW) become back-facing.
  //
  //   cullMode: 'back' => the GPU discards back-facing triangles.
  //     Outer faces (now back-facing) are culled. Inner faces (now
  //     front-facing) survive and are rendered.
  //
  // The unlit shader honors per-material renderState via the engine's
  // renderState-aware pipeline cache; the static unlit pipeline's default
  // frontFace='ccw' would back-cull these CW-appearing inner faces and show
  // nothing -- a face-culling demo is exactly the case that needs custom
  // winding on an unlit material.
  //
  // AC-03 verification: frontFace: 'cw' is a top-level string literal
  // accepted by TS strict + exactOptionalPropertyTypes (MaterialRenderState
  // .frontFace is the closed union 'ccw' | 'cw').
  //
  // AC-09 demonstration: switch cullMode to 'front' and the inner faces
  // (now CW-appearing and thus front-facing) are culled -- the camera
  // inside sees only clear-color, proving the culling semantics.
  const cubeMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { ...{
          frontFace: 'cw',
          cullMode: 'back',
        }, tags: { LightMode: 'Forward' } } },
    ],
    values: {
      baseColor: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: marbleTex,
    },
  });

  // Single marble cube at origin.
  world.spawn(
    { component: Transform, data: {} },
    { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
    { component: MeshRenderer, data: { materials: [cubeMat] } },
  ).unwrap();

  // Camera inside the cube at (0, 0, 0), looking along -Z via default
  // Transform identity orientation. First-person system drives WASD/mouse
  // on top of this spawn so the user can explore the cube interior.
  const cameraEntity = world.spawn(
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
  ).unwrap();

  addFirstPersonSystem(app.world, {
    name: 'learn-render-4.4-first-person',
    overrideBackend: undefined,
  });

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 4.4 face-culling] app.start failed:', startRes.error);
    return;
  }

  installCaptureHook(target, world);

  window.addEventListener('resize', () => {
    const dpr = devicePixelRatio;
    target.width = window.innerWidth * dpr;
    target.height = window.innerHeight * dpr;
    world.set(cameraEntity, Camera, { aspect: window.innerWidth / window.innerHeight });
  });

  console.warn('[learn-render 4.4 face-culling] Standard pipeline active');
}

// Canvas capture hook for the capture smoke harness (pixel mode). Advances the
// World before reading the Host-owned presentation surface.
function installCaptureHook(target: HTMLCanvasElement, world: App['world']): void {
  type CaptureHook = () => Promise<Uint8Array>;
  const win = window as unknown as { __captureFaceCulling?: CaptureHook };
  win.__captureFaceCulling = async (): Promise<Uint8Array> => {
    world.update(1 / 60).unwrap();
    const r = await captureCanvasPixels(target);
    if (!r.ok) {
      throw new Error(
        `[learn-render 4.4 face-culling] canvas capture failed: ${r.error.code} -- ${r.error.hint}`,
      );
    }
    return r.value;
  };
}

declare global {
  interface Window {
    __captureFaceCulling?: () => Promise<Uint8Array>;
    __learnRenderErrors?: Array<{ code: string; hint?: string }>;
  }
}
