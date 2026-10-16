import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { Update } from '@forgeax/engine-ecs';
// apps/hello/sprite -- 2D sprite + Layer + transparent-sort double-scene
// demo (feat-20260520-2d-sprite-layer-mvp / M-4 / w29; AC-12).
//
// What this demo exercises end-to-end (charter F1 progressive disclosure):
//   - sprite material via pass-based MaterialAsset (feat-20260524 OOS-7
//     in-main migration) -- `passes: [{ program: { module: 'forgeax::sprite' } }]`
//     + `values: { texture, sampler, baseColor, region?, pivot?,
//     flipX?, flipY?, slices?, sliceMode? }`. No sibling type.
//   - HANDLE_QUAD (M-1 / w06) -- the 3rd builtin mesh handle (12-float
//     interleaved layout, same as HANDLE_CUBE / HANDLE_TRIANGLE).
//   - Layer + SortKey components (M-2 / w11 + w12) -- i32 layer order +
//     optional f32 per-entity sort override.
//   - TransparentSortConfig KV resource (M-2 / w14) -- mode + yzAlpha
//     selector for the 3 sort formulas (layer-z / layer-y / layer-yz).
//   - sprite.wgsl (M-3 / w19) + alpha-blend pipeline (M-3 / w24) +
//     RenderSystem three-bucket dispatch (M-3 / w22) + transparent CPU
//     sort (M-3 / w23).
//   - createApp(canvas, opts) (feat-20260518-app-shell-game-loop) --
//     second consumer of the canvas thin-wrapper that lands rAF +
//     auto input-attach + Time resource on a one-screen takeoff.
//   - Renderer.input.snapshot(world) (feat-20260519 V-2) -- first-class
//     frozen-snapshot facade for keyboard / mouse-wheel switching.
//   - loadByGuid<TextureAsset> + configureRuntimeAssetCatalog
//     (feat-20260517-vite-plugin-image-build-time-cook) -- the
//     wood-container.jpg imports at build time, runtime side never
//     touches an image decoder.
//
// Two scenes (charter F1 sub-example index, mirrored in README.md):
//
//   | Scene | mode | pivot       | Visual                         |
//   |:------|:----:|:------------|:-------------------------------|
//   | A     |  0   | [0.5, 0.5]  | horizontal layer-z; 3 sprites  |
//   |       |      |             | crossed by Layer {-100,0,100}   |
//   |       |      |             | (background / mid / foreground) |
//   | B     |  1   | [0.5, 1.0]  | JRPG foot-pivot Y-sort; 3       |
//   |       |      |             | sprites whose draw order        |
//   |       |      |             | follows world-Y                 |
//
// Switching (charter F2 wheel/key as text-equivalent secondary signal):
//   keyboard '1' -> scene-A           keyboard '2' -> scene-B
//   mouse-wheel up  -> scene-B (JRPG) mouse-wheel down -> scene-A (layer-z)
//
// D-5 (plan-strategy): the 3 sprites share a single texture
// (wood-container.jpg analogue) and are visually disambiguated through
// 3 colorTints (warm red / fresh green / cool blue). Zero new asset
// vendor cost (the JPG + sidecar copy under ./assets/ mirrors the
// learn-render-1.4-textures pinned-asset carve-out so the demo stays
// self-contained when the forgeax-engine-assets submodule is not
// initialised in the worktree).
//
// charter mapping:
//   F1 -- AGENTS-style 4-step recipe lives at the top of bootstrap();
//         README sub-example index table mirrors the JSDoc table above.
//   P3 -- every Result.err path logs `.code` + `.hint` via console.error
//         (never .message string parsing); `setTransparentSortConfig`
//         returns Result<void, ResourceInvalidValueError> and is
//         consumed via the structured property path.
//   P4 -- sprite + 3D PBR share the same `MeshFilter + MeshRenderer`
//         entry (zero new component); the demo never imports a
//         SpriteRenderer / 2D-only surface (charter P4 consistent
//         abstraction; Bevy 0.19 SpriteBundle retracement is avoided).
//
// feat-20260626-sprite-transparent-collapse-to-bare-renderstate-blend
// M3 — post M1/M2 SSOT collapse:
//   - Pass-side `renderState.blend` is the SSOT for premultiplied-alpha
//     blend pipeline selection + LDR pass split (Q3=b). The legacy
//     `transparent` boolean flag (ablated in feat-20260625 M2 + collapsed
//     in this feat M1) used to imply the premultiplied preset; demos
//     now declare the blend preset directly via the
//     `SPRITE_PREMULTIPLIED_ALPHA_BLEND` named constant re-exported
//     from `@forgeax/engine-runtime`. Passes that omit `renderState`
//     render through the opaque geometry pass.
//   - values field names are UBO-aligned to sprite.material.json
//     paramSchema 1:1 (D-4): colorTint (was baseColor),
//     baseColorTexture (was texture), pivotAndSize vec4 (was pivot +
//     size split), slicesAndMode vec4 (was slices + sliceMode split;
//     tile sentinel = negative .w).
//   - Transform.scale numeric values updated for visual equivalence
//     under the F-4 unit-quad change (scale^2 -> scale^1): the sprite
//     quad is a local-space unit quad and world scale flows entirely
//     through GlobalTransform.world. New scale = old scale^2 keeps the same
//     screen footprint (0.4 -> 0.16, [0.3,0.18] -> [0.09,0.0324],
//     [0.6,0.4] -> [0.36,0.16]).

import type { App, CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import type { World } from '@forgeax/engine-ecs';
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { HANDLE_NINESLICE_QUAD, HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { Transform } from '@forgeax/engine-scene';

import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { orthographic } from '@forgeax/engine-render';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import {
  TransparentSort,
  SPRITE_PREMULTIPLIED_ALPHA_BLEND,
} from '@forgeax/engine-render/authoring';
import { Layer } from '@forgeax/engine-render';

import { type Handle, type MaterialAsset, type TextureAsset } from '@forgeax/engine-types';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

// D-5 SSOT: the wood-container disk-schema GUID is the same identifier
// learn-render-1.4-textures uses (the build-time importer stamps it
// into wood-container.meta.json subAssets[0].guid). Reusing the
// same GUID across demos is "zero new vendor cost" cashed out (the
// sidecar JSON is identical to the upstream submodule copy, just stored
// locally under ./assets/ so the demo loads with or without
// --recurse-submodules).
const WOOD_TEXTURE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';

// 3 colorTints disambiguate the 3 sprites in either scene. The values
// are mid-saturation so the wood-container texture remains visible
// under multiplicative tinting (charter F2 visual signals stay
// secondary to text; the colors are mnemonic not semantic).
const SPRITE_COLOR_TINTS = [
  [1.0, 0.4, 0.4, 1.0], // sprite-0: warm red
  [0.4, 1.0, 0.4, 1.0], // sprite-1: fresh green
  [0.4, 0.4, 1.0, 1.0], // sprite-2: cool blue
] as const;

const SPRITE_PARAMETERS = [
  { name: 'colorTint', type: 'vec4' },
  { name: 'region', type: 'vec4' },
  { name: 'pivotAndSize', type: 'vec4' },
  { name: 'slicesAndMode', type: 'vec4' },
  { name: 'baseColorTexture', type: 'texture' },
] as const;

// scene-A: 3 sprites at distinct Layer values along Z; pivot=[0.5, 0.5]
// (geometric centre). The Layer values { -100, 0, 100 } cross zero so a
// negative-Layer regression in the sort code (charter P3 explicit
// failure: a sign flip on Layer would invert background / foreground)
// is caught visually in one frame.
const SCENE_A: ReadonlyArray<{
  layer: number;
  pos: readonly [number, number, number];
}> = [
  { layer: -100, pos: [-0.4, -0.1, -0.5] }, // background
  { layer: 0, pos: [0.0, 0.0, 0.0] }, // mid
  { layer: 100, pos: [0.4, 0.1, 0.5] }, // foreground
];

// scene-B: 3 sprites at the same Layer (0) but staggered along Y;
// pivot=[0.5, 1.0] (foot pivot, JRPG Y-sort convention -- the sprite's
// "depth" is measured at the bottom edge so a character "behind" stands
// further up the screen and draws first).
const SCENE_B: ReadonlyArray<{
  layer: number;
  pos: readonly [number, number, number];
}> = [
  { layer: 0, pos: [-0.4, 0.3, 0.0] }, // far / top of screen
  { layer: 0, pos: [0.0, 0.0, 0.0] }, // mid
  { layer: 0, pos: [0.4, -0.3, 0.0] }, // near / bottom of screen
];

type SceneId = 'A' | 'B';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) {
  throw new Error('[sprite] missing <canvas id="app"> in index.html');
}

bootstrap(canvas).catch((err: unknown) => {
  if (err instanceof EngineEnvironmentError) {
    console.error('[sprite] no usable WebGPU backend:', err);
  } else {
    console.error('[sprite] bootstrap error:', err);
  }
});

async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // Step 1: createApp(canvas, opts) -- one-screen takeoff (feat-20260518
  // shell); the app owns the rAF frame-loop + Time resource + auto
  // input-attach. clearColor is a neutral dark slate so the sprite
  // alpha-blend (premultiplied) reads cleanly against the background.
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
  console.warn(`[sprite] backend=${app.renderer.inspect().capabilities.backendKind}`);


  const assets = app.assets;
  if (assets === undefined) {
    console.error(
      '[sprite] AssetRegistry is null (renderer construction did not complete successfully)',
    );
    return;
  }
  configureRuntimeAssetCatalog(assets, runtimeBinding);
  const world = app.world;

  // Step 2: resolve the wood-container texture through the production
  // loadByGuid fetch chain (returns the payload, D-17), then mint a
  // user-tier column handle. The vite-plugin-pack build-time import step
  // emits the decoded RGBA bytes, and the runtime side here just consumes
  // the GUID.
  const woodGuidRes = AssetGuid.parse(WOOD_TEXTURE_GUID);
  if (!woodGuidRes.ok) {
    console.error('[sprite] WOOD_TEXTURE_GUID parse failed:', woodGuidRes.error.code);
    return;
  }
  const texHandleRes = await assets.loadByGuid<TextureAsset>(woodGuidRes.value);
  let textureHandle: Handle<'TextureAsset', 'shared'> | undefined;
  if (texHandleRes.ok) {
    textureHandle = world.allocSharedRef('TextureAsset', texHandleRes.value);
  } else {
    // charter P3 explicit failure: the sprite bucket warn-once
    // path (render-system-record.ts AC-18 path 4) will fire when the
    // material binds an unresolved handle. We log the loadByGuid
    // failure once at boot so the AI user reading the console can
    // distinguish the bootstrap miss from the per-frame warn.
    console.warn(
      '[sprite] wood-container texture loadByGuid failed (continuing with debug-pink fallback):',
      texHandleRes.error.code,
    );
  }

  // Step 3: mint the default linear-filter sampler. The sprite
  // material's `sampler` slot is non-optional (AC-01); minting one
  // shared sampler is the minimum-surface route. addressMode='repeat'
  // mirrors wood-container.meta.json importSettings (linear /
  // repeat / mipmap=auto SSOT).
  // The 3 sprite materials per scene share the same texture + sampler
  // but differ in `pivot`. We pre-mint 6 handles (3 colors x 2
  // pivots) at boot so scene switching does not re-mint material
  // assets every frame. If textureHandle is undefined the material
  // still mints cleanly -- the sprite bucket missing-texture
  // warn-once path takes over at the record stage (charter P3).
  const materialHandles: Record<SceneId, Handle<'MaterialAsset', 'shared'>[]> = {
    A: [],
    B: [],
  };
  const PIVOT_BY_SCENE: Record<SceneId, readonly [number, number]> = {
    A: [0.5, 0.5],
    B: [0.5, 1.0],
  };
  for (const sceneId of ['A', 'B'] as const) {
    for (let i = 0; i < 3; i++) {
      const tint = SPRITE_COLOR_TINTS[i] ?? SPRITE_COLOR_TINTS[0];
      const material = buildSpriteMaterial({
        texture: textureHandle,
        colorTint: tint,
        pivot: PIVOT_BY_SCENE[sceneId],
      });
      materialHandles[sceneId].push(world.allocSharedRef('MaterialAsset', material));
    }
  }


  // Step 4: orthographic camera with tonemap='none' (zero-overhead
  // path). The HDR (reinhard-extended) crossings are gated by the
  // dawn smoke matrix (w30) rather than a runtime toggle on this demo
  // -- adding a third axis (scene x tonemap) on top of the keyboard
  // switch would crowd the AI-user discovery surface (charter F1
  // limited context).
  world.spawn(
    {
      component: Transform,
      data: { pos: [0, 0, 5]},
    },
    {
      component: Camera,
      data: orthographic({
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
        near: 0.1,
        far: 100,
      }),
    },
  ).unwrap();

  // Track the entities of the currently-spawned scene so a switch can
  // despawn them cleanly before respawning. Single Array (not a Set)
  // because the order matches scene definitions for grep-friendly
  // debug logging.
  let activeEntities: Array<ReturnType<World['spawn']>> = [];
  let currentScene: SceneId = 'A';

  // feat-20260527-sprite-nineslice / M5 / w19 (AC-11): the 9-slice
  // section coexists with the region+quad scenes above in a visually
  // disjoint screen band so the AI user reading this demo sees both
  // sprite idioms side by side without one mode masking the other.
  // The 9-slice entities are spawned once at boot and persist across
  // applyScene() switches (they sit at world-Y = +0.7 / -0.7 which
  // never overlaps the scene-A/B sprites at world-Y in [-0.3, 0.3]).
  setupNineSliceSection(world, textureHandle);

  // Apply scene-A as the initial configuration (mode=0 layer-z).
  applyScene('A');

  // Step 5: scene-switch system. Reads InputSnapshot every frame and
  // toggles the active scene on '1' / '2' edges or mouse-wheel notches.
  // The system runs after the engine-input frame-start scan so the
  // edges are fresh; charter P4 consistent abstraction -- same
  // Read the frame-start snapshot owned by the Input package.
  world.addSystem(Update, {
    name: 'hello-sprite-scene-switcher',
    after: ['input-frame-start-scan'],
    queries: [],
    fn: () => {
      const snap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
      // up-edge ('1' / '2') is one-frame-deep so a sustained key press
      // does not flicker. mouse-wheel notch is sign-discrete (D-5):
      // positive = scroll down = scene-A (layer-z), negative = scroll
      // up = scene-B (JRPG). The ladder evaluates in deterministic
      // priority order so simultaneous '1' + wheel-up still picks the
      // most-recent key.
      if (snap.keyboard.up('1')) {
        applyScene('A');
        return;
      }
      if (snap.keyboard.up('2')) {
        applyScene('B');
        return;
      }
      if (snap.mouse.wheelDelta > 0) {
        applyScene('A');
      } else if (snap.mouse.wheelDelta < 0) {
        applyScene('B');
      }
    },
  });

  // Final wire: arm the rAF loop. createApp's frame-loop tracks the
  // World update cadence via Time + dispatches to RenderSystem each
  // tick.
  const startRes = app.start();
  if (!startRes.ok) {
    reportAppError(startRes.error);
    return;
  }
  console.warn('[sprite] running. Press 1 / 2 to switch scenes.');

  // --------------- helpers ---------------------------------------------

  function applyScene(target: SceneId): void {
    // Despawn the entire previous scene before reinstalling the new
    // sort config. The order matters because TransparentSortCache
    // reads the world resource at render time; flipping the mode
    // mid-frame would otherwise sort the previous scene's entries
    // against the new formula for one tick.
    for (const r of activeEntities) {
      if (r.ok) world.despawn(r.value);
    }
    activeEntities = [];

    const newMode = target === 'A' ? TransparentSort.layerZ : TransparentSort.layerY;
    const cfgRes = TransparentSort.configure(world, { mode: newMode, yzAlpha: 1.0 });
    if (!cfgRes.ok) {
      // charter P3 structured failure: read .code / .expected / .hint
      // properties; never parse .message. Should be unreachable -- the
      // two constants live in the valid {0, 1, 2} set by construction.
      console.error(
        '[sprite] setTransparentSortConfig rejected:',
        cfgRes.error.code,
        cfgRes.error.expected,
        cfgRes.error.hint,
      );
      return;
    }

    const def = target === 'A' ? SCENE_A : SCENE_B;
    for (let i = 0; i < def.length; i++) {
      const slot = def[i];
      const matHandle = materialHandles[target][i];
      if (slot === undefined || matHandle === undefined) continue;
      const r = world.spawn(
        {
          component: Transform,
          data: {
            pos: [slot.pos[0], slot.pos[1], slot.pos[2]], scale: [0.16, 0.16, 1],},
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
        { component: MeshRenderer, data: { materials: [matHandle] } },
        { component: Layer, data: { value: slot.layer } },
      );
      activeEntities.push(r);
    }
    currentScene = target;
    console.warn(
      `[sprite] scene=${currentScene} mode=${
        newMode === TransparentSort.layerZ ? 'layer-z' : 'layer-y'
      }`,
    );
  }
}

function buildSpriteMaterial(args: {
  texture: Handle<'TextureAsset', 'shared'> | undefined;
  colorTint: readonly [number, number, number, number];
  pivot: readonly [number, number];
}): MaterialAsset {
  const texture = args.texture ?? (0 as unknown as Handle<'TextureAsset', 'shared'>);
  // feat-20260626-sprite-transparent-collapse M3 — post M1/M2 SSOT
  // collapse: sprite is a regular MaterialAsset whose pass-side
  // `renderState.blend` drives the LDR split + premultiplied-alpha
  // blend pipeline. The legacy `transparent` boolean flag (ablated in
  // feat-20260625 M2 + collapsed in this feat M1) used to imply this
  // preset; post-collapse the demo declares the
  // `SPRITE_PREMULTIPLIED_ALPHA_BLEND` constant directly.
  //
  // values uses UBO-aligned field names that match sprite.wgsl.meta.
  // json paramSchema 1:1 (M3 / w11, D-4): colorTint (was baseColor),
  // baseColorTexture (was texture). region/pivot are folded into
  // pivotAndSize via the extract-stage compat path; here we declare
  // pivotAndSize directly to keep the demo aligned with the post-w11
  // SSOT (no reliance on the compat fold).
  return {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND }, tags: { LightMode: 'Forward' }, queue: 3000 } },
    ],
    parameters: SPRITE_PARAMETERS,
    values: {
      colorTint: args.colorTint,
      baseColorTexture: texture,
      pivotAndSize: [args.pivot[0], args.pivot[1], 1, 1],
    },
  };
}

// feat-20260527-sprite-nineslice / M5 / w19 — 9-slice section helper.
//
// Spawns 3 entities into `world` exercising the two 9-slice sliceMode
// values on the same MaterialAsset shader id (`forgeax::sprite`,
// charter P4 consistent abstraction; D-1 plan-strategy: no
// sibling sprite-only asset type — the unified pass-based MaterialAsset
// surface carries the 9-slice fields directly, no parallel asset
// kind).
//
//   panel-stretch (sliceMode=0): 2 entities with the same material
//     handle but different Transform.scale[xy] so the AI user reading
//     the demo verifies AC-06 (one material, many sizes, four corners
//     stay pixel-fixed). Top band of the screen (y=+0.7).
//   panel-tile    (sliceMode=1): 1 entity at scale[xy] = N x cell-size
//     so the centre region tiles >=2 times (AC-07). Bottom band of
//     the screen (y=-0.7). The shared sampler in bootstrap() is
//     already configured with addressModeU/V='repeat' (D-4 plan
//     strategy) so the shader vs_main uv > 1 outputs wrap; the AI
//     user reading apps/hello/sprite/README.md FAQ row 3 also has the
//     same warning surface.
//
// D-6: no new PNG; the same wood-container texture handle from the
// region+quad scenes is reused as the 9-slice atlas region. The
// "circle corners do not stretch" expectation lives on the slice
// math + Transform.scale, not on the texture's visual identity
// (AC-15 panel-corners-preserved).
//
// D-1: values literal carries `slices` + `sliceMode` directly;
// the demo never imports a sprite-specific asset variant (a grep gate
// in w19 acceptanceCheck enforces zero hits in this file).
function setupNineSliceSection(
  world: World,
  textureHandle: Handle<'TextureAsset', 'shared'> | undefined,
): void {
  const texture = textureHandle ?? (0 as unknown as Handle<'TextureAsset', 'shared'>);

  // Stretch UI panel material: 4-corner anchors at 0.25 of region UV,
  // sliceMode=0 (stretch). Corners stay pixel-fixed at any scale; the
  // 4 edges stretch along their major axis only; centre stretches
  // bilinearly. Shared by both stretch entities below.
  //
  // feat-20260626-sprite-transparent-collapse M3 — post M1/M2 SSOT:
  //   - first-pass `renderState.blend` drives LDR split + blend pipeline
  //     (preset `SPRITE_PREMULTIPLIED_ALPHA_BLEND`).
  //   - values UBO-aligned: colorTint / baseColorTexture (was
  //     baseColor / texture), pivotAndSize vec4 (was pivot + size split),
  //     slicesAndMode vec4 (was slices + sliceMode split). Tile mode is
  //     sentinel-encoded on .w (negative = tile).
  const panelMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND }, tags: { LightMode: 'Forward' }, queue: 3000 } },
    ],
    parameters: SPRITE_PARAMETERS,
    values: {
      colorTint: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: texture,
      region: [0, 0, 1, 1],
      pivotAndSize: [0.5, 0.5, 1, 1],
      slicesAndMode: [0.25, 0.25, 0.25, 0.25], // .w>=0 -> stretch
    },
  });

  // Tile material: corners 0.30 of region UV, sliceMode=1 (tile). The
  // centre cell repeats N times along each axis when the entity's
  // Transform.scale[xy] is N x cell-size; the sampler.addressMode
  // 'repeat' lets the vs_main uv > 1 outputs wrap to multiple atlas
  // copies (D-4). Different `slices` value from the panel material
  // so the AI user can grep on these literal numbers and see the two
  // configurations side by side. Tile sentinel: slicesAndMode.w < 0.
  const tileMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
    kind: 'material',
    passes: [
      { name: 'Forward', program: { module: 'forgeax::sprite' }, renderState: { ...{ blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND }, tags: { LightMode: 'Forward' }, queue: 3000 } },
    ],
    parameters: SPRITE_PARAMETERS,
    values: {
      colorTint: [1.0, 1.0, 1.0, 1.0],
      baseColorTexture: texture,
      region: [0, 0, 1, 1],
      pivotAndSize: [0.5, 0.5, 1, 1],
      slicesAndMode: [0.3, 0.3, 0.3, -0.3], // .w<0 -> tile (sentinel)
    },
  });

  // 2 stretch panels: same material, different scale. AC-06 falsifier
  // is "the four corners stretch with scale" — visible in one frame.
  //
  // feat-20260625 M4 / w17 (D-6): scale^2 -> scale^1 visual-equivalence
  // remap. Old [0.3, 0.18] visual was [0.09, 0.0324]; the wide thin
  // panel and tall narrow panel keep the same screen footprint when the
  // post-w11 unit-quad path uses Transform.scale directly.
  const STRETCH_PANELS: ReadonlyArray<{
    pos: readonly [number, number, number];
    scale: readonly [number, number];
  }> = [
    { pos: [-0.5, 0.7, 0], scale: [0.09, 0.0324] }, // wide thin panel
    { pos: [0.5, 0.7, 0], scale: [0.0324, 0.09] }, // tall narrow panel
  ];
  for (const slot of STRETCH_PANELS) {
    world
      .spawn(
        {
          component: Transform,
          data: {
            pos: [slot.pos[0], slot.pos[1], slot.pos[2]], scale: [slot.scale[0], slot.scale[1], 1],},
        },
        { component: MeshFilter, data: { assetHandle: HANDLE_NINESLICE_QUAD } },
        { component: MeshRenderer, data: { materials: [panelMat] } },
        { component: Layer, data: { value: 200 } },
      )
      .unwrap();
  }

  // 1 tile entity: scale chosen so centre-cell repeats >= 2 times.
  // With slices=[0.3,0.3,0.3,0.3] the centre cell occupies the inner
  // 0.4 of the UV region; post-w11 scale^1 path keeps the same screen
  // footprint as the pre-w11 scale^2=[0.36, 0.16] visual size.
  world
    .spawn(
      {
        component: Transform,
        data: {
          pos: [0.0, -0.7, 0], scale: [0.36, 0.16, 1],},
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_NINESLICE_QUAD } },
      { component: MeshRenderer, data: { materials: [tileMat] } },
      { component: Layer, data: { value: 200 } },
    )
    .unwrap();
}

function reportAppError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[sprite] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  console.error(`[sprite] ${err.code}: ${err.hint}`);
}
