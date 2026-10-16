# Materials (LearnOpenGL section 2.lighting 3)

> [!NOTE]
> **LO original chapter**: [LearnOpenGL 2.lighting 3.1 Materials](https://learnopengl.com/Lighting/Materials)
>
> **Engine surface**: `createApp` + ECS components (`Transform`, `Camera`, `MeshFilter`, `MeshRenderer`, `PointLight`) + `MaterialAsset` (`shadingModel: 'standard'` / `'unlit'`) + `world.addSystem(Update, system)` for frame-level light animation + builtin `HANDLE_CUBE` mesh.

## What this example shows

LO 3.1 teaches that **material properties modulate how a surface responds to a light**. The LO scene uses a single cube + a time-varying light color (sin waves at different frequencies per RGB channel) to show how the same material reads differently under different light spectra. The LO Phong material exposes four slots -- `ambient`, `diffuse`, `specular`, `shininess` -- and the LO `light` struct exposes matching `ambient` / `diffuse` / `specular` channels.

LO 3.1's fragment shader uses `normalize(light.position - FragPos)` -- the source is a **point light** at a fixed world-space position. In forgeax the Phong material slots collapse onto PBR parameters (`baseColor` + `metallic` + `roughness`) on a single `StandardMaterialAsset`. The `PointLight` carries only `color` + `intensity` + `range`: mainstream PBR engines do **not** split ambient/diffuse/specular on the light side -- ambient is the job of environment lighting / IBL, specular is the job of the BRDF. So LO's `light.ambient` and `light.specular` have no engine-side counterparts; only the color animation translates over.

The scene renders:
1. A colored cube at origin with `shadingModel: 'standard'`, `roughness: 0.3` (PBR equivalent of LO `shininess: 32`)
2. A small white unlit cube (lamp marker) at the LO light position `(1.2, 1.0, 2.0)`, carrying a co-located `PointLight` so the lamp's `Transform` provides both the visible marker and the light's world-space position
3. The PBR shader evaluates per-fragment `lightDir = normalize(lightPos - worldPos)` plus 1/d^2 attenuation; the `PointLight.color{R,G,B}` is updated each frame by an ECS system

The lamp marker falls outside the initial camera framing (matches LO's initial view: the user pans to it via WASD/mouse — same as the LO chapter). forgeax wires the LO §1.7 first-person controls into examples 1-3 via `addFirstPersonSystem` from [`apps/shared/`](../../../shared/).

## Run

```bash
# Dev server (port 5192)
pnpm --filter "@forgeax/app-learn-render-2-lighting-3-materials" dev

# Build
pnpm --filter "@forgeax/app-learn-render-2-lighting-3-materials" build

# Preview
pnpm --filter "@forgeax/app-learn-render-2-lighting-3-materials" preview

# Semantic RHI-debug smoke and controlled falsifier
pnpm --filter "@forgeax/app-learn-render-2-lighting-3-materials" smoke:rhi-debug
FALSIFY_NO_LIGHT=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-3-materials" smoke:rhi-debug
FALSIFY_MATERIAL_METALLIC=metal pnpm --filter "@forgeax/app-learn-render-2-lighting-3-materials" smoke:rhi-debug

# Browser capture -> fresh replay -> pixel comparison
pnpm --filter "@forgeax/app-learn-render-2-lighting-3-materials" smoke:browser
```

The semantic smoke requires the animated StandardMaterial response to be red-dominant at the
documented sample site after the 60-frame light-color animation. The `FALSIFY_NO_LIGHT=1` control
keeps the white lamp mesh but removes its `PointLight`; the same material witness must then reject
the frame, proving that the result came from the producer's point-light/material path.

`FALSIFY_MATERIAL_METALLIC=metal` changes only the cube's StandardMaterial `metallic` value from
the default dielectric `0` to `1`. The smoke accepts the altered red-dominant response only when
it is separated from the dielectric sample by a measured pixel distance greater than `0.1`;
`FALSIFY_MATERIAL_METALLIC=dielectric` is the explicit control spelling for the default path.

The browser smoke uses the producer's `__captureMaterials` hook through the shared RHI-debug capture
path and compares the live WebGPU readback with a fresh-device replay; it is a local Chrome + WebGPU
gate for the default lane. The `metal` and `dielectric` browser lanes use the structural capture
mode and prove the schema-sized Standard PBR upload carries `metallic` at global byte offset 16 and
that the Standard PBR pipeline is selected for a draw; the Dawn smoke remains the deterministic CI
gate.

## forgeax-vs-LearnOpenGL mapping

| LO concept | LO C++ / OpenGL | forgeax equivalent |
|:--|:--|:--|
| Object color | `material.diffuse` uniform vec3 | `StandardMaterialAsset.baseColor` RGBA |
| Material ambient reflectivity | `material.ambient` uniform vec3 | -- no ambient term in PBR; energy conservation + microfacet shadowing produce dark regions |
| Material specular reflectivity | `material.specular` uniform vec3 | -- folded into Cook-Torrance specular via `metallic` (0 = white specular, 1 = baseColor-tinted) |
| Specular lobe width | `material.shininess` float (2-256) | `MaterialAsset.roughness` (0-1, perceptually linear); roughness=0.3 approximates shininess=32 |
| Light color | `light.ambient` + `light.diffuse` + `light.specular` (three vec3 uniforms) | `PointLight.color{R,G,B}` (single channel; PBR BRDF decomposes diffuse + specular internally) |
| Light position | `light.position` uniform vec3 | Co-located lamp entity's `Transform.pos{X,Y,Z}` -- read by the engine via `[Transform, PointLight]` query |
| Light direction | `normalize(light.position - FragPos)` in shader (per-fragment) | Engine `pbr.wgsl` computes `normalize(lightPos - worldPos)` per fragment from the light's Transform |
| Time-varying light color | `lightColor = sin(glfwGetTime() * freq)` per channel each frame | ECS system `animated-light-color` calls `world.set(lightEntity, PointLight, ...)` each frame; `Math.max(0, Math.sin(elapsed * freq))` per channel (clamp negatives) |
| Phong `* 0.5` decrease factor | `diffuseColor = lightColor * 0.5; ambientColor = diffuseColor * 0.2` | -- dropped; PBR uses `color` directly, no Phong-era scaling hacks |
| Lamp cube | Separate `lightCubeShader` outputting light color as-is | `UnlitMaterialAsset` (`shadingModel: 'unlit'`) |
| Camera | `Camera(glm::vec3(0.0f, 0.0f, 3.0f))` with Zoom=45 deg + WASD movement | Static `Transform` at `(0, 0, 3)` + `Camera` with `fov = π/4` |
| Window + render loop | `glfwCreateWindow` + `while(!glfwWindowShouldClose)` | `createApp(canvas, opts)` from `@forgeax/engine-app` |
| Vertex data | Manual `float vertices[]` with position + normal | Built-in `HANDLE_CUBE` procedural geometry |
| Per-frame light update | `lightingShader.setVec3("light.diffuse", ...)` in C++ loop | `world.addSystem(Update, { name: 'animated-light-color', fn, queries: [] })` |

## Differences from the LearnOpenGL original

| Dimension | LO original (C++ / GLSL / GLFW) | forgeax here (TS / WGSL / WebGPU) |
|:--|:--|:--|
| Lighting model | Phong (`ambient + diffuse + specular`) | PBR microfacet (Cook-Torrance specular + Lambertian diffuse) |
| Light type | Point light at `light.position`, **no distance attenuation** in 3.1's fragment shader | `PointLight` co-located with the lamp marker; KHR_lights_punctual quartic (collapsed at `range=Infinity`) **plus** 1/d^2 attenuation in `pbr.wgsl` -- so the cube renders darker than the LO reference at the same position (physically correct, not a bug) |
| Material parameters | Four: `ambient`, `diffuse`, `specular` (vec3) + `shininess` (float) | Three: `baseColor` (RGBA), `metallic` (0-1), `roughness` (0-1) |
| Light color channels | Three separate vec3 (`ambient`, `diffuse`, `specular`) | Single `color{R,G,B}` -- the BRDF + env lighting do the per-term split |
| Light color clamp | Implicit framebuffer clamp on negative `lightColor * material.diffuse` | Explicit `Math.max(0, sin(...))` in JS before `world.set` (avoids passing negative colors to the GPU) |
| Light intensity scaling | `diffuseColor = lightColor * 0.5; ambientColor = diffuseColor * 0.2` | None -- `intensity = 1.0`, color animation drives the brightness curve directly |
| Camera | `Camera` class + WASD/mouse | Static `Transform` + `Camera` ECS components |
| Shader management | `Shader` class + compile/link/use | `vite-plugin-shader` build-time compile + `/shaders/manifest.json` |

> [!IMPORTANT]
> **No ambient term in forgeax PBR.** When all three `sin` channels are simultaneously near zero (rare but possible as the three frequencies decorrelate), the cube goes near-black -- this is physically correct under a single point light with no environment contribution. LO's Phong baseline `light.ambient * material.ambient` would have kept a dim residual; PBR considers that a job for env lighting / IBL, which this example does not configure. Add an env probe or `Skylight` (see `feat-20260520-skylight-ibl-cubemap`) to fill the shadow side.

### Concept mapping: LO Phong terms to forgeax PBR

| LO Phong term | LO formula (per-fragment) | forgeax PBR equivalent | forgeax parameter |
|:--|:--|:--|:--|
| Material ambient | `light.ambient * material.ambient` | -- (deferred to env lighting / IBL) | -- |
| Material diffuse | `light.diffuse * (diff * material.diffuse)` where `diff = max(NdotL, 0)` | Lambertian: `baseColor / PI * (1 - metallic) * NdotL * lightColor` | `baseColor`, `metallic` |
| Material specular | `light.specular * (spec * material.specular)` where `spec = pow(RdotV, shininess)` | Cook-Torrance: `D * G * F / (4 * NdotL * NdotV)` (D=GGX, G=Smith, F=Schlick) | `metallic`, `roughness` |
| Shininess | `material.shininess` uniform (2-256) | `roughness` (0-1), mapped to GGX alpha = `roughness^2` | `roughness` |
| Light color animation | `sin(glfwGetTime() * freq)` per channel | `Math.max(0, Math.sin(elapsed * freq))` per channel in ECS system | `PointLight.color{R,G,B}` |

## Key files

| File | Role |
|:--|:--|
| `src/index.ts` | Three-section (engine usage + example glue + bootstrap) -- spawns one standard-material cube, lamp+PointLight (single co-located entity) animated via ECS system, and a first-person camera (`addFirstPersonSystem` from `apps/shared`) |
| `scripts/smoke-dawn.mjs` | dawn-node smoke with the animated-material oracle and no-light falsifier |
| `scripts/smoke-browser.mjs` | browser capture -> fresh replay -> pixel comparison through the shared RHI-debug verifier |
| `package.json` | Workspace metadata + dependencies (`engine-app`, `engine-runtime`, `engine-ecs`, `engine-types`) |
| `vite.config.ts` | Vite config with `forgeaxShader` plugin, port 5192 |

## AI user discoverability

- Directory name: `apps/learn-render/2.lighting/3.materials/` mirrors LO chapter ordering
- Package name: `@forgeax/app-learn-render-2-lighting-3-materials` is grep-able by chapter prefix
- Three-section source markers (`// 1. engine usage` / `// 2. example-specific glue` / `// 3. bootstrap`) serve as grep anchors per convention AC-06
- ECS system name `animated-light-color` is a grep-able anchor showing the frame-level light animation pattern
