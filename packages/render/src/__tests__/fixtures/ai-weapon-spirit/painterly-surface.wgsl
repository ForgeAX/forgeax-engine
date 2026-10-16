#define_import_path ai_weapon_spirit::painterly_surface

fn pigmentHash(point : vec2<f32>) -> f32 {
  var p = fract(vec3<f32>(point.x, point.y, point.x) * .1031);
  p += vec3<f32>(dot(p, p.yzx + vec3<f32>(33.33)));
  return fract((p.x + p.y) * p.z);
}

fn pigmentNoise(point : vec2<f32>) -> f32 {
  let cell = floor(point);
  let f = fract(point);
  let u = f * f * (vec2<f32>(3.0) - 2.0 * f);
  return mix(mix(pigmentHash(cell), pigmentHash(cell + vec2<f32>(1.0, 0.0)), u.x),
    mix(pigmentHash(cell + vec2<f32>(0.0, 1.0)), pigmentHash(cell + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

fn pigmentPlane(position : vec3<f32>, normal : vec3<f32>) -> vec2<f32> {
  let axis = abs(normal);
  if (axis.y >= max(axis.x, axis.z)) { return position.xz; }
  if (axis.x > axis.z) { return position.zy; }
  return position.xy;
}

// Soft pigment pools, with no repeated stroke or bristle shapes. Rotate and
// gently warp the field so its broad transitions do not reveal the noise grid.
// Units are metres: moving actors use local coordinates, fixed terrain world coordinates.
fn applyPigment(base : vec3<f32>, position : vec3<f32>, normal : vec3<f32>, scale : f32, strength : f32) -> vec3<f32> {
  let plane = pigmentPlane(position, normal) * scale;
  let point = vec2<f32>(plane.x * .8 + plane.y * .6, plane.y * .8 - plane.x * .6);
  let drift = vec2<f32>(
    pigmentNoise(point * .11 + vec2<f32>(5.2, 11.7)),
    pigmentNoise(point * .11 + vec2<f32>(19.3, -4.6)),
  ) - vec2<f32>(.5);
  let field = point * .18 + drift * .65;
  let wash = pigmentNoise(field + vec2<f32>(3.2, 8.1)) - .5;
  let bloom = pigmentNoise(field * .47 + vec2<f32>(-7.4, 2.9)) - .5;
  let pigment = (wash * .72 + bloom * .28) * strength;
  // Pigment changes local reflectance; it never emits light or changes normals.
  return max(vec3<f32>(0.0), base * (1.0 + pigment) + vec3<f32>(.08, .02, -.055) * pigment);
}

fn paintedSpecular(base : vec3<f32>, normal : vec3<f32>, light : vec3<f32>, camera : vec3<f32>,
  roughness : f32, metallic : f32, strength : f32, visibility : f32) -> vec3<f32> {
  let halfVector = normalize(light + camera);
  let smoothness = 1.0 - clamp(roughness, .04, 1.0);
  let lobe = pow(max(dot(normal, halfVector), 0.0), mix(12.0, 112.0, smoothness));
  let reflection = strength * smoothness * smoothness * lobe
    * max(dot(normal, light), 0.0) * visibility;
  return mix(vec3<f32>(.88, .86, .81), base, metallic) * reflection;
}

fn paintedRim(normal : vec3<f32>, camera : vec3<f32>, roughness : f32, strength : f32, visibility : f32) -> f32 {
  let fresnel = pow(1.0 - clamp(dot(normal, camera), 0.0, 1.0), 4.0);
  return fresnel * strength * mix(1.0, .18, roughness) * mix(.35, 1.0, visibility);
}
