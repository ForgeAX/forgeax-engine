# Basic Lighting (LearnOpenGL section 2.lighting 2)

> [!NOTE]
> **LO original chapters**: [LearnOpenGL 2.1 basic_lighting_diffuse](https://learnopengl.com/Lighting/Basic-Lighting) and [2.2 basic_lighting_specular](https://learnopengl.com/Lighting/Basic-Lighting)
>
> **Engine surface**: `createApp` + ECS components (`Transform`, `Camera`, `MeshFilter`, `MeshRenderer`, `PointLight`) + `MaterialAsset` (`shadingModel: 'standard'` / `'unlit'`) + builtin `HANDLE_CUBE` mesh.

## What this example shows

LO 2.1 teaches **diffuse lighting**: the angle between the surface normal and the light direction determines brightness via `max(dot(norm, lightDir), 0)`. LO 2.2 adds the **specular component**: view-dependent highlights computed from the reflection vector and the view direction via `pow(max(dot(viewDir, reflectDir), 0), shininess)`. Together they form "basic lighting" = ambient + diffuse + specular (Phong model).

LO 2.2's fragment shader computes `vec3 lightDir = normalize(lightPos - FragPos)` per fragment, which is **point-light** behavior (the light direction varies across the surface based on the fragment's world-space position). The lamp cube rendered at `lightPos` is the visible emitter.

In forgeax, both diffuse and specular are handled by the engine PBR pipeline: a `StandardMaterialAsset` with `baseColor` on the cube, a `PointLight` component co-located with the lamp marker on a single entity (so its `Transform.pos*` provides both the visible lamp position and the light position via the `[Transform, PointLight]` query), and a separate `UnlitMaterialAsset` for the lamp's surface. The PBR microfacet BRDF decomposes into a Lambertian diffuse term (analogous to LO's diffuse) and a Cook-Torrance specular term (with GGX normal distribution, Smith geometry, and Schlick Fresnel -- analogous to LO's specular shininess model but physically-based and energy-conserving).

The `roughness` parameter controls the specular lobe width: low roughness produces a tight, bright specular highlight (analogous to high shininess in LO), while high roughness spreads the highlight (analogous to low shininess). This example uses `roughness: 0.2` to produce a clearly visible specular highlight.

The scene renders:
1. A colored cube (object) at origin with `shadingModel: 'standard'` and low roughness for visible specular
2. A small white unlit cube (lamp marker) at the LO light position, carrying a co-located `PointLight`
3. The PBR shader evaluates per-fragment `lightDir = normalize(lightPos - FragPos)` plus 1/d^2 attenuation

## Run

```bash
# Dev server (port 5191)
pnpm --filter "@forgeax/app-learn-render-2-lighting-2-basic-lighting" dev

# Build
pnpm --filter "@forgeax/app-learn-render-2-lighting-2-basic-lighting" build

# Preview
pnpm --filter "@forgeax/app-learn-render-2-lighting-2-basic-lighting" preview

# Dawn semantic RHI-debug smoke (60 frames; orange point-light witness)
pnpm --filter "@forgeax/app-learn-render-2-lighting-2-basic-lighting" smoke:rhi-debug

# Expected-red control: keep the lamp mesh but remove its PointLight
FALSIFY_NO_LIGHT=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-2-basic-lighting" smoke:rhi-debug

# Standard PBR emissiveIntensity witness: authored red emissive, intensity=2,
# and no PointLight; the non-zero exit is not expected for this profile.
FALSIFY_NO_LIGHT=1 FALSIFY_MATERIAL_EMISSIVE_INTENSITY=2 pnpm --filter "@forgeax/app-learn-render-2-lighting-2-basic-lighting" smoke:rhi-debug

# Standard PBR metallicChannel witness: select the authored red metallic channel
# from the engine-managed metallic-roughness texture; the command is expected green.
FALSIFY_MATERIAL_METALLIC_CHANNEL=red pnpm --filter "@forgeax/app-learn-render-2-lighting-2-basic-lighting" smoke:rhi-debug

# Standard PBR roughnessChannel witness: select the authored blue roughness channel
# from the engine-managed metallic-roughness texture; expected green.
FALSIFY_MATERIAL_ROUGHNESS_CHANNEL=blue pnpm --filter "@forgeax/app-learn-render-2-lighting-2-basic-lighting" smoke:rhi-debug

# Standard PBR alpha-cutoff witness: lower the object alpha to 0.25 and
# require alphaCutoff=0.5 to discard the cube on the live render path.
FALSIFY_MATERIAL_ALPHA_CUTOFF=1 pnpm --filter "@forgeax/app-learn-render-2-lighting-2-basic-lighting" smoke:rhi-debug
```

The semantic smoke samples the cube center and requires a stable lit-orange channel ordering
(`red > green > blue`) with a minimum brightness. The `FALSIFY_NO_LIGHT=1` control must reject the
same witness; its non-zero exit is expected and proves the check is not merely a non-empty-pixel
test.

The alpha-cutoff control is mutually exclusive with the other material and PointLight controls. It
proves the Standard PBR `alphaCutoff=0.5` UBO lane at byte offset 68, the authored object alpha
`0.25`, and fragment discard by requiring the cube-center ROI to return to clear color without an
RHI error.

## forgeax-vs-LearnOpenGL mapping

| LO concept | LO C++ / OpenGL | forgeax equivalent |
|:--|:--|:--|
| Object with color | `objectColor` uniform vec3 fed to fragment shader | `StandardMaterialAsset.baseColor` RGBA array |
| Light color | `lightColor` uniform vec3 | `PointLight.color{R,G,B}` f32 fields |
| Light position | `lightPos` uniform vec3 | Co-located lamp entity's `Transform.pos{X,Y,Z}` -- read by the engine via `[Transform, PointLight]` query |
| Light direction | `normalize(lightPos - FragPos)` in shader | Engine `pbr.wgsl` computes `normalize(lightPos - worldPos)` per fragment from the light's Transform |
| Diffuse term | `max(dot(norm, lightDir), 0.0) * lightColor` in fragment shader | Lambertian diffuse term in `pbr.wgsl` (built into standard material) |
| Specular term | `pow(max(dot(viewDir, reflectDir), 0.0), shininess) * lightColor * specularStrength` | Cook-Torrance microfacet specular in `pbr.wgsl` (GGX NDF + Smith visibility + Schlick Fresnel) |
| Specular width | `shininess` exponent (2-256) in fragment shader uniform `material.shininess` | `MaterialAsset.roughness` (0-1, perceptually linear); low roughness = tight highlight |
| View position | `viewPos` uniform vec3 for specular calculation | Engine `RenderSystem` extracts camera position from `Transform`, feeds it to UBO |
| Lamp cube | Separate shader that outputs `lightColor` | `UnlitMaterialAsset` (`shadingModel: 'unlit'`) -- ignores lighting, always renders as given baseColor |
| Camera | `Camera` class + WASD movement (LO section 1.7) | `Transform` + `Camera` ECS components + `addFirstPersonSystem` from `apps/shared` (mirrors LO WASD/mouse/scroll controls) |
| Window + render loop | `glfwCreateWindow` + `while(!glfwWindowShouldClose)` | `createApp(canvas, opts)` from `@forgeax/engine-app` |
| Vertex data | Manual `float vertices[]` array + VBO/VAO setup | Built-in `HANDLE_CUBE` procedural geometry from `@forgeax/engine-runtime` |

## Differences from the LearnOpenGL original

| Dimension | LO original (C++ / GLSL / GLFW) | forgeax here (TS / WGSL / WebGPU) |
|:--|:--|:--|
| Lighting model | Phong (ambient + diffuse + specular via per-fragment Blinn-Phong) | PBR microfacet (Cook-Torrance specular + Lambertian diffuse) |
| Light type | Point light at `lightPos` with **no distance attenuation** in 2.2's fragment shader | `PointLight` component on the lamp entity; KHR_lights_punctual quartic (collapsed at `range=Infinity`) **plus** 1/d^2 attenuation in `pbr.wgsl` -- so the cube renders darker than the LO reference at the same distance (physically correct, not a bug). LO chapter 5.2 (`light_casters_point`) re-introduces per-fragment attenuation; that is when LO matches forgeax's behavior here. |
| Diffuse model | N dot L clamped cos weighted by light color | Lambertian diffuse with energy conservation |
| Specular model | Blinn-Phong: `pow(N dot H, shininess)` weighted by specular strength | Cook-Torrance with GGX normal distribution + Smith geometry + Fresnel |
| Specular parameter | `shininess` exponent (32, 64, 256 typical) | `roughness` (0-1, perceptually linear) |
| Material parameters | `objectColor` + `lightColor` shader uniforms | `MaterialAsset` with `baseColor`, `metallic`, `roughness` |
| Lamp shader | Separate `lightCubeShader` C++ object | `shadingModel: 'unlit'` discriminant on `MaterialAsset` |
| Fragment formula | `(ambient + diffuse + specular) * objectColor` | PBR BRDF evaluation in `pbr.wgsl` (microfacet specular + Lambertian diffuse, no ambient term) |
| Camera | `Camera` class with `glm::lookAt` | `Transform` + `Camera` ECS components; engine `RenderSystem` composes `view = inverse(camera.Transform)` |
| Render loop | `glfwSwapBuffers` + `glfwPollEvents` | `createApp` rAF frame-loop with `Time` resource + auto input |
| Shader management | `Shader` class + compile/link/use calls | `vite-plugin-shader` build-time compile + `/shaders/manifest.json` at runtime |
| View position | Explicit `viewPos` uniform set from `camera.Position` | Engine RenderSystem extracts camera position from the camera entity's `Transform` automatically |

> [!IMPORTANT]
> **PBR specular differs visually from Phong.** The Cook-Torrance specular lobe follows the GGX microfacet distribution: it produces a narrower, more realistic highlight at low roughness and correctly darkens at grazing angles due to the Fresnel term. LO's Phong/Blinn-Phong model produces a broader highlight with no Fresnel darkening. Both demonstrate the same concept (view-dependent specular reflection), but forgeax's is physically-based and energy-conserving.

### Concept mapping: LO Phong terms to forgeax PBR

| LO Phong term | LO formula (per-fragment) | forgeax PBR equivalent | forgeax parameter |
|:--|:--|:--|:--|
| Ambient | `ambientStrength * lightColor` | No ambient term in PBR; dark areas come from energy conservation and microfacet shadowing | -- |
| Diffuse | `max(dot(norm, lightDir), 0.0) * lightColor` | Lambertian diffuse: `baseColor / PI * (1 - F) * (1 - metallic)` | `baseColor`, `metallic` |
| Specular | `specularStrength * pow(max(dot(viewDir, reflectDir), 0.0), shininess) * lightColor` | Cook-Torrance: `D * G * F / (4 * NdotL * NdotV)` | `metallic`, `roughness` |
| Shininess | `material.shininess` uniform (2-256) | `roughness` (0-1), mapped to GGX alpha = `roughness^2` | `roughness` |

## Key files

| File | Lines | Role |
|:--|--:|:--|
| `src/index.ts` | ~230 | Three-section (engine usage + example glue + bootstrap) -- spawns colored cube with specular highlight, lamp+PointLight (single co-located entity), and a first-person camera (`addFirstPersonSystem` from `apps/shared`) |
| `package.json` | ~40 | Workspace metadata + dependencies (`engine-app`, `engine-runtime`, `engine-ecs`, `engine-types`) |
| `vite.config.ts` | ~30 | Vite config with `forgeaxShader` plugin for shader manifest generation |

## AI user discoverability

- Directory name: `apps/learn-render/2.lighting/2.basic-lighting/` mirrors LO chapter ordering
- Package name: `@forgeax/app-learn-render-2-lighting-2-basic-lighting` is grep-able by chapter prefix
- Three-section source markers (`// 1. engine usage` / `// 2. example-specific glue` / `// 3. bootstrap`) serve as grep anchors per convention AC-06
