#define_import_path ai_weapon_spirit::low_poly_toon

#import forgeax_view::common::{view, meshes, instances, shadowCasterCascade}
#import forgeax_pbr::lighting_directional::{evalDirectionalShadowFactor}
#import ai_weapon_spirit::painterly_surface::{applyPigment, paintedSpecular, paintedRim}

struct Material {
  baseColor : vec4<f32>,
  shadowColor : vec4<f32>,
  rimColor : vec4<f32>,
  rimStrength : f32,
  specularStrength : f32,
  emissionStrength : f32,
  sideShade : f32,
  surfaceRoughness : f32,
  surfaceMetallic : f32,
  pigmentStrength : f32,
  pigmentScale : f32,
};

@group(1) @binding(0) var<uniform> material : Material;

struct VsIn {
  @location(0) pos : vec3<f32>,
  @location(1) normal : vec3<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) worldNormal : vec3<f32>,
  @location(2) viewZ : f32,
  @location(3) paintPos : vec3<f32>,
};

@vertex
fn vs_main(input : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  // One path covers regular meshes (the renderer binds one identity instance)
  // and explicit GPU Instances batches used by projectiles.
  let model = meshes[0].worldFromLocal * instances[idx].localFromInstance;
  let world = model * vec4<f32>(input.pos, 1.0);
  var output : VsOut;
  output.clip = view.worldViewProj * world;
  output.worldPos = world.xyz;
  output.paintPos = input.pos * vec3<f32>(length(model[0].xyz), length(model[1].xyz), length(model[2].xyz));
  output.worldNormal = normalize((model * vec4<f32>(input.normal, 0.0)).xyz);
  output.viewZ = -output.clip.w;
  return output;
}

@fragment
fn fs_main(input : VsOut, @builtin(front_facing) frontFacing : bool) -> @location(0) vec4<f32> {
  // PCG crowd meshes share the eight geometric cube corners instead of
  // duplicating four vertices per face. Reconstructing the face normal from
  // world-space derivatives preserves exact hard Low Poly planes while
  // reducing full-stage stress vertex traffic by roughly three times.
  // WebGPU framebuffer Y grows downward, so dy × dx produces the outward
  // normal for the front-facing triangle winding used by ForgeAX meshes.
  var normal = normalize(cross(dpdy(input.worldPos), dpdx(input.worldPos)));
  if (!frontFacing) {
    normal = -normal;
  }
  let toLight = normalize(vec3<f32>(0.46, 1.0, 0.32));
  let toCamera = normalize(view.cameraPos - input.worldPos);
  let nDotL = dot(normal, toLight);
  let upFacing = dot(normal, vec3<f32>(0.0, 1.0, 0.0));
  let paintNormal = normalize(cross(dpdy(input.paintPos), dpdx(input.paintPos)));
  let surfaceColor = applyPigment(material.baseColor.rgb, input.paintPos, paintNormal, material.pigmentScale, material.pigmentStrength);

  // Three broad light bands keep the blocks graphic instead of plastic.
  var lightBand = 0.16;
  if (nDotL > 0.08) {
    lightBand = 0.58;
  }
  if (nDotL > 0.68) {
    lightBand = 1.0;
  }
  var color = mix(material.shadowColor.rgb, surfaceColor, lightBand);

  // Preserve native PCF and cascade blending. Thresholding BRDF radiance
  // makes shadow edges depend on view direction and amplifies small changes.
  // Toon bands stay authored here, with a readable cool ambient floor.
  let shadowVisibility = evalDirectionalShadowFactor(normal, input.worldPos, input.viewZ, 0u);
  if (nDotL > 0.08) {
    color *= mix(0.46, 1.0, shadowVisibility);
  }

  // Top planes carry the clean local color; sides become the darker cut face.
  var planeShade = material.sideShade;
  if (upFacing > 0.72) {
    planeShade = 1.0;
  }
  if (upFacing < -0.72) {
    planeShade = material.sideShade * 0.72;
  }
  color *= planeShade;

  color += paintedSpecular(surfaceColor, normal, toLight, toCamera, material.surfaceRoughness,
    material.surfaceMetallic, material.specularStrength, shadowVisibility);
  let rim = paintedRim(normal, toCamera, material.surfaceRoughness, material.rimStrength, shadowVisibility);
  color += material.rimColor.rgb * rim;
  color += material.rimColor.rgb * material.emissionStrength;

  return vec4<f32>(color, material.baseColor.a);
}

// Isolated candidate entry for the readability preview. Production
// materials continue to use fs_main; this variant only tests a coloured
// ambient floor and a restrained Fresnel lift before the values are approved.
@fragment
fn fs_readability_candidate(input : VsOut, @builtin(front_facing) frontFacing : bool) -> @location(0) vec4<f32> {
  var normal = normalize(cross(dpdy(input.worldPos), dpdx(input.worldPos)));
  if (!frontFacing) {
    normal = -normal;
  }

  let toLight = normalize(vec3<f32>(0.46, 1.0, 0.32));
  let toCamera = normalize(view.cameraPos - input.worldPos);
  let nDotL = dot(normal, toLight);
  let upFacing = dot(normal, vec3<f32>(0.0, 1.0, 0.0));
  let paintNormal = normalize(cross(dpdy(input.paintPos), dpdx(input.paintPos)));
  let surfaceColor = applyPigment(material.baseColor.rgb, input.paintPos, paintNormal, material.pigmentScale, material.pigmentStrength);

  var lightBand = 0.24;
  if (nDotL > -0.22) {
    lightBand = 0.43;
  }
  if (nDotL > 0.08) {
    lightBand = 0.70;
  }
  if (nDotL > 0.68) {
    lightBand = 1.0;
  }
  var color = mix(material.shadowColor.rgb, surfaceColor, lightBand);

  let shadowVisibility = evalDirectionalShadowFactor(normal, input.worldPos, input.viewZ, 0u);
  if (nDotL > 0.08) {
    // Move occluded faces toward their authored hue without multiplying the
    // already-dark result toward black a second time.
    let retainedLight = mix(0.48, 1.0, shadowVisibility);
    color = mix(material.shadowColor.rgb, color, retainedLight);
  }

  var planeShade = material.sideShade;
  if (upFacing > 0.72) {
    planeShade = 1.0;
  }
  if (upFacing < -0.72) {
    planeShade = material.sideShade * 0.86;
  }
  color *= planeShade;

  color += paintedSpecular(surfaceColor, normal, toLight, toCamera, material.surfaceRoughness,
    material.surfaceMetallic, material.specularStrength, shadowVisibility);
  let rim = paintedRim(normal, toCamera, material.surfaceRoughness, material.rimStrength, shadowVisibility);
  color += material.rimColor.rgb * rim;
  color += material.rimColor.rgb * material.emissionStrength;

  return vec4<f32>(color, material.baseColor.a);
}

// Opaque Toon depth entry shares this material's composed module and layout.
@vertex
fn vs_shadow(@location(0) position : vec3<f32>, @builtin(instance_index) idx : u32) -> @builtin(position) vec4<f32> {
  let world = meshes[0].worldFromLocal * instances[idx].localFromInstance * vec4<f32>(position, 1.0);
  if (shadowCasterCascade.isSpot == 1u) {
    return shadowCasterCascade.spotLightViewProj * world;
  }
  switch (shadowCasterCascade.index) {
    case 0u: { return view.lightViewProj_A * world; }
    case 1u: { return view.lightViewProj_B * world; }
    case 2u: { return view.lightViewProj_C * world; }
    default: { return view.lightViewProj_D * world; }
  }
}

@fragment
fn fs_shadow() {}
