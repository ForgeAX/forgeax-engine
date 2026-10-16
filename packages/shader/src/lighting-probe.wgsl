// @forgeax/engine-shader - lighting-probe.wgsl
// Local diffuse LightProbe composition. The record is supplied by the
// renderer's per-object retained projection; Skylight remains the sole Sky
// and specular owner.

#define_import_path forgeax_pbr::lighting_probe

const PROBE_INV_PI : f32 = 0.3183098861837907;

fn probe_sh9(shPreblend : array<vec4<f32>, 9>, normal : vec3<f32>) -> vec3<f32> {
  let x = normal.x;
  let y = normal.y;
  let z = normal.z;
  // Keep the nine terms scalar. Chromium's GLES translator can emit an
  // unqualified float[9] constructor for a local WGSL array, which some
  // mobile GLSL ES drivers reject even when the declaration is highp.
  var result = shPreblend[0].xyz * 0.2820947918;
  result += shPreblend[1].xyz * (0.4886025119 * y);
  result += shPreblend[2].xyz * (0.4886025119 * z);
  result += shPreblend[3].xyz * (0.4886025119 * x);
  result += shPreblend[4].xyz * (1.0925484306 * x * y);
  result += shPreblend[5].xyz * (1.0925484306 * y * z);
  result += shPreblend[6].xyz * (0.3153915653 * (3.0 * z * z - 1.0));
  result += shPreblend[7].xyz * (1.0925484306 * x * z);
  result += shPreblend[8].xyz * (0.5462742153 * (x * x - y * y));
  return result;
}

// One SH9 evaluation, then the real Skylight residual. No Sky q, probe loop,
// hidden gain, smoothstep, or specular probe path is present here.
fn evaluateProbeDiffuse(
  shPreblend : array<vec4<f32>, 9>,
  localBlendFraction : f32,
  normal : vec3<f32>,
  e_sky : vec3<f32>,
  k_d : vec3<f32>,
  albedo : vec3<f32>,
  metallic : f32,
) -> vec3<f32> {
  // `shPreblend` stores cosine-convolved irradiance. Match the existing
  // Standard-PBR Skylight path and Three's BRDF_Lambert: irradiance becomes
  // reflected diffuse radiance only after the single 1/pi factor. The Sky
  // argument is already the Skylight path's E/pi * color * intensity value,
  // so it must not be divided a second time below.
  let local = max(probe_sh9(shPreblend, normal), vec3<f32>(0.0)) * PROBE_INV_PI;
  let skyResidualFraction = 1.0 - localBlendFraction;
  return (local + skyResidualFraction * e_sky) * k_d * albedo * (1.0 - metallic);
}
