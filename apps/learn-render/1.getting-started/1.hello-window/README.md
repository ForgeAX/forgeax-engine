# Hello Window (LearnOpenGL §1.1)

> [!NOTE]
> **对应 LO 原章节**：[LearnOpenGL §1.1 Hello Window](https://learnopengl.com/Getting-started/Hello-Window)
>
> **对应引擎能力**：feat-20260515-learn-render-getting-started — `@forgeax/engine-runtime` `Engine.create({ canvas })`
>
> 该示例属于「占位」形态（plan-strategy §2.9 / D-3 锁定）。LO §1.1 在 C++/GLFW 中的 `glfwInit() + glfwCreateWindow() + glClear` 在 forgeax 中由 `Engine.create({ canvas })` 单行覆盖；因此本 README 不再重复 LO 文本，仅提供顶部 callout + 简短理由 + 直接链接到 [`src/index.ts`](./src/index.ts) 最薄代码段。本占位 README 显式豁免 AC-23（LO 折叠块）+ AC-24（`err.code` 差异行）。

## 为何占位

LO §1.1 的核心信息量是「能开一个窗口 + 把它清成统一颜色」。forgeax 的 `Engine.create({ canvas, clearColor })` 一行等价完成 GLFW + 渲染循环 + `glClearColor` + `glClear` 四件事，所以本示例无需重述 LO 教程；AI 用户只需读一遍 `src/index.ts`（约 80 行含注释）即可拿到整套 LO §1.1 → forgeax 的最薄映射。

完整示例（§1.3 shaders / §1.4 textures / §1.5 transformations / §1.6 coordinate-systems / §1.7 camera）严格遵循 wiki §7.4 7 段 MUST 模板（含 mermaid 渲染流程图 + 与 LO 差异表 + LO 折叠块）。

## 入口代码

最薄实现见 [`src/index.ts`](./src/index.ts)，三段式注释（AC-06）一目了然：

1. `// 1. engine usage` — 仅 import `Engine` + `EngineEnvironmentError` + `World` + `Camera` + `Transform`
2. `// 2. example-specific glue` — `clearColor = [0.2, 0.3, 0.3, 1.0]`（与 LO §1.1 同色）+ 单个 Camera 实体。引擎 `RenderSystem` 在 `renderables.length === 0` 时仍执行 swap-chain clear pass（Case E 软化，AGENTS.md §Breaking changes 2026-05-17 行；镜像 D-Q7 case C 0-Light 软化），所以 LO §1.1 不需要任何 mesh / material 占位，单个 Camera 足以触发清屏。
3. `// 3. bootstrap` — `Engine.create({ canvas, clearColor })` + `await renderer.ready` + `requestAnimationFrame` 渲染循环

运行：`pnpm --filter '@forgeax/app-learn-render-1-getting-started-1-hello-window' dev`（vite dev port 5180）。
