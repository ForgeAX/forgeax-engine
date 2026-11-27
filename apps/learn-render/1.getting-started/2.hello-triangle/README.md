<!-- LANG-SWITCH -->
**Language**: **English** · [简体中文](README.zh-CN.md)

# Hello Triangle (LearnOpenGL §1.2)

> [!NOTE]
> **Original chapter**: [LearnOpenGL 1.2 Hello Triangle](https://learnopengl.com/Getting-started/Hello-Triangle)
>
> **Engine capability**: feat-20260515-learn-render-getting-started -- `world.spawn(Transform + MeshFilter { assetHandle: triangle } + MeshRenderer)` plus `world.spawn(Transform + Camera)`, then `Engine.create({ canvas, clearColor })` and `renderer.draw(world)` draw the first triangle to the swap chain. LO 1.2 uses unlit orange, so no `DirectionalLight` is spawned; the material pass selects the unlit program and `values.baseColor` supplies color (charter F1 / P1 progressive disclosure).

## Following LO 1.2 in ForgeaX

LO's `glGenVertexArrays + glGenBuffers + glBufferData + glDrawArrays(GL_TRIANGLES, 0, 3)` becomes two steps: **built-in mesh handle and ECS spawn**.

1. Geometry's `createPrimitiveMesh('triangle')` creates triangle data. `assets.create(mesh).unwrap()` returns a managed handle for `MeshFilter.assetHandle`; Renderer owns GPU upload.
2. `world.spawn(Transform + MeshFilter { assetHandle: triangle } + MeshRenderer)` replaces binding the VAO and drawing. RenderSystem traverses the World query graph through Extract / Prepare / Record and submits one GPU command buffer per frame.

See [`src/index.ts`](src/index.ts) for the AC-06 markers `// 1. engine usage`, `// 2. example-specific glue` and `// 3. bootstrap`.

## Run

```bash
pnpm --filter "@forgeax/app-learn-render-1-getting-started-2-hello-triangle" dev
```

Open <http://localhost:5181>. Expect a teal background matching LO 1.1 / 1.3 and a centered orange triangle (`vec4(1.0, 0.5, 0.2, 1.0)`, matching LO 1.2's fragment shader). DevTools logs `[learn-render 1.2 hello-triangle] backend=webgpu`.

## Relationship to apps/hello/triangle/

`apps/hello/triangle/` is the engineering anchor: `pnpm --filter @forgeax/hello-triangle smoke` performs 300 Dawn frames and pixel readback, and the app supplies the pixel-parity benchmark baseline with gray PBR and DirectionalLight. This directory is the **minimal LO 1.2 teaching mapping**, using unlit orange without DirectionalLight. Their roles and spawned content differ:

| Dimension | `apps/hello/triangle/` | `apps/learn-render/1.getting-started/2.hello-triangle/` |
|:--|:--|:--|
| Role | Engineering anchor: Dawn smoke, pixel-parity baseline and multiple RHI backends | LO 1.2 teaching example |
| `world.spawn` | Transform + MeshFilter + gray MeshRenderer + Camera + DirectionalLight | Transform + MeshFilter + LO-orange MeshRenderer (1.0/0.5/0.2) + Camera |
| Color | Default PBR (`baseColor=0.5/0.5/0.5`, `metallic=0`, `roughness=1`), retaining lighting for PBR shader upgrades | LO 1.2 literal fragment output `vec4(1.0, 0.5, 0.2, 1.0)` |
| Extras | Explicit `createCanvasContext`, dual-projection NO/ReverseZ CPU baking, URL counterexamples (`?backend=webgl2` smoke failure / `?clearOnly=1`) | Minimal LO mapping, rAF loop and capture hook, prioritizing teaching |
| Smoke gate | 300 Dawn frames and pixel readback | OOS-10 / D-7 selects 4.textures and 7.camera only; validate 1.2 visually with the local dev server |

Start here for the teaching path; consult `apps/hello/triangle/README.md` for Dawn smoke, pixel parity and dual-projection engineering topics.

## R5 fallback recovery probe

`r5-probe.html#mode=b` first waits for a completed ready geometry picture, then
injects the invalid submission on the same device. Exactly the next renderer
frame must complete with `presentation: ready` and non-black pixels. A successful
clear-only submission is not a recovered triangle. The full verifier retains
the 15,000-entity mode, channel proof, no-panic assertions and its original budget.
