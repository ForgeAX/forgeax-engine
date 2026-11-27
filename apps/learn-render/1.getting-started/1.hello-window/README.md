<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.zh-CN.md)

# Hello Window (LearnOpenGL §1.1)

> [!NOTE]
> **Original chapter**: [LearnOpenGL 1.1 Hello Window](https://learnopengl.com/Getting-started/Hello-Window)
>
> **Engine capability**: feat-20260515-learn-render-getting-started -- `@forgeax/engine-runtime` `Engine.create({ canvas })`
>
> This is a placeholder example (plan-strategy 2.9 / D-3). One `Engine.create({ canvas })` replaces C++/GLFW `glfwInit() + glfwCreateWindow() + glClear`, so this README provides a callout, rationale and direct link to the minimal [`src/index.ts`](./src/index.ts) rather than repeating LO. It is explicitly exempt from AC-23 (LO collapsible block) and AC-24 (`err.code` comparison row).

## Why a Placeholder

LO 1.1 teaches opening a window and clearing it to one color. `Engine.create({ canvas, clearColor })` performs GLFW setup, the render loop, `glClearColor` and `glClear` in one line. Read `src/index.ts` (about 80 lines including comments) for the complete minimal mapping.

The full examples (1.3 shaders, 1.4 textures, 1.5 transformations, 1.6 coordinate systems, 1.7 camera) follow wiki 7.4's mandatory seven-section template, including a Mermaid rendering flow, comparison table and collapsible LO source.

## Entry Code

See [`src/index.ts`](./src/index.ts), organized by three comment markers (AC-06):

1. `// 1. engine usage`: import only `Engine`, `EngineEnvironmentError`, `World`, `Camera` and `Transform`.
2. `// 2. example-specific glue`: `clearColor = [0.2, 0.3, 0.3, 1.0]` matches LO 1.1, with one Camera entity. `RenderSystem` clears the swap chain even when `renderables.length === 0` (Case E relaxation, AGENTS.md breaking changes 2026-05-17; mirrored D-Q7 case C zero-light relaxation). No placeholder mesh/material is needed; one Camera triggers clearing.
3. `// 3. bootstrap`: `Engine.create({ canvas, clearColor })`, `await renderer.ready` and a `requestAnimationFrame` render loop.

Run `pnpm --filter '@forgeax/app-learn-render-1-getting-started-1-hello-window' dev` (Vite port 5180).
