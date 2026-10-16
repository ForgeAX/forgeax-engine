# learn-render 3.1 -- Model Loading: Sponza

> [!NOTE]
> LearnOpenGL section 3.1 (Model Loading) -- Sponza atrium with full PBR rendering, multi-light (1 DirectionalLight + 4 PointLight), and Skylight IBL, loaded through the `@forgeax/engine-gltf` Tier-C importer (103 primitives, 25 materials, 69 textures).

## What this demo teaches

Sponza is the canonical large-model stress test for a real-time PBR pipeline. This demo shows:

1. **glTF Tier-C import** -- `parseGltf` reads 103 primitives into per-primitive `MeshIr` entries with POSITION + NORMAL + TEXCOORD_0 + TANGENT vertex attributes, loads 69 textures (63 JPG + 4 PNG) through `externalLoader`, and bridges 25 `pbrMetallicRoughness` materials into `MaterialAsset { shadingModel: 'standard' }` with `baseColorTexture` / `metallicRoughnessTexture` / `normalTexture` slots.
2. **DirectionalLight with castShadow** -- 1 warm-sun directional light casts PCF shadows across the atrium (`mapSize=2048`, `shadowDistance=36`, `depthBias=0.005`).
3. **4 PointLight cap** -- 4 point lights (warm yellow, cyan, magenta, neutral white) placed in the atrium demonstrate the forgeax 4-point-light rendering cap (charter F4: demo failures route to engine fixes).
4. **Skylight IBL** -- HDR equirectangular newport_loft.hdr is loaded as an `EquirectAsset` via `loadByGuid<EquirectAsset>` and handed to `Skylight{ equirect }`; the engine projects the irradiance + specular cubemap internally (lazy, in the render record arm) to feed the PBR indirect diffuse + specular terms. No manual cubemap upload call.
5. **4-step recipe** -- `configureRuntimeAssetCatalog` -> `loadByGuid<SceneAsset>` -> `assets.instantiate` -> `app.start()`, identical to hello-gltf (charter P4 consistent abstraction). The helper selects the scoped Vite catalog in development and the emitted `/pack-index.json` in a production build.

## Asset provenance

| Asset | Source | License | Repository path |
|:--|:--|:--|:--|
| Sponza glTF 2.0 | [KhronosGroup/glTF-Sample-Models](https://github.com/KhronosGroup/glTF-Sample-Models/tree/main/2.0/Sponza) (Crytek original model, glTF-Transform v1.2.3 conversion) | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | `forgeax-engine-assets/khronos-gltf-samples/Sponza/` |
| `newport_loft.hdr` | LearnOpenGL (Joey de Vries) PBR/IBL resources | **CC BY-NC 4.0** | `forgeax-engine-assets/learn-opengl/textures/newport_loft.hdr` |

> [!WARNING]
> **CC BY-NC carve-out**: newport_loft.hdr is licensed under CC BY-NC 4.0 (NonCommercial). This demo as a whole is **NonCommercial-tainted** -- it must not be used for commercial purposes. The NC boundary is documented in research-decisions D-5 and plan-decisions D-5.

## Scene statistics

Measured from `Sponza.gltf` by `jq` (research section G-2; 167 KB JSON, fetch from KhronosGroup/glTF-Sample-Models main branch):

| Statistic | Value |
|:--|:--|
| Primitives (draw calls) | 103 |
| Materials | 25 |
| Textures (63 JPG + 4 PNG) | 69 |
| Samplers | 1 (shared) |
| Total vertices (cross-primitive) | 192,496 |
| Bounding box X | [-1920.95, 1799.91] |
| Bounding box Y | [-126.44, 1429.43] |
| Bounding box Z | [-1182.81, 1105.43] |
| Nodes | 1 (flat hierarchy, no children recursion) |

## Light layout

### DirectionalLight (merged shadow fields)

| Parameter | Value |
|:--|:--|
| Direction (normalized) | (-0.3, -1.0, -0.3) |
| Color (warm sun) | (1.0, 0.95, 0.85) |
| Intensity | 3.0 |
| `mapSize` | 2048 |
| `shadowDistance` | 36 |
| `depthBias` | 0.005 |

### 4 PointLight

| # | Position (x, y, z) | Color | Intensity | Range |
|:--|:--|:--|:--|:--|
| 1 (warm yellow) | (-800, 200, 0) | (1.0, 0.85, 0.5) | 500,000 | 2,500 |
| 2 (cool cyan) | (800, 200, 0) | (0.4, 0.85, 1.0) | 500,000 | 2,500 |
| 3 (magenta) | (0, 200, -400) | (0.95, 0.4, 0.85) | 500,000 | 2,500 |
| 4 (neutral white) | (0, 200, 400) | (1.0, 1.0, 1.0) | 500,000 | 2,500 |

### Skylight

| Parameter | Value |
|:--|:--|
| HDR source | `newport_loft.hdr` (CC BY-NC 4.0) |
| GUID | `019e4a26-3c29-7420-af5d-20f2724a16b0` |
| Irradiance cubemap face size | 64 px |
| Specular cubemap face size | 256 px |
| Specular mip levels | 5 |
| Intensity | 1.0 |

### Camera

| Parameter | Value |
|:--|:--|
| Projection | Perspective |
| FOV | 60 degrees (pi/3) |
| Near / Far | 10 / 10,000 |
| Position | (800, 600, 0) |

## How to run

```bash
# Smoke (dawn-node, 60 frames, run-without-error) -- canonical acceptance path
# Validates: no RhiError during load + render for 60 frames.
# AssetError (asset-not-registered) is expected in offline smoke without pack-index.
pnpm --filter @forgeax/app-learn-render-3-model-loading-1-model-loading smoke

# Production build
pnpm --filter @forgeax/app-learn-render-3-model-loading-1-model-loading build

# Dev server (vite, browser WebGPU) -- renders Sponza end-to-end via vite-plugin-pack thin gltf entry catalog
pnpm --filter @forgeax/app-learn-render-3-model-loading-1-model-loading dev
```

| Command | Backend | Frames | Criterion |
|:--|:--|:--|:--|
| `smoke` (canonical) | Dawn-node | 60 | 0 RhiError -> exit 0 |
| `build` | N/A | N/A | Vite build success + `pack-index.json` with 69 texture entries |
| `dev` | Browser WebGPU | N/A (interactive) | 4-step recipe end-to-end (thin gltf entry catalog, feat-20260523) |

> [!NOTE]
> Dev / build / smoke paths all render Sponza end-to-end as of feat-20260523 (ticket-142 done — `build-catalog.ts` gltf arm now folds mesh/material/scene subAssets into thin catalog rows; the scoped dev catalog and build `pack-index.json` cover all 129 entries). Run `pnpm dev` from the demo directory (or `pnpm --filter @forgeax/app-learn-render-3-model-loading-1-model-loading dev` from the repo root) to spawn the vite server and view the browser-rendered Sponza.

## Out of scope (OOS)

| ID | Item | Reason |
|:--|:--|:--|
| OOS-1 | Other Khronos samples (DamagedHelmet, FlightHelmet, etc.) | Sponza only |
| OOS-2 | glTF animation / skinning / morph targets | Static mesh only |
| OOS-3 | KHR_* extensions (KHR_materials_unlit, KHR_texture_transform, KHR_lights_punctual, etc.) | Core 2.0 + existing EXT_mesh_gpu_instancing only |
| OOS-4 | Anisotropic filtering / mipmap LOD bias / advanced texture filtering | Default sampler |
| OOS-5 | Transparent material sorting (alpha-blend depth sort) | Does not block demo |
| OOS-6 | Cascaded shadow maps / multiple shadow maps | Single directional shadow map |
| OOS-7 | Free camera / first-person controls / orbit controls | Static camera pose |
| OOS-8 | Smoke in AGENTS.md gate / CI workflow / metrics | User Q7+Q9 decision: local run-only |
| OOS-9 | Sparse / interleaved accessor support | Tier-C covers packed accessor only |
| OOS-10 | Orthographic camera | Perspective only |
| OOS-11 | Cross-GPU pixel-parity baseline PNG | User Q7 decision |
| OOS-12 | Inspector / Console extra fields for Sponza (mesh vertex stats, texture byte counts, etc.) | Existing base inspector |
| OOS-13 | Asset compression (KTX2 / Basis) / texture re-encoding | Direct JPG + PNG consumption |
| OOS-14 | Built-in transcode plugin bin (`forgeax asset import transcode`) | `gltf-image-mime-unsupported` hint points to external toolchain |

See `requirements.md` section 4 (out-of-scope) for the full rationale per item.

## CI decisions

- **Smoke gate**: This demo is NOT in the AGENTS.md smoke gate list. The smoke script (`pnpm smoke`, dawn-node 60 frames) validates "does the engine crash under Sponza load" (run-without-error, 0 RhiError) but does NOT participate in CI gate / workflow / metrics gates (user Q7+Q9 decision, plan-decisions D-7).
- **Metrics**: All 5 `forgeax.metrics` kinds (`bundle-size`, `fps`, `bench`, `gate`, `spike-report`) are `enabled: false` for this workspace package. This is a teaching sample -- the run-without-error acceptance level is sufficient.
- **Pixel parity**: No baseline PNG / pixel readback. The verification level is "engine does not crash or emit RhiError," not pixel-perfect visual parity.

## Charter alignment audit

1. **P1 (Progressive disclosure)**: This README exposes layers from one-line summary -> scene stats -> light layout -> run commands -> OOS boundary -> charter alignment. Each layer is independently indexable.
2. **P3 (Explicit failure > silent behavior)**: `parseGltf` errors are closed-union `GltfErrorCode` (9 members as of Tier-C); `renderer.onError` fires structured `{ code, hint, detail }` -- AI user does not parse string messages.
3. **P4 (Consistent abstraction > exposing implementation)**: The 4-step recipe (`configureRuntimeAssetCatalog` -> `loadByGuid` -> `assets.instantiate` -> `app.start()`) is byte-for-byte identical to hello-gltf. The helper keeps dev scope routing and the production `pack-index.json` projection behind one call, so AI users do not learn a different API surface for "large model" vs "small model."
4. **P5 (Tool produce/consume by role)**: Screenshots (if any) are produced by playwright (subagent), consumed by orchestrator (main session reading PNG). No subagent claims "image observed" self-report; all visual evidence flows through orchestrator reads.
