// apps/hello/sprite-atlas -- 1 atlas / 10000 independent sprite entities /
// 1 instanced drawIndexed (charter P4 transparent fold).
//
// feat-20260622-chunk-gpu-instancing-sprite-tilemap M4 / w17:
// the legacy 1-host-entity-with-Instances(100) opt-in path is REPLACED with
// spawn 10000 independent sprite entities sharing one MaterialAsset handle.
// The record-stage fold operator (M1 / w4) collapses the 10000 transparent
// dispatch entries into one instanced drawIndexed because all share
// `(Layer.value=0, pos z=0, materialHandle)` -- AC-03 transparent abstraction
// (AI users spawn N entities, engine collapses to 1 draw automatically).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - SpriteMaterialAsset (sprite-atlas-animation feat M1) -- one shared
//     atlas material handle drives all 10000 entities.
//   - 10000 individual sprite entities (Transform + MeshFilter + MeshRenderer
//     + SpriteRegionOverride) -- the canonical AI-user spawn shape (AGENTS.md
//     §Component naming) without the Instances opt-in.
//   - record-stage fold operator (this feat M1 / w4) -- 10000 entries with
//     equal (Layer.value, pos z, materialHandle) collapse into one fold
//     bucket -> one drawIndexed(indexCount, 10000).
//   - foldedDraws metric (this feat M3 / w13) -- retained as host-owned
//     evidence; the smoke (and verify-stage M4 verifier) reads it to confirm
//     fold engaged without widening the Renderer facade.
//
// charter mapping:
//   F1 -- 4-step recipe lives at the top of bootstrap().
//   P3 -- every Result.err consumed via .code + .hint.
//   P4 -- AI users spawn N entities; engine folds transparently with no
//         opt-in component, no new API surface, no concept additions.
//   P5 -- atlas PNG + sidecar pre-generated; demo build chain has zero
//         atlas-tool dependency.

import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import type { App, CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { AssetGuid } from '@forgeax/engine-pack/guid';

import { Transform } from '@forgeax/engine-scene';

import { CAMERA_PROJECTION_ORTHOGRAPHIC } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { SpriteRegionOverride, SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';

import { ok as okResult, type MaterialAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';


const ATLAS_GUID = '0e8657b1-c0ab-4940-a4f6-27fcd976823c';

// 10000 independent sprite entities arranged in a 100x100 grid. Each gets
// its own Transform / MeshFilter / MeshRenderer / SpriteRegionOverride;
// the fold operator (record stage) collapses them into one drawIndexed
// because all share (Layer.value=0, pos z=0, materialHandle). Performance
// anchor: requirements AC-01 sprite-atlas 10k @ p95>=60fps (verify-stage
// SSOT, charter P5).
const SPRITE_GRID = 100;
const SPRITE_COUNT = SPRITE_GRID * SPRITE_GRID;
const SPRITE_SPACING = 0.018;

// Hardcoded first-frame walk region. The sidecar JSON produced by the
// atlas CLI carries 4 regions (one per walk frame) but for the M4
// fold-validation demo we only need a single region — the visual
// surface is "10000 entities sharing one atlas tile", not animated walk.
// Keeping this hardcoded removes a runtime fetch dependency that broke
// the browser dev path (no `/assets/` route in dev), letting the
// Playwright probe (smoke-browser.mjs) actually exercise fold.
const WALK_REGION_FRAME_0: readonly [number, number, number, number] = [0, 0, 0.5, 0.5];

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[sprite-atlas] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[sprite-atlas] no usable WebGPU backend:', err);
  } else {
    console.error('[sprite-atlas] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step 1: createApp(canvas, opts) -- one-screen takeoff.
  const appRes = await createApp(
    target,
    {},
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    reportAppError(appRes.error);
    return;
  }
  const app: App = appRes.value;
  console.warn(`[sprite-atlas] backend=${app.renderer.inspect().capabilities.backendKind}`);


  const assets = app.assets;
  if (assets === undefined || assets === null) {
    console.error('[sprite-atlas] AssetRegistry is unavailable (no usable backend)');
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  const world = app.world;
const primitiveQuad = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();


  // Step 2: load the atlas texture. The 4-region walk.atlas.json sidecar
  // (charter F2) is not fetched here — the fold-validation demo uses one
  // hardcoded region for all 10000 entities, so no per-frame walk
  // animation is wired (animation surface is exercised by the legacy
  // sprite-atlas test fixtures and the dawn smoke).
  const atlasGuidRes = AssetGuid.parse(ATLAS_GUID);
  if (!atlasGuidRes.ok) {
    console.error('[sprite-atlas] ATLAS_GUID parse failed:', atlasGuidRes.error.code);
    return;
  }
  const texHandleRes = await assets.load(atlasGuidRes.value, 'texture');
  if (!texHandleRes.ok) {
    console.error(
      '[sprite-atlas] atlas texture loadByGuid failed:',
      texHandleRes.error.code,
      texHandleRes.error.hint,
    );
    return;
  }
  const textureHandle = texHandleRes.value;

  // Step 3: mint sampler + one shared MaterialAsset handle (all 10000
  // sprite entities reference this same handle so the fold operator
  // can collapse them into one drawIndexed; charter P4 transparent
  // optimisation).
  //
  // feat-20260626-sprite-transparent-collapse M3 — post M1/M2 SSOT:
  //   - first-pass `renderState.blend` drives the LDR split + premulti-
  //     plied-alpha blend pipeline (preset `SPRITE_PREMULTIPLIED_ALPHA_BLEND`;
  //     replaces ablated `transparent` boolean flag + earlier
  //     shadingModel='sprite' arm; requirements §2 NOTE breaking change).
  //   - values UBO-aligned: colorTint (was baseColor),
  //     baseColorTexture (was texture), pivotAndSize (was pivot).
  //     SpriteRegionOverride still writes the .region vec4 into
  //     paramSnapshot every frame, untouched by the rename.
  const material: MaterialAsset = {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND }, tags: { LightMode: 'Forward' }, queue: 3000 } },
    ],
    values: {
      colorTint: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: textureHandle,
      region: [...WALK_REGION_FRAME_0],
      pivotAndSize: [0.5, 0.5, 1, 1],
    },
  };
  const materialHandle = assets.create(material).unwrap();

  // Step 4: spawn ortho camera. Camera frustum spans roughly the 100x100
  // grid (each cell is SPRITE_SPACING wide, total grid extent ~= 1.78
  // unit at 100*0.018) so the user sees the whole field from frame 0.
  const aspect = target.width / Math.max(target.height, 1);
  const halfH = (SPRITE_GRID * SPRITE_SPACING) / 2 + 0.1;
  const halfW = halfH * aspect;
  okResult(
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 5], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect,
          near: 0.1,
          far: 100,
          projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
          left: -halfW,
          right: halfW,
          bottom: -halfH,
          top: halfH,
          clearColor: [0.07, 0.07, 0.09, 1.0],
        },
      },
    ),
  );

  // Step 5: spawn 10000 independent sprite entities. Each has its own
  // Transform / MeshFilter / MeshRenderer / SpriteRegionOverride. The
  // record-stage fold operator collapses them into one instanced
  // drawIndexed because the (Layer.value, pos z, materialHandle) triple
  // is uniform across the batch (charter P4 transparent optimisation).
  // Per-entity SpriteRegionOverride still works because the sprite
  // shader reads it via a per-entity mesh UBO slice.
  const region: readonly [number, number, number, number] = WALK_REGION_FRAME_0;
  const half = (SPRITE_GRID - 1) / 2;
  for (let i = 0; i < SPRITE_COUNT; i++) {
    const row = Math.floor(i / SPRITE_GRID);
    const col = i % SPRITE_GRID;
    const cx = (col - half) * SPRITE_SPACING;
    const cy = (row - half) * SPRITE_SPACING;
    const spawnRes = world.spawn(
      {
        component: Transform,
        data: {
          pos: [cx, cy, 0], quat: [0, 0, 0, 1], scale: [SPRITE_SPACING * 0.9, SPRITE_SPACING * 0.9, 1],},
      },
      { component: MeshFilter, data: { assetHandle: primitiveQuad } },
      { component: MeshRenderer, data: { materials: [materialHandle] } },
      {
        component: SpriteRegionOverride,
        data: { region: new Float32Array([...region]) },
      },
    );
    if (!spawnRes.ok) {
      console.error('[sprite-atlas] spawn failed at', i, spawnRes.error.code);
      return;
    }
  }

  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn(
    `[sprite-atlas] running. ${SPRITE_COUNT} independent sprite entities / 1 atlas / ` +
      'transparent fold collapses to 1 instanced drawIndexed.',
  );
}

function reportAppError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[sprite-atlas] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[sprite-atlas] ${err.code}: ${err.hint}`);
}
