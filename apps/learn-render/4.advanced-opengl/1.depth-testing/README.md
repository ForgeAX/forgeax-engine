# Depth Testing (LearnOpenGL section 4.advanced-opengl 1)

> [!NOTE]
> **LO original chapter**: [LearnOpenGL 4.1 Depth Testing](https://learnopengl.com/Advanced-OpenGL/Depth-testing)
>
> **Engine surface**: `createApp` + `MeshRenderer` with `depthCompare`/`depthWriteEnabled` in `MaterialRenderState` + `configureRuntimeAssetCatalog` + `loadByGuid<TextureAsset>` + custom `registerMaterialShader` (depth-viz).

## Hit-rate index (AI user fast-locate)

| Engine capability | grep anchor | Where |
|:--|:--|:--|
| `depthCompare` / `depthWriteEnabled` pipeline state | `renderState: {` | `src/index.ts` (pass-based `MaterialAsset.renderState`) |
| `loadByGuid<TextureAsset>` GUID texture loading | `loadByGuid<TextureAsset>` | `src/index.ts` (bootstrap section) |
| Runtime catalog wiring | `configureRuntimeAssetCatalog` | `src/index.ts` (bootstrap section) |
| `registerMaterialShader` custom shader | `registerMaterialShader` | `src/index.ts` (depth-viz shader registration) |
| Custom WGSL material shader (`@builtin(position).z`) | `depth-viz.wgsl` | `src/depth-viz.wgsl` |

## What this example shows

LO 4.1 teaches two concepts: (1) the depth buffer and depth testing (`GL_LESS` vs `GL_ALWAYS`), and (2) depth buffer visualization via `gl_FragCoord.z` and the `linearizeDepth` formula.

In forgeax, this example expresses the same concepts through two rendering paths toggled by the `USE_DEPTH_VIZ` constant in `src/index.ts`:

1. **Normal path** (`USE_DEPTH_VIZ = false`): A `metal.png`-textured floor at Y=-0.5 and two `marble.jpg`-textured cubes at (-1,0,-1) and (2,0,0). All entities use the PBR material shader (`forgeax::default-standard-pbr`). Depth testing is the engine default (`depthCompare: 'less'`), so closer objects occlude farther ones.

2. **Depth-viz path** (`USE_DEPTH_VIZ = true`): Same scene geometry, but all entities use a custom depth-viz material shader registered via `registerMaterialShader`. The fragment shader reads `@builtin(position).z` (clip-space depth), applies the standard `linearizeDepth` formula (near=0.1, far=100.0), and outputs grayscale where near pixels are dark and far pixels are light.

Textures are loaded through the GUID asset pipeline (`configureRuntimeAssetCatalog(assets, runtimeBinding)` + `loadByGuid<TextureAsset>`). The helper selects the scoped Vite catalog in development and the emitted `/pack-index.json` in a production build.

## Run

```bash
# Dev server (port 5174)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-1-depth-testing" dev

# Build
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-1-depth-testing" build

# Smoke (dawn-node pixel-readback)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-1-depth-testing" smoke

# Typecheck
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-1-depth-testing" typecheck
```

## forgeax-vs-LearnOpenGL mapping

| LO concept | LO C++ / OpenGL | forgeax equivalent |
|:--|:--|:--|
| Depth test | `glEnable(GL_DEPTH_TEST)` + `glDepthFunc(GL_LESS)` | Engine default `depthCompare: 'less'` in MaterialRenderState (opt-in per-pass via `renderState`) |
| Depth buffer visualization | `gl_FragCoord.z` in GLSL + `LinearizeDepth()` function | `@builtin(position).z` in WGSL + inline `linearizeDepth` formula in `depth-viz.wgsl` |
| Floor plane | Custom 6-vertex plane at Y=-0.5 with texcoord=2.0 | `HANDLE_QUAD` (engine-builtin 1x1 quad) rotated -90 deg around X, scaled 5x5 at Y=-0.5 |
| Cube geometry | 1x1x1 CCW cube, 36 vertices | `HANDLE_CUBE` (engine-builtin CCW cube) |
| Cube transforms | `glm::translate((-1,0,-1))` / `glm::translate((2,0,0))` | ECS `Transform` component: `pos=[-1, 0, -1]` / `pos=[2, 0, 0]` |
| Texture loading | `stb_image.h` + `loadTexture(path)` with `GL_REPEAT` | `configureRuntimeAssetCatalog` + `loadByGuid<TextureAsset>` with sidecar `.meta.json` `importSettings.addressMode: 'repeat'` |
| Camera | LO `Camera` class at (0,0,3), Zoom=45 deg | `Transform` (at (0,0,3)) + `Camera` (fov=PI/4, near=0.1, far=100) |
| Custom shader | Separate GLSL program for depth-viz | `registerMaterialShader('learn_render::depth_viz', entry)` + pass-based MaterialAsset |
| Window + loop | `glfwCreateWindow` + `while(!glfwWindowShouldClose)` | `createApp(canvas, opts)` from `@forgeax/engine-app` |

## Differences from the LearnOpenGL original

| Dimension | LO original (C++ / GLSL / GLFW) | forgeax here (TS / WGSL / WebGPU) |
|:--|:--|:--|
| Shading model | Phong / untextured for depth-viz | PBR microfacet for normal path; custom WGSL for depth-viz |
| Floor texcoord | 6 custom vertices, texcoord=2.0 on edges for REPEAT tiling | `HANDLE_QUAD` [0,1] texcoords; metal.png tiles 1x across 5-unit quad (same tiling frequency as LO's 2x across 10 units) |
| Depth-viz FS input | `gl_FragCoord.z` (window-space depth, [0,1] in NDC) | `@builtin(position).z` (clip-space depth, [0,1] after perspective divide) |
| Depth-test toggle | Separate `.cpp` files (1.1 vs 1.2) | Compile-time `USE_DEPTH_VIZ` constant toggle in `index.ts` |
| Render loop | `glfwSwapBuffers` + `glfwPollEvents` | `createApp` rAF frame-loop with `Time` resource + auto input |
| Shader management | `Shader` class + compile/link/use | `vite-plugin-shader` build-time compile + `registerMaterialShader` at runtime |

> [!IMPORTANT]
> The PBR output differs visually from LO's Phong result. The depth-viz path uses the exact same `linearizeDepth` formula from LO 4.1.2, inlined in the custom WGSL shader per OOS-1.

## Key files

| File | Lines | Role |
|:--|--:|:--|
| `src/index.ts` | ~250 | Three-section bootstrap -- spawns floor, 2 cubes, light, camera; loads textures via GUID; registers depth-viz shader |
| `src/depth-viz.wgsl` | ~70 | Custom WGSL material shader: vertex pass-through + fragment depth-to-grayscale |
| `src/depth-viz.wgsl.meta.json` | ~10 | Sidecar required by `vite-plugin-shader`: declares `.wgsl` file as `kind: 'material-shader'`; omitting it causes vite build to ignore the shader |
| `scripts/smoke-dawn.mjs` | ~340 | Dawn-node pixel-readback smoke: decode textures via `decodeImageFromFile`, register with `registerWithGuid`, draw 60 frames, verify >=1 mesh site exceeds clear-color threshold |
| `package.json` | ~50 | Workspace metadata + dependencies (`engine-app`, `engine-runtime`, `engine-ecs`, `engine-pack`, `engine-types`) |

## AI user discoverability

- Directory name: `apps/learn-render/4.advanced-opengl/1.depth-testing/` mirrors LO chapter ordering
- Package name: `@forgeax/app-learn-render-4-advanced-opengl-1-depth-testing` is grep-able by chapter prefix
- Three-section source markers (`// 1. engine usage` / `// 2. example glue` / `// 3. bootstrap`) serve as grep anchors
- `depth-viz.wgsl` source is a self-contained WGSL file that AI users can copy as a starting point for their own post-process shaders
