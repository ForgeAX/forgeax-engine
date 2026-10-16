# Stencil Testing (LearnOpenGL section 4.advanced-opengl 2)

> [!NOTE]
> **LO original chapter**: [LearnOpenGL 4.2 Stencil Testing](https://learnopengl.com/Advanced-OpenGL/Stencil-testing)
>
> **Engine surface**: `createApp` + `MeshRenderer` with `stencilWriteMask`/`stencilReadMask` in `MaterialRenderState` + `stencilReference` in `MaterialPass` + `configureRuntimeAssetCatalog` + `loadByGuid<TextureAsset>` + custom `registerMaterialShader` (outline-solid).

## Hit-rate index (AI user fast-locate)

| Engine capability | grep anchor | Where |
|:--|:--|:--|
| `stencilWriteMask` pipeline state | `stencilWriteMask:` | `src/index.ts` (floor + cube pass renderState literals) |
| `stencilReadMask` pipeline state | `stencilReadMask:` | `src/index.ts` (outline pass renderState literal) |
| `stencilReference` draw-call state | `stencilReference:` | `src/index.ts` (cube + outline MaterialPass) |
| `stencil.compare='not-equal'` stencil test | `compare: 'not-equal'` | `src/index.ts` (outline pass renderState.stencil) |
| Multi-pass material (per-entity passes) | `passes: [` | `src/index.ts` (cube + floor + outline three-pass layout) |
| `loadByGuid<TextureAsset>` GUID texture loading | `loadByGuid<TextureAsset>` | `src/index.ts` (bootstrap section) |
| `registerMaterialShader` custom shader | `registerMaterialShader` | `src/index.ts` (outline-solid shader registration) |
| Custom WGSL pure-color unlit shader | `outline-solid.wgsl` | `src/outline-solid.wgsl` |

## What this example shows

LO 4.2 teaches the stencil buffer through a three-entity stencil outline sequence:

1. **Floor**: A `metal.png`-textured floor at Y=-0.5 with `stencilWriteMask=0x00` -- does NOT write to the stencil buffer. Because the floor never writes stencil, the outline pass never draws outline pixels over floor regions.

2. **Cubes**: Two `marble.jpg`-textured cubes at (-1,0,-1) and (2,0,0) with `stencil.compare='always'` + `stencilWriteMask=0xFF` + `stencilReference=1`. These always pass the stencil test and write ref=1 everywhere they rasterize.

3. **Outlines**: Two scale-1.1 cubes at the same positions, using a custom `outline-solid` unlit material shader with `stencil.compare='not-equal'` + `stencilReadMask=0xFF` + `stencilReference=1` + `depthWriteEnabled=false`. The stencil test rejects fragments where stencil value equals 1 (the cube interior), so only the narrow outline band outside each cube passes. The outline color matches LO exactly: `(0.04, 0.28, 0.26, 1.0)` (cyan-green).

Since the engine does not support per-pass Transform overrides on a single entity, the outline is implemented via separate outline entities with `Transform.scale = 1.1` at the same world positions as the cube entities. This is structurally equivalent to LO's `glm::scale(model, glm::vec3(1.1))` draw call.

## Run

```bash
# Dev server (port 5175)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-2-stencil-testing" dev

# Build
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-2-stencil-testing" build

# Smoke (dawn-node pixel-readback)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-2-stencil-testing" smoke

# Typecheck
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-2-stencil-testing" typecheck
```

## forgeax-vs-LearnOpenGL mapping

| LO concept | LO C++ / OpenGL | forgeax equivalent |
|:--|:--|:--|
| Stencil write disable | `glStencilMask(0x00)` | `renderState.stencilWriteMask: 0x00` in MaterialRenderState (top-level field, mirrors `GPUDepthStencilState`) |
| Stencil write enable | `glStencilMask(0xFF)` | `renderState.stencilWriteMask: 0xFF` in MaterialRenderState |
| Stencil func always (cube pass) | `glStencilFunc(GL_ALWAYS, 1, 0xFF)` | `renderState.stencil: { compare:'always', passOp:'replace' }` + `stencilReference: 1` |
| Stencil func not-equal (outline) | `glStencilFunc(GL_NOTEQUAL, 1, 0xFF)` | `renderState.stencilReadMask: 0xFF` + `renderState.stencil: { compare:'not-equal' }` + `stencilReference: 1` |
| Depth test disable (outline) | `glDisable(GL_DEPTH_TEST)` | `renderState.depthWriteEnabled: false` (outline pass renderState) |
| Outline scale 1.1 | `glm::scale(model, glm::vec3(1.1))` | ECS `Transform` component: `scale=[1.1, 1.1, 1.1]` |
| Single-color outline shader | `2.stencil_single_color.fs` outputs constant `vec4(0.04,0.28,0.26,1.0)` | `outline-solid.wgsl` fragment returns `material.baseColor` (uniform parameter) |
| Floor plane | Custom 6-vertex plane at Y=-0.5 with texcoord=2.0 | `HANDLE_QUAD` (engine-builtin 1x1 quad) rotated -90 deg around X, scaled 5x5 at Y=-0.5 |
| Cube geometry | 1x1x1 CCW cube, 36 vertices | `HANDLE_CUBE` (engine-builtin CCW cube) |
| Cube transforms | `glm::translate((-1,0,-1))` / `glm::translate((2,0,0))` | ECS `Transform` component: `pos=[-1, 0, -1]` / `pos=[2, 0, 0]` |
| Texture loading | `stb_image.h` + `loadTexture(path)` with `GL_REPEAT` | `configureRuntimeAssetCatalog` + `loadByGuid<TextureAsset>` with sidecar `.meta.json` |
| Camera | LO `Camera` class at (0,0,3), Zoom=45 deg | `Transform` (at (0,0,3)) + `Camera` (fov=PI/4, near=0.1, far=100) |
| Window + loop | `glfwCreateWindow` + `while(!glfwWindowShouldClose)` | `createApp(canvas, opts)` from `@forgeax/engine-app` |

## Differences from the LearnOpenGL original

| Dimension | LO original (C++ / GLSL / GLFW) | forgeax here (TS / WGSL / WebGPU) |
|:--|:--|:--|
| Shading model | Phong (cube normal pass) | PBR microfacet (cube normal pass) |
| Outline shader binding | Single `uniform vec4` (no textures, no samplers) | Full engine BindGroupLayout at @group(1) (7 bindings: material + 3 texture-sampler pairs) -- unused in the shader body but structurally required for pipeline layout compatibility |
| Per-pass scale | `glm::scale(model, vec3(1.1))` applied per-draw-call on the same VAO | Separate outline entity with `Transform.scale = 1.1` -- structurally equivalent |
| Multi-pass | Sequential `draw` + `draw` on same VAO with different state per call | Three entity groups (floor / cubes / outlines) with distinct MaterialAssets |
| Stencil state API | `glStencilMask` / `glStencilFunc` / `glStencilOp` global state mutations per draw | Declarative per-pass `renderState` + `stencilReference` on each `MaterialAsset` |
| Floor texcoord | 6 custom vertices, texcoord=2.0 on edges for REPEAT tiling | `HANDLE_QUAD` [0,1] texcoords; metal.png tiles 1x across 5-unit quad (same tiling frequency as LO's 2x across 10 units) |
| Render loop | `glfwSwapBuffers` + `glfwPollEvents` | `createApp` rAF frame-loop with `Time` resource + auto input |

> [!IMPORTANT]
> The PBR output differs visually from LO's Phong result for the cube interior. The outline band uses the exact LO color `(0.04, 0.28, 0.26, 1.0)` rendered as a pure unlit pass, matching the LO outline visual exactly.

## Key files

| File | Lines | Role |
|:--|--:|:--|
| `src/index.ts` | ~280 | Three-section bootstrap -- spawns floor entity (stencilWriteMask=0x00) + 2 cube entities (stencil write ref=1) + 2 outline entities (stencil compare='not-equal' + scale=1.1); loads textures via GUID; registers outline-solid shader |
| `src/outline-solid.wgsl` | ~65 | Custom WGSL pure-color unlit material shader: vertex pass-through + fragment return `material.baseColor` |
| `src/outline-solid.wgsl.meta.json` | ~10 | Sidecar required by `vite-plugin-shader`: declares `.wgsl` file as `kind: 'material-shader'`; omitting it causes vite build to ignore the shader |
| `scripts/smoke-dawn.mjs` | ~540 | Dawn-node pixel-readback smoke: compose outline-solid WGSL, decode textures via `decodeImageFromFile`, register with `registerWithGuid`, draw 60 frames, verify >=1 mesh site exceeds clear-color threshold |
| `package.json` | ~50 | Workspace metadata + dependencies (`engine-app`, `engine-runtime`, `engine-ecs`, `engine-pack`, `engine-types`) |

## AI user discoverability

- Directory name: `apps/learn-render/4.advanced-opengl/2.stencil-testing/` mirrors LO chapter ordering
- Package name: `@forgeax/app-learn-render-4-advanced-opengl-2-stencil-testing` is grep-able by chapter prefix
- Three-section source markers (`// 1. engine usage` / `// 2. example glue` / `// 3. bootstrap`) serve as grep anchors
- `outline-solid.wgsl` source is a self-contained WGSL file that AI users can copy as a starting point for their own unlit post-process or overlay shaders
- `stencilWriteMask` / `stencilReadMask` are MaterialRenderState top-level fields (not inside `StencilFaceState`) mirroring `GPUDepthStencilState` byte-for-byte per forgeax RHI form rules
