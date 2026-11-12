// Screen-space AO: view-space hemisphere sampling and bilateral filtering.
// Both passes consume the same current-frame depth and world normals.

#define_import_path forgeax_hdrp::ssao
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness}

#import forgeax_view::common::{fullscreen_triangle, FullscreenOutput}

// ── SSAO uniform (3 mat4 + 3 vec4, padded to 256 B) ────────────────────────
//
// intensityPad carries the raw visibility exponent plus the calc radius/bias.
// Raw intensity is applied before the spatial filter, once.
// clusterPack is used only by the no-storage integer-texture AO packer.

struct SsaoUniform {
  view              : mat4x4<f32>,  // world -> view
  projection        : mat4x4<f32>,  // view -> clip
  inverseProjection : mat4x4<f32>,  // NDC -> view
  intensityPad      : vec4<f32>,    // intensity, radius, bias, sample budget
  algorithmPad      : vec4<f32>,    // algorithm, thickness, radial exponent, distance falloff
  clusterPack       : vec4<u32>,   // physical base origin, Cluster width, packed AO row width
};

// ── SSAO binding declarations (@group(2)) ───────────────────────────────────

@group(0) @binding(0) var<uniform> ssao_uniform      : SsaoUniform;
@group(0) @binding(1) var<uniform> ssao_kernel  : array<vec4<f32>, 64>;
@group(0) @binding(2) var ssao_noise_texture          : texture_2d<f32>;
@group(0) @binding(3) var ssao_noise_sampler          : sampler;
@group(0) @binding(4) var gbuffer_normal              : texture_2d<u32>;
@group(0) @binding(5) var hdr_depth                   : texture_depth_2d;
@group(0) @binding(6) var ssao_depth_sampler          : sampler;
@group(0) @binding(7) var ssaoRaw                     : texture_2d<f32>;
@group(0) @binding(8) var ssaoSampler                 : sampler;

fn ssaoNormal(uv : vec2<f32>) -> vec3<f32> {
  let size = vec2<i32>(textureDimensions(gbuffer_normal));
  let pixel = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - 1);
  return loadStandardNormalRoughness(gbuffer_normal, pixel).xyz;
}

fn ssaoDepth(uv: vec2<f32>) -> f32 {
  let size = vec2<i32>(textureDimensions(hdr_depth));
  let pixel = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - 1);
  return textureLoad(hdr_depth, pixel, 0);
}

// ── vertex: fullscreen triangle (SSOT in common.wgsl) ───────────────────────

struct SsaoVsOut {
  @builtin(position) position : vec4<f32>,
  @location(0) uv             : vec2<f32>,
};

@vertex
fn vs_ssao(@builtin(vertex_index) vertex_index : u32) -> SsaoVsOut {
  let ft = fullscreen_triangle(vertex_index);
  var out : SsaoVsOut;
  out.position = ft.position;
  out.uv = ft.uv;
  return out;
}

// GTAO: cosine-weighted slice integral (Jimenez et al., Algorithm 1).
// Three r184 radial search; projected-length/open-integral correction and
// orthographic rays retain the independently verified rendering-equation integral.
// Sources and deliberate differences: packages/render/README.md, GTAO references.
// The two horizons are angles measured from viewDir and may lie on one side of zero.
fn gtaoSliceIntegral(n: f32, hNegative: f32, hPositive: f32) -> f32 {
  let pi = 3.14159265359;
  let lower = min(hNegative, hPositive);
  let upper = max(hNegative, hPositive);
  let starts = array<f32, 4>(
    lower,
    max(lower, -pi),
    max(lower, 0.0),
    max(lower, pi),
  );
  let ends = array<f32, 4>(
    min(upper, -pi),
    min(upper, 0.0),
    min(upper, pi),
    upper,
  );
  var integral = 0.0;
  for (var segment = 0u; segment < 4u; segment += 1u) {
    let theta0 = starts[segment];
    let theta1 = ends[segment];
    if (theta0 < theta1) {
      let primitive0 = 0.5 * theta0 * sin(n) - 0.25 * cos(2.0 * theta0 - n);
      let primitive1 = 0.5 * theta1 * sin(n) - 0.25 * cos(2.0 * theta1 - n);
      let sinIsPositive = segment == 0u || segment == 2u;
      integral += select(-1.0, 1.0, sinIsPositive) * (primitive1 - primitive0);
    }
  }
  return integral;
}

fn aoViewPosition(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  let p = ssao_uniform.inverseProjection * vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), depth, 1.0);
  return p.xyz / p.w;
}

// Three r184's default 5x5 magic-square rotation, including RGBA8 quantization.
// Derive it without a second texture/upload owner; SSAO keeps its hemisphere noise.
fn gtaoRotation(pixel: vec2<i32>, height: i32) -> f32 {
  let square = array<u32, 25>(9u, 3u, 22u, 16u, 15u, 2u, 21u, 20u, 14u, 8u, 25u, 19u, 13u, 7u, 1u, 18u, 12u, 6u, 5u, 24u, 11u, 10u, 4u, 23u, 17u);
  let index = u32((height - 1 - pixel.y) % 5) * 5u + u32(pixel.x % 5);
  let angle = 6.28318530718 * f32(square[index]) / 25.0;
  let encoded = floor((vec2<f32>(cos(angle), sin(angle)) * 0.5 + 0.5) * 255.0);
  let tangent = encoded * (2.0 / 255.0) - 1.0;
  return atan2(tangent.y, tangent.x);
}

fn gtaoVisibility(uv: vec2<f32>) -> f32 {
  let dimensions = vec2<i32>(textureDimensions(hdr_depth));
  // Depth and reconstructed position must refer to the SAME full-res texel.
  // Half-res fragment UVs lie between texel centers, particularly at odd extents.
  let pixel = clamp(vec2<i32>(uv * vec2<f32>(dimensions)), vec2<i32>(0), dimensions - 1);
  let centerUv = (vec2<f32>(pixel) + 0.5) / vec2<f32>(dimensions);
  let depth = textureLoad(hdr_depth, pixel, 0);
  if (depth <= 0.0) { return 1.0; }
  let position = aoViewPosition(centerUv, depth);
  let normal = normalize((ssao_uniform.view * vec4<f32>(ssaoNormal(centerUv), 0.0)).xyz);
  // Orthographic view rays are parallel. normalize(-position) is wrong here.
  let perspective = abs(ssao_uniform.projection[3][3]) < 0.5;
  let viewDir = select(vec3<f32>(0.0, 0.0, 1.0), normalize(-position), perspective);
  let radius = ssao_uniform.intensityPad.y;
  let bias = ssao_uniform.intensityPad.z;
  let budget = u32(ssao_uniform.intensityPad.w);
  // Three r184 samples=16 is 3 slices * 6 steps * 2 sides, not 16 reads.
  let slices = select(3u, 5u, budget >= 30u);
  let steps = (budget + slices - 1u) / slices;
  let thickness = ssao_uniform.algorithmPad.y;
  let distanceExponent = ssao_uniform.algorithmPad.z;
  let distanceFallOff = ssao_uniform.algorithmPad.w;
  let rotation = gtaoRotation(pixel, dimensions.y);
  // Integrate blocked arcs: the unoccluded hemisphere is analytically 1.
  // Subtracting the same slice's open integral avoids finite-angle baseline
  // darkening on sloped surfaces, without changing the occluded arc equation.
  var occlusion = 0.0;
  let basisX = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), viewDir));
  let basisY = cross(viewDir, basisX);
  for (var slice = 0u; slice < slices; slice++) {
    let angle = f32(slice) * 3.14159265359 / f32(slices) + rotation;
    // Uniform azimuth about the view ray, not about screen Z. Project this
    // slice onto the constant-Z sampling plane for perspective-correct UVs.
    let tangent = basisX * cos(angle) + basisY * sin(angle);
    let axis = cross(tangent, viewDir);
    let direction = normalize(tangent - viewDir * (tangent.z / max(viewDir.z, 0.00001)));
    let projected = normal - axis * dot(normal, axis);
    let projectedLength = length(projected);
    if (projectedLength < 0.00001) { continue; }
    let n = atan2(dot(projected, tangent), dot(projected, viewDir));
    let low = vec2<f32>(cos(n + 1.57079632679), cos(n - 1.57079632679));
    var horizons = low;
    for (var step = 0u; step < steps; step++) {
      let t = pow(f32(step + 1u) / f32(steps), distanceExponent);
      for (var side = 0u; side < 2u; side++) {
        let sign = select(1.0, -1.0, side == 1u);
        let probe = position + sign * direction * radius * t;
        let clip = ssao_uniform.projection * vec4<f32>(probe, 1.0);
        if (clip.w <= 0.0) { continue; }
        let sampleUv = clip.xy / clip.w * vec2<f32>(0.5, -0.5) + 0.5;
        if (any(sampleUv < vec2<f32>(0.0)) || any(sampleUv >= vec2<f32>(1.0))) { continue; }
        let samplePixel = vec2<i32>(sampleUv * vec2<f32>(dimensions));
        if (all(samplePixel == pixel)) { continue; }
        let sampleDepth = textureLoad(hdr_depth, samplePixel, 0);
        if (sampleDepth <= 0.0) { continue; }
        let snappedUv = (vec2<f32>(samplePixel) + 0.5) / vec2<f32>(dimensions);
        let delta = aoViewPosition(snappedUv, sampleDepth) - position;
        let distance = length(delta);
        // Thickness rejects depth discontinuities independently of the optional
        // normal-plane bias. The search radius controls sample placement only.
        // X12/Y12 octahedral normals have a bounded angular uncertainty.
        // Quantization must not turn a coplanar sample into an occluder when
        // the authored bias is zero. sqrt(18)/(4095-sqrt(18)) bounds sin(error)
        // after decoding and normalization; this scales with sample distance.
        let normalUncertainty = distance * (4.242641 / (4095.0 - 4.242641));
        if (distance <= 0.00001 || dot(delta, normal) <= max(bias, normalUncertainty) || abs(delta.z) >= thickness) { continue; }
        let falloff = mix(1.0, 2.0 / f32(step + 2u), distanceFallOff);
        let cosine = dot(delta / distance, viewDir);
        horizons[side] += max(0.0, (cosine - horizons[side]) * falloff);
      }
    }
    let hNegative = n + clamp(-acos(clamp(horizons.y, -1.0, 1.0)) - n, -1.57079632679, 1.57079632679);
    let hPositive = n + clamp(acos(clamp(horizons.x, -1.0, 1.0)) - n, -1.57079632679, 1.57079632679);
    let openIntegral = gtaoSliceIntegral(n, n - 1.57079632679, n + 1.57079632679);
    occlusion += projectedLength * max(0.0, openIntegral - gtaoSliceIntegral(n, hNegative, hPositive));
  }
  return clamp(1.0 - occlusion / f32(slices), 0.0, 1.0);
}

// ── hemisphere SSAO: 64-sample kernel (LO 5.9) ──────────────────────────────

fn hemisphereVisibility(in : SsaoVsOut) -> f32 {
  // Reconstruct view-space position from depth + NDC.
  let depth = ssaoDepth(in.uv);
  // NDC reconstruction: screen-space xy in [-1,1], depth in [0,1].
  if (depth <= 0.0) { return 1.0; }
  let ndc = vec4<f32>(in.uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), depth, 1.0);
  // Transform NDC -> view via inverse projection.
  var viewPosH = ssao_uniform.inverseProjection * ndc;
  viewPosH = viewPosH / viewPosH.w;
  let viewPos = viewPosH.xyz;

  // Read and decode the packed world-space normal.
  let worldNormal = ssaoNormal(in.uv);

  // Rotate world normal to view-space.
  let viewNormal = normalize((ssao_uniform.view * vec4<f32>(worldNormal, 0.0)).xyz);

  // Read noise for per-pixel TBN rotation.
  // Actually: scale factor is screenDim / noiseDim. Use the selected AO target extent.
  // The noise texture is 4x4 and tiled via REPEAT sampling.
  let screenDim = vec2<f32>(textureDimensions(gbuffer_normal, 0));
  let noiseUV = in.uv * screenDim / 8.0;
  let randomVec = normalize(textureSampleLevel(ssao_noise_texture, ssao_noise_sampler, noiseUV, 0).xyz);

  // TBN: Gram-Schmidt orthonormalization (tangent-space -> view-space).
  let tangent = normalize(randomVec - viewNormal * dot(randomVec, viewNormal));
  let bitangent = cross(viewNormal, tangent);
  let TBN = mat3x3<f32>(tangent, bitangent, viewNormal);

  // SSAO parameters are install-time config values projected by the host.
  let radius = ssao_uniform.intensityPad.y;
  let bias = ssao_uniform.intensityPad.z;

  let sampleCount = u32(clamp(ssao_uniform.intensityPad.w, 16.0, 64.0));
  var occlusion = 0.0;
  for (var i = 0u; i < sampleCount; i = i + 1u) {
    // Tangent-space sample -> view-space via TBN.
    let sampleTangent = ssao_kernel[i * 64u / sampleCount].xyz;
    var sampleView = TBN * sampleTangent;
    sampleView = viewPos + sampleView * radius;

    // Project sample to screen.
    var offset = ssao_uniform.projection * vec4<f32>(sampleView, 1.0);
    if (offset.w <= 0.0) { continue; }
    offset = offset / offset.w;
    let sampleUv = offset.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
    if (any(sampleUv < vec2<f32>(0.0)) || any(sampleUv > vec2<f32>(1.0))) { continue; }

    // Sample depth at the projected screen location.
    let sampleDepth = ssaoDepth(sampleUv);
    // Reconstruct view-space z of the sampled fragment (at offset.xy).
    var sampledViewPosH = ssao_uniform.inverseProjection * vec4<f32>(offset.xy, sampleDepth, 1.0);
    sampledViewPosH = sampledViewPosH / sampledViewPosH.w;
    let sampledViewZ = sampledViewPosH.z;

    // Range check: smoothstep based on distance along view-z axis.
    let rangeCheck = smoothstep(0.0, 1.0, radius / max(abs(viewPos.z - sampledViewZ), 0.0001));
    let sampleContrib = select(0.0, 1.0, sampledViewZ >= sampleView.z + bias);
    occlusion += sampleContrib * rangeCheck;
  }

  occlusion = 1.0 - (occlusion / f32(sampleCount));
  return occlusion;
}

// The raw target carries the center world normal beside visibility, so the
// blur weights 25 taps from this AO texel instead of re-reading and
// decoding the full-res G-buffer per tap (the dominant filter cost).
fn encodeSsaoNormal(n : vec3<f32>) -> vec2<f32> {
  var oct = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) {
    oct = (1.0 - abs(oct.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), oct >= vec2<f32>(0.0));
  }
  return oct * 0.5 + 0.5;
}

fn decodeSsaoNormal(encoded : vec2<f32>) -> vec3<f32> {
  let oct = encoded * 2.0 - 1.0;
  var n = vec3<f32>(oct, 1.0 - abs(oct.x) - abs(oct.y));
  let fold = max(-n.z, 0.0);
  n = vec3<f32>(n.xy + select(vec2<f32>(fold), vec2<f32>(-fold), n.xy >= vec2<f32>(0.0)), n.z);
  return normalize(n);
}

// Shared raw GTAO adapter target. Both the fragment path and the selected
// compute entry call this exact function, including intensity and normal data.
fn gtaoRawVisibility(uv : vec2<f32>) -> vec4<f32> {
  var visibility = gtaoVisibility(uv);
  if (ssao_uniform.intensityPad.x == 0.0) { visibility = 1.0; }
  else { visibility = pow(visibility, ssao_uniform.intensityPad.x); }
  return vec4<f32>(visibility, encodeSsaoNormal(ssaoNormal(uv)), 1.0);
}

// ── fs_ssao_calc: raw visibility (r) + encoded world normal (gb) ────────────

@fragment
fn fs_ssao_calc(in : SsaoVsOut) -> @location(0) vec4<f32> {
  if (ssao_uniform.algorithmPad.x > 0.5) {
    return gtaoRawVisibility(in.uv);
  }
  var visibility = hemisphereVisibility(in);
  // Three's scale is applied to raw visibility, before spatial denoising.
  // Explicit zero strength is identity, including fully occluded samples.
  if (ssao_uniform.intensityPad.x == 0.0) { visibility = 1.0; }
  else { visibility = pow(visibility, ssao_uniform.intensityPad.x); }
  return vec4<f32>(visibility, encodeSsaoNormal(ssaoNormal(in.uv)), 1.0);
}

// Symmetric depth/normal-aware filter. Never spread a foreground contact
// shadow across a background edge or wrap the opposite screen border.
fn ssaoViewZ(uv: vec2<f32>, depth: f32) -> f32 {
  let p = ssao_uniform.inverseProjection * vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), depth, 1.0);
  return p.z / p.w;
}

@fragment
fn fs_ssao_blur(in: SsaoVsOut) -> @location(0) f32 {
  let depth = ssaoDepth(in.uv);
  if (depth <= 0.0) { return 1.0; }
  let z = ssaoViewZ(in.uv, depth);
  let normal = decodeSsaoNormal(textureSampleLevel(ssaoRaw, ssao_depth_sampler, in.uv, 0.0).gb);
  let texel = 1.0 / vec2<f32>(textureDimensions(ssaoRaw));
  var total = 0.0;
  var weight = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let uv = in.uv + vec2<f32>(f32(x), f32(y)) * texel;
      if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { continue; }
      let d = ssaoDepth(uv);
      if (d <= 0.0) { continue; }
      let raw = textureSampleLevel(ssaoRaw, ssao_depth_sampler, uv, 0.0);
      let n = decodeSsaoNormal(raw.gb);
      let dz = abs(ssaoViewZ(uv, d) - z);
      let w = exp(-f32(x*x + y*y) / 4.0) * exp(-dz / max(0.01, ssao_uniform.intensityPad.y * 0.1)) * pow(max(dot(n, normal), 0.0), 8.0);
      total += raw.r * w;
      weight += w;
    }
  }
  return total / max(weight, 0.00001);
}

// Pack four adjacent normalized AO values into the spare Cluster texture
// region on no-storage devices. The viewport restricts writes to that region;
// this pass never samples its Cluster destination.
@fragment
fn fs_ssao_cluster_pack(
  @builtin(position) position : vec4<f32>,
) -> @location(0) vec4<u32> {
  let origin = ssao_uniform.clusterPack.xy;
  let textureWidth = ssao_uniform.clusterPack.z;
  let packedWidth = ssao_uniform.clusterPack.w;
  let logicalSize = textureDimensions(ssaoRaw);
  let physicalPixel = vec2<u32>(u32(position.x), u32(position.y)) - origin;
  let packedIndex = physicalPixel.y * textureWidth + physicalPixel.x;
  let sourceRow = packedIndex / packedWidth;
  let sourceX = (packedIndex % packedWidth) * 4u;
  // Out-of-range lanes remain the neutral AO value and every packed texel is initialized.
  var result = vec4<u32>(0xffffffffu);
  for (var lane = 0u; lane < 4u; lane += 1u) {
    let x = sourceX + lane;
    if (x < logicalSize.x && sourceRow < logicalSize.y) {
      let ao = clamp(textureLoad(ssaoRaw, vec2<i32>(i32(x), i32(sourceRow)), 0).r, 0.0, 1.0);
      // The filter target is UNORM8. Recover its byte before integer expansion:
      // f32 texture decoders can differ by an ULP for the same normalized byte.
      let aoByte = u32(round(ao * 255.0));
      result[lane] = select(aoByte * 0x01010100u, 0xffffffffu, aoByte == 255u);
    }
  }
  return result;
}
