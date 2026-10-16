# Hello Triangle (LearnOpenGL §1.2)

> [!NOTE]
> **对应 LO 原章节**：[LearnOpenGL §1.2 Hello Triangle](https://learnopengl.com/Getting-started/Hello-Triangle)
>
> **对应引擎能力**：feat-20260515-learn-render-getting-started — LO §1.2 在 forgeax 中映射为 `world.spawn(Transform + MeshFilter(HANDLE_TRIANGLE) + MeshRenderer)` + `world.spawn(Transform + Camera)`，再通过 `Engine.create({ canvas, clearColor })` + `renderer.draw(world)` 把第一个可见三角形画到 swap-chain 上。LO 1.2 是 unlit + 橙色，故不 spawn `DirectionalLight`；引擎 v1 的 fallback fragment shader 直接输出 `material.baseColor`，因此 `MeshRenderer.baseColor{R,G,B}` 就是屏幕像素颜色（charter F1 + P1 progressive disclosure）。

## 在 forgeax 里跟着 LO §1.2 走

LO §1.2 的核心步骤 `glGenVertexArrays + glGenBuffers + glBufferData + glDrawArrays(GL_TRIANGLES, 0, 3)` 在 forgeax 中折叠成 **builtin mesh handle + ECS spawn** 两步：

1. 顶点数据（3 个 clip-space 顶点）由引擎 builtin `HANDLE_TRIANGLE` 持有，AI 用户**不需要手写 VBO/VAO**——引擎 `AssetRegistry` 在 `await renderer.ready` 时把 builtin mesh upload 到 GPU，业务侧只引用 handle 常量。
2. `world.spawn(Transform + MeshFilter(HANDLE_TRIANGLE) + MeshRenderer)` 等价于 LO §1.2 的「绑定 VAO + draw call」，引擎 RenderSystem 内部 walk World query graph（Extract / Prepare / Record 三阶段）每帧提交一个 GPU command buffer。

完整三段式 mapping 见 [`src/index.ts`](src/index.ts)（按 AC-06 三段 marker `// 1. engine usage` / `// 2. example-specific glue` / `// 3. bootstrap` 排列）。

## 跑起来

```bash
pnpm --filter "@forgeax/app-learn-render-1-getting-started-2-hello-triangle" dev
```

打开 <http://localhost:5181>，应当看到 teal 背景（LO §1.1 / §1.3 同色）+ 屏幕中央一个橙色（`vec4(1.0, 0.5, 0.2, 1.0)`，与 LO §1.2 fragment shader 字面值一致）的三角形。DevTools console 会打印 `[learn-render 1.2 hello-triangle] backend=webgpu`。

## 与 `apps/hello/triangle/` 的关系

`apps/hello/triangle/` 是引擎仓库另一个端到端 Hello Triangle 示例，承担 dawn-node smoke 锚 app（`pnpm --filter @forgeax/hello-triangle smoke` 跑 300 帧 + 像素回读）+ pixel-parity bench 基线两个工程职责，使用 PBR 灰色 + DirectionalLight 作为引擎光照路径的基线。本目录 `apps/learn-render/1.getting-started/2.hello-triangle/` 是 **LO 教材路径上的最小映射**——LO 1.2 unlit 橙色，故不 spawn `DirectionalLight`。两者用途不同，spawn 内容也不同：

| 维度 | `apps/hello/triangle/` | `apps/learn-render/1.getting-started/2.hello-triangle/` |
|:--|:--|:--|
| 角色 | 引擎工程 anchor（dawn-node smoke + pixel-parity baseline + RHI 多 backend 演示） | 教材路径 §1.2 章节示例 |
| `world.spawn` 形态 | Transform + MeshFilter + MeshRenderer（灰色） + Camera + DirectionalLight | Transform + MeshFilter + MeshRenderer（LO 橙色 1.0/0.5/0.2） + Camera |
| 颜色语义 | 引擎默认 PBR 材质（`baseColor=0.5/0.5/0.5`、`metallic=0`、`roughness=1`），保留 light 入口供 PBR shader 升级 | LO §1.2 fragment shader 字面输出 `vec4(1.0, 0.5, 0.2, 1.0)` |
| 额外 | 显式 `createCanvasContext` 配置 + dual-projection (NO/ReverseZ) CPU pre-bake binding exemplar + URL 参数 counter-examples（`?backend=webgl2` smoke FAIL simulation / `?clearOnly=1`） | 仅最小 LO §1.2 mapping，rAF 循环 + capture hook（教材体验优先） |
| smoke gate | dawn-node 300 帧像素回读 | OOS-10 / D-7：smoke 子集只跑 4.textures + 7.camera；1.2 视觉正确性靠人眼 + 本地 dev server 校对 |

教材路径从本目录读，遇到 dawn-node smoke / pixel-parity / dual-projection 这类工程话题时跳到 `apps/hello/triangle/README.md` 拓展。
