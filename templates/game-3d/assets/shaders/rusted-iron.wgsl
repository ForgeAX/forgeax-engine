#define_import_path game_3d::rusted_iron_surface

#import forgeax_material::parameters::{material}
#import forgeax_material::surface_v1::{SurfaceData, SurfaceInput}

fn hash31(p : vec3<f32>) -> f32 {
  var q = fract(p * 0.1031);
  q = q + dot(q, q.yzx + vec3<f32>(33.33));
  return fract((q.x + q.y) * q.z);
}

fn valueNoise(p : vec3<f32>) -> f32 {
  let cell = floor(p);
  let local = fract(p);
  let blend = local * local * (vec3<f32>(3.0) - 2.0 * local);
  let x00 = mix(hash31(cell), hash31(cell + vec3<f32>(1.0, 0.0, 0.0)), blend.x);
  let x10 = mix(hash31(cell + vec3<f32>(0.0, 1.0, 0.0)), hash31(cell + vec3<f32>(1.0, 1.0, 0.0)), blend.x);
  let x01 = mix(hash31(cell + vec3<f32>(0.0, 0.0, 1.0)), hash31(cell + vec3<f32>(1.0, 0.0, 1.0)), blend.x);
  let x11 = mix(hash31(cell + vec3<f32>(0.0, 1.0, 1.0)), hash31(cell + vec3<f32>(1.0, 1.0, 1.0)), blend.x);
  return mix(mix(x00, x10, blend.y), mix(x01, x11, blend.y), blend.z);
}

fn fbm(p : vec3<f32>) -> f32 {
  var samplePos = p;
  var amplitude = 0.54;
  var sum = 0.0;
  for (var octave = 0u; octave < 4u; octave = octave + 1u) {
    sum = sum + valueNoise(samplePos) * amplitude;
    samplePos = samplePos * 2.03 + vec3<f32>(13.1, 7.7, 5.3);
    amplitude = amplitude * 0.48;
  }
  return sum;
}

fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  let p = input.positionWS * material.noiseScale;
  let broad = fbm(p * 0.62 + vec3<f32>(2.4, 11.7, 4.1));
  let streak = fbm(vec3<f32>(p.x * 1.3, p.y * 4.8, p.z * 1.3));
  let fine = valueNoise(p * 7.6 + vec3<f32>(19.0, 3.0, 17.0));
  let vein = 0.5 + 0.5 * sin(p.y * 2.6 + broad * 10.5 + sin(p.x * 2.2) * 1.7);
  let corrosion = broad * 0.52 + streak * 0.18 + fine * 0.16 + vein * 0.14;
  let rust = smoothstep(0.55, 0.65, corrosion);
  let pits = smoothstep(0.75, 0.9, valueNoise(p * 10.2 + vec3<f32>(5.0, 29.0, 2.0)));

  let oxideVariation = fbm(p * 2.8 + vec3<f32>(31.0, 1.0, 8.0));
  let rustColor = mix(material.rustDark.rgb, material.rustBright.rgb, oxideVariation);
  let rustEdge = smoothstep(0.47, 0.55, corrosion) - rust;
  var albedo = mix(material.ironColor.rgb, rustColor, rust);
  albedo = mix(albedo, vec3<f32>(0.24, 0.075, 0.022), rustEdge * 0.68);
  albedo = albedo * mix(1.0, 0.58, pits * mix(0.3, 1.0, rust));

  return SurfaceData(
    albedo,
    input.vertexNormalWS,
    1.0 - rust * 0.9,
    mix(0.38, 0.88, rust),
    vec3<f32>(0.0),
    1.0,
    1.0,
    0.0,
  );
}
