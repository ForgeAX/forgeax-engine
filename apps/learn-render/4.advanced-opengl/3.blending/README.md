# Blending (LearnOpenGL section 4.advanced-opengl 3)

> [!NOTE]
> **LO original chapter**: [LearnOpenGL 4.3 Blending](https://learnopengl.com/Advanced-OpenGL/Blending)
>
> **Engine surface**: `createApp` + `MeshRenderer` with `blend` in `MaterialRenderState` + `TRANSPARENT_SORT_MODE_DISTANCE` (distance-based transparent sort) + `setTransparentSortConfig` + `configureRuntimeAssetCatalog` + `loadByGuid<TextureAsset>` + custom `registerMaterialShader` (alpha-test discard).

## Hit-rate index (AI user fast-locate)

| Engine capability | grep anchor | Where |
|:--|:--|:--|
| `setTransparentSortConfig` with mode=3 | `TRANSPARENT_SORT_MODE_DISTANCE` | `src/index.ts` (bootstrap, before scene setup) |
| `blend` SRC_ALPHA / ONE_MINUS_SRC_ALPHA | `blend:` | `src/index.ts` (window MaterialAsset renderState) |
| alpha-test discard shader (alpha < 0.1) | `alpha-test.wgsl` | `src/alpha-test.wgsl` (custom WGSL material shader) |
| `loadByGuid<TextureAsset>` GUID texture loading | `loadByGuid<TextureAsset>` | `src/index.ts` (bootstrap section) |
| Runtime catalog wiring | `configureRuntimeAssetCatalog` | `src/index.ts` (bootstrap section) |
| `registerMaterialShader` custom shader | `registerMaterialShader` | `src/index.ts` (alpha-test shader registration) |

## What this example shows

LO 4.3 teaches two techniques for handling partially-transparent objects: (1) alpha-test (discard) for sharp cutouts like grass/vegetation, and (2) alpha blending for semi-transparent surfaces like windows with correct back-to-front draw order via distance sorting.

In forgeax, this example expresses both techniques:

1. **Grass discard (alpha-test)**: Five `grass.png` quads at LO 4.3 exact positions, using the custom `alpha-test.wgsl` material shader that discards fragments where sampled alpha < 0.1 in the fragment stage. Grass renders in `RenderQueue.Transparent` with `depthWriteEnabled=false` so discarded holes do not occlude geometry behind them.

2. **Window blending**: Five `window.png` semi-transparent quads at the same LO 4.3 positions, using `blend.srcFactor='src-alpha'` / `blend.dstFactor='one-minus-src-alpha'` (SRC_ALPHA / ONE_MINUS_SRC_ALPHA) in `MaterialRenderState`. Windows also render in `RenderQueue.Transparent` with `depthWriteEnabled=false`.

3. **Distance-based transparent sort (mode=3)**: The demo calls `setTransparentSortConfig(world, { mode: TRANSPARENT_SORT_MODE_DISTANCE, yzAlpha: 1.0 })` to enable engine-level per-frame distance sorting of the Transparent queue. On each frame, the engine computes the squared distance from each transparent object to the camera and sorts them back-to-front (far objects drawn first), so near transparent windows correctly composite on top of far ones.

The scene also includes a `metal.png` textured floor at Y=-0.5 and a single `marble.jpg` textured cube at (0, 0.5, 0). Grass and window textures use `clamp-to-edge` addressMode (set in their `.meta.json` sidecar files) to prevent grey border artifacts from bilinear interpolation at texture edges.

Textures are loaded through the GUID asset pipeline (`configureRuntimeAssetCatalog(assets, runtimeBinding)` + `loadByGuid<TextureAsset>`). The helper selects the scoped Vite catalog in development and the emitted `/pack-index.json` in a production build.

## Run

```bash
# Dev server (port 5176)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-3-blending" dev

# Build
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-3-blending" build

# Smoke (dawn-node pixel-readback)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-3-blending" smoke

# Typecheck
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-3-blending" typecheck
```

## forgeax-vs-LearnOpenGL mapping

| LO concept | LO C++ / OpenGL | forgeax equivalent |
|:--|:--|:--|
| Alpha discard | `if (texColor.a < 0.1) discard;` in GLSL | `alpha-test.wgsl` fragment shader: `if (alpha < 0.1) { discard; }` in WGSL |
| Blend function | `glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA)` | `renderState.blend.color: { srcFactor:'src-alpha', dstFactor:'one-minus-src-alpha', operation:'add' }` |
| Distance sort (back-to-front) | `std::map<float, vec3>` + reverse iterator | `TRANSPARENT_SORT_MODE_DISTANCE` (mode=3) engine-level per-frame re-sort of `RenderQueue.Transparent` segment |
| Depth write disable (transparent) | Default (depth test still active, depth write controlled separately) | `renderState.depthWriteEnabled: false` on transparent passes |
| RGBA texture wrap | `GL_CLAMP_TO_EDGE` for RGBA textures | `.meta.json` sidecar `importSettings.addressMode: 'clamp-to-edge'` (prevents bilinear edge artifacts) |
| Grass texture | `resources/textures/grass.png` (RGBA, discard variant) | `grass.png` loaded via GUID `loadByGuid<TextureAsset>`, clamp-to-edge |
| Window texture | `resources/textures/window.png` (RGBA, sorted variant) | `window.png` loaded via GUID `loadByGuid<TextureAsset>`, clamp-to-edge |
| Floor plane | Custom 6-vertex plane at Y=-0.5 with texcoord=2.0 | `HANDLE_QUAD` (engine-builtin 1x1 quad) rotated -90 deg around X, scaled 5x5 at Y=-0.5 |
| Cube geometry | 1x1x1 CCW cube, 36 vertices | `HANDLE_CUBE` (engine-builtin CCW cube) |
| Transparent positions | 5 `glm::vec3` positions | Same 5 positions: (-1.5,0,-0.48), (1.5,0,0.51), (0,0,0.7), (-0.3,0,-2.3), (0.5,0,-0.6) |
| Texture loading | `stb_image.h` + `loadTexture(path)` | `configureRuntimeAssetCatalog` + `loadByGuid<TextureAsset>` with sidecar `.meta.json` |
| Camera | LO `Camera` class at (0,0,3), Zoom=45 deg | `Transform` (at (0,0,3)) + `Camera` (fov=PI/4, near=0.1, far=100) |
| Window + loop | `glfwCreateWindow` + `while(!glfwWindowShouldClose)` | `createApp(canvas, opts)` from `@forgeax/engine-app` |

## Differences from the LearnOpenGL original

| Dimension | LO original (C++ / GLSL / GLFW) | forgeax here (TS / WGSL / WebGPU) |
|:--|:--|:--|
| Shading model | Phong (cube + floor) / untextured for transparent objects | PBR microfacet for opaque floor + cube, PBR with alpha blend for windows, custom WGSL alpha-test for grass |
| Discard shader texture | 1 texture binding (diffuse only) | 7 bindings at @group(1) (material uniform + 3 texture-sampler pairs) per engine BindGroupLayout |
| Sort mechanism | `std::map<float, vec3>` per-frame CPU sort with `glm::length` | Engine record-stage per-frame distance sub-sort of Transparent queue segment using squared distance kernel |
| Sort configuration | Hardcoded in C++ render loop | Declarative `setTransparentSortConfig(world, { mode: 3 })` once at setup |
| Two techniques | Separate C++ examples (3.1 discard, 3.2 sorted) | Single scene combining both techniques (grass discard + window blend) |
| Floor texcoord | 6 custom vertices, texcoord=2.0 on edges for REPEAT tiling | `HANDLE_QUAD` [0,1] texcoords; metal.png tiles 1x across 5-unit quad (same tiling frequency as LO's 2x across 10 units) |
| Cube count | 2 cubes at (-1,0,-1) and (2,0,0) | 1 cube at (0, 0.5, 0) |
| Render loop | `glfwSwapBuffers` + `glfwPollEvents` | `createApp` rAF frame-loop with `Time` resource + auto input |

> [!IMPORTANT]
> The PBR output differs visually from LO's Phong result for the cube interior and floor. The blending behavior (alpha-test discard threshold 0.1 + SRC_ALPHA composition) matches LO exactly. The distance sort direction (back-to-front, far objects drawn first) is identical to LO's `std::map` + reverse iterator.

## Key files

| File | Lines | Role |
|:--|--:|:--|
| `src/index.ts` | ~380 | Three-section bootstrap -- spawns floor, cube, 5 grass discard quads, 5 window blend quads; loads textures via GUID; registers alpha-test shader; configures mode=3 transparent sort |
| `src/alpha-test.wgsl` | ~60 | Custom WGSL material shader: vertex pass-through + fragment alpha discard (< 0.1 threshold) |
| `src/alpha-test.wgsl.meta.json` | ~10 | Sidecar required by `vite-plugin-shader`: declares `.wgsl` file as `kind: 'material-shader'`; omitting it causes vite build to ignore the shader |
| `scripts/smoke-dawn.mjs` | ~690 | Dawn-node pixel-readback smoke: compose alpha-test WGSL, decode textures via `decodeImageFromFile`, register with `registerWithGuid`, draw 60 frames, verify >=1 mesh site exceeds clear-color threshold |
| `package.json` | ~50 | Workspace metadata + dependencies (`engine-app`, `engine-runtime`, `engine-ecs`, `engine-pack`, `engine-types`) |

## AI user discoverability

- Directory name: `apps/learn-render/4.advanced-opengl/3.blending/` mirrors LO chapter ordering
- Package name: `@forgeax/app-learn-render-4-advanced-opengl-3-blending` is grep-able by chapter prefix
- Three-section source markers (`// 1. engine usage` / `// 2. example glue` / `// 3. bootstrap`) serve as grep anchors
- `setTransparentSortConfig` + `TRANSPARENT_SORT_MODE_DISTANCE` are designed as self-documenting descriptor APIs (mode=3 for distance-based sort)
- `alpha-test.wgsl` source is a self-contained WGSL file that AI users can copy as a starting point for their own discard-based shaders (e.g., ladders, fences, foliage)
