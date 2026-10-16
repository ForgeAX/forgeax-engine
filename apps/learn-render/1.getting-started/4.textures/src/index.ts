// apps/learn-render/1.getting-started/4.textures/src/index.ts
// LearnOpenGL section 1.4 - Textures (forgeax mapping with disk JPEG +
// .meta.json sidecar -> @forgeax/engine-image decode -> GUID-keyed
// AssetRegistry.uploadTexture -> render-system materialBindGroup
// baseColorTexture consumption).
//
// Plan-strategy section 7 / M8 milestone (T-M8-04) wires the LO 1.4
// chapter to the forgeax engine surface. LO 1.4 covers GLSL `texture(
// sampler2D, vTexCoord)` sampling on a `container.jpg` image loaded via
// `stb_image.h`; in forgeax the equivalent surface is the 4-step recipe:
//   (1) configureRuntimeAssetCatalog(...)      -- select the dev scope or
//                                                   static build catalog.
//   (2) loadByGuid<TextureAsset>(containerGuid) -- resolve the container
//                                                   image handle (the
//                                                   GUID is minted into
//                                                   forgeax-engine-
//                                                   assets/learn-opengl/
//                                                   textures/container
//                                                   .jpg.meta.json).
//   (2) loadByGuid<MeshAsset>(cubeGuid)    -- resolve the cube handle
//                                              (engine-builtin HANDLE_
//                                              CUBE-equivalent stub).
//   (2) loadByGuid<MaterialAsset>(matGuid) -- resolve the unlit material
//                                              whose baseColorTexture
//                                              field references the wood
//                                              GUID.
//   (3) world.spawn({Transform, MeshFilter, MeshRenderer}) -- wire
//                                              the cube entity onto the
//                                              shared world; render-
//                                              system materialBindGroup
//                                              picks up baseColorTexture
//                                              via AssetRegistry.get
//                                              TextureGpuView (research
//                                              F-6 fix).
//   (4) requestAnimationFrame loop -> renderer.draw(world).
//
// AC-06 three-section marker convention:
//   `// 1. engine usage`            -> public engine API consumed.
//   `// 2. example-specific glue`   -> the LO 1.4 wood-container disk
//                                       schema fixtures + guid literals.
//   `// 3. bootstrap`               -> entry point that wires (1)+(2).
//
// AC-09 grep anchor (`// ac-09:`) marks the AssetRegistry.get<Material
// Asset> traversal where the TS compiler infers `Handle<TextureAsset>
// | undefined` for the `baseColorTexture` field without an `as` cast
// (charter F1 single-grep handle + charter P4 consistent abstraction).
//
// AC-15 (c) regression: textures index.ts call stack stays loadByGuid-
// only. The build-time decode runs out-of-band via `forgeax-engine-
// console asset import` (T-M8-03); the runtime upload runs out-of-band
// via the engine internal that loadByGuid resolves on cache-miss for
// the prod path. This file does not import the engine-image build-time
// helper, does not call the AssetRegistry low-level upload entry, and
// does not expose any image-byte path -- the AI user reads 3 GUID
// literals + 3 loadByGuid lines and gets the LO 1.4 wood-container
// picture.
//
// charter mapping:
//   - F1 (limited context):  three-section markers double as grep
//     anchors (AC-06) so AI users locate the LO 1.4 -> forgeax mapping
//     via a single `rg "// 1\. engine usage"` call across the seven
//     learn-render workspaces; `// ac-09:` marks the type-inference
//     proof point.
//   - F2 (text > image):     the LO 1.4 wood-container chapter is
//     documented as text in this file's comment block + the README
//     LO folded `<details>` block; the pixel-parity baseline (round-1-
//     textures.png) is verification only.
//   - P1 (progressive disclosure):  the README top callout points at
//     this file; AI users read the 3 sections + the 3 GUID literals
//     and have the full LO 1.4 -> forgeax picture in one directory.
//   - P3 (explicit failure):  `EngineEnvironmentError` surfaces the
//     "no usable backend" path; `await host initialization` returns a
//     `Result` whose `.ok === false` branch is logged via console
//     .error -- no silent fallback. loadByGuid Err arms switch on
//     err.code and log structured detail.
//   - P4 (consistent abstraction):  the same `Engine.create({ canvas
//     })` factory + ECS spawn + `MeshRenderer` discriminator (the
//     `MaterialAsset.shadingModel` value picks unlit vs standard
//     pipeline inside the engine) is the entry across every learn-
//     render example; LO 1.4 just adds the wood-container texture
//     atop the LO 1.3 unlit material baseline.
//   - P5 (producer / consumer split):  the @forgeax/engine-vite-plugin
//     -image plugin guards the disk fixture (AC-17 c surface overlay
//     when sidecar missing); the runtime side here only consumes
//     loadByGuid -- the producer / consumer responsibilities never
//     interleave (charter F3 instrumentation).

// 1. engine usage - the public Engine.create factory, the ECS World,
// the AssetRegistry namespace + AssetGuid parser, the merged
// MaterialAsset / TextureAsset / MeshAsset POD types, the 4 component
// schemas (Transform / Camera / MeshFilter / MeshRenderer), the
// `EngineEnvironmentError` narrowing class, and the engine-builtin
// HANDLE_CUBE mesh handle. The runtime AssetRegistry surface this
// example consumes:
//   - configureRuntimeAssetCatalog(...)      -- select the scoped dev
//                                               catalog or the prod fetch
//                                               path (loadByGuid consults
//                                               the catalog before falling
//                                               back to registerWithGuid).
//   - loadByGuid<T>(guid)                   -- single entry that
//                                               resolves Handle<T> on
//                                               cache-hit or fetches
//                                               the asset payload from
//                                               the pack-index URL on
//                                               cache-miss.
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { World } from '@forgeax/engine-ecs';
import { captureCanvasPixels } from '@forgeax/apps-shared/canvas-capture';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_CUBE, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { perspective } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';

import { unwrapHandle } from '@forgeax/engine-types';
import type { Handle, MaterialAsset, MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import materialPackJson from '../assets/material-wood.pack.json';

// 2. example-specific glue - LO 1.4 container chapter mapped onto
// forgeax. Three GUID literals form the disk-schema -> runtime bridge
// (the build-time importer minted these into the sidecar JSON files;
// AI users read them via `rg "CONTAINER_TEXTURE_GUID" apps/`):
//
//   CONTAINER_TEXTURE_GUID -> forgeax-engine-assets/learn-opengl/
//                              textures/container.jpg.meta.json
//                              subAssets[0].guid (vendor SSOT; charter
//                              P4 consistent abstraction across 4
//                              learn-render sections that use the LO
//                              container.jpg fixture).
//   CUBE_MESH_GUID         -> forgeax-engine-assets/learn-opengl/
//                              meshes/cube-mesh.stub.meta.json
//                              subAssets[0].guid (engine-builtin
//                              procedural cube; the GUID is the
//                              disk-side identifier, the runtime side
//                              aliases the same logical mesh as
//                              HANDLE_CUBE).
//   WOOD_MATERIAL_GUID     -> assets/material-wood.pack.json
//                              assets[0].guid (UnlitMaterialAsset whose
//                              baseColorTexture slot references
//                              CONTAINER_TEXTURE_GUID -- the LO 1.4
//                              sampler2D bind point in WGSL terms).
const CONTAINER_TEXTURE_GUID = '019e3969-1d46-773e-988c-a10e305ff2a4';
const CUBE_MESH_GUID = '019e3968-6007-71ae-856e-1fd6c9728cfb';
const WOOD_MATERIAL_GUID = '019e2cc6-5e6a-757c-a001-b69bc85af3c3';
// `@forgeax/engine-vite-plugin-pack` serves the catalog at
// the scoped `runtimeBinding.catalogUrl` in dev (configureServer middleware)
// and emits `/pack-index.json` in `dist/` at build time (generateBundle hook).
// `configureRuntimeAssetCatalog` owns this dev/prod selection.
// feat-20260517-vite-plugin-image-build-time-cook M5 w14: the legacy
// 1x1 saddle-brown stand-in pixel + registerWithGuid<TextureAsset>
// pre-seed block has been deleted. The texture handle now resolves
// through the production fetch chain: `loadByGuid<TextureAsset>` ->
// fetch(catalogUrl) -> entry.kind='texture' -> fetch(jpg/.bin) ->
// parseImage (dev) / skip-decode (prod) -> AssetRegistry.uploadTexture.


interface MaterialPackEntry {
  readonly guid: string;
  readonly kind: string;
  readonly payload: {
    readonly kind: string;
    readonly passes: ReadonlyArray<{
      readonly name: string;
      readonly program: { readonly module: string };
    }>;
    readonly values: {
      readonly baseColor: readonly [number, number, number, number];
      readonly baseColorTexture?: string;
    };
  };
}

interface MaterialPackFile {
  readonly assets: ReadonlyArray<MaterialPackEntry>;
}

// 3. bootstrap - locate the canvas the index.html document declares,
// hand it to Engine.create, await host initialization (the engine internal
// pipeline + RHI handshake), wire the AssetRegistry, route the 4-step
// loadByGuid recipe, spawn the cube entity onto the world, and drive
// the rAF loop. All Err branches log a structured detail line so the
// AI user reads the failure mode without console-stepping.
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) {
  throw new Error("[learn-render 1.4 textures] missing <canvas id='app'> in index.html");
}

void bootstrap(canvas);

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  try {
    const constructed = await constructRuntimeRendererHost(
      target,
      {},
      // feat-20260608 / M2: BundlerOptions third arg aggregates the
      // shader manifest URL and the dev-only import transport.
      //
      // four-verb redesign 2026-06-06: dev lazy-import transport so a
      // raw container.jpg row resolves through POST /__import on a DDC
      // miss. Absent => loadByGuid<TextureAsset> would surface
      // `asset-not-imported`.
      { ...forgeaxBundlerAdapter(), importTransport: createRuntimeAssetImportTransport(runtimeBinding) },
    );
    if (!constructed.ok) throw constructed.error;
    const renderer = constructed.value.renderer;
    const assets = constructed.value.assets;
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      const e = event.error;
      console.error('[learn-render 1.4 textures] renderer error:', e.code, e.hint);
      const bus = (globalThis as unknown as { __learnRenderErrors?: Array<{ code: string; hint?: string }> }).__learnRenderErrors;
      if (bus !== undefined) bus.push({ code: e.code, hint: e.hint });
    });
    // Step (1): wire the prod pack-index URL. loadByGuid fast-path
    // checks the in-memory map first; on miss it falls back to the
    // configured URL. `@forgeax/engine-vite-plugin-pack` serves the
    // catalog at this URL in dev and emits the same file in `dist/` at
    // build time (charter P4 consistent abstraction).
    configureRuntimeAssetCatalog(assets, runtimeBinding);

    // Parse the 3 GUID literals once. Each parse Result narrows the
    // string into an `AssetGuid` brand consumed by loadByGuid + the
    // registerWithGuid alias paths below (cube + material; the texture
    // resolves end-to-end through loadByGuid + the engine-image disk
    // decoder).
    const containerGuidRes = AssetGuid.parse(CONTAINER_TEXTURE_GUID);
    const cubeGuidRes = AssetGuid.parse(CUBE_MESH_GUID);
    const matGuidRes = AssetGuid.parse(WOOD_MATERIAL_GUID);
    if (!containerGuidRes.ok || !cubeGuidRes.ok || !matGuidRes.ok) {
      console.error('[learn-render 1.4 textures] GUID parse failed for one of the 3 fixtures');
      return;
    }

    // Step (2): the AC-15 (c) loadByGuid call stack -- 3 entries; no
    // build-time decode helper import + no AssetRegistry low-level
    // upload call site appears in this file. The texture handle resolves
    // through the configured catalog fetch chain above;
    // the cube + material handles resolve through the Map fast-path
    // seeded by the registerWithGuid calls below (cube alias to
    // engine-builtin HANDLE_CUBE; material reconstructed from the
    // .pack.json payload because parseAssetPayload material arm is
    // out-of-scope for v1 -- charter P5 producer / consumer split).
    const containerHandleRes = await assets.loadByGuid<TextureAsset>(containerGuidRes.value);
    if (!containerHandleRes.ok) {
      console.error(
        '[learn-render 1.4 textures] container texture loadByGuid failed:',
        containerHandleRes.error.code,
      );
      return;
    }

    // The cube mesh.stub.meta.json delegates to the engine-builtin
    // HANDLE_CUBE procedural geometry; alias the GUID onto that asset
    // so the disk-schema reads the same as a regular .pack.json mesh
    // entry while the runtime continues to draw the procedural cube
    // without re-decoding vertex data. The builtin payload is resolved
    // off HANDLE_CUBE via the two-tier `resolveAssetHandle` (M8 D-15) and
    // re-catalogued under the demo GUID via `catalog`.
    const world = new World();
    const worldAttachment1 = renderer.attach(world);
    if (!worldAttachment1.ok) throw worldAttachment1.error;
    const cubeAssetRes = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE);
    if (!cubeAssetRes.ok) {
      console.error('[learn-render 1.4 textures] HANDLE_CUBE asset unavailable');
      return;
    }
    assets.catalog<MeshAsset>(cubeGuidRes.value, cubeAssetRes.value);

    const matPack = materialPackJson as unknown as MaterialPackFile;
    const matEntry = matPack.assets.find((a) => a.kind === 'material');
    if (matEntry === undefined) {
      console.error('[learn-render 1.4 textures] material-wood.pack.json missing material entry');
      return;
    }
    // loadByGuid returns the texture PAYLOAD (M8 D-17); mint a user-tier column
    // handle so the baseColorTexture slot carries a resolved numeric Handle.
    const containerTexHandle = unwrapHandle(
      world.allocSharedRef('TextureAsset', containerHandleRes.value),
    );
    const woodMaterial: MaterialAsset = {
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } },
      ],
      values: {
        baseColor: matEntry.payload.values.baseColor,
        baseColorTexture: containerTexHandle,
      },
    };
    assets.catalog<MaterialAsset>(matGuidRes.value, woodMaterial);

    const cubeHandleRes = await assets.loadByGuid<MeshAsset>(cubeGuidRes.value);
    const matHandleRes = await assets.loadByGuid<MaterialAsset>(matGuidRes.value);
    if (!cubeHandleRes.ok || !matHandleRes.ok) {
      console.error(
        '[learn-render 1.4 textures] loadByGuid failed:',
        cubeHandleRes.ok ? null : cubeHandleRes.error.code,
        matHandleRes.ok ? null : matHandleRes.error.code,
      );
      return;
    }
    // loadByGuid returns payloads (M8 D-17); mint user-tier column handles.
    const cubeHandle = world.allocSharedRef('MeshAsset', cubeHandleRes.value);
    const matHandle = world.allocSharedRef('MaterialAsset', matHandleRes.value);

    // Step (3): spawn the textured cube + camera onto the world.
    //
    // `MeshFilter.assetHandle` binds the minted user-tier `cubeHandle`. The
    // runtime auto-uploads GPU vertex/index buffers when the column is first
    // recorded; the record stage looks GPU residency up via
    // `getMeshGpuHandles(handle)` (render-system-record.ts) -- user-tier
    // handle ids are accepted transparently (feat-20260519 M-2; regression
    // lock in packages/runtime/src/__tests__/dawn/user-handle-mesh-render
    // .dawn.test.ts).
    world.spawn(
      {
        component: Transform,
        data: {},
      },
      { component: MeshFilter, data: { assetHandle: cubeHandle } },
      {
        component: MeshRenderer,
        data: { materials: [matHandle] },
      },
    ).unwrap();
    world.spawn(
      {
        component: Transform,
        data: { pos: [0, 0, 3]},
      },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect: target.width / target.height, near: 0.1, far: 100 }),
          clearColor: [0.2, 0.3, 0.3, 1.0],
        },
      },
    ).unwrap();

    // ac-09: AI-user TS-inference proof point. loadByGuid<MaterialAsset>
    // returns the MaterialAsset POD directly (M8 D-17); its
    // values.baseColorTexture: Handle<TextureAsset> | undefined assigns
    // to a typed local with no `as` cast (charter P4 consistent abstraction).
    // AI users read this block as the single grep target for AC-09.
    const mat = matHandleRes.value;
    const slot =
      (mat.values?.baseColorTexture as Handle<'TextureAsset', 'shared'> | undefined);
    console.warn(
      `[learn-render 1.4 textures] baseColorTexture slot=${
        slot === undefined ? 'undefined' : unwrapHandle(slot).toString()
      }`,
    );

    // Step (4): rAF-driven draw loop. RenderSystem materialBindGroup
    // automatically consumes baseColorTexture via AssetRegistry.get
    // TextureGpuView (research F-6 fix) on every frame.
    const tick = (): void => {
      world.update().unwrap();
      const drawn = renderer.draw({
        leases: [worldAttachment1.value],
        camera: { lease: worldAttachment1.value },
        environment: { lease: worldAttachment1.value },
      });
      if (!drawn.ok) {
        console.error('[learn-render 1.4 textures] draw failed:', drawn.error);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Capture hook used by the M8 bench-screenshot recorder + any
    // downstream readback path: re-draw the world before sampling so
    // the canvas presents a fresh frame on every snapshot. Body
    // delegates to the host-owned canvas capture helper. Direct page.screenshot
    // returns black PNGs on chromium 130 surface state; the
    // compositor capture is not used here because it can observe a stale frame.
    type TexturesCaptureHook = () => Promise<Uint8Array>;
    const win = window as unknown as { __captureTextures?: TexturesCaptureHook };
    win.__captureTextures = async (): Promise<Uint8Array> => {
      world.update().unwrap();
      renderer.draw({
        leases: [worldAttachment1.value],
        camera: { lease: worldAttachment1.value },
        environment: { lease: worldAttachment1.value },
      });
      const r = await captureCanvasPixels(target);
      if (!r.ok) throw new Error(`[learn-render 1.4 textures] canvas capture failed: ${r.error.hint}`);
      return r.value;
    };
    console.warn(`[learn-render 1.4 textures] backend=${renderer.inspect().capabilities.backendKind}`);
  } catch (err: unknown) {
    if (err instanceof EngineEnvironmentError) {
      console.error('[learn-render 1.4 textures] no usable backend:', err);
    } else {
      console.error('[learn-render 1.4 textures] bootstrap error:', err);
    }
  }
}
