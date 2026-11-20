**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`。

# forgeax-engine-modeling

ForgeaX `.pack.ts` 构建中的可编辑网格建模：选择器、带标签操作、曲线、曲面、rig、UV、烘焙、MeshAsset 导出及 forgeax model 工具。用于在代码中创建、修改或检查游戏网格。

`@forgeax/engine/modeling` 是纯 TypeScript 的确定性、可编辑 n-gon 网格内核。`.pack.ts` 构建以普通函数调用它，将 `{ 'mesh/<key>': MeshAsset }` 返回给已有 Pack、Catalog 和 Renderer 所属模块；rig 还会返回场景和 clip。

它不是编辑器，没有可点击视口，只通过 `forgeax model render` 查看成果；不是 CAD B-rep 内核，曲线和曲面会细分为网格；也不是运行时编译器，玩家加载的是导出网格。

契约唯一权威为 [`packages/modeling/README.md`](../../packages/modeling/README.md)，包含数据模型、选择、会话契约和参考映射。下述每项考虑都链接一个 `reference/*.md`；按任务需要打开。示例按由小到大排列，并说明各自教学目标：[`examples/README.md`](../../packages/modeling/examples/README.md)。

专业经验，包括观察内容、取舍、阈值及错误码恢复，位于 [`knowledge/`](../../packages/modeling/knowledge/)。按任务选择主题：

| 任务 | 主题 |
|:--|:--|
| 选择方案、根据图纸搭建体块 | [design-methodology](../../packages/modeling/knowledge/design-methodology.md)、[design-drawings](../../packages/modeling/knowledge/design-drawings.md) |
| 车辆、硬表面主体、面板缝隙 | [vehicle-design](../../packages/modeling/knowledge/vehicle-design.md) |
| 平滑曲面、patch 网络、曲率质量 | [surface-quality](../../packages/modeling/knowledge/surface-quality.md)、[nsided-patches](../../packages/modeling/knowledge/nsided-patches.md) |
| 角色、风格化身体、脸部、头发 | [stylized-character](../../packages/modeling/knowledge/stylized-character.md) |
| 机构、关节、运动能力 | [mechanism-design](../../packages/modeling/knowledge/mechanism-design.md) |
| 细节目录、动画展示 | [detail-catalog](../../packages/modeling/knowledge/detail-catalog.md)、[animation-presentation](../../packages/modeling/knowledge/animation-presentation.md) |
| UV 切线、低模、烘焙 | [uv-cuts-lowpoly](../../packages/modeling/knowledge/uv-cuts-lowpoly.md)、[baking-uv](../../packages/modeling/knowledge/baking-uv.md) |
| 水密网格、公差 | [watertight-tolerance](../../packages/modeling/knowledge/watertight-tolerance.md) |

## 最小构建

```ts
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { model, sel } from '@forgeax/engine/modeling';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01900000-0000-7000-8000-00000000a0de'),
  parameters: [{ name: 'depth', type: 'f32', default: 0.03, minimum: 0.005, maximum: 0.1 }],
  build: ({ values: p }) => {
    const m = model();
    m.box({ size: [0.42, 0.3, 0.36], tag: 'shell' });
    m.inset(sel.tag('shell').and(sel.facing('+z', 10)).largest().one(), {
      thickness: 0.02, region: 'merged', label: 'visor',
    });
    m.extrude(sel.createdBy('visor', 'inner'), { distance: -p.depth, region: 'merged', label: 'visor-depth' });
    m.markSharp(sel.edges.dihedral('>', 40));
    m.uv.project({ mode: 'box', scale: 0.5 });
    m.assign(sel.createdBy('visor-depth', 'top'), 'glow');
    return m.finish({ key: 'helmet', normals: { mode: 'weighted' } });
  },
});
```

查看成果：`forgeax model render --source <file>.pack.ts --json`，再打开其列出的 PNG。准确参数使用 `forgeax help model <command>`，参见[工具](../../packages/modeling/reference/tools.md#forgeax-model--commands)。

## 不变量

- **Y 向上，+Z 向前**；单位米，角度度。`facing('+y')` 指顶面。
- **选择器是表达式**，每次调用都重新求值，不保留面或顶点 ID。空选择失败为 `model-selection-empty`，绝不表示全部；全部使用 `sel.all()`。
- **身份由你命名：** `tag` 在派生后保留；操作的 `label` 写入角色，通过 `sel.createdBy(label, role)` 读回。无标签操作不添加角色。
- **幅值没有默认值，**包括 `distance`、`thickness`、尺寸和分段数。
- **首次失败会使会话中毒；** `finish()` 返回该 `ModelingError`，含 `code`、`hint` 及 `detail.site = { op, opIndex, label }`。修复该调用。失败应改用另一构造时，用 `m.try(() => ...)` 回滚一个块。
- **拓扑编辑产生的新面没有 UV：** 最后一次编辑后再投影或展开；`finish()` 要求完整 `uv0`。
- **输出只依赖源码和参数：** 不使用 `Date`、`Math.random` 或 `fetch`，从种子派生变化。
- **预算：** Pack build 15 秒，每次 `forgeax model` 重建 60 秒，运行时重建应接近 100 ms。重型工作转入 cooked `MeshJob`，参见[工具预算](../../packages/modeling/reference/tools.md#budgets-and-isolation)。

## 需要考虑的方面

每项建模任务会涉及其中一些，没有固定顺序，多数任务可跳过部分内容。

**用途和观察距离。** 谁会看到资产、距离多远、是否运动，决定面数预算、细节级别以及是否需要 rig 或烘焙。游戏距离下的道具需要清晰轮廓和材质分区，而不是支撑线；参见[导出性能层级](../../packages/modeling/reference/export.md#performance-tiers)。`node packages/modeling/bench/scale-f1.mjs --fixture f1 --out <file>` 用大型夹具测量内核规模表现。

**形体来源。** Pack `parameters` 保存值得调整的尺寸。参考图转为设计图；`m.threeView` 将 2 至 3 个正交轮廓相交形成体块，`extrudeContour` 将单轮廓转为棱柱。参见[图纸](../../packages/modeling/reference/drawings.md)及 `body-blockout` 示例。

**形状策略。** 按形体选择构造方式，可自由混合：

| 形体 | 起点 | 参考 |
|:--|:--|:--|
| 方盒、机械加工、面板结构 | 基元、`inset`、`extrude`、`shell`、`mirror` | [operations](../../packages/modeling/reference/operations.md) |
| 缺口、孔洞、并集 | 闭合操作数上的布尔运算 | [booleans](../../packages/modeling/reference/booleans.md) |
| 管、框架、线缆、弹簧、分枝 | `sweep`、`loft`、`pipeNetwork`、`array` | [sweep-deform](../../packages/modeling/reference/sweep-deform.md) |
| 有机身体、头部、生物 | 低模 cage，再 `subdivide`、折痕、`arap` 和变形器；低多边形使用 `loft` 截面和平面法线 | [sweep-deform](../../packages/modeling/reference/sweep-deform.md) |
| 服装、层、发片 | `shrinkwrap`、`layer`、`strands`、`knife` | [artist-editing](../../packages/modeling/reference/artist-editing.md) |
| 平滑 A 级面板、车身 | NURBS 曲线和曲面、patch 网络 | [surfaces](../../packages/modeling/reference/surfaces.md) |
| 团块融合、低模切面、重拓扑 | `voxel`、`simplify`、`remesh`；`lowpoly({ slivers })` 移除狭长面 | [voxels-remesh](../../packages/modeling/reference/voxels-remesh.md) |
| 过细而不宜建模的格栅、通风口、薄孔 | `thinHole` / `thinHoleCheck`，属于烘焙配方，不是几何 | [uv-bake](../../packages/modeling/reference/uv-bake.md)，示例 `thin-vent` |
| 现有网格 | `lift` | [operations](../../packages/modeling/reference/operations.md#lifting-existing-meshes) |

对称形体建一半再 `mirror`。各部件用独立函数构建，再 `append`；向 session 构建内容的函数就是复用单位，参见[跨 Pack 复用](../../packages/modeling/reference/export.md#reuse-across-packs)。

**细节。** 边缘处理（`bevel`、圆角、混合、支撑线）、面板线和闭合缝，以及螺栓、铰链、齿轮、销接头等机械配方见 [detail](../../packages/modeling/reference/detail.md)。`markSharp` 将硬法线标记为创作意图，不存在焊接角阈值。

**运动。** 不通过旋转网格面制作动画。将部件绑定到 `rig`，给关节设置限制并为路径打关键帧；其 `finish` 导出部件网格、场景和 clip。干涉、净空和运动能力检查由同一所属模块负责，参见 [rig](../../packages/modeling/reference/rig.md)，以及 `limb-choreography`、`door-hinge`、`transforming-limb` 示例。

**外观。** 使用 `assign(faces, slot)` 分配材质槽。程序化 Standard 材质、纹理和文字见 [materials](../../packages/modeling/reference/materials.md)。UV 投影、展开、自动图表（`uv.unwrap` / `uv.auto` 可显式选择 `refine: 'slim'`）、trim sheet 及高模到低模烘焙见 [uv-bake](../../packages/modeling/reference/uv-bake.md)，示例 `armor-bake`。`cage-clip` 和 `stray-detail` 烘焙问题携带聚类结果及修复 `hint`。分类表面遮罩需显式设置 `BakeSlot.materialId` 并烘焙 `materialId`；外观颜色和循环默认调色板不能建立材质身份。

**观察与验证。** 经常渲染并查看；数字不能独自揭示形状错误。`forgeax model render` 绘制真实 Engine 帧，包括正交图、线框、覆盖层、剖面、X 光、斑马纹和曲率。`replay` 展示每一步，`select` 尝试选择器，`history` 将面映射到源码行，`validate` 查找拓扑和自交问题；`validate({ shells })` 在只做过一次并集的实体仍有重叠 shell 时报告 `shell-overlap`。`diff` 比较变体，`pose` / `interference` 检查 rig。参见[工具](../../packages/modeling/reference/tools.md)及[验证](../../packages/modeling/reference/validation.md)。`m.checkpoint('name')` 标记可被工具渲染或选择的状态。

**交付。** `finish({ key, normals })` 导出网格；法线模式、LOD 和 cooked job 见 [export](../../packages/modeling/reference/export.md)。蒙皮 LOD 通过 `reduceSkinForLod` 减少关节，参见 [rig](../../packages/modeling/reference/rig.md)。rig 场景要求 Pack 声明 `sceneComponents`。`model render --materials auto` 将 Pack 的 `material/<slot>` 输出绑定到同名槽，`materialBinding` 报告各槽。`model render` 还返回 `renderer { backend, adapter, software }`；Lavapipe 或 SwiftShader 上 `software` 为 true，这类渲染得到的纯像素结论需注明。烘焙和完整场景通过游戏工程中的 `forgeax project preview` 查看，参见 `forgeax-engine-cli`。

输出网格、材质和处理后纹理的离线配方可使用 `AssetsJob` 和 `assetsJobSources`；通过 `createMeshJobCooker` 注册，并将其 `cache` 转给 `bakeMaps`。配方保留在 Pack 静态导入闭包中；同一 job 通过已有 Pack 生产器提供声明的输出，不另建工程自有缓存或烘焙默认值。

## 失败模式

| 症状 | 常见原因 |
|:--|:--|
| `+z` 上 `model-selection-empty` | 习惯使用 Z-up；hint 指明可匹配的轴 |
| 按索引选取的面在编辑后失效 | 改用 tag 或 label/role 选择 |
| `finish` 在 `uv0` 失败 | UV 调用后又编辑拓扑；最后再投影或展开 |
| inset、shell、bevel 出现 `model-degenerate` | 幅值超过面或壁允许范围，读取 `expected` |
| `model-work-budget` | 面过多或 build 工作太重；减少负载或 cook 为 `MeshJob` |
| Validate 通过但形状不对 | 验证检查拓扑，不检查设计要求；渲染后比较 |
| 面留在较早 rig 部件上 | 绑定标签拼错导致未选中；比较 `rig.parts()` |
| 曲面有切面感或接缝 | 缺少 sharp/smooth 意图或分段过少；使用 `--overlays '["sharp"]'` 渲染 |
| Engine 检出中 `forgeax: command not found` | 从 Engine 根目录运行 `node packages/engine/dist/bin/forgeax.mjs` |
| `model-render-backend-unavailable` | 无 Vulkan 设备；软件驱动见[工具 render](../../packages/modeling/reference/tools.md) |
| 渲染颜色与 Pack 材质不同 | `model render` 默认 `--materials palette`；传入 `--materials auto`，输出命名为 `material/<slot>`；rig 需要 `finish({ materials })`，参见 [rig](../../packages/modeling/reference/rig.md) |
| 加载时 `pack-parameter-invalid` | `parameters` 必须是非空数组；至少声明一个可调尺寸 |
| `model-capability-unavailable` | 超出此版本能力，包括 ABF/ARAP unwrap、原生计算、MCP；使用现有能力构建 |

封闭失败联合及 `detail` 结构见 [README 会话契约与错误](../../packages/modeling/README.md#session-contract-and-errors)。
