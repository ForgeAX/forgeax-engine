#define_import_path bevy::parallax_mapping

#import forgeax_view::common::{transformNormal, View, Mesh, view, meshes}
#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg}

// parallax.wgsl — LearnOpenGL 5.5 Parallax Mapping (basic / steep / POM).
//
// One custom material shader carrying all three LO 5.5 algorithms; the active
// path is selected at runtime by `material.algoMode` (0=basic, 1=steep,
// 2=parallax-occlusion). The demo mutates algoMode + heightScale on the
// MaterialAsset.paramValues by reference (keydown), so no shader recompile or
// re-registration happens on switch.
//
// AI-user discoverability (charter F1): grep
//   - `#define_import_path learn_render::5_5_parallax`  this module
//   - `#import forgeax_pbr`  engine helpers reused (tangent-normal decode)
//   - `parallaxBasic` / `parallaxSteep` / `parallaxOcclusion`  the 3 paths
//
// Per-shader-derived BGL (feat-20260621): the paramSchema declares THREE
// texture fields (baseColorTexture / normalTexture / heightTexture). The engine
// derives the @group(1) material BGL from that schema — the heightTexture slot
// at @binding(5)/@binding(6) exists purely because the schema declares it; no
// engine edit is needed to add the 3rd texture. Bindings are sampler-first per
// derive(paramSchema).bglEntries (sampler at the odd binding, texture at the
// even+1). User bindings stop at 6; the engine reserves @binding(7..) for IBL +
// emissive/AO injection, so this shader must NOT declare bindings above 6.

// UBO @binding(0): the record-stage schema overlay projects `baseColor` ->
// f32[0..3] and the FIRST TWO f32 schema entries -> f32[4], f32[5]. So the
// schema lists heightScale + algoMode as the only two f32 fields and they map
// to .heightScale / .algoMode here. (metallic/roughness are intentionally
// absent — LO 5.5 uses fixed Blinn-Phong constants, not PBR params.)
// LO 5.5 constants. The light orbits in the C++ tutorial; the demo keeps it
// static (a single point light) so the parallax depth cue is unambiguous.
const LIGHT_POS   : vec3<f32> = vec3<f32>(0.5, 1.0, 0.3);
const LIGHT_COLOR : vec3<f32> = vec3<f32>(1.0, 1.0, 1.0);
const SHININESS   : f32       = 32.0;
const AMBIENT_K   : f32       = 0.1;
const SPECULAR_K  : f32       = 0.2;

const ALGO_BASIC : f32 = 0.0;
const ALGO_STEEP : f32 = 1.0;
const ALGO_POM   : f32 = 2.0;

// Steep / POM layer counts (LO 5.5 verbatim).
const MIN_LAYERS : f32 = 8.0;
const MAX_LAYERS : f32 = 32.0;
// Hard upper bound for the WGSL march loop (must be >= MAX_LAYERS). The loop
// also tests the depth condition; this only guarantees termination.
const MAX_MARCH_STEPS : i32 = 64;

struct VsIn {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};

struct VsOut {
  @builtin(position) clip            : vec4<f32>,
  @location(0)       uv              : vec2<f32>,
  @location(1)       tangentViewPos  : vec3<f32>,
  @location(2)       tangentFragPos  : vec3<f32>,
  @location(3)       tangentLightPos : vec3<f32>,
};

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let world = meshes[idx].worldFromLocal * vec4<f32>(in.pos, 1.0);
  let worldPos = world.xyz;

  // Build the world-space TBN from the per-vertex normal + tangent
  // (createPlaneGeometry emits tangent at @location(3), handedness in .w).
  // Per LO 5.5 / constraint O-2: bitangent is B = cross(N, T) * T.w — NO
  // Gram-Schmidt re-orthogonalization (the plane's tangent is already
  // perpendicular to its normal, and LO computes the whole lighting in this
  // tangent space). transpose(mat3(T,B,N)) maps world-space -> tangent space
  // (D-5: TBN built in-shader, no geometry change).
  let n = normalize(transformNormal(meshes[idx].worldFromLocal, in.normal));
  let t = normalize((meshes[idx].worldFromLocal * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
  let b = cross(n, t) * in.tangent.w;
  let worldToTangent = transpose(mat3x3<f32>(t, b, n));

  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.uv = in.uv;
  out.tangentViewPos = worldToTangent * view.cameraPos;
  out.tangentFragPos = worldToTangent * worldPos;
  out.tangentLightPos = worldToTangent * LIGHT_POS;
  return out;
}

fn sampleHeight(uv : vec2<f32>) -> f32 {
  // textureSampleLevel (explicit LOD 0) is mandatory inside the march loop:
  // WGSL forbids implicit-LOD textureSample under non-uniform control flow.
  return textureSampleLevel(heightTexture, heightTexture_sampler, uv, 0.0).r;
}

// LOD-0 implicit-LOD read used ONLY in the uniform-control-flow basic path.
// Its purpose beyond basic mapping: a single `textureSample` use makes naga
// reflect heightTexture as `float` / heightSampler as `filtering` (matching
// the engine's derive(paramSchema).bglEntries, which always emits filtering
// samplers). Without one implicit-LOD use, an explicit-LOD-only texture
// reflects as `unfilterable-float` + `non-filtering` and fails the build-time
// paramSchema-vs-WGSL binding check.
fn sampleHeightFiltered(uv : vec2<f32>) -> f32 {
  return textureSample(heightTexture, heightTexture_sampler, uv).r;
}

// LO 5.5 "Parallax Mapping" with offset limiting: shift the UV by the view
// vector scaled by the sampled height. Faithful to the LO original, this
// variant does NOT divide by viewDir.z (offset limiting), trading a little
// depth accuracy for far fewer swim artifacts at grazing angles.
fn parallaxBasic(uv : vec2<f32>, viewDir : vec3<f32>) -> vec2<f32> {
  // Uniform control flow here -> implicit-LOD textureSample is legal (and
  // anchors the filtering reflection; see sampleHeightFiltered).
  let height = sampleHeightFiltered(uv);
  let p = viewDir.xy * (height * material.heightScale);
  return uv - p;
}

// LO 5.5 "Steep Parallax Mapping": march fixed-depth layers along the view
// vector until the sampled depth exceeds the current layer depth.
fn parallaxSteep(uv : vec2<f32>, viewDir : vec3<f32>) -> vec2<f32> {
  let numLayers = mix(MAX_LAYERS, MIN_LAYERS, abs(dot(vec3<f32>(0.0, 0.0, 1.0), viewDir)));
  let layerDepth = 1.0 / numLayers;
  let p = viewDir.xy / viewDir.z * material.heightScale;
  let deltaUv = p / numLayers;

  var currentLayerDepth = 0.0;
  var currentUv = uv;
  var currentDepth = sampleHeight(currentUv);
  for (var i = 0; i < MAX_MARCH_STEPS; i = i + 1) {
    if (currentLayerDepth >= currentDepth) { break; }
    currentUv = currentUv - deltaUv;
    currentDepth = sampleHeight(currentUv);
    currentLayerDepth = currentLayerDepth + layerDepth;
  }
  return currentUv;
}

// LO 5.5 "Parallax Occlusion Mapping": steep march, then linearly interpolate
// between the layer before and after the collision for a smooth surface.
fn parallaxOcclusion(uv : vec2<f32>, viewDir : vec3<f32>) -> vec2<f32> {
  let numLayers = mix(MAX_LAYERS, MIN_LAYERS, abs(dot(vec3<f32>(0.0, 0.0, 1.0), viewDir)));
  let layerDepth = 1.0 / numLayers;
  let p = viewDir.xy / viewDir.z * material.heightScale;
  let deltaUv = p / numLayers;

  var currentLayerDepth = 0.0;
  var currentUv = uv;
  var currentDepth = sampleHeight(currentUv);
  for (var i = 0; i < MAX_MARCH_STEPS; i = i + 1) {
    if (currentLayerDepth >= currentDepth) { break; }
    currentUv = currentUv - deltaUv;
    currentDepth = sampleHeight(currentUv);
    currentLayerDepth = currentLayerDepth + layerDepth;
  }

  let prevUv = currentUv + deltaUv;
  let afterDepth = currentDepth - currentLayerDepth;
  let beforeDepth = sampleHeight(prevUv) - currentLayerDepth + layerDepth;
  let weight = afterDepth / (afterDepth - beforeDepth);
  return prevUv * weight + currentUv * (1.0 - weight);
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let viewDir = normalize(in.tangentViewPos - in.tangentFragPos);

  // Algorithm dispatch by material.algoMode (f32-encoded; D-4). algoMode is a
  // discrete switch, so threshold compares are exact for the 0/1/2 values the
  // demo writes.
  var texCoords = in.uv;
  if (material.algoMode < ALGO_STEEP + 0.5) {
    if (material.algoMode < ALGO_BASIC + 0.5) {
      texCoords = parallaxBasic(in.uv, viewDir);
    } else {
      texCoords = parallaxSteep(in.uv, viewDir);
    }
  } else {
    texCoords = parallaxOcclusion(in.uv, viewDir);
  }

  // Discard UVs that walked off the [0,1] tile — LO 5.5 trims the silhouette
  // so steep/POM displacement does not smear edge texels.
  if (texCoords.x > 1.0 || texCoords.y > 1.0 || texCoords.x < 0.0 || texCoords.y < 0.0) {
    discard;
  }

  // Tangent-space normal from the normal map (RG decode reuses the engine
  // helper; z is reconstructed under the unit-length constraint).
  let normalRg = textureSample(normalTexture, normalTexture_sampler, texCoords).rg;
  let n = decodeTangentSpaceNormalRg(normalRg);

  let color = textureSample(baseColorTexture, baseColorTexture_sampler, texCoords).rgb * material.baseColor.rgb;

  let lightDir = normalize(in.tangentLightPos - in.tangentFragPos);
  let halfwayDir = normalize(lightDir + viewDir);

  let ambient = AMBIENT_K * color;
  let diff = max(dot(lightDir, n), 0.0);
  let diffuse = diff * color * LIGHT_COLOR;
  let spec = pow(max(dot(n, halfwayDir), 0.0), SHININESS);
  let specular = SPECULAR_K * spec * LIGHT_COLOR;

  return vec4<f32>(ambient + diffuse + specular, 1.0);
}
