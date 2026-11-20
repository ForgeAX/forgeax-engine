<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.zh-CN.md)

# hello-sprite

> **This demo shows region+quad and 9-slice sprites side by side.** The upper area contains two differently sized stretch panels and a tiled brick; the lower area contains classic region+quad scenes A (horizontal layer-z) and B (JRPG foot-pivot Y-sort), switched by keys `1` / `2`. Both use `forgeax::sprite` and the same MaterialAsset entry; only `values.slices` / `sliceMode` differ (charter P4; feat-20260527-sprite-nineslice D-1). One demo exposes both authoring paths.

## Run locally

```bash
pnpm --filter @forgeax/hello-sprite dev      # vite dev server -> http://localhost:5193
pnpm --filter @forgeax/hello-sprite build    # vite production build
pnpm --filter @forgeax/hello-sprite smoke    # dawn-node 4-case matrix smoke (scene-A/B x tonemap-none/reinhard-extended)
```

## Controls

| Input | Action |
|:--|:--|
| `1` | switch to scene-A (mode=0 layer-z, horizontal) |
| `2` | switch to scene-B (mode=1 layer-y, JRPG Y-sort) |
| mouse-wheel down | switch to scene-A |
| mouse-wheel up   | switch to scene-B |

## Sub-example index

| Scene | mode (constant) | pivot | Visual |
|:-:|:--|:--|:--|
| A | `0` (`TRANSPARENT_SORT_MODE_LAYER_Z`)  | `[0.5, 0.5]` | 3 sprites at `Layer = {-100, 0, 100}` crossing the 0 axis; background draws first, foreground last; geometric-centre pivot |
| B | `1` (`TRANSPARENT_SORT_MODE_LAYER_Y`)  | `[0.5, 1.0]` | 3 sprites at same `Layer = 0` staggered along world-Y; foot-pivot Y-sort means a character behind (higher Y) draws first |

The two scenes share the same texture + the same 3 `colorTint` slots (warm red / fresh green / cool blue) so the visual identity of each sprite stays stable across switches. The difference is entirely in `Layer` + `pivot` + the world-resource `mode` field.

## Three Sections (feat-20260527-sprite-nineslice M5 / w19)

> Following charter F2, each section explains its visual/material combination before code, so region+quad, 9-slice stretch and 9-slice tile are understandable without screenshots.

### Section 1: Classic Region+Quad (Lower Half, Scenes A/B)

Three lower sprites share managed quad assets and forgeax::sprite. Their values omit slices/sliceMode; paramSchema supplies sentinels [0,0,0,0] / 0 and runtime recording uses ordinary bound quads (D-1 / D-2 early return). Keys 1/2 select layer-z scene A or foot-pivot layer-y JRPG scene B.

### Section 2: 9-Slice Stretch (Two Upper Panels)

The two stretch panels share **one MaterialAsset handle** and differ only in Transform.scale[xy]. AC-06 demonstrates one material across sizes with undeformed corners. Values:

```ts
{
  slices: [0.25, 0.25, 0.25, 0.25],  // [left, top, right, bottom], region-local UV 0..1
  sliceMode: 0,                       // 0 = stretch the center cell
}
```

`slices` uses **region-local UVs (0..1), not pixels**. For region:[0,0,1,1], slices:[0.25,...] reserves 25% at each corner of the atlas subregion. region.zw supplies its width/height. validateSpriteSlices enforces `slices.x + slices.z < region.z` / `slices.y + slices.w < region.y`.

> [!IMPORTANT]
> **Slice-order differences (charter F2):**
>
> | Framework | Order |
> |:--|:--|
> | **forgeax-engine** | `[left, top, right, bottom]` |
> | CSS border-image-slice | top right bottom left (clockwise, starting at top) |
> | Unity Sprite.border | Vector4(left, bottom, right, top) |
>
> Orders differ across frameworks. This Engine uses left-top-right-bottom to align with sprite UBO slicesAndMode.xyzw (D-3).

### Section 3: 9-Slice Tile (Bottom Brick)

The bottom brick has an **independent MaterialAsset**, slices:[0.3,0.3,0.3,0.3], sliceMode:1. Center repetition uses sampler.addressMode='repeat'; the shared sampler sets addressModeU/V:'repeat' (D-4). Transform.scale[xy]=N*cell-size repeats the center N times along the main axis:

```ts
{
  slices: [0.3, 0.3, 0.3, 0.3],
  sliceMode: 1,                       // 1 = repeat the center cell
}
```

> [!CAUTION]
> **sliceMode is numeric `0 | 1`, not a string.** Schema-driven UBO writes accept WGSL f32-compatible numbers; 'stretch' fails MATERIAL_PARAM_TYPES_V1 validation. With sliceMode:1 and a non-repeat sampler, Engine does not throw: host-owned AssetRegistry metrics report `app.assets?._getMetrics()?.snapshot()['nineslice.tile-needs-repeat-sampler']` (D-9 register-time soft warning), and appearance degrades to clamp-stretch.

## FAQ

<details>
<summary>How can a panel stay on top?</summary>

Combine Overlay queue (RenderQueue.Overlay=4000) and Layer: set the material pass queue to 4000 (high-Z bucket) and add Layer{value:9999}. Overlay draws after transparent queue 3000; within a queue, higher Layer values take priority.
</details>

<details>
<summary>How are slices values converted?</summary>

`slices` uses **region-local UV 0..1, not pixels**. For an atlas subregion region:[0,0,0.5,0.5] (upper-left quarter), slices:[0.25,0.25,0.25,0.25] reserves 25% of that subregion at each corner, corresponding to 0.5*0.25=12.5% in atlas coordinates. AssetError.hint provides exact region.zw values for checking.
</details>

<details>
<summary>Why does tile mode not repeat?</summary>

Usually the bound sampler lacks addressMode='repeat'. This demo's shared sampler sets addressModeU/V:'repeat'. In another project, inspect host-owned AssetRegistry metrics via app.assets?._getMetrics()?.snapshot(); nineslice.tile-needs-repeat-sampler>=1 means registration detected a mismatch. Set repeat and register again (D-9).
</details>

## 5-view selection table

> Mirrors the JSDoc table in `packages/render/src/systems/transparent-sort-config.ts` so AI users browsing this demo see the full mode landscape without leaving the workspace (charter F1 progressive disclosure).

| view              | mode | yzAlpha | sortValue formula                          |
|:------------------|:----:|:-------:|:-------------------------------------------|
| horizontal (side) |  0   |   ---   | `posZ`                                     |
| top-down          |  1   |   ---   | `-(posY - pivot.y * size.y)`               |
| Don't Starve      |  2   |   1.0   | `(posY - pivot.y * size.y) + posZ`         |
| isometric         |  2   |   0.5   | `(posY - pivot.y * size.y) + 0.5 * posZ`   |
| JRPG (foot pivot) |  1   |   ---   | `-(posY - pivot.y * size.y)`               |

> When `entry.sortKey !== undefined` the entry's `sortKey` REPLACES the mode formula's output; `Layer` remains the primary sort key. Use this to pin a specific sprite above / below the procedural ordering inside the same layer without reshaping the whole scene.

## Source roadmap

| Path | Purpose |
|:--|:--|
| `index.html` | `<canvas id="app">` host page + keyboard hint overlay |
| `src/main.ts` | `createApp(canvas, { clearColor })` bootstrap + `assets.load(guid, 'texture')` (wood-container.jpg analogue) + 6 sprite materials (3 colors x 2 pivots) + ortho Camera + `applyScene(target)` despawn-and-respawn switcher + scene-switch system reading `renderer.input.snapshot(world)` (`keyboard.up('1')` / `keyboard.up('2')` / `mouse.wheelDelta`) |
| `scripts/smoke-dawn.mjs` | dawn-node headless smoke; renders 4 cases (scene-A/B x `tonemap = 'none'` / `'reinhard-extended'`) and compares each against `reference-dawn-scene-<a|b>-tonemap-<none|reinhard>.png` byte-for-byte (eps <= `SMOKE_PIXEL_THRESHOLD`, default `0.05`) |
| `vite.config.ts` | Two-plugin stack (`forgeaxShader` + `pluginPack`) so the production build carries the sprite + tonemap + pbr + unlit shader manifest plus the local `/pack-index.json` GUID catalog |
| `assets/wood-container.jpg` | 64x64 procedural JPEG (1.4 KB) re-used from the learn-render-1.4-textures pinned-asset carve-out. D-5 SSOT: the same GUID `019e2cc6-0c86-79da-aa76-b0984c86d45c` resolves the sprite texture under both the demo-local path and the `forgeax-engine-assets/learn-opengl/` submodule path |
| `assets/wood-container.meta.json` | Sidecar with `subAssets[0].guid` mirroring the upstream SSOT |

## Reference PNGs (AC-13 4-case matrix)

| File | Generated by |
|:--|:--|
| `scripts/reference-dawn-scene-a-tonemap-none.png` | first run of `pnpm --filter @forgeax/hello-sprite smoke` (writes baseline + exits 1) |
| `scripts/reference-dawn-scene-a-tonemap-reinhard.png` | same first run |
| `scripts/reference-dawn-scene-b-tonemap-none.png` | same first run |
| `scripts/reference-dawn-scene-b-tonemap-reinhard.png` | same first run |

> The 4 PNGs are produced **only** when a WebGPU-capable runtime executes the smoke script (dawn-node + Vulkan or a real GPU). When the host container lacks Vulkan (`libvulkan.so.1` missing) the smoke aborts with `[smoke] FAIL - createRenderer threw` and the baselines stay un-generated; the first GitHub Actions CI run with the standard `lavapipe` swiftshader stack populates them (charter F2 + P5 producer/consumer split: subagent reports delta numerics; orchestrator + humans inspect the PNGs).

## What this demo proves

- **sprite uses the unified pass-based `MaterialAsset` surface.** Same `MeshFilter + MeshRenderer` ECS entry as PBR / unlit — there is no `SpriteRenderer` / `SpriteBundle` and no sprite-only sibling asset type (charter P4 consistent abstraction; Bevy 0.19 retracement avoided). The shader id `'forgeax::sprite'` in `passes[0].shader` selects the sprite branch in the runtime extract / record stages.
- **Geometry produces the primitive; the asset owner supplies its identity.** Use `const quad = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap()` and bind `MeshFilter { assetHandle: quad }`. Nine-slice uses `createPrimitiveMesh('nine-slice-quad')` through the same admission path.
- **`Layer` is a generic render component, not a 2D-only one.** A 3D PBR mesh can carry `Layer` for the same sort-key purpose; the demo just exercises 2D first.
- **`TransparentSortConfig` is the single switch.** Five common 2D camera idioms (horizontal / top-down / Don't Starve / isometric / JRPG) reduce to two fields (`mode` + `yzAlpha`) on a world-level KV resource; the switch system in `src/main.ts` calls `setTransparentSortConfig(world, { mode, yzAlpha: 1.0 })` and the rest of the world stays unchanged.
- **AC-18 path (4) sprite-bucket missing-texture warn-once.** If the wood-container handle fails to resolve, the render-system fires `console.warn('[forgeax] sprite texture ...')` once per handle and surfaces a structured `RhiError(asset-not-registered)` to listeners; the AI user reads `.code` / `.hint` / `.detail.assetHandle` properties.

## Relation to docs/roadmaps/2026-05-15-2d-roadmap.md M1

This demo is the visible deliverable for **`docs/roadmaps/2026-05-15-2d-roadmap.md` v3 §4 M1 (2D Sprite + Layer + Sort MVP)**. The M1 roadmap line "1k sprites @ 60 fps + pixel-parity vs three.js Sprite" is not gated here; the demo itself runs 3 sprites per scene because the visual point is the sort order, not the throughput.
