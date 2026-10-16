// apps/learn-render/1.getting-started/6.coordinate-systems/src/index.ts
// LearnOpenGL section 1.6 - Coordinate Systems (forgeax mapping with 10
// textured cubes + perspective Camera; the LO 1.6 model / view /
// projection matrix chain idiom mapped onto the forgeax ECS schedule).
//
// LO 1.6 covers the GLM CPU-side `glm::mat4 model = glm::translate(
// glm::mat4(1.0f), cubePositions[i]) * glm::rotate(...)` plus
// `glm::translate(view, glm::vec3(0,0,-3))` plus
// `glm::perspective(glm::radians(45.0f), w/h, 0.1f, 100.0f)` matrix
// chain, then uploads three uniforms (`model`, `view`, `projection`)
// to the vertex shader.
//
// In forgeax the equivalent surface is split across three layers
// (charter P4 consistent abstraction):
//   1. **model** -> per-entity `Transform` component (10 f32 SoA cols:
//      `pos + quat quaternion + scale` array columns); the engine
//      `RenderSystem` internally composes `worldFromLocal: mat4` per
//      frame using `@forgeax/engine-math` (see `packages/runtime/src/
//      components/transform.ts`).
//   2. **view** -> the active camera entity's `Transform` (the engine
//      computes `viewFromWorld = inverse(cameraTransform)`); LO's
//      `glm::vec3(0, 0, -3)` translation becomes `Transform.pos = [0, 0, 3]`
//      on the camera entity (note the sign: in forgeax the camera sits
//      at +z and looks down -z, matching LO right-handed convention).
//   3. **projection** -> the `Camera` component's `fov / aspect / near /
//      far + projection` 5 scalar fields (perspective variant) drive
//      the projection mat4; LO `glm::perspective(glm::radians(45.0f),
//      w/h, 0.1f, 100.0f)` becomes `{fov: Math.PI / 4, aspect: w / h,
//      near: 0.1, far: 100, projection: CAMERA_PROJECTION_PERSPECTIVE}`.
//
// AC-06 three-section marker convention:
//   `// 1. engine usage`            -> public engine API consumed.
//   `// 2. example-specific glue`   -> the LO 1.6 cubePositions array
//                                       + GUID literals + perspective
//                                       camera config.
//   `// 3. bootstrap`               -> entry point that wires (1)+(2).
//
// AC-03 + AC-07 + AC-10 + AC-11 contract: 10 textured cubes spawn (LO
// `cubePositions[]` array idiom), each pointing at the same wood-
// container `MaterialAsset` (sRGB JPG decoded by @forgeax/engine-image
// via the pluginPack pack-index pipeline). `MeshFilter.assetHandle`
// binds `cubeHandleRes.value` (GUID-derived user-handle); the engine
// `pipelineState.meshes` alias map upload path covers the user-handle
// id (>=1024) so the V-3 deferred punt is gone (the previous deferred
// concern marker + recipe-only loadByGuid both removed).
//
// AC-15 (c) regression carried from M8 / M9: this file does NOT import
// `@forgeax/engine-image` and does NOT call any low-level decode /
// upload helper -- the cube enters the world via `loadByGuid<MeshAsset>`
// alone (charter P4 + P5).
//
// charter mapping:
//   - F1 (limited context):  three-section markers double as grep
//     anchors (AC-06) so AI users locate the LO 1.6 -> forgeax mapping
//     via a single `rg "// 1\. engine usage"` call; `CUBE_POSITIONS`
//     + `CAMERA_PROJECTION_PERSPECTIVE` are the LO 1.6 -> forgeax
//     idiom anchors.
//   - F2 (text > image):     the LO 1.6 GLM chapter is documented as
//     text in this file's comment block + the README LO folded
//     `<details>` block; the pixel-parity baseline (round-6-coordi
//     nate-systems.png) is verification only.
//   - P1 (progressive disclosure):  the README top callout points at
//     this file; AI users read the 3 sections + the cubePositions
//     array + the GUID literals + the perspective Camera config and
//     have the full LO 1.6 -> forgeax picture in one directory.
//   - P3 (explicit failure):  `EngineEnvironmentError` surfaces the
//     "no usable backend" path; createApp returns a `Result` whose
//     `.ok === false` branch is logged via console.error -- no silent
//     fallback. loadByGuid Err arms switch on err.code and log
//     structured detail.
//   - P4 (consistent abstraction):  the same `createApp(canvas, opts)`
//     factory + ECS spawn + `MeshRenderer` discriminator + 10 f32
//     Transform column SoA + 9 f32 Camera column SoA is the entry
//     across every learn-render example; LO 1.6 just adds the multi-
//     entity spawn loop + perspective Camera projection field atop
//     the LO 1.5 textured cube baseline.
//   - P5 (producer / consumer split):  `loadByGuid<MeshAsset>` returns
//     the user-handle the spawn path consumes; the producer / consumer
//     responsibilities never interleave (charter F3 instrumentation).

// 1. engine usage - the public createApp + ECS World facade + Asset
// Registry namespace + AssetGuid parser + MaterialAsset / TextureAsset /
// MeshAsset POD types + 4 component schemas (Transform / Camera /
// MeshFilter / MeshRenderer). createApp owns the rAF frame-loop +
// Time resource + auto input attach (charter P4; OOS-9 / OOS-11 -- the
// demo never touches raw mat4 math or the browser raw rAF API).
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp } from '@forgeax/engine-app/browser';
import type { CanvasAppError } from '@forgeax/engine-app';
import { quat, vec3 } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_CUBE, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';

import type { MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import materialPackJson from '../assets/material-wood.pack.json';

// 2. example-specific glue - LO 1.6 cubePositions[] + perspective
// projection mapped onto forgeax. Three GUID literals form the disk-
// schema -> runtime bridge (AI users grep them via `rg "WOOD_TEXTURE_
// GUID" apps/`):
//
//   WOOD_TEXTURE_GUID  -> forgeax-engine-assets/learn-opengl/textures/
//                          container.jpg.meta.json subAssets[0].guid
//                          (sRGB JPG decoded by @forgeax/engine-image
//                          at build time / runtime fetch through
//                          pluginPack pack-index path).
//   CUBE_MESH_GUID     -> forgeax-engine-assets/learn-opengl/meshes/
//                          cube-mesh.stub.meta.json subAssets[0].guid
//                          (engine-builtin procedural cube; the GUID
//                          is the disk identifier, the runtime aliases
//                          the same logical mesh as HANDLE_CUBE).
//   CUBE_MATERIAL_GUID -> assets/material-wood.pack.json assets[0].guid
//                          (UnlitMaterialAsset whose baseColorTexture
//                          slot references WOOD_TEXTURE_GUID -- the LO
//                          §1.4 sampler2D bind point in WGSL terms).
const WOOD_TEXTURE_GUID = '019e3969-1d46-773e-988c-a10e305ff2a4';
const CUBE_MESH_GUID = '019e3968-6007-71ae-856e-1fd6c9728cfb';
const CUBE_MATERIAL_GUID = '019e4906-23e9-771c-afd1-1896daeaa11e';
// Dev uses the binding's scoped catalog route; build emits the static
// `/pack-index.json` file. `configureRuntimeAssetCatalog` selects the route
// for the current Vite mode.


// LO 1.6 cubePositions[] array (verbatim translation; the LO source
// uses `glm::vec3(...)` literals, here they map onto the per-entity
// `Transform.pos` flat array column the engine RenderSystem reads each
// frame). 10 cubes laid out in a loose grid so AI users can visually
// confirm the perspective projection in the captured PNG. Source:
// LearnOpenGL/src/1.getting_started/6.1.coordinate_systems/coordinate
// _systems.cpp `cubePositions[]`.
const CUBE_POSITIONS: ReadonlyArray<readonly [number, number, number]> = [
  [0.0, 0.0, 0.0],
  [2.0, 5.0, -15.0],
  [-1.5, -2.2, -2.5],
  [-3.8, -2.0, -12.3],
  [2.4, -0.4, -3.5],
  [-1.7, 3.0, -7.5],
  [1.3, -2.0, -2.5],
  [1.5, 2.0, -2.5],
  [1.5, 0.2, -1.5],
  [-1.3, 1.0, -1.5],
];

// LO 1.6 perspective projection: matches the GLM call
// `glm::perspective(glm::radians(45.0f), w/h, 0.1f, 100.0f)`.
const CAMERA_FOV_RADIANS = Math.PI / 4;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;
// forgeax Camera.projection is a numeric f32 discriminant; the engine
// SSOT lives at `packages/runtime/src/components/camera.ts` as
// `CAMERA_PROJECTION_PERSPECTIVE = 0`. AI users mirror the literal
// here so the LO 1.6 -> forgeax perspective mapping is grep-visible
// in this directory (charter F1 + AC-04). The engine narrows
// `Camera.projection` to `'perspective' | 'orthographic'` via
// `cameraProjectionFromF32` -- 0 narrows to 'perspective'.
const CAMERA_PROJECTION_PERSPECTIVE = 0;

// LO 1.6 per-cube rotation: each cube tilts on a fixed axis by an
// angle proportional to its index, matching the LO sample
// `glm::rotate(model, glm::radians(20.0f * i), glm::vec3(1.0f, 0.3f,
// 0.5f))`. The axis is normalised before being baked into the
// Transform quaternion.
const CUBE_AXIS = vec3.normalize(vec3.create(), [1.0, 0.3, 0.5]);
const CUBE_TILT_RADIANS_PER_INDEX = (20 * Math.PI) / 180;

interface MaterialPackEntry {
  readonly guid: string;
  readonly kind: string;
  readonly payload: {
    readonly kind: string;
    readonly passes: ReadonlyArray<{ readonly name: string; readonly program: { readonly module: string } }>;
    readonly values: {
      readonly baseColor: readonly [number, number, number, number];
      readonly baseColorTexture?: string;
    };
  };
}

interface MaterialPackFile {
  readonly assets: ReadonlyArray<MaterialPackEntry>;
}

// 3. bootstrap - locate the canvas, hand it to createApp (engine-app
// shell wires the rAF frame-loop + Time resource + auto input attach),
// wire the AssetRegistry through the loadByGuid recipe, spawn 10
// textured cubes (each with a distinct Transform) + 1 perspective
// camera, and start the app.
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 1.6 coordinate-systems] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  const appRes = await createApp(
    target,
    {},
    // four-verb redesign 2026-06-06: dev lazy-import transport for
    // raw-source texture rows.
    { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
  );
  if (!appRes.ok) {
    reportBootstrapError(appRes.error);
    return;
  }
  const app = appRes.value;
  const world = app.world;

  app.onError((e) => {
    console.error('[learn-render 1.6 coordinate-systems] app.onError:', e.code, e.hint);
    const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
    if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
  });

  const assets = app.assets;
  if (assets === undefined) throw new Error('[learn-render 1.6 coordinate-systems] asset host is unavailable');
  configureRuntimeAssetCatalog(assets, runtimeBinding);

  // Parse the 3 GUID literals once (charter F1 single-grep entry).
  const woodGuidRes = AssetGuid.parse(WOOD_TEXTURE_GUID);
  const cubeGuidRes = AssetGuid.parse(CUBE_MESH_GUID);
  const matGuidRes = AssetGuid.parse(CUBE_MATERIAL_GUID);
  if (!woodGuidRes.ok || !cubeGuidRes.ok || !matGuidRes.ok) {
    console.error(
      '[learn-render 1.6 coordinate-systems] GUID parse failed for one of the 3 fixtures',
    );
    return;
  }

  // The texture handle resolves through the production fetch chain
  // (catalog configuration -> container.jpg ->
  // parseImage -> uploadTexture); the cube handle resolves through the
  // Map fast-path seeded by registerWithGuid below (alias to engine-
  // builtin HANDLE_CUBE); the material handle resolves through the
  // same Map fast-path after we register the reconstructed POD.
  const woodHandleRes = await assets.loadByGuid<TextureAsset>(woodGuidRes.value);
  if (!woodHandleRes.ok) {
    console.error(
      '[learn-render 1.6 coordinate-systems] wood texture loadByGuid failed:',
      woodHandleRes.error.code,
    );
    return;
  }

  const cubeAssetRes = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE);
  if (!cubeAssetRes.ok) {
    console.error('[learn-render 1.6 coordinate-systems] HANDLE_CUBE asset unavailable');
    return;
  }
  assets.catalog<MeshAsset>(cubeGuidRes.value, cubeAssetRes.value);

  const matPack = materialPackJson as unknown as MaterialPackFile;
  const matEntry = matPack.assets.find((a) => a.kind === 'material');
  if (matEntry === undefined) {
    console.error(
      '[learn-render 1.6 coordinate-systems] material-wood.pack.json missing material entry',
    );
    return;
  }
  // loadByGuid returns the texture PAYLOAD (M8 D-17); mint a user-tier column
  // handle so the baseColorTexture slot carries a resolved numeric Handle.
  const woodTexHandle = unwrapHandle(world.allocSharedRef('TextureAsset', woodHandleRes.value));
  const cubeMaterial: MaterialAsset = {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }],
    values: {
      baseColor: matEntry.payload.values.baseColor,
      baseColorTexture: woodTexHandle,
    },
  };
  assets.catalog<MaterialAsset>(matGuidRes.value, cubeMaterial);

  const cubeHandleRes = await assets.loadByGuid<MeshAsset>(cubeGuidRes.value);
  const matHandleRes = await assets.loadByGuid<MaterialAsset>(matGuidRes.value);
  if (!cubeHandleRes.ok || !matHandleRes.ok) {
    console.error(
      '[learn-render 1.6 coordinate-systems] loadByGuid failed:',
      cubeHandleRes.ok ? null : cubeHandleRes.error.code,
      matHandleRes.ok ? null : matHandleRes.error.code,
    );
    return;
  }
  // loadByGuid returns payloads (M8 D-17); mint user-tier column handles.
  const cubeHandle = world.allocSharedRef('MeshAsset', cubeHandleRes.value);
  const matHandle = world.allocSharedRef('MaterialAsset', matHandleRes.value);

  // Spawn the 10 cubes. Each cube uses the LO 1.6 cubePositions[i]
  // translation + a per-index axis-angle rotation around (1, 0.3,
  // 0.5) (LO `glm::rotate(model, glm::radians(20.0f * i), ...)`).
  // The axis-angle is baked into the Transform quaternion so the
  // engine RenderSystem can compose `worldFromLocal: mat4` from the
  // SoA columns without further per-frame work (the LO 1.6 chapter
  // does not animate; the rotation is static per-cube).
  // `MeshFilter.assetHandle: cubeHandleRes.value` binds the GUID-
  // derived user-handle directly -- the engine pipelineState.meshes
  // alias map handles user-handle (>=1024) ids (V-3 punt removed).
  const cubeQuat = quat.create();
  for (let i = 0; i < CUBE_POSITIONS.length; i++) {
    const pos = CUBE_POSITIONS[i];
    if (pos === undefined) continue;
    quat.fromAxisAngle(cubeQuat, CUBE_AXIS, i * CUBE_TILT_RADIANS_PER_INDEX);
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [pos[0], pos[1], pos[2]], quat: [cubeQuat[0] ?? 0, cubeQuat[1] ?? 0, cubeQuat[2] ?? 0, cubeQuat[3] ?? 1], scale: [1, 1, 1],},
        },
        { component: MeshFilter, data: { assetHandle: cubeHandle } },
        {
          component: MeshRenderer,
          data: { materials: [matHandle] },
        },
      )
      .unwrap();
  }

  // LO 1.6 view + projection: spawn a camera entity at (0, 0, 3)
  // looking down -Z (the LO `glm::translate(view, glm::vec3(0,0,-3))`
  // is equivalent to placing the camera at +z=3 in world space; the
  // engine RenderSystem inverts the camera Transform to derive the
  // view matrix). The Camera component's `projection: CAMERA_
  // PROJECTION_PERSPECTIVE` discriminant + `fov / aspect / near /
  // far` 4-tuple is the LO 1.6 `glm::perspective` analogue.
  const cameraAspect = target.width / target.height;
  world.spawn(
    {
      component: Transform,
      data: {
        pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1],},
    },
    {
      component: Camera,
      data: {
        fov: CAMERA_FOV_RADIANS,
        aspect: cameraAspect,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
        projection: CAMERA_PROJECTION_PERSPECTIVE,
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
      },
    },
  );

  const startRes = app.start();
  if (!startRes.ok) {
    console.error('[learn-render 1.6 coordinate-systems] app.start failed:', startRes.error);
    return;
  }
  console.warn('[learn-render 1.6 coordinate-systems] Standard pipeline active');
}

function reportBootstrapError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(
      `[learn-render 1.6 coordinate-systems] EngineEnvironmentError: webgpu inner=${code}`,
    );
    return;
  }
  console.error(`[learn-render 1.6 coordinate-systems] ${err.code}: ${err.hint}`);
}
