# learn-render

> [!IMPORTANT]
> **forgeax-first 1:1 translation of [LearnOpenGL](https://learnopengl.com/) chapters into ECS + PBR + WebGPU.** Each sub-demo mirrors an LO chapter but expresses the concept through `@forgeax/engine-*` primitives (Transform / Camera / MeshFilter / MeshRenderer / DirectionalLight / SpotLight / MaterialAsset / first-person controls) — not raw GL calls.

## What this tree is

Each `apps/learn-render/N.<chapter>/M.<topic>/` is the forgeax counterpart of LO `src/N.<chapter>/M.<topic>/`. The demos exist for three audiences:

For the completed HDR Bloom carrier, start with [5.7 Bloom](5.advanced-lighting/7.bloom/README.md); its README names the contributor asset prerequisite and the self-contained public `hello-bloom` fallback.

1. **AI users** reading the codebase to learn forgeax's preferred shape for camera / lighting / material / asset usage — by example
2. **Engine designers** who can run a demo, screenshot it, and check it matches the LO hero image (visual SSOT)
3. **CI** — each demo (when ready) ships a 60-60 frame `dawn-node` smoke that proves the render path didn't break

## Translation rules

| LO original | forgeax equivalent | rationale |
|:--|:--|:--|
| Phong (`material.ambient/diffuse/specular/shininess`) | PBR (`baseColor`, `metallic`, `roughness`) | mainstream modern engines; energy-conserving |
| `light.ambient/diffuse/specular` (three vec3 channels) | `DirectionalLight.color{R,G,B}` + `intensity` | Phong-era three-channel split has no PBR equivalent; ambient → env/IBL, specular → BRDF |
| `Camera` class with WASD/mouse | `Transform + Camera` ECS components + `addFirstPersonSystem` from [`apps/shared/`](../shared/) | engine-agnostic ECS shape; first-person controls live in app-level shared, **not** in `@forgeax/engine-*` (out of scope for the engine) |
| Manual `glClearColor / glEnable(GL_DEPTH_TEST)` | `createApp(canvas, { clearColor })` | engine handles depth state, swapchain, gamma |
| Vertex array literals | builtin `HANDLE_CUBE` / glTF `MeshAsset` | engine ships standard primitives; user assets ride the GUID `*.pack.json` pipeline |
| `Shader` C++ class | `vite-plugin-shader` + build-time WGSL compile + `/shaders/manifest.json` at runtime | naga compiled ahead-of-time; runtime is shader-source-free |
| Imgui (LO §6 PBR-IBL chapters) | not yet | inspector via JSON-RPC `@forgeax/engine-console` is the equivalent layer; per-demo imgui-style UI deferred |
| Direct file IO | `assets.loadByGuid()` + `*.image.meta.json` / `*.gltf.meta.json` sidecars | GUID-addressed disk schema |

> [!NOTE]
> **PBR ≠ Phong visually identical.** When a LO chapter is fully translated, the forgeax demo will not pixel-match the LO C++ output: PBR has Fresnel darkening at grazing angles, energy conservation, and no constant ambient term. The *teaching concept* is preserved, the *exact pixels* are not. This is intentional — pixel-matching LO would require keeping Phong, which contradicts AGENTS.md `Change stance` (optimal > compatible).

## Shared building blocks

App-level helpers in [`apps/shared/`](../shared/), consumed via relative-path import (not via package name — D-P4 path-A):

| Helper | Where | What |
|:--|:--|:--|
| `addFirstPersonSystem(world, renderer, opts)` | `apps/shared/src/learn-render-first-person.ts` | FPS-style camera ECS system: WASD displacement + mouse yaw/pitch + (optional) SpotLight flashlight; quaternion derived via `quat.fromEuler(...,'YXZ')` from `@forgeax/engine-math`, forward+right via `quat.transformVec3` (SSOT — no hand-rolled Tait-Bryan formula) |
| `createFirstPersonControls(target, backend, ...)` | same | Override-input bootstrap variant for `createApp` (used when smoke / e2e wants to drive a synthetic input backend) |
| `computeWasdDisplacement(...)` | same | Pure-function helper (testable without renderer); used both by shared + 7.camera's inline FPS system |
| `createScrollFovAccumulator()` | same | LO §1.7.3 scroll-wheel FoV clamp (1-45 deg) |
| `populateDemoWorld(...)` | `apps/shared/src/populate-demo-world.ts` | Standard demo bootstrap (hello-cube / inspector-demo) |

> [!IMPORTANT]
> First-person controls **live in app-level shared, not in `@forgeax/engine-*`.** Per AGENTS.md: the engine should not ship a one-size-fits-all FPS camera primitive; demo-scoped helpers belong here. If a future game needs FPS controls, it copies / adapts this file rather than importing it from the engine.

## Chapter status (2026-05-21)

> Each `M.<topic>` directory is one LO sub-example. **stub** = directory exists with placeholder content (typically a `package.json` + minimal smoke gate marker) but `src/index.ts` has not landed yet. **SRC** = real implementation. **smoke** = dawn-node smoke gate present.

| Chapter | Sub-demos | SRC | smoke | Notes |
|:--|:--|:--|:--|:--|
| **1.getting-started** | 7 | 7/7 | 4.textures, 7.camera | window/triangle/shaders/textures/transforms/coords/camera all landed |
| **2.lighting** | 6 | 6/6 | 1.colors, 2.basic-lighting, 3.materials | 4/5/6 (lighting-maps, light-casters, multiple-lights) landed but no smoke gate yet |
| **3.model-loading** | 1 | stub | -- | blocked on glTF mesh-loader maturation |
| **4.advanced-opengl** | 10 | 7/10 | 6.cubemaps, 7.advanced-glsl-ubo, 9.instancing | 4.1-4.4 (depth/stencil/blending/cull) + 4.6/4.7/4.9 landed; 4.5 framebuffers + 4.8 geometry-shader + 4.10 MSAA deferred (4.8 geometry-shader has no WebGPU equivalent stage — deferred to handover); instancing also lives standalone in `apps/parity/instancing-static` |
| **5.advanced-lighting** | 11 | 5/11 | 1.advanced-lighting, 2.gamma-correction, 4.normal-mapping, 6.hdr, 7.bloom | 5.1 Blinn-Phong / 5.2 gamma / 5.4 normal-mapping (feat-20260611); 5.6 HDR inline WGSL / 5.7 bloom declarative (feat-20260612) landed; 5.3 shadow-mapping / 5.5 parallax-mapping / 5.8 deferred-shading / 5.9 SSAO deferred |
| **6.pbr** | 3 | 0/3 | -- | direct PBR + IBL irradiance + IBL specular |
| **7.in-practice** | 3 | 0/3 | -- | debugging / text rendering / 2D game |
| **8.guest** | 0 | -- | -- | post v1.0 (compute / OIT / skeletal / area lights) |

> [!CAUTION]
> The `stub` count above is **not** "fake progress" — those directories exist because the `learnopengl-as-evolution-roadmap.md` wiki uses the on-disk tree as the SSOT for chapter naming and forgeax-engine-assets sidecar layout. When a chapter lands, it slots into a pre-named directory rather than being added on the fly.

## Running a demo

Each landed sub-demo exposes the same three scripts:

```bash
# Dev server (each demo binds a unique port; see its index.html or vite.config.ts)
pnpm --filter @forgeax/app-learn-render-<chapter>-<topic> dev

# Production build
pnpm --filter @forgeax/app-learn-render-<chapter>-<topic> build

# dawn-node smoke (where the smoke-dawn.mjs script exists)
pnpm --filter @forgeax/app-learn-render-<chapter>-<topic> smoke
```

Package names use the path with dots → dashes: `apps/learn-render/2.lighting/3.materials/` → `@forgeax/app-learn-render-2-lighting-3-materials`.

## Source structure convention

Every `src/index.ts` follows the three-section AC-06 grep-anchor pattern:

```ts
// 1. engine usage
import { createApp } from '@forgeax/engine-app';
// ... other @forgeax/engine-* imports ...

// 2. example-specific glue
const OBJECT_BASE_COLOR = [1.0, 0.5, 0.31, 1.0] as const;
const LIGHT_POS_X = 1.2;
// ... numeric constants and types specific to this LO sub-example ...

// 3. bootstrap
const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null) throw new Error('missing canvas');
void bootstrap(canvas);
async function bootstrap(target: HTMLCanvasElement): Promise<void> {
  // ...
}
```

This makes `grep -rn '// 1\. engine usage' apps/learn-render/` enumerate all the demos, and `grep -rn '// 2\. example-specific glue'` cleanly cleaves the "what the demo wants to show" from "how the demo wires up the engine".

## Known cleanup queues

| Item | Status | Tracking |
|:--|:--|:--|
| `populateScene()` SSOT extraction (today `src/index.ts` + `scripts/smoke-dawn.mjs` each spawn the scene independently) | open | `feat-*-scene-ssot-extraction` (to be opened) |
| `addScrollFovSystem` inline-duplicated across 6 demos | open | hoist into `apps/shared/src/learn-render-first-person.ts` |
| smoke sample-site naming drift after camera changes (e.g. `lampRegion` no longer covers lamp under new framing) | open | folded into the same SSOT extraction effort |
| Chapter 4-7 stubs awaiting their respective `feat-*-engine-X` capability landings | tracked | `learnopengl-as-evolution-roadmap.md` §2 + §7.3 |

## See also

- [`AGENTS.md`](../../AGENTS.md) — engine-wide conventions (component naming, change stance, error model)
- [`apps/shared/`](../shared/) — app-level demo helpers (consumed by relative-path import)
- [`apps/hello/*/`](../) — engine smoke entrypoints (independent of LO chapter mapping)
