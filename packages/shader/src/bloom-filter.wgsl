#define_import_path forgeax_view::bloom_filter
// Pair adjacent Gaussian taps through bilinear filtering. Use the normalized
// truncated kernel so a constant HDR field has the same gain at every level.
fn bloomGaussian(
  src: texture_2d<f32>, samp: sampler, uv: vec2<f32>, step: vec2<f32>, level: u32,
) -> vec3<f32> {
  let radius = 6u + 4u * level;
  let sigma = f32(radius) / 3.0;
  let scale = -0.5 / (sigma * sigma);
  var color = max(textureSampleLevel(src, samp, uv, 0.0).rgb, vec3<f32>(0.0));
  var total = 1.0;
  for (var i = 1u; i < radius; i += 2u) {
    let j = i + 1u;
    let a = exp(f32(i * i) * scale);
    let b = select(exp(f32(j * j) * scale), 0.0, j >= radius);
    let weight = a + b;
    let offset = step * (f32(i) + b / weight);
    let left = max(textureSampleLevel(src, samp, uv - offset, 0.0).rgb, vec3<f32>(0.0));
    let right = max(textureSampleLevel(src, samp, uv + offset, 0.0).rgb, vec3<f32>(0.0));
    color += (left + right) * weight;
    total += 2.0 * weight;
  }
  return color / total;
}

// Snap to the nearest finite storage value before the attachment conversion.
// Some backends truncate RGB11F stores, which biases the accumulation darker.
// Normal float32 values share the packed float exponent and leading bit.
fn bloomAttachmentColor(color: vec3<f32>, packed: bool) -> vec3<f32> {
  if (!packed) {
    return clamp(color, vec3<f32>(0.0), vec3<f32>(65504.0));
  }
  let value = clamp(color, vec3<f32>(0.0), vec3<f32>(65024.0, 65024.0, 64512.0));
  let bits = bitcast<vec3<u32>>(value);
  let shift = vec3<u32>(17u, 17u, 18u);
  let one = vec3<u32>(1u);
  let evenBias = ((one << (shift - one)) - one) + ((bits >> shift) & one);
  let normal = bitcast<vec3<f32>>(((bits + evenBias) >> shift) << shift);
  let subnormalScale = vec3<f32>(1048576.0, 1048576.0, 524288.0);
  let subnormal = round(value * subnormalScale) / subnormalScale;
  return select(normal, subnormal, value < vec3<f32>(0.00006103515625));
}
