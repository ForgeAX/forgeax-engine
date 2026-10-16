# Advanced GLSL: Uniform Buffer Objects (LearnOpenGL section 4.advanced-opengl 7)

> [!NOTE]
> **LO original chapter**: [LearnOpenGL 4.7 Advanced GLSL](https://learnopengl.com/Advanced-OpenGL/Advanced-GLSL)
>
> **Engine surface**: The View UBO is engine-managed — the AI user spawns a `Camera` + `DirectionalLight` and the engine auto-fills a 784 B std140 `View` struct at `@group(0) @binding(0)`. Zero user-side UBO code required (charter P4: uniform abstraction over manual binding).

## Hit-rate index (AI user fast-locate)

| LO sub-example | Hit? | forgeax equivalent | grep anchor |
|:--|:--|:--|:--|
| GLSL `layout(std140) uniform Matrices` hand-written UBO block | **engine-managed** | Engine allocates+populates View UBO (`@group(0)@binding(0)`, 784 B std140) automatically; user never writes a UBO declaration | `@group(0)` / `@binding(0)` |
| `glBindBufferRange(GL_UNIFORM_BUFFER, ...)` manual binding | **engine-managed** | Engine binds the View UBO at group 0 / binding 0 in every pipeline layout; user never calls a bind-buffer function | `common.wgsl:127` |
| Uniform block layout with `std140` padding rules | **engine-managed** | Engine's `View` struct in `common.wgsl:17-52,103-128` uses WGSL-native `var<uniform>` (auto-std140); user reads the struct field list if curious | `struct View` |
| Uniform block per-shader-stage binding points | **engine-managed** | Engine binds View UBO once for all pipelines; every material shader `#import forgeax_view::common` picks it up | `forgeax_view::common` |
| `glGetUniformBlockIndex` / `glUniformBlockBinding` query API | N/A | No query API needed; the engine does not expose the UBO binding to application code | N/A |
| Shader uniform-set reuse (binding same UBO to multiple shaders) | **hit** | Engine's `View` struct is shared across all material shaders via naga_oil `#import` (charter P4: one View struct everywhere) | `#define_import_path forgeax_view::common` |

## What this example shows

LO 4.7 teaches Advanced GLSL, with the Uniform Buffer Object (UBO) sub-section focused on: declaring `layout(std140) uniform` blocks in GLSL, allocating uniform buffers on the host side, and binding them to shader programs with `glBindBufferRange`. The goal is to share a single uniform buffer (view/projection matrices, light direction) across multiple shader programs without duplicating uploads.

In forgeax, the View UBO is **engine-managed** — it is an internal detail the user never touches. This example is a **documentary demo**: the `src/index.ts` is a minimal proof that spawning a `Camera` + `DirectionalLight` is all a user does; the engine handles the rest. The README is the main teaching artifact.

### How forgeax manages the View UBO (engine-internal, transparent to user)

The engine's View UBO lives at:

```
@group(0) @binding(0) var<uniform> view : View;   // common.wgsl:231
```

The `View` struct layout (784 B std140, `packages/shader/src/common.wgsl:17-52,103-128`):

| Byte range | Field | Size | Description |
|:--|:--|--:|:--|
| 0..64 | `worldViewProj` | 64 B | `mat4x4<f32>` — view-projection matrix |
| 64..80 | `lightDir` | 16 B | `vec3<f32>` + 4 B pad — dominant directional light direction |
| 80..96 | `lightColor` | 16 B | `vec3<f32>` + 4 B pad — dominant directional light color*intensity |
| 96..112 | `cameraPos` | 16 B | `vec3<f32>` + 4 B pad — camera world-space position |
| 112..176 | `lightViewProj_A` | 64 B | First directional-light shadow cascade |
| 176..240 | `inverseViewProj` | 64 B | `mat4x4<f32>` — inverse of viewProjection (skybox reconstruction) |
| 240..432 | `lightViewProj_B..D` | 192 B | Three additional directional-light shadow cascades |
| 432..496 | `splitPlanes` | 64 B | Four cascade split-depth values in `vec4<f32>` slots |
| 496..512 | `cascadeCount`, `cascadeBlend`, `depthBias`, `normalBias` | 16 B | Directional CSM controls |
| 512..528 | `directionalShadowFilter` | 16 B | Filter profile, PCSS angular radius, max penumbra, and reserved lane |
| 528..784 | `spotLightViewProj` | 256 B | Four fragment-read spot-light shadow matrices |

**Host-side lifecycle** (all engine-internal, zero user code):

1. **Allocation**: the renderer allocates the uniform buffer with `VIEW_UBO_BYTES = 784` during setup (`packages/render/src/assembly/factory.ts`).
2. **Per-frame write**: `view-ubo.ts` reads the extracted `Camera` + `DirectionalLight` state and builds the 196-float payload (`packages/render/src/record/view-ubo.ts`).
3. **Binding**: Every pipeline layout declares `@group(0) @binding(0) var<uniform> view : View`; the engine binds this buffer once and all material shaders (`pbr.wgsl`, `unlit.wgsl`, etc.) reference it via `forgeax_view::common` naga_oil import.

### What the user writes (minimal proof: `src/index.ts`)

The demo spawns three cubes + a camera + a directional light:

```typescript
// 1. engine usage — zero UBO code, just engine APIs:
import { createApp } from '@forgeax/engine-app';
import { Camera, DirectionalLight, Materials, ... } from '@forgeax/engine-render';
import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';

// 3. bootstrap — app creation + scene spawn:
const app = await createApp(canvas, { clearColor, shaderManifestUrl });

// Spawn geometry + material (engine routes this mesh through Forward pass
// which reads the View UBO @group(0)@binding(0) automatically):
world.spawn(Transform{}, MeshFilter{ HANDLE_CUBE }, MeshRenderer{ material });

// Spawn light -> engine writes direction/color into View.lightDir/lightColor:
world.spawn(DirectionalLight{ direction, color, intensity });

// Spawn camera -> engine writes pos into View.cameraPos, viewProj into
// View.worldViewProj, and inverseViewProj into View.inverseViewProj:
world.spawn(Transform{}, Camera{ fov, aspect, near, far });
```

That is the entire UBO story. No `layout(std140)`, no `glBindBufferRange`, no `glGetUniformBlockIndex`. The user's interaction with the View UBO is entirely through engine components.

## Pipeline steps (how the engine processes the data)

```
user spawns Camera { fov, aspect, near, far } + Transform { pos: [x, y, z] }
  |-- propagateTransforms system computes world matrix from local TRS
  |-- render-system-record reads Camera + Transform -> builds viewProj, cameraPos
  |
user spawns DirectionalLight { direction: [x, y, z], color: [r, g, b], intensity }
  |-- render-system-record reads DirectionalLight -> builds lightDir, lightColor
  |
view-ubo.ts assembles the 196 f32 payload:
  worldViewProj[0..16] | lightDir[16..20]+pad | lightColor[20..24]+pad
  | cameraPos[24..28]+pad | cascades[28..124] | split/shadow controls[124..132]
  | spotLightViewProj[132..196]
  |
  v
device.queue.writeBuffer(viewUbo, 0, payload)   -- 784 bytes per frame
  |
  v
every Forward-pass draw: @group(0) @binding(0) var<uniform> view : View
  |-- pbr.wgsl reads view.worldViewProj, view.lightDir, view.lightColor, view.cameraPos
  |-- unlit.wgsl reads view.worldViewProj (rest bound but unused, zero perf cost)
```

## Run

```bash
# Dev server (port 5179)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-7-advanced-glsl-ubo" dev

# Build
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-7-advanced-glsl-ubo" build

# Smoke (dawn-node structural-only: boot + 0 RhiError)
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-7-advanced-glsl-ubo" smoke

# Typecheck
pnpm --filter "@forgeax/app-learn-render-4-advanced-opengl-7-advanced-glsl-ubo" typecheck
```

> [!NOTE]
> Unlike sibling 4.6 (whose HDR skybox is cooked at build time and only renders
> via `build` + `preview`), this demo's 3 cubes have no build-time-cooked asset
> dependency -- `dev` and `build` + `preview` both render identically.

## forgeax-vs-LearnOpenGL mapping

| LO concept | LO C++ / OpenGL | forgeax equivalent |
|:--|:--|:--|
| UBO declaration in shader | `layout(std140) uniform Matrices { mat4 view; mat4 projection; vec3 lightDir; ... }` | `struct View` in `common.wgsl:103-128` — one superset struct shared across all shaders via `#import` |
| UBO host allocation | `glGenBuffers(1, &ubo)` + `glBufferData(GL_UNIFORM_BUFFER, size, NULL, GL_STATIC_DRAW)` | Engine allocates a 784 B uniform buffer in `assembly/factory.ts` |
| UBO host per-frame write | `glBufferSubData(GL_UNIFORM_BUFFER, 0, size, &data)` | Engine writes a 196-float payload each frame in `record/view-ubo.ts` (via `device.queue.writeBuffer`) |
| UBO binding point | `glUniformBlockBinding(program, index, bindingPoint)` + `glBindBufferRange(GL_UNIFORM_BUFFER, bindingPoint, ...)` | Engine declares `@group(0) @binding(0) var<uniform> view : View` in every pipeline layout |
| UBO reuse across shaders | Manual per-shader-program `glUniformBlockBinding` calls | naga_oil `#import forgeax_view::common` in every material shader — single definition, all consumers pull it |
| Window + loop | `glfwCreateWindow` + `while(!glfwWindowShouldClose)` | `createApp(canvas, opts)` from `@forgeax/engine-app` |
| Keyboard camera | `glfwGetKey(window, GLFW_KEY_W)` etc. | `addFirstPersonSystem` from `apps/shared/src/learn-render-first-person.ts` |

## Differences from the LearnOpenGL original

| Dimension | LO original (C++ / GLSL / GLFW) | forgeax here (TS / WGSL / WebGPU) |
|:--|:--|:--|
| UBO authorship | User writes `layout(std140) uniform Matrices { ... }` in every shader | Engine owns the View struct; user never writes a WGSL `var<uniform>` declaration |
| UBO binding | User calls `glBindBufferRange` with explicit binding index | Engine binds at `@group(0)@binding(0)` automatically |
| UBO layout management | User manually aligns fields to std140 padding rules | Engine defines one `View` struct in `common.wgsl`; new fields append at tail (charter P4) |
| Uniform updates | User calls `glBufferSubData` each frame with dirty flags | Engine auto-extracts Camera+DirectionalLight into per-frame payload |
| Multiple UBOs | User manages multiple UBO binding points (matrices, lights, material) | Engine has one View UBO for per-view data; Mesh storage for per-entity; light storage buffer for punctual lights |
| Teaching focus | "Here is how you write/allocate/bind a UBO in GLSL+OpenGL" | "The engine manages the View UBO; you spawn components and it flows through automatically" |

## Key files

| File | Lines | Role |
|:--|--:|:--|
| `src/index.ts` | ~160 | Minimal proof — three cubes + camera + DirectionalLight, heavy comments referencing View UBO anchor (`common.wgsl:17-128`, `@group(0)@binding(0)`, 784 B std140) |
| `scripts/smoke-dawn.mjs` | ~220 | Dawn-node structural-only smoke: createApp boot + 60 frames + 0 RhiError assertion, no pixel readback |
| `package.json` | ~55 | Workspace metadata + dependencies |

> [!NOTE]
> This demo uses engine built-in `forgeax::default-standard-pbr` material shader — no custom `.wgsl` file is needed.

## Smoke gate semantics

The smoke script uses a **structural-only** approach (AC-06):

- **Single-pass**: `createApp` boot + spawn minimal proof scene + run N>=60 frames.
- **Assert**: createApp boot succeeds + 0 `RhiError` events collected + no render-loop crash.
- **No pixel assertion**: The View UBO is engine-internal with no visible state toggle. Forcing a pixel diff would introduce a non-discriminative assertion (plan D-4).

## Traps / debugging

- **Black screen / no geometry visible**: Check that `Camera` + `DirectionalLight` are both spawned. A scene without a camera has no View UBO payload; a scene without a light has zero `lightColor` (the PBR shader reads `view.lightColor` from the UBO).
- **Understanding the View UBO from code**: The SSOT for the View UBO layout is `packages/shader/src/common.wgsl:17-43`. The binding declaration is at line 127. Host-side allocation is in `packages/runtime/src/createRenderer.ts:1688`. Per-frame write logic is in `packages/runtime/src/render-system-record.ts`.
- **Why no "UBO toggle" smoke?** M2 smoke is structural-only because the View UBO has no visible on/off state (unlike skybox in M1). The engine always writes a View UBO for every camera. Spawning a broken camera would crash the pipeline, not produce a diff-able visual result.

For rendering / smoke debugging, load `forgeax-engine-debug` and walk the symptom chain.
