# hello-sprite

> **这个 demo 展示 sprite 的两种用法：region+quad 与 9-slice 双模式。** 顶部屏幕区是 9-slice 区段（左侧 stretch 面板 + 右侧另一尺寸 stretch 面板，下方 tile 砖块），下半屏是经典 region+quad 区段（scene-A 横向 layer-z / scene-B JRPG 脚锚 Y-sort，用键盘 `1` / `2` 切换）。两个区段共用同一 sprite shader (`forgeax::sprite`) + 同一 `MaterialAsset` 入口形态（charter P4 一致抽象），区别仅在 `values` 内是否带 `slices` / `sliceMode` 两字段（feat-20260527-sprite-nineslice / D-1）。AI 用户读这一个 demo 即可看到 sprite 物料的两种编写路径并排呈现，无需切到第二个 demo 比对。

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

## 三个区段速读（feat-20260527-sprite-nineslice / M5 / w19）

> charter F2 文字命题先行：以下三个独立小节先用文字描述每个区段的视觉与物料组合，再放入示例代码。AI 用户读完三段命题即可在不依赖图片的前提下理解"region+quad / 9-slice stretch / 9-slice tile"三种 sprite 写法的差异。

### Section 1 · region+quad 经典区（屏幕下半屏，scene-A / scene-B 切换）

下半屏的 3 个 sprite 共用 `HANDLE_QUAD`（builtin mesh id=3）+ `forgeax::sprite` shader，`values` 内**不带** `slices` / `sliceMode` 字段——`paramSchema` 默认让两字段走 sentinel `[0, 0, 0, 0]` / `0`，runtime record-stage 自动绑定 `HANDLE_QUAD` 而非 `HANDLE_NINESLICE_QUAD`（plan-strategy D-1 + D-2 sentinel 早退）。键盘 `1` / `2` 在 scene-A（layer-z 横向）与 scene-B（pivot 脚锚 + layer-y JRPG sort）间切换。

### Section 2 · 9-slice stretch（屏幕上半屏，左右两面板）

上半屏的 2 个 stretch 面板共用**同一** `MaterialAsset` handle，仅 `Transform.scale[xy]` 不同——这是 AC-06 的核心命题（"一张 material，多种尺寸，4 个圆角不形变"）。`values` 内：

```ts
{
  slices: [0.25, 0.25, 0.25, 0.25],  // [left, top, right, bottom]，区域局部 UV 0..1
  sliceMode: 0,                       // 0 = stretch（拉伸中心格）
}
```

注意 `slices` **是 region 局部 UV（0..1 范围）**，**不是像素**——例如 `region: [0, 0, 1, 1]` 时 `slices=[0.25, ...]` 等价于"从 atlas 子区四角各取 25% 留作 corner anchor"。`region.zw` 给定 region 的宽高，`slices.x + slices.z < region.z` / `slices.y + slices.w < region.y` 是 `validateSpriteSlices` 的两条 fail-fast 上界。

> [!IMPORTANT]
> **`slices` 顺序差异提醒（charter F2 防混表）**：
>
> | 框架 | 顺序 |
> |:--|:--|
> | **forgeax-engine** | `[left, top, right, bottom]`（左上右下）|
> | CSS `border-image-slice` | `top right bottom left`（顺时针，以 top 起）|
> | Unity `Sprite.border` | `Vector4(left, bottom, right, top)`（左下右上）|
>
> 不同框架的字段顺序互不一致；本引擎选 left-top-right-bottom 与 sprite UBO `slicesAndMode.xyzw` 顺序对齐（plan-strategy D-3）。

### Section 3 · 9-slice tile（屏幕底部砖块）

底部 1 个 tile 砖块用一个**独立** `MaterialAsset`（`slices=[0.3, 0.3, 0.3, 0.3]` / `sliceMode: 1`）。tile 模式下中心格通过 `sampler.addressMode='repeat'` 硬件采样器环绕实现重复——demo 共享的 sampler 已配 `addressModeU/V: 'repeat'`（plan-strategy D-4）。`Transform.scale[xy] = N × cell-size` 控制中心格沿主轴重复 N 次：

```ts
{
  slices: [0.3, 0.3, 0.3, 0.3],
  sliceMode: 1,                       // 1 = tile（瓷砖重复）
}
```

> [!CAUTION]
> **`sliceMode: 0 | 1` 是数值字面量、不是字符串**——`values` schema-driven UBO 写入只支持 `wgsl f32` 兼容的数值类型；`sliceMode: 'stretch'` 字符串会触发 `MATERIAL_PARAM_TYPES_V1` 校验失败。当 `sliceMode: 1` 但绑定的 `sampler.addressMode` 不是 `'repeat'` 时，引擎**不抛错**，而是由 host-owned `AssetRegistry` metrics 计数器报告（`app.assets?._getMetrics()?.snapshot()['nineslice.tile-needs-repeat-sampler']`，plan-strategy D-9 register-time soft-warn）；视觉退化为 clamp-stretch。

## FAQ（常见疑问）

<details>
<summary>如何让某个 panel 始终在最上？</summary>

走 Overlay queue（`RenderQueue.Overlay = 4000`）+ `Layer` 组件双重保障：把 9-slice material 的 pass `queue` 改为 `4000`（high-Z bucket）+ entity 加 `Layer { value: 9999 }`。Overlay queue 在 transparent queue（3000）之后绘制；同 queue 内 `Layer` 高位优先。
</details>

<details>
<summary><code>slices</code> 数值如何换算？</summary>

`slices` 是 **region 局部 UV（0..1）**，不是像素。当你的 atlas 子区整体尺寸是 `region: [0, 0, 0.5, 0.5]`（atlas 的左上 1/4），`slices: [0.25, 0.25, 0.25, 0.25]` 仍然解为"从子区四角各取 25%"——也就是 atlas 像素空间中真实的 corner anchor 是 `0.5 * 0.25 = 12.5%` 的子区面积。`AssetError` 的 `.hint` 字段会给出具体的 `region.zw` 数值帮你复制 prompt 自检。
</details>

<details>
<summary>tile 模式没看到重复怎么办？</summary>

最常见的原因是绑定的 `sampler` 没配 `addressMode='repeat'`。本 demo 的共享 sampler 已经配置 `addressModeU/V: 'repeat'`；如果你在自己的项目里 `sliceMode: 1` 看不到瓷砖重复，先读取 host-owned `AssetRegistry` 的 metrics snapshot（`app.assets?._getMetrics()?.snapshot()`）——`nineslice.tile-needs-repeat-sampler >= 1` 即说明 register 期发现 sampler 配置不匹配，需要把对应 sampler 改为 `addressMode='repeat'` 后重 register（plan-strategy D-9）。
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
| `src/main.ts` | `createApp(canvas, { clearColor })` bootstrap + `loadByGuid<TextureAsset>` (wood-container.jpg analogue) + 6 sprite materials (3 colors x 2 pivots) + ortho Camera + `applyScene(target)` despawn-and-respawn switcher + scene-switch system reading `renderer.input.snapshot(world)` (`keyboard.up('1')` / `keyboard.up('2')` / `mouse.wheelDelta`) |
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
- **`HANDLE_QUAD` lives alongside `HANDLE_CUBE` / `HANDLE_TRIANGLE`.** Same 12-float vertex layout, same `assetHandle: HANDLE_QUAD` spawn pattern.
- **`Layer` is a generic render component, not a 2D-only one.** A 3D PBR mesh can carry `Layer` for the same sort-key purpose; the demo just exercises 2D first.
- **`TransparentSortConfig` is the single switch.** Five common 2D camera idioms (horizontal / top-down / Don't Starve / isometric / JRPG) reduce to two fields (`mode` + `yzAlpha`) on a world-level KV resource; the switch system in `src/main.ts` calls `setTransparentSortConfig(world, { mode, yzAlpha: 1.0 })` and the rest of the world stays unchanged.
- **AC-18 path (4) sprite-bucket missing-texture warn-once.** If the wood-container handle fails to resolve, the render-system fires `console.warn('[forgeax] sprite texture ...')` once per handle and surfaces a structured `RhiError(asset-not-registered)` to listeners; the AI user reads `.code` / `.hint` / `.detail.assetHandle` properties.

## Relation to docs/roadmaps/2026-05-15-2d-roadmap.md M1

This demo is the visible deliverable for **`docs/roadmaps/2026-05-15-2d-roadmap.md` v3 §4 M1 (2D Sprite + Layer + Sort MVP)**. The M1 roadmap line "1k sprites @ 60 fps + pixel-parity vs three.js Sprite" is gated by the render bench (`packages/render/bench/transparent-sort.bench.ts`, 10k entities x 100 iterations); the demo itself runs 3 sprites per scene because the visual point is the sort order, not the throughput.
