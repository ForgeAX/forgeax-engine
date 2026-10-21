#define_import_path forgeax_environment::ibl

// @forgeax/engine-shader - atmosphere-ibl.wgsl
//
// The analytic atmosphere evaluator writes only the sky cube. Diffuse and
// specular consumers derive their own products from that cube here, keeping
// the Sun disc out of every IBL payload and preventing a second direct-Sun
// injection. The graph selects one entry point per producer kind.

#import forgeax_pbr::ibl_shared::{PI}

struct AtmosphereIblVsIn {
  // xy is clip-space; z is the one-based cube-face tag supplied by the
  // producer's six fullscreen triangles.
  @location(0) faceVertex: vec3<f32>,
};

struct AtmosphereIblVsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) direction: vec3<f32>,
};

@group(0) @binding(0) var sky: texture_cube<f32>;
@group(0) @binding(1) var skySampler: sampler;

@vertex
fn atmosphere_ibl_vs(input: AtmosphereIblVsIn) -> AtmosphereIblVsOut {
  var output: AtmosphereIblVsOut;
  let face = u32(input.faceVertex.z) - 1u;
  let x = input.faceVertex.x;
  let y = input.faceVertex.y;
  output.clip = vec4<f32>(x, y, 0.5, 1.0);
  switch face {
    case 0u: { output.direction = vec3<f32>(1.0, -y, -x); }
    case 1u: { output.direction = vec3<f32>(-1.0, -y, x); }
    case 2u: { output.direction = vec3<f32>(x, -1.0, -y); }
    case 3u: { output.direction = vec3<f32>(x, 1.0, y); }
    case 4u: { output.direction = vec3<f32>(x, -y, 1.0); }
    default: { output.direction = vec3<f32>(-x, -y, -1.0); }
  }
  return output;
}

fn atmosphere_ibl_tangent_frame(normal: vec3<f32>) -> mat3x3<f32> {
  let up = select(
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(1.0, 0.0, 0.0),
    abs(normal.y) > 0.999,
  );
  let tangent = normalize(cross(up, normal));
  let bitangent = normalize(cross(normal, tangent));
  return mat3x3<f32>(tangent, bitangent, normal);
}

@fragment
fn atmosphere_irradiance_fs(input: AtmosphereIblVsOut) -> @location(0) vec4<f32> {
  let normal = normalize(input.direction);
  let frame = atmosphere_ibl_tangent_frame(normal);
  var irradiance = vec3<f32>(0.0);
  var sampleCount: f32 = 0.0;
  var phiIndex: u32 = 0u;
  while (phiIndex < 16u) {
    let phi = 2.0 * PI * f32(phiIndex) / 16.0;
    var thetaIndex: u32 = 0u;
    while (thetaIndex < 8u) {
      let theta = 0.5 * PI * (f32(thetaIndex) + 0.5) / 8.0;
      let tangentSample = vec3<f32>(
        sin(theta) * cos(phi),
        sin(theta) * sin(phi),
        cos(theta),
      );
      let sampleDirection = frame * tangentSample;
      let weight = cos(theta) * sin(theta);
      let cubeSampleDirection = vec3<f32>(
        sampleDirection.x,
        -sampleDirection.y,
        sampleDirection.z,
      );
      irradiance += textureSampleLevel(sky, skySampler, cubeSampleDirection, 0.0).rgb * weight;
      sampleCount += 1.0;
      thetaIndex = thetaIndex + 1u;
    }
    phiIndex = phiIndex + 1u;
  }
  return vec4<f32>(PI * irradiance / max(sampleCount, 1.0), 1.0);
}
