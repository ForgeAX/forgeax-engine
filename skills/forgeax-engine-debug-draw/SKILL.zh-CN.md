**语言**：[English](SKILL.md) · **简体中文**

> [!NOTE]
> 本文供人阅读；工具入口为英文 `SKILL.md`。

# forgeax-engine-debug-draw

ForgeAX 即时模式调试几何。适用于不创建 ECS 实体就可视化位置、碰撞体、视锥、坐标轴或半径。

> debug-draw 可视化玩法事实：`app.debugDraw.line(a, b, RED)` 在最终帧绘制线框几何，不需要 ECS 实体、组件或系统。GPU 录制和帧分析使用 [`forgeax-engine-rhi-debug`](../forgeax-engine-rhi-debug/SKILL.zh-CN.md)。演示、物理调参、相机和音频半径使用 debug-draw。

## 理解模型

`@forgeax/engine-debug-draw` 是即时模式的 RHI 便捷层：

- 形状调用 `line` / `sphere` / `aabb` / `frustum` / `arrow` / `axes` 在 CPU 暂存区累积顶点。`arrow` 由主体和四条箭头线构成，默认 `tipLength = |end-start|/10`；`axes(worldMat,length)` 沿本地 XYZ 绘制 RGB 箭头，类似 Bevy `gizmos.axes`。
- 帧结束时，`flush(encoder, view, viewProj)` 上传暂存区、提交一次绘制，并清空暂存区以供下一帧使用。
- 不持久保留任何形状：下一帧不再调用，该形状就不再出现。
- 不依赖 ECS、render-graph 或 shader-registry；包自行编译 WGSL 并创建 PSO。

运行时用户使用自动处理的 `app.debugDraw.*`；低层 RHI 脚本使用 `createDebugDraw(...)` 并显式 `flush(...)`。

### 与 engine-math 并列的依赖层级

| 包 | 依赖 | 用途 |
|:--|:--|:--|
| `engine-math` | 无 ForgeAX 依赖 | Vec、Mat、Quat、Color 和视锥重建 |
| `engine-debug-draw` | rhi、math、types | 收集线框覆盖层并向 GPU flush |
| `engine-runtime` | debug-draw（轻量连接） | createApp 时挂载 `app.debugDraw` |

运行时连接位于 `packages/render/src/debug-draw-glue.ts`；debug-draw 本身不依赖 runtime、ECS、render-graph 或 shader。

## 集成路径

### 运行时路径（自动，推荐）

```ts
import { createApp } from '@forgeax/engine-runtime';

const app = await createApp({ canvas });

// In any update system or hook:
app.debugDraw.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);   // red line
app.debugDraw.sphere([0, 0, 0], 1, [0, 1, 0, 1]);          // green sphere
app.debugDraw.aabb([-1, -1, -1], [1, 1, 1], [0, 0, 1, 1]); // blue box
app.debugDraw.frustum(cameraViewProj, [1, 1, 0, 1]);        // yellow frustum
app.debugDraw.arrow([0, 0, 0], [0, 2, 0], [1, 1, 1, 1]);    // arrow (body + head); tipLength optional
app.debugDraw.axes(transform.world, 1);                     // local frame: X=red / Y=green / Z=blue arrows

// No manual flush -- runtime appends a DebugOverlay pass to the render graph
// and draws the staged vertices every frame.
```

- `createApp` 通过 `debug-draw-glue.ts` hook 挂载 `app.debugDraw`。
- 在 update 系统或其他代码中调用形状；顶点自动累积，并在帧结束时清空。
- GPU 覆盖层归运行时所有：`app.debugDraw` 是 CPU 数据源，Renderer 每帧读取一次，在每个 view 中绘制；仅 update 或不绘制的帧丢弃其几何。
- 覆盖层失败时跳过该层，每个原因触发一次 `debug-overlay-failed` 错误，原因为 `overlay-source-failed`、`overlay-upload-failed`、`overlay-pipeline-failed`；场景帧继续。读取 `renderer.inspect().debugOverlay` 获取最新结果。

### 低层路径（自定义 RHI 和图）

```ts
import { createDebugDraw } from '@forgeax/engine-debug-draw';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';

const r = await createDebugDraw({ device, queue, createShaderModule });
if (!r.ok) {
  switch (r.error.code) {
    case 'pipeline-create-failed':  /* ... */
    case 'buffer-allocation-failed': /* ... */
  }
}
const dd = r.value;

// Per-frame:
dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);
// ... more shape calls ...
dd.flush(encoder, swapChainView, cameraViewProj);

// When done:
dd.destroy();
```

- 提供 `device`、`queue`，并从 `@forgeax/engine-rhi-webgpu` 注入 WGSL 编译工厂 `createShaderModule`。
- 在自定义渲染图或捕获脚本末尾调用 `flush(encoder, view, viewProj)`。
- `destroy()` 释放 GPU 资源；之后的形状调用为空操作且只发出一次控制台警告，flush 返回 `Result.err`。

## 核心 API 速查

| API | 形式 | 顶点数 |
|:--|:--|:--|
| `dd.line(a, b, color)` | `a: Vec3, b: Vec3, color: ColorLike => void` | 2 |
| `dd.sphere(center, radius, color, segments?)` | `center: Vec3, radius: number, color: ColorLike, segments?: number => void` | $3 \times 2 \times \text{segments}$，默认 `segments=16` 时为 96 |
| `dd.aabb(min, max, color)` | `min: Vec3, max: Vec3, color: ColorLike => void` | 24（12 条边） |
| `dd.frustum(viewProj, color)` | `viewProj: Mat4, color: ColorLike => void` | 24（12 条边） |
| `dd.flush(encoder, view, viewProj)` | `encoder: RhiCommandEncoder, view: TextureView, viewProj: Mat4 => Result<void, DebugDrawError>` | 无 |
| `dd.destroy()` | `() => void` | 无 |

> `ColorLike` 接受普通 `[r, g, b, a?]` 元组、`Float32Array` 或 `@forgeax/engine-math` 的品牌类型 `Color`，无需 `as Vec4` 断言。

### 深度模式

| 模式 | 行为 |
|:--|:--|
| `'always'`（默认） | 忽略深度，在场景上方绘制覆盖层 |
| `'less-equal'` | 使用场景深度，让前景几何遮挡覆盖层 |

`createDebugDraw({ depthMode: 'less-equal', depthFormat: 'depth24plus' })` 必须提供 `depthFormat`。每个实例为固定深度模式编译一个 PSO。同一帧需要两种模式时，创建两个实例，参见 AC-06 演示。

### 容量扩展与截断

| 触发条件 | 行为 |
|:--|:--|
| 顶点超过容量，但未达到 `MAX_VERTEX_CAPACITY`（一百万） | 容量翻倍，仅记录一次旧、新大小 |
| 顶点超过 `MAX_VERTEX_CAPACITY` | 在上限内 flush，丢弃溢出部分，每帧最多警告一次 |

导出常量：`INITIAL_VERTEX_CAPACITY`（1024）、`MAX_VERTEX_CAPACITY`（1_000_000）、`VERTEX_STRIDE_BYTES`（16）。

## 错误模型

`DebugDrawErrorCode` 是封闭联合。各成员按 AGENTS 约定携带 `.code`、`.expected`、`.hint`、`.detail`。下表保留真实 `.hint` 文案，方便与诊断对应：

| `err.code` | 触发条件 | 可执行的 `.hint` |
|:--|:--|:--|
| `'pipeline-create-failed'` | PSO 或着色器编译失败 | `Pipeline creation failed: <rhiError>. Check WGSL syntax, vertex layout, and depth-stencil state.` |
| `'buffer-allocation-failed'` | GPU 缓冲分配失败 | `Buffer allocation failed: <rhiError>. Check available device memory and buffer usage flags.` |
| `'flushed-after-destroy'` | 销毁后 flush | `DebugDraw was destroyed; create a new instance via createDebugDraw().` |
| `'viewProj-required'` | flush 缺少 viewProj | `Pass a viewProj Mat4 to flush(encoder, view, viewProj).` |

穷尽处理 `err.code`，不使用 default。完整错误契约由 `packages/debug-draw/src/errors.ts` 所有。

## 常见问题

- **用 ECS 网格实体替代 `dd.line()`：** debug-draw 是即时模式，无需注册组件。网格实体可能跨帧存活，留下过时调试几何，并将引擎缺口固化到演示中。
- **缺少 `createShaderModule` 注入：** 从 `@forgeax/engine-rhi-webgpu` 导入 WGSL 工厂；没有它就无法创建 PSO。
- **`less-equal` 缺少 `depthFormat`：** PSO 需要 `depthStencil.format`；提供 `depthFormat: 'depth24plus'`，避免 `pipeline-create-failed`。
- **混淆 debug-draw 与 rhi-debug：** 前者绘制玩法线框覆盖层；后者记录 GPU 调用用于帧分析。参见包 README 的区别表。
- **期待销毁后的形状调用抛错：** 它们为空操作，不写暂存区，只警告一次；下一次 flush 报告 `Result.err({ code: 'flushed-after-destroy' })`。
- **忘记 flush 幂等：** 暂存区为空时返回 `ok(undefined)`，不调用 `beginRenderPass`，不产生 GPU 副作用。同一帧第二次 flush 不会重复绘制。
- **球体分段过多：** 10,000 段产生 60,000 顶点，可能触发容量警告，但不会使帧崩溃。默认 16 段产生 96 顶点。

## 延伸阅读

- 形状签名、深度模式、容量行为和错误：`packages/debug-draw/README.md`。
- 封闭错误联合及可辨识详情：`packages/debug-draw/src/errors.ts`。
- `DebugDraw` 类、`createDebugDraw` 工厂和 GPU 资源生命周期：`packages/debug-draw/src/debug-draw.ts`。
- 运行时挂载和最终图 pass：`packages/render/src/debug-draw-glue.ts`。
- Hello 演示，五种模式为 runtime / low / depth / hdrp-tonemap / empty：`apps/hello/debug-draw/src/main.ts`。
- 与 rhi-debug 比较：`packages/debug-draw/README.md`。
