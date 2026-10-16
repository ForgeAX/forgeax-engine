#define_import_path forgeax_material::alpha_hash

// Object-space, derivative-scaled hashed alpha, following Three.js r184 and
// Wyman/McGuire 2017. No frame seed: camera jitter supplies temporal samples.
fn alphaHash2D(value : vec2<f32>) -> f32 {
  return fract(1.0e4 * sin(17.0 * value.x + 0.1 * value.y) *
    (0.1 + abs(sin(13.0 * value.y + value.x))));
}

fn alphaHash3D(value : vec3<f32>) -> f32 {
  return alphaHash2D(vec2<f32>(alphaHash2D(value.xy), value.z));
}

fn alphaHashThreshold(position : vec3<f32>, derivative : f32) -> f32 {
  // Degenerate projected coordinates must not create log2(infinity) or NaN.
  let scale = 1.0 / max(0.05 * derivative, 1.0e-6);
  let level = log2(scale);
  let noise = vec2<f32>(
    alphaHash3D(floor(exp2(floor(level)) * position)),
    alphaHash3D(floor(exp2(ceil(level)) * position)),
  );
  let t = fract(level);
  let x = mix(noise.x, noise.y, t);
  let a = min(t, 1.0 - t);
  // At an exact octave the distribution is already uniform. Avoid the
  // reference's unused 0/0 tail expressions on stricter GPU implementations.
  var threshold = x;
  if (a > 0.0) {
    if (x < a) {
      threshold = x * x / (2.0 * a * (1.0 - a));
    } else if (x < 1.0 - a) {
      threshold = (x - 0.5 * a) / (1.0 - a);
    } else {
      threshold = 1.0 - (1.0 - x) * (1.0 - x) / (2.0 * a * (1.0 - a));
    }
  }
  return clamp(threshold, 1.0e-6, 1.0);
}

fn applyAlphaHash(alpha : f32, position : vec3<f32>, enabled : f32) {
  // Evaluate derivatives before any per-fragment discard or divergent branch.
  let derivative = max(length(dpdx(position)), length(dpdy(position)));
  if (enabled > 0.5) {
    let threshold = alphaHashThreshold(position, derivative);
    if (alpha < threshold) { discard; }
  }
}
