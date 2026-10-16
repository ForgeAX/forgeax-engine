# Parallax Mapping (LearnOpenGL §5.5)

> [!NOTE]
> **LO original chapter**: [LearnOpenGL 5.5 Parallax Mapping](https://learnopengl.com/Advanced-Lighting/Parallax-Mapping)
>
> **Engine surface**: a user-authored **custom material shader** (`parallax.wgsl`) whose `paramSchema` declares **three** sampled textures — `baseColorTexture`, `normalTexture`, **`heightTexture`**. The engine derives the `@group(1)` material bind-group layout straight from that schema, so the height-map slot exists end-to-end with **no engine edit**. This demo is the dogfood for `feat-20260621` per-shader-derived material BGL.

> [!IMPORTANT]
> **One shader, three algorithms.** `parallax.wgsl` carries all three LO 5.5 variants — **basic** parallax (offset-limited), **steep** parallax, and **parallax occlusion mapping (POM)** — selected at runtime by `material.algoMode` (an f32-encoded discriminant). Switching is a `values` mutation, not a recompile. Press `1` / `2` / `3` to switch.

## Run

```bash
# Dev server (port 5189) — WASD + mouse drag to reach grazing angles
pnpm --filter "@forgeax/app-learn-render-5-advanced-lighting-5-parallax-mapping" dev

# Build (composes parallax.wgsl via naga_oil + validates bindings vs paramSchema)
pnpm --filter "@forgeax/app-learn-render-5-advanced-lighting-5-parallax-mapping" build

# Smoke (dawn-node structural-only, 60 frames, onError=0)
pnpm --filter "@forgeax/app-learn-render-5-advanced-lighting-5-parallax-mapping" smoke

# Smoke (browser pixel readback: non-black + textured + basic->POM algo diff)
pnpm --filter "@forgeax/app-learn-render-5-advanced-lighting-5-parallax-mapping" smoke:browser
```

### Keymap

| Key | Action |
|:--|:--|
| `1` | basic parallax mapping (offset-limited; no `/viewDir.z`) |
| `2` | steep parallax mapping (layered ray-march) |
| `3` | parallax occlusion mapping (steep + interpolation) |
| `-` / `=` | decrease / increase `heightScale` (0.0 .. 0.5, default 0.1) |
| `T` | toggle texture set: `bricks2` ↔ `toy_box` |
| `WASD` + mouse drag, scroll | first-person camera (reach grazing angles to see the depth cue) |

## What this example shows

LO §5.5 teaches **parallax mapping**: a fragment-shader trick that displaces texture coordinates along the view vector using a **height (displacement) map**, faking surface depth on a flat quad without extra geometry. The three algorithms trade cost for quality:

1. **Basic** — one height sample, shift the UV by `viewDir.xy * height * scale`. The faithful LO variant uses **offset limiting** (does **not** divide by `viewDir.z`), trading depth accuracy for far fewer swim artifacts at grazing angles.
2. **Steep** — march fixed-depth layers along the view vector until the sampled depth exceeds the layer depth. Eliminates the basic-variant's flattening at steep angles but shows visible layer stepping.
3. **POM** — steep march, then linearly interpolate between the layer before and after the collision for a smooth, aliasing-free surface. The highest-quality variant.

### The engine angle: schema-derived bindings for an arbitrary texture count

The reason this is a *5.advanced-lighting* milestone and not just a shader port: forgeax's standard PBR material has a fixed three-texture slot set (baseColor / metallic-roughness / normal). Parallax needs a **height** map, which standard PBR has no slot for. Rather than special-casing a 4th texture in the engine, the engine now **derives** the material bind-group layout from each shader's `paramSchema`:

- Declare `heightTexture` (type `texture2d`) in the `.wgsl.meta.json` `paramSchema`.
- The engine's `derive(paramSchema)` emits a `@group(1)` BGL with a sampler+texture pair per declared texture, in declaration order, **sampler-first**.
- `extract` and `record` iterate `derive(paramSchema).textureFieldNames` — the height handle flows from `MaterialAsset.values.heightTexture` to the GPU bind group with **no per-texture hardcoding**.

A custom shader can declare *any* number of textures and they bind end-to-end. Built-in material BGL behaviour is unchanged.

## How the shader is wired

```wgsl
// parallax.wgsl (composed via vite-plugin-shader / naga_oil)
#define_import_path learn_render::5_5_parallax
#import forgeax_view::common::{View, Mesh, view, meshes}
#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg}   // reuse engine normal decode

// UBO @binding(0): the record-stage schema overlay projects `baseColor` -> f32[0..3]
// and the FIRST TWO f32 schema fields -> f32[4], f32[5]. heightScale + algoMode are
// the only two f32 fields, so they map cleanly.
struct ParallaxMaterial { baseColor: vec4<f32>, heightScale: f32, algoMode: f32 };
@group(1) @binding(0) var<uniform> material : ParallaxMaterial;
// Sampler-first per derive(paramSchema).bglEntries, declaration order:
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
@group(1) @binding(3) var normalSampler    : sampler;
@group(1) @binding(4) var normalTexture    : texture_2d<f32>;
@group(1) @binding(5) var heightSampler    : sampler;
@group(1) @binding(6) var heightTexture    : texture_2d<f32>;   // <- the new slot
```

```ts
// index.ts — register the shader, then mutate values by reference on keydown.
shader.registerMaterialShader('learn_render::5_5_parallax', {
  source: parallaxShader.wgsl,
  paramSchema: [
    { name: 'baseColor', type: 'color' },
    { name: 'heightScale', type: 'f32' },
    { name: 'algoMode', type: 'f32' },
    { name: 'baseColorTexture', type: 'texture2d' },
    { name: 'normalTexture', type: 'texture2d' },
    { name: 'heightTexture', type: 'texture2d' },
  ],
});

// Switching is a discrete event: mutate the live values ref; the next
// extract -> record cycle picks it up (no recompile, no re-register).
window.addEventListener('keydown', (ev) => {
  if (ev.key === '3') values.algoMode = 2.0; // -> POM next frame
});
```

## Tangent space without a tangent attribute change

LO 5.5 transforms the view, light, and fragment positions into **tangent space** in the vertex shader, then runs the whole parallax + lighting computation there. This demo does the same — but builds the TBN basis **in-shader** from the per-vertex tangent that `createPlaneGeometry` (and `HANDLE_QUAD`) already emit at `@location(3)`. No geometry-format change, no extra vertex attribute:

```wgsl
let n = normalize(transformNormal(meshes[idx].worldFromLocal, in.normal));
let t = normalize(t0 - dot(t0, n) * n);          // Gram-Schmidt
let b = cross(n, t) * in.tangent.w;              // handedness from tangent.w
let worldToTangent = transpose(mat3x3<f32>(t, b, n));
```

## Tuning

- **`heightScale`** (`-` / `=`): the displacement depth. LO default 0.1. Push it past ~0.2 on `toy_box` to see steep/POM hold up where basic visibly smears.
- **Algorithm** (`1`/`2`/`3`): at near-perpendicular view, all three look similar; rotate to a grazing angle (WASD around the wall) to see basic flatten, steep step, and POM stay smooth.
- **Texture set** (`T`): `bricks2` is the LO hero (subtle relief); `toy_box` has deep wells that exaggerate the parallax and make the algorithm differences obvious.

## Differences from the LO original

| Dimension | LO original (C++ / GLSL / GLFW) | forgeax here (TS / WGSL / WebGPU) |
|:--|:--|:--|
| Shading model | Blinn-Phong (ambient + diffuse + specular, hardcoded light) | Blinn-Phong (faithful: same ambient/diffuse/specular, light in tangent space) |
| Algorithm selection | three separate `.fs` shaders compiled/swapped | one shader, `material.algoMode` f32 dispatch (no recompile) |
| Height map binding | manual `glActiveTexture` + `glUniform1i("depthMap", 3)` | `paramSchema` declares `heightTexture` -> engine derives the BGL slot |
| `basic` formula | LO uses offset limiting (no `/viewDir.z`) | identical (offset limiting preserved, `feat` constraint F-1) |
| Tangent space | per-vertex `aTangent`/`aBitangent` attributes from the mesh | built in-shader from `createPlaneGeometry`'s `@location(3)` tangent |
| Texture loading | `stbi_load` + `glTexImage2D` | GUID asset pipeline (`loadByGuid<TextureAsset>`) |
| UV trim | `if (texCoords.x > 1.0 || ... ) discard;` | identical `discard` silhouette trim |
| Error handling | `glGetError` manual checks | structured `Result` + `renderer.onError` bus (charter P3) |

<details>
<summary>LO original C++/GLSL key fragments (reference)</summary>

LO §5.5 `parallax_mapping.fs` core (from [JoeyDeVries/LearnOpenGL](https://github.com/JoeyDeVries/LearnOpenGL)):

```glsl
// parallax_mapping.fs -- the three algorithms LO 5.5 walks through.
#version 330 core
out vec4 FragColor;
in VS_OUT {
    vec3 FragPos;
    vec2 TexCoords;
    vec3 TangentViewPos;
    vec3 TangentFragPos;
} fs_in;

uniform sampler2D diffuseMap;
uniform sampler2D normalMap;
uniform sampler2D depthMap;
uniform float heightScale;

// Basic parallax mapping with offset limiting (does NOT divide by viewDir.z).
vec2 ParallaxMapping(vec2 texCoords, vec3 viewDir) {
    float height = texture(depthMap, texCoords).r;
    vec2 p = viewDir.xy * (height * heightScale);
    return texCoords - p;
}

// Steep parallax mapping: march fixed-depth layers.
vec2 SteepParallaxMapping(vec2 texCoords, vec3 viewDir) {
    const float minLayers = 8.0;
    const float maxLayers = 32.0;
    float numLayers = mix(maxLayers, minLayers, abs(dot(vec3(0.0,0.0,1.0), viewDir)));
    float layerDepth = 1.0 / numLayers;
    float currentLayerDepth = 0.0;
    vec2 P = viewDir.xy / viewDir.z * heightScale;
    vec2 deltaTexCoords = P / numLayers;
    vec2 currentTexCoords = texCoords;
    float currentDepthMapValue = texture(depthMap, currentTexCoords).r;
    while (currentLayerDepth < currentDepthMapValue) {
        currentTexCoords -= deltaTexCoords;
        currentDepthMapValue = texture(depthMap, currentTexCoords).r;
        currentLayerDepth += layerDepth;
    }
    return currentTexCoords;
}

// Parallax occlusion mapping: steep + interpolate the collision.
vec2 ParallaxOcclusionMapping(vec2 texCoords, vec3 viewDir) {
    // ... steep march ...
    vec2 prevTexCoords = currentTexCoords + deltaTexCoords;
    float afterDepth  = currentDepthMapValue - currentLayerDepth;
    float beforeDepth = texture(depthMap, prevTexCoords).r - currentLayerDepth + layerDepth;
    float weight = afterDepth / (afterDepth - beforeDepth);
    return prevTexCoords * weight + currentTexCoords * (1.0 - weight);
}

void main() {
    vec3 viewDir = normalize(fs_in.TangentViewPos - fs_in.TangentFragPos);
    vec2 texCoords = ParallaxOcclusionMapping(fs_in.TexCoords, viewDir);
    if (texCoords.x > 1.0 || texCoords.y > 1.0 || texCoords.x < 0.0 || texCoords.y < 0.0)
        discard;
    vec3 normal = texture(normalMap, texCoords).rgb;
    normal = normalize(normal * 2.0 - 1.0);
    vec3 color = texture(diffuseMap, texCoords).rgb;
    // ... Blinn-Phong ambient + diffuse + specular ...
}
```

`texture` / `discard` / `mix` / `dot` / `normalize` / `sampler2D depthMap` / `heightScale` / `TangentViewPos` / `TangentFragPos` / `ParallaxMapping` / `SteepParallaxMapping` / `ParallaxOcclusionMapping` — the LO §5.5 identifiers are all mirrored in `parallax.wgsl` (the WGSL function names drop the `Mapping` suffix: `parallaxBasic` / `parallaxSteep` / `parallaxOcclusion`).

</details>
