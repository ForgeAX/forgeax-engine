# Cubemaps (LearnOpenGL section 4.advanced-opengl 6)

> [!NOTE]
> **LO original chapter**: [LearnOpenGL 4.6 Cubemaps](https://learnopengl.com/Advanced-OpenGL/Cubemaps)
>
> **Engine surface**: `createApp` + `loadByGuid<EquirectAsset>` + `Skylight{ equirect }` + `SkyboxBackground(SKYBOX_MODE_CUBEMAP)` + `Materials.standard({ metallic, roughness })` + PBR IBL reflection.

## Hit-rate index (AI user fast-locate)

| LO sub-example | Hit? | forgeax equivalent | grep anchor |
|:--|:--|:--|:--|
| 6-PNG cubemap face loading | **offset** | equirect HDR routing via `loadByGuid<EquirectAsset>` (OOS-3: 6-PNG loader deferred) | `EquirectAsset` |
| Cube-mapped skybox rendering | **hit** | `SkyboxBackground(SKYBOX_MODE_CUBEMAP)` renders the cubemap as visible background | `SkyboxBackground` |
| Reflection environment mapping | **hit** | PBR `standard` material with `metallic=1, roughness=0` + IBL `Skylight` | `Materials.standard` |
| Cubemap sampler in shader | N/A | Engine handles `textureCube` sampling internally via `Skylight`; user sees one `SkyboxBackground` spawn | `SKYBOX_MODE_CUBEMAP` |

## What this example shows

LO 4.6 teaches cubemaps: loading 6 cube-face PNG images, creating a cubemap texture, rendering a skybox cube, and using the cubemap for reflection/environment mapping on objects.

In forgeax, this example demonstrates the same teaching concept through forgeax-first primitives:

1. **Equirect HDR as an asset kind**: forgeax loads an equirectangular HDR image (`newport_loft.hdr`, GUID `019e4a26-3c29-7420-af5d-20f2724a16b0` from the `forgeax-engine-assets` vendor submodule, CC BY-NC 4.0) as an `EquirectAsset` via `loadByGuid<EquirectAsset>`. This is the forgeax equivalent of LO's 6-PNG cubemap face loading -- a single HDR input replaces 6 PNG faces (OOS-3: 6-PNG cubemap loader is deferred in the engine). The equirect-to-cubemap conversion + IBL precompute happen **internally** inside the render record arm; the demo never calls an upload API.

2. **Skylight + SkyboxBackground**: Two components hold the same equirect handle (`Skylight{ equirect }`, `SkyboxBackground{ equirect }`):
   - `Skylight` provides PBR IBL (image-based lighting) -- diffuse irradiance and specular prefiltered mip chain for the PBR standard material.
   - `SkyboxBackground(SKYBOX_MODE_CUBEMAP)` renders the internally-projected cubemap as the visible background, matching LO's skybox render.

3. **Reflection contrast**: Two cubes sit side-by-side:
   - **Reflective cube** (left): `Materials.standard({ metallic: 1, roughness: 0 })` -- full metallic PBR surface mirrors the IBL cubemap environment with sharp specular reflections.
   - **Non-reflective cube** (right): `Materials.standard({ metallic: 0, roughness: 0.5 })` -- matte dielectric surface, lit by the same IBL environment but without mirror-like reflections.

4. **Camera with HDR tonemap**: The camera uses `TONEMAP_REINHARD_EXTENDED` (AC-02). Skybox rendering requires HDR color target support; tonemap maps the HDR values into the SDR display range.

5. **DirectionalLight**: A single directional light supplements the IBL illumination, providing explicit direct-light shading on the non-reflective cube.

## Pipeline steps (how the engine processes the data)

```
newport_loft.hdr (disk, 3.8 MB equirect HDR)
  |-- loadByGuid<EquirectAsset>(guid)                    -- GUID asset pipeline (EquirectAsset POD)
  |-- allocSharedRef('EquirectAsset', pod)               -- mint a user-tier equirect handle
  |-- spawn Skylight{ equirect: handle }                 -- PBR IBL diffuse+specular
  |-- spawn SkyboxBackground{ equirect: handle }         -- visible cubemap background
  |   (engine record arm lazily projects equirect->cubemap + IBL internally)
  +-- spawn reflective cube (metallic=1, roughness=0)     -- shows IBL environment mirror
  +-- spawn non-reflective cube (metallic=0, roughness=0.5) -- shows matte IBL-lit surface
```

## Run

> [!IMPORTANT]
> **Use `build` + `preview`, not `dev`, to see this demo render.** The newport_loft
> HDR equirect source is cooked into a cubemap at **build time** only; `pnpm dev`
> serves the raw source uncooked, so `loadByGuid` returns `asset-not-imported` and
> the frame stays black (structured error logged to the console, per charter P3).
> This is shared IBL-demo-family behavior (same as `6.pbr/3.ibl-specular`), not a
> bug. The dawn-node `smoke` builds an in-memory cubemap and is unaffected.

```bash
# Build + preview (recommended — see the skybox + reflections render)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-6-cubemaps" build
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-6-cubemaps" preview

# Dev server (port 5178) — note: HDR skybox renders black in dev (see above)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-6-cubemaps" dev

# Smoke (dawn-node dual-state pixel-diff)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-6-cubemaps" smoke

# FALSIFY check (local-only: verify smoke sensitivity)
FALSIFY=skybox-reuse-buffer pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-6-cubemaps" smoke

# Typecheck
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-6-cubemaps" typecheck
```

## forgeax-vs-LearnOpenGL mapping

| LO concept | LO C++ / OpenGL | forgeax equivalent |
|:--|:--|:--|
| Cube-map face images | 6 PNG files (right/left/top/bottom/front/back) | Single HDR equirect image (`newport_loft.hdr`) loaded as `EquirectAsset` |
| Cubemap texture creation | `glTexImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X + i, ...)` for each face | Engine projects the cubemap internally from the equirect handle; user calls no upload API |
| Skybox rendering | Manual skybox cube with depth-trick (`glDepthFunc(GL_LEQUAL)`) | `SkyboxBackground(SKYBOX_MODE_CUBEMAP)` component -- engine handles depth + render pass ordering |
| Reflection mapping | `glTexGeni(GL_S, GL_TEXTURE_GEN_MODE, GL_REFLECTION_MAP)` | PBR `Materials.standard({ metallic: 1, roughness: 0 })` + IBL `Skylight` -- engine resolves reflection via split-sum approximation |
| Environment mapping | Fragment shader samples `skybox` via `reflect(viewDir, normal)` | Engine handles it in PBR BRDF shader; user provides `Skylight{ equirect }` + sets `metallic`/`roughness` on material |
| Shader uniform for cubemap | `glUniform1i(glGetUniformLocation(shader, "skybox"), 0)` | `Skylight` component data drives engine's internal IBL binding |
| Window + loop | `glfwCreateWindow` + `while(!glfwWindowShouldClose)` | `createApp(canvas, opts)` from `@forgeax/engine-app` |
| Keyboard camera | `glfwGetKey(window, GLFW_KEY_W)` etc. | `addFirstPersonSystem` from `apps/shared/src/learn-render-first-person.ts` |

## Differences from the LearnOpenGL original

| Dimension | LO original (C++ / GLSL / GLFW) | forgeax here (TS / WGSL / WebGPU) |
|:--|:--|:--|
| Cubemap source | 6 PNG faces loaded from disk | Single HDR equirect image (OOS-3: 6-PNG deferred) |
| Skybox mesh | Hand-crafted cube geometry with 36 vertices | Engine-internal fullscreen triangle (no cube geometry needed) |
| Depth write trick | `glDepthFunc(GL_LEQUAL)` + `glDepthMask(GL_FALSE)` | Engine skybox pass handles depth automatically |
| Reflection shader | Fragment shader `reflect(viewDir, normal)` to sample cubemap | PBR split-sum BRDF + prefiltered IBL mip chain (automatic) |
| Shading model | Phong + environment override | PBR `standard` (`forgeax::default-standard-pbr`) |
| Scene complexity | 1 skybox cube + 1 reflective cube | 1 equirect HDR skybox background + 2 cubes (reflective + non-reflective) for contrast |
| First-person camera | Manual keyboard input | `addFirstPersonSystem` from apps/shared |

## Key files

| File | Lines | Role |
|:--|--:|:--|
| `src/index.ts` | ~190 | Three-section bootstrap -- loads newport_loft.hdr via `loadByGuid<EquirectAsset>`, spawns Skylight + SkyboxBackground (both hold the equirect handle) + 2 contrast cubes, camera with HDR tonemap |
| `scripts/smoke-dawn.mjs` | ~480 | Dawn-node dual-state pixel-diff smoke: skybox-on vs skybox-off two-World diff, FALSIFY=skybox-reuse-buffer sensitivity check |
| `package.json` | ~55 | Workspace metadata + dependencies |

> [!NOTE]
> This demo uses engine built-in `forgeax::default-standard-pbr` material shader -- no custom `.wgsl` file is needed. Demos with custom WGSL (like 4.1 depth-viz, 4.2 outline-solid) each require a `.wgsl.meta.json` sidecar for vite-plugin-shader.

## Smoke gate semantics

The smoke script uses a **dual-state pixel-diff** approach (not single-state self-baseline):

- **skybox-on**: Full scene with `Skylight` + `SkyboxBackground(SKYBOX_MODE_CUBEMAP)` + reflective cube + non-reflective cube.
- **skybox-off**: Same scene, minus the `SkyboxBackground` spawn (plan D-1 minimal delta).
- **Assert**: pixel difference between the two states exceeds threshold (0.05% of total pixels), proving the skybox contributes visible pixels.
- **FALSIFY**: Set `FALSIFY=skybox-reuse-buffer` to force the off-state to reuse the on-state readback buffer (byte-identical) -- smoke must FAIL, proving sensitivity to the skybox variable.

## Traps / debugging

- **Black screen / no skybox visible**: Verify the `forgeax-engine-assets` submodule is initialised (`git submodule update --init --recursive`). The `newport_loft.hdr` file is in the CC BY-NC 4.0 carve-out vendor subtree. If the file is missing, `loadByGuid` will fail with a structured error (charter P3 explicit failure).
- **Reflective cube appears matte**: Check that `Skylight` is spawned (PBR IBL requires it) and the material uses `metallic: 1, roughness: 0`.
- **Tonemap issues**: The camera must use a non-none tonemap (`TONEMAP_REINHARD_EXTENDED` here). The skybox pass writes HDR values; a `'none'` tonemap clips them.
- **Smoke flakiness**: The dual-state diff threshold is 0.05% of (512x512) = 131 pixels. If the smoke fails with diff slightly below threshold, try increasing `SMOKE_MIN_FRAMES` to ensure the IBL pipeline has fully settled (default 60).

For rendering / smoke debugging, load `forgeax-engine-debug` and walk the symptom chain.
