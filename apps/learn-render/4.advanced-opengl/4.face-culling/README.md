# Face Culling (LearnOpenGL section 4.advanced-opengl 4)

> [!NOTE]
> **LO original chapter**: [LearnOpenGL 4.4 Face Culling](https://learnopengl.com/Advanced-OpenGL/Face-culling)
>
> **Engine surface**: `createApp` + `MeshRenderer` with `frontFace` + `cullMode` in `MaterialRenderState` + `loadByGuid<TextureAsset>` texture loading + `configureRuntimeAssetCatalog`.

## Hit-rate index (AI user fast-locate)

| Engine capability | grep anchor | Where |
|:--|:--|:--|
| `frontFace` winding flip | `frontFace:` | `src/index.ts` (cube MaterialAsset renderState) |
| `cullMode` face culling | `cullMode:` | `src/index.ts` (cube MaterialAsset renderState) |
| `loadByGuid<TextureAsset>` GUID texture loading | `loadByGuid<TextureAsset>` | `src/index.ts` (bootstrap section) |
| Runtime catalog wiring | `configureRuntimeAssetCatalog` | `src/index.ts` (bootstrap section) |

## What this example shows

LO 4.4 exercise 1 asks the reader to create a CW-winding cube, set `glFrontFace(GL_CW)` to declare CW triangles as front-facing, enable culling with `glCullFace(GL_BACK)`, and move the camera inside the cube to observe the interior faces.

In forgeax, this example expresses the same culling semantics without manual vertex data:

1. **`frontFace: 'cw'`** (in `MaterialRenderState`) tells the GPU to treat CW-wound triangles as front-facing. When the camera is inside the cube looking at an inner face, the visible surface is the back side of an outward-facing CCW triangle. From the camera's viewpoint, that back side appears CW-wound. `frontFace='cw'` recognises these as front-facing.

2. **`cullMode: 'back'`** (in `MaterialRenderState`) culls back-facing triangles. The outer faces (originally CCW-wound, now back-facing because `frontFace='cw'`) are discarded. The inner faces (CW-appearing from inside, now front-facing) survive and are rendered. The camera at `(0,0,0)` inside the [-0.5, 0.5]^3 cube sees marble-textured interior walls.

3. **Camera inside the cube**: The camera entity has `Transform.pos=[0, 0, 0]` (cube center). With `perspective({ fov: PI/4, aspect: computed from canvas, near: 0.1, far: 100 })`, the view frustum captures the inner back face (z=-0.5), inner floor (y=-0.5), and inner side walls (x=-0.5, x=0.5).

4. **AC-09 verification**: Changing `cullMode` to `'front'` culls front-facing triangles -- the inner faces (CW-appearing from inside, front-facing with `frontFace='cw'`) are discarded, and the camera inside the cube sees only clear-color. Changing `frontFace` to `'ccw'` restores the default: CCW outer faces are front-facing and only the outer faces render (invisible from inside because they face outward).

The scene uses a single `marble.jpg` textured cube. Texture is loaded through the GUID asset pipeline (`configureRuntimeAssetCatalog(assets, runtimeBinding)` + `loadByGuid<TextureAsset>`), selecting the scoped dev catalog or emitted production catalog as appropriate. The cube uses **unlit** shading (forgeax `default-unlit` material shader) -- LO 4.4 teaches face culling, not lighting, so the full-brightness texture sample matches the tutorial's intent and keeps the interior walls evenly visible (a single directional light would darken inward-facing walls). The `default-unlit` shader honors the per-material `renderState` (`frontFace` / `cullMode`) on the same renderState-aware pipeline path that `standard` uses.

## Run

```bash
# Dev server (port 5177)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-4-face-culling" dev

# Build
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-4-face-culling" build

# Smoke (dawn-node pixel-readback)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-4-face-culling" smoke

# Typecheck
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-4-face-culling" typecheck
```

## forgeax-vs-LearnOpenGL mapping

| LO concept | LO C++ / OpenGL | forgeax equivalent |
|:--|:--|:--|
| CW winding input | CW-winding cube vertex data (36 vertices manually reversed) | `HANDLE_CUBE` (CCW winding, OOS-5: no manual CW mesh) |
| Front-face declaration | `glFrontFace(GL_CW)` | `renderState.frontFace: 'cw'` (TS literal, no `as` cast) |
| Enable culling | `glEnable(GL_CULL_FACE)` | Implicit -- culling is enabled when `cullMode` is set in `MaterialRenderState` |
| Cull back faces | `glCullFace(GL_BACK)` | `renderState.cullMode: 'back'` |
| Camera inside cube | User moves camera inside via keyboard input | `Transform` at `(0, 0, 0)` (cube center) |
| Cube geometry | 1x1x1 CW cube, 36 vertices, pos+texcoord | `HANDLE_CUBE` (engine-builtin 1x1x1 CCW cube) |
| Cube texture | `resources/textures/marble.jpg` | `marble.jpg` loaded via GUID `loadByGuid<TextureAsset>` |
| Shading | Unlit textured shader (texture sample, no lighting) | Unlit (forgeax `default-unlit`) |
| Window + loop | `glfwCreateWindow` + `while(!glfwWindowShouldClose)` | `createApp(canvas, opts)` from `@forgeax/engine-app` |

## Differences from the LearnOpenGL original

| Dimension | LO original (C++ / GLSL / GLFW) | forgeax here (TS / WGSL / WebGPU) |
|:--|:--|:--|
| Cube winding | CW-winding vertex data (exercise-specific) | CCW `HANDLE_CUBE` with `frontFace='cw'` flipping semantics |
| Winding declaration | `glFrontFace(GL_CW)` at OpenGL state level | `frontFace` field on `MaterialRenderState` (per-material, WebGPU `GPUPrimitiveState`) |
| Culling enablement | `glEnable(GL_CULL_FACE)` global state toggle | Implicit via `cullMode` field presence in `MaterialRenderState.renderState` |
| Camera control | First-person fly-camera with keyboard input | Static camera at cube center (no input system; interactive exploration via `apps/shared/src/learn-render-first-person.ts` if desired) |
| Shading model | Simple diffuse texture sample | Unlit texture sample (no lighting) -- matches LO 4.4 intent |
| Scene complexity | Single cube at origin | Single cube at origin (no floor or second cube; 4.4 tutorial focus is face culling, not scene composition) |

> [!IMPORTANT]
> The unlit output samples the marble texture at full brightness (no lighting), so the interior walls are evenly visible regardless of orientation. The culling behavior (frontFace='cw' + cullMode='back' revealing interior faces from a camera-inside viewpoint) is identical to LO's `glFrontFace(GL_CW)` + `glCullFace(GL_BACK)` with manual CW vertices.

## Key files

| File | Lines | Role |
|:--|--:|:--|
| `src/index.ts` | ~190 | Three-section bootstrap -- loads marble.jpg texture via GUID, registers unlit material with `frontFace:'cw'+cullMode:'back'`, spawns single cube, places camera at cube center |
| `scripts/smoke-dawn.mjs` | ~310 | Dawn-node pixel-readback smoke: decodes marble texture via `decodeImageFromFile`, registers with `registerWithGuid`, draws 60 frames, samples 4 interior wall sites and 2 corner sites, verifies >=1 interior wall site exceeds clear-color threshold |
| `package.json` | ~55 | Workspace metadata + dependencies (`engine-app`, `engine-runtime`, `engine-ecs`, `engine-pack`, `engine-types`) |

> [!NOTE]
> This demo uses the engine built-in `forgeax::default-unlit` material shader -- no custom `.wgsl` file nor `.wgsl.meta.json` sidecar is needed. Demos with custom material shaders (4.1 `depth-viz.wgsl`, 4.2 `outline-solid.wgsl`, 4.3 `alpha-test.wgsl`) each require a `.wgsl.meta.json` sidecar for `vite-plugin-shader` to recognise and compile the shader at build time.

## AI user discoverability

- Directory name: `apps/learn-render/4.advanced-opengl/4.face-culling/` mirrors LO chapter ordering
- Package name: `@forgeax/app-learn-render-4-advanced-opengl-4-face-culling` is grep-able by chapter prefix
- Three-section source markers (`// 1. engine usage` / `// 2. example glue` / `// 3. bootstrap`) serve as grep anchors
- `frontFace: 'cw'` is a top-level literal in `MaterialRenderState.renderState` -- AI users see it alongside `cullMode` at the same nesting level, no `as` casts needed
- `loadByGuid<TextureAsset>` + `configureRuntimeAssetCatalog` pattern is shared with all other learn-render 4.x demos (4.1, 4.2, 4.3), making it a consistent discoverable texture-loading idiom
