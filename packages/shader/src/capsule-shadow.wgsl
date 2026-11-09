#define_import_path forgeax_shadow::capsule

const CAPSULE_PI : f32 = 3.14159265;

fn capsuleCapArea(angle : f32) -> f32 {
  return 2.0 * CAPSULE_PI * (1.0 - cos(angle));
}

// Fraction of the light cone (half-angle params.lanes.w) left unblocked by one
// capsule: the closest point on its segment to the light ray is treated as a
// sphere whose solid angle overlaps the cone, faded out past the capsule reach.
fn capsuleVisibility(position : vec3<f32>, toLight : vec3<f32>, a : vec3<f32>, radius : f32,
    b : vec3<f32>, reach : f32, cone : f32) -> f32 {
  let d = b - a;
  let w0 = a - position;
  let lengthSq = dot(d, d);
  let along = dot(d, toLight);
  let denominator = lengthSq - along * along;
  var s = 0.0;
  if (denominator > 1e-6) {
    s = clamp((along * dot(toLight, w0) - dot(d, w0)) / denominator, 0.0, 1.0);
  } else if (lengthSq > 1e-6) {
    s = clamp(-dot(d, w0) / lengthSq, 0.0, 1.0);
  }
  let toCapsule = a + s * d - position;
  let t = dot(toCapsule, toLight);
  if (t <= 0.0) { return 1.0; }
  let fade = clamp(3.0 - 3.0 * t / reach, 0.0, 1.0);
  if (fade <= 0.0) { return 1.0; }
  let distance = max(length(toCapsule), 1e-4);
  // Receivers inside the capsule shrink it so the occluder never covers the whole sky.
  let apparent = min(radius, 0.9 * distance);
  let omega = atan(apparent / distance);
  let beta = acos(clamp(t / distance, -1.0, 1.0));
  let low = abs(cone - omega);
  let overlap = 1.0 - clamp((beta - low) / max(cone + omega - low, 1e-5), 0.0, 1.0);
  let occlusion = capsuleCapArea(min(cone, omega)) * smoothstep(0.0, 1.0, overlap) /
    capsuleCapArea(cone);
  return 1.0 - min(occlusion, 1.0) * fade;
}
