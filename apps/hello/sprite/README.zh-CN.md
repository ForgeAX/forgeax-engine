<!-- LANG-SWITCH -->
**语言**：[English](README.md) · **简体中文**

# hello-sprite

> **这个 demo 展示 sprite 的两种用法：region+quad 与 9-slice 双模式。** 顶部屏幕区是 9-slice 区段（左侧 stretch 面板 + 右侧另一尺寸 stretch 面板，下方 tile 砖块），下半屏是经典 region+quad 区段（scene-A 横向 layer-z / scene-B JRPG 脚锚 Y-sort，用键盘 `1` / `2` 切换）。两个区段共用同一 sprite shader (`forgeax::sprite`) + 同一 `MaterialAsset` 入口形态（charter P4 一致抽象），区别仅在 `values` 内是否带 `slices` / `sliceMode` 两字段（feat-20260527-sprite-nineslice / D-1）。AI 用户读这一个 demo 即可看到 sprite 物料的两种编写路径并排呈现，无需切到第二个 demo 比对。

## 本地运行

```bash
pnpm --filter @forgeax/hello-sprite dev      # vite dev server -> http://localhost:5193
pnpm --filter @forgeax/hello-sprite build    # vite production build
pnpm --filter @forgeax/hello-sprite smoke    # dawn-node 4-case matrix smoke (scene-A/B x tonemap-none/reinhard-extended)
```

## 操作

| 输入 | 动作 |
|:--|:--|
| `1` | 切换到 scene-A（mode=0，layer-z，横向场景） |
| `2` | 切换到 scene-B（mode=1，layer-y，JRPG Y 轴排序） |
| 鼠标滚轮向下 | 切换到 scene-A |
| 鼠标滚轮向上 | 切换到 scene-B |

## 子示例索引

| 场景 | mode（常量） | pivot | 视觉表现 |
|:-:|:--|:--|:--|
| A | `0` (`TRANSPARENT_SORT_MODE_LAYER_Z`) | `[0.5, 0.5]` | 3 个精灵的 `Layer = {-100, 0, 100}`，横跨零轴；先画背景、后画前景，轴心位于几何中心 |
| B | `1` (`TRANSPARENT_SORT_MODE_LAYER_Y`) | `[0.5, 1.0]` | 3 个精灵都使用 `Layer = 0`，沿世界 Y 轴错开；以脚底为轴心排序，后方角色（Y 更大）先绘制 |

两个场景共用纹理和 3 个 `colorTint` 槽位（暖红、鲜绿、冷蓝），因此切换时每个精灵的视觉身份保持稳定。差异仅来自 `Layer`、`pivot` 和世界资源的 `mode` 字段。

## 三个区段速读（feat-20260527-sprite-nineslice / M5 / w19）

> charter F2 文字命题先行：以下三个独立小节先用文字描述每个区段的视觉与物料组合，再放入示例代码。AI 用户读完三段命题即可在不依赖图片的前提下理解"region+quad / 9-slice stretch / 9-slice tile"三种 sprite 写法的差异。

### 区段 1：region+quad 经典区（屏幕下半屏，scene-A / scene-B 切换）

下半屏的 3 个 sprite 共用受管理的 quad 资产 + `forgeax::sprite` shader，`values` 内**不带** `slices` / `sliceMode` 字段——`paramSchema` 默认让两字段走 sentinel `[0, 0, 0, 0]` / `0`，runtime record-stage 消费绑定的普通 quad（plan-strategy D-1 + D-2 sentinel 早退）。键盘 `1` / `2` 在 scene-A（layer-z 横向）与 scene-B（pivot 脚锚 + layer-y JRPG sort）间切换。

### 区段 2：九宫格拉伸（屏幕上半屏，左右两面板）

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

### 区段 3：九宫格平铺（屏幕底部砖块）

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

## 五种视角的排序选择

> 此表与 `packages/render/src/systems/transparent-sort-config.ts` 的 JSDoc 一致，便于在示例中直接查看完整模式范围（charter F1 渐进披露）。

| 视角 | mode | yzAlpha | sortValue 公式 |
|:------------------|:----:|:-------:|:-------------------------------------------|
| 横向（侧视） | 0 | --- | `posZ` |
| 俯视 | 1 | --- | `-(posY - pivot.y * size.y)` |
| 饥荒式视角 | 2 | 1.0 | `(posY - pivot.y * size.y) + posZ` |
| 等距视角 | 2 | 0.5 | `(posY - pivot.y * size.y) + 0.5 * posZ` |
| JRPG（脚底轴心） | 1 | --- | `-(posY - pivot.y * size.y)` |

> 当 `entry.sortKey !== undefined` 时，该项的 `sortKey` 替换模式公式的结果；`Layer` 仍是第一排序键。这样可以在同层内把特定精灵固定到常规排序之前或之后，无需重新组织整个场景。

## 源码索引

| 路径 | 职责 |
|:--|:--|
| `index.html` | `<canvas id="app">` 宿主页和键盘提示层 |
| `src/main.ts` | `createApp(canvas, { clearColor })` 启动、`assets.load(guid, 'texture')` 加载纹理、6 个精灵材质（3 色 × 2 轴心）、正交相机、通过销毁和重建实体切换的 `applyScene(target)`，以及读取 `renderer.input.snapshot(world)` 的场景切换系统（`keyboard.up('1')`、`keyboard.up('2')`、`mouse.wheelDelta`） |
| `scripts/smoke-dawn.mjs` | dawn-node 无头冒烟测试，渲染 4 种组合（scene-A/B × `tonemap = 'none'` / `'reinhard-extended'`），逐字节对比 `reference-dawn-scene-<a\|b>-tonemap-<none\|reinhard>.png`（eps ≤ `SMOKE_PIXEL_THRESHOLD`，默认 `0.05`） |
| `vite.config.ts` | 组合 `forgeaxShader` 和 `pluginPack`，使生产构建包含 sprite、tonemap、pbr、unlit 着色器清单和本地 `/pack-index.json` GUID 目录 |
| `assets/wood-container.jpg` | 复用 learn-render-1.4-textures 固定资产的 64×64 程序化 JPEG（1.4 KB）；相同 GUID `019e2cc6-0c86-79da-aa76-b0984c86d45c` 在示例路径和 `forgeax-engine-assets/learn-opengl/` 子模块路径下解析到同一精灵纹理（D-5 单一权威） |
| `assets/wood-container.meta.json` | `subAssets[0].guid` 与上游权威身份保持一致的伴随元数据 |

## 参考 PNG（AC-13 四种组合）

| 文件 | 生成方式 |
|:--|:--|
| `scripts/reference-dawn-scene-a-tonemap-none.png` | 首次运行 `pnpm --filter @forgeax/hello-sprite smoke`（写入基线后以 1 退出） |
| `scripts/reference-dawn-scene-a-tonemap-reinhard.png` | 同次首次运行 |
| `scripts/reference-dawn-scene-b-tonemap-none.png` | 同次首次运行 |
| `scripts/reference-dawn-scene-b-tonemap-reinhard.png` | 同次首次运行 |

> 这 4 张 PNG **仅在支持 WebGPU 的运行时执行冒烟脚本时**生成（dawn-node + Vulkan 或真实 GPU）。宿主容器缺少 Vulkan（`libvulkan.so.1`）时，脚本以 `[smoke] FAIL - createRenderer threw` 中止，不生成基线；首次使用标准 `lavapipe` swiftshader 环境的 GitHub Actions CI 运行会生成它们（charter F2 + P5 生产者/消费者分离：子代理报告差值，协调者与人检查 PNG）。

## 本示例验证的内容

- **精灵使用统一的多 Pass `MaterialAsset`。** 它与 PBR、unlit 共用 `MeshFilter + MeshRenderer` ECS 入口，没有 `SpriteRenderer`、`SpriteBundle` 或精灵专用资产类型（charter P4 一致抽象，避免 Bevy 0.19 的回退路径）。`passes[0].shader` 中的 `'forgeax::sprite'` 在运行时提取和录制阶段选择精灵分支。
- **Geometry 生成图元，资产所有者提供身份。** 使用 `const quad = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap()` 并绑定 `MeshFilter { assetHandle: quad }`；九宫格通过相同准入路径使用 `createPrimitiveMesh('nine-slice-quad')`。
- **`Layer` 是通用渲染组件。** 3D PBR 网格也可以用它控制排序键；本示例先展示 2D 用法。
- **`TransparentSortConfig` 是唯一切换入口。** 横向、俯视、饥荒式、等距和 JRPG 五种常用视角归结为世界级 KV 资源的 `mode` 与 `yzAlpha`。`src/main.ts` 的切换系统调用 `setTransparentSortConfig(world, { mode, yzAlpha: 1.0 })`，其余世界状态保持不变。
- **AC-18 路径（4）：精灵分组的纹理缺失只警告一次。** wood-container 句柄无法解析时，渲染系统对每个句柄仅发出一次 `console.warn('[forgeax] sprite texture ...')`，并向监听者发布结构化 `RhiError(asset-not-registered)`；AI 可读取 `.code`、`.hint`、`.detail.assetHandle`。

## 与 docs/roadmaps/2026-05-15-2d-roadmap.md M1 的关系

本示例是 **`docs/roadmaps/2026-05-15-2d-roadmap.md` v3 §4 M1（2D Sprite + Layer + Sort MVP）** 的可见交付物。路线图中的“1000 个精灵保持 60 fps，并与 three.js Sprite 像素对齐”不属于本示例门禁；每个场景只绘制 3 个精灵，重点展示排序而非吞吐量。
