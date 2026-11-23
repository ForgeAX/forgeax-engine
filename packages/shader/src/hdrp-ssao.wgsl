// Screen-space AO: view-space hemisphere sampling and bilateral filtering.
// Estimator/filter entries consume current-frame depth with world normals, or
// reconstruct normals from depth for the depth-only and spiral paths.

#define_import_path forgeax_hdrp::ssao
#import forgeax_pbr::gbuffer::{loadStandardSceneNormal, loadStandardSceneSurfaceValid}

#import forgeax_view::common::{fullscreen_triangle, FullscreenOutput}

// ── SSAO uniform (3 mat4 + 3 vec4, padded to 256 B) ────────────────────────
//
// intensityPad carries the raw visibility exponent plus the calc radius/bias.
// Raw intensity is applied before the spatial filter, once.

struct SsaoUniform {
  view              : mat4x4<f32>,  // world -> view
  projection        : mat4x4<f32>,  // view -> clip
  inverseProjection : mat4x4<f32>,  // NDC -> view
  intensityPad      : vec4<f32>,    // intensity, radius, bias, sample budget
  algorithmPad      : vec4<f32>,    // algorithm, thickness, radial exponent, distance falloff
  reserved          : array<vec4<u32>, 2>,
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

fn ssaoSurfaceValid(uv : vec2<f32>) -> bool {
  let size = vec2<i32>(textureDimensions(gbuffer_normal));
  let pixel = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - 1);
  return loadStandardSceneSurfaceValid(gbuffer_normal, pixel);
}

fn ssaoNormal(uv : vec2<f32>) -> vec3<f32> {
  let size = vec2<i32>(textureDimensions(gbuffer_normal));
  let pixel = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - 1);
  if (!loadStandardSceneSurfaceValid(gbuffer_normal, pixel)) { return vec3<f32>(0.0); }
  return loadStandardSceneNormal(gbuffer_normal, pixel);
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
  let bounds = vec2<f32>(min(hNegative, hPositive), max(hNegative, hPositive));
  let sinN = sin(n);
  let cosN = cos(n);
  // The primitive of cos(theta-n)*sin(theta). Across -pi, 0 and pi,
  // |sin(theta)| only changes its sign; carry those boundary constants
  // analytically instead of integrating four separately indexed segments.
  let primitive = 0.5 * bounds * sinN - 0.25 * cos(2.0 * bounds - vec2<f32>(n));
  let signed = sign(bounds) * (primitive + vec2<f32>(0.25 * cosN));
  let cumulative = select(signed, vec2<f32>(pi * sinN) - signed, abs(bounds) > vec2<f32>(pi));
  return cumulative.y - cumulative.x;
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

// Depth and reconstructed position must refer to the SAME full-res texel.
// Half-res fragment UVs lie between texel centers, particularly at odd extents.
fn gtaoPixel(uv: vec2<f32>) -> vec2<i32> {
  let dimensions = vec2<i32>(textureDimensions(hdr_depth));
  return clamp(vec2<i32>(uv * vec2<f32>(dimensions)), vec2<i32>(0), dimensions - 1);
}

fn gtaoTexelUv(pixel: vec2<i32>) -> vec2<f32> {
  return (vec2<f32>(pixel) + 0.5) / vec2<f32>(textureDimensions(hdr_depth));
}

fn gtaoVisibility(uv: vec2<f32>) -> f32 {
  let pixel = gtaoPixel(uv);
  let depth = textureLoad(hdr_depth, pixel, 0);
  if (depth <= 0.0) { return 1.0; }
  let normal = normalize((ssao_uniform.view * vec4<f32>(ssaoNormal(gtaoTexelUv(pixel)), 0.0)).xyz);
  return gtaoVisibilityAt(pixel, depth, normal);
}

// One view-space position delta along a screen axis (UE ReconstructNormalFromDepthBuffer):
// take the neighbor whose depth step is smaller, so a silhouette never bends the
// plane. Sky or off-screen neighbors are never taken.
fn ssaoAxisDelta(pixel: vec2<i32>, axis: vec2<i32>, center: vec3<f32>, fallback: vec3<f32>) -> vec3<f32> {
  let dimensions = vec2<i32>(textureDimensions(hdr_depth));
  let minus = pixel - axis;
  let plus = pixel + axis;
  let minusDepth = select(0.0, textureLoad(hdr_depth, clamp(minus, vec2<i32>(0), dimensions - 1), 0), all(minus >= vec2<i32>(0)) && all(minus < dimensions));
  let plusDepth = select(0.0, textureLoad(hdr_depth, clamp(plus, vec2<i32>(0), dimensions - 1), 0), all(plus >= vec2<i32>(0)) && all(plus < dimensions));
  if (minusDepth <= 0.0 && plusDepth <= 0.0) { return fallback; }
  let toMinus = center - aoViewPosition(gtaoTexelUv(minus), max(minusDepth, 1e-30));
  let toPlus = aoViewPosition(gtaoTexelUv(plus), max(plusDepth, 1e-30)) - center;
  if (minusDepth <= 0.0) { return toPlus; }
  if (plusDepth <= 0.0) { return toMinus; }
  return select(toPlus, toMinus, abs(toMinus.z) < abs(toPlus.z));
}

// View-space normal from depth alone, for prepasses that write no normal target.
fn ssaoReconstructedViewNormal(pixel: vec2<i32>, depth: f32) -> vec3<f32> {
  let center = aoViewPosition(gtaoTexelUv(pixel), depth);
  let right = ssaoAxisDelta(pixel, vec2<i32>(1, 0), center, vec3<f32>(1.0, 0.0, 0.0));
  let down = ssaoAxisDelta(pixel, vec2<i32>(0, 1), center, vec3<f32>(0.0, -1.0, 0.0));
  // Screen y grows downward; cross(down, right) faces the camera (+z in view space).
  return normalize(cross(down, right));
}

fn gtaoVisibilityAt(pixel: vec2<i32>, depth: f32, normal: vec3<f32>) -> f32 {
  let dimensions = vec2<i32>(textureDimensions(hdr_depth));
  let position = aoViewPosition(gtaoTexelUv(pixel), depth);
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
    // A normal along the view ray gives sin(n) = -0; SwiftShader's atan2(-0, x > 0)
    // returns pi, which flips the slice. Fold it to +0 so n is 0 on every backend.
    let sinN = dot(projected, tangent);
    let n = atan2(select(sinN, 0.0, sinN == 0.0), dot(projected, viewDir));
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
  // Read and decode the packed world-space normal, then rotate it to view space.
  let viewNormal = normalize((ssao_uniform.view * vec4<f32>(ssaoNormal(in.uv), 0.0)).xyz);
  return hemisphereVisibilityAt(in, depth, viewNormal, vec2<f32>(textureDimensions(gbuffer_normal, 0)));
}

fn hemisphereVisibilityAt(in : SsaoVsOut, depth: f32, viewNormal: vec3<f32>, screenDim: vec2<f32>) -> f32 {
  let ndc = vec4<f32>(in.uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), depth, 1.0);
  // Transform NDC -> view via inverse projection.
  var viewPosH = ssao_uniform.inverseProjection * ndc;
  viewPosH = viewPosH / viewPosH.w;
  let viewPos = viewPosH.xyz;

  // Read noise for per-pixel TBN rotation.
  // Actually: scale factor is screenDim / noiseDim. Use the selected AO target extent.
  // The noise texture is 4x4 and tiled via REPEAT sampling.
  let noiseUV = in.uv * screenDim / 8.0;
  let randomVec = normalize(textureSampleLevel(ssao_noise_texture, ssao_noise_sampler, noiseUV, 0).xyz);

  // TBN: Gram-Schmidt orthonormalization (tangent-space -> view-space).
  let tangent = normalize(randomVec - viewNormal * dot(randomVec, viewNormal));
  let bitangent = cross(viewNormal, tangent);
  let TBN = mat3x3<f32>(tangent, bitangent, viewNormal);

  // SSAO parameters are install-time config values projected by the host.
  let radius = ssao_uniform.intensityPad.y;
  let bias = ssao_uniform.intensityPad.z;

  let sampleCount = u32(clamp(ssao_uniform.intensityPad.w, 1.0, 64.0));
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
  if (!ssaoSurfaceValid(uv)) { return vec4<f32>(1.0,0.0,0.0,1.0); }
  var visibility = gtaoVisibility(uv);
  if (ssao_uniform.intensityPad.x == 0.0) { visibility = 1.0; }
  else { visibility = pow(visibility, ssao_uniform.intensityPad.x); }
  return vec4<f32>(visibility, encodeSsaoNormal(ssaoNormal(uv)), 1.0);
}

// ── fs_ssao_calc: raw visibility (r) + encoded world normal (gb) ────────────

@fragment
fn fs_ssao_calc(in : SsaoVsOut) -> @location(0) vec4<f32> {
  if (!ssaoSurfaceValid(in.uv)) { return vec4<f32>(1.0,0.0,0.0,1.0); }
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

// ── depth-only prepass: normals reconstructed from depth ───────────────────
// Neither entry reads gbuffer_normal, so their layout omits binding 4.

fn ssaoIntensity(visibility: f32) -> f32 {
  // Explicit zero strength is identity, including fully occluded samples.
  if (ssao_uniform.intensityPad.x == 0.0) { return 1.0; }
  return pow(visibility, ssao_uniform.intensityPad.x);
}

// Like fs_ssao_calc, gb carries the world normal the visibility used.
@fragment
fn fs_ssao_calc_depth(in : SsaoVsOut) -> @location(0) vec4<f32> {
  let pixel = gtaoPixel(in.uv);
  let depth = textureLoad(hdr_depth, pixel, 0);
  if (depth <= 0.0) { return vec4<f32>(1.0, 0.5, 0.5, 1.0); }
  let normal = ssaoReconstructedViewNormal(pixel, depth);
  // The view rotation is orthonormal: its transpose maps view back to world.
  let view = ssao_uniform.view;
  let worldNormal = transpose(mat3x3<f32>(view[0].xyz, view[1].xyz, view[2].xyz)) * normal;
  var visibility: f32;
  if (ssao_uniform.algorithmPad.x > 0.5) {
    visibility = gtaoVisibilityAt(pixel, depth, normal);
  } else {
    let screenDim = vec2<f32>(textureDimensions(hdr_depth));
    visibility = hemisphereVisibilityAt(in, ssaoDepth(in.uv), normal, screenDim);
  }
  return vec4<f32>(ssaoIntensity(visibility), encodeSsaoNormal(worldNormal), 1.0);
}

// GTAO spatial filter (UE GTAOSpatialFilterCS, r.GTAO.FilterWidth=5): 5x5 taps
// weighted only by their distance to the center's depth plane. Reverse-Z device
// depth is affine in screen space, so the plane extrapolates exactly across flat
// surfaces and a foreground contact shadow never spreads onto a background edge.
// Taps outside the screen or on the sky are skipped instead of clamped.
fn ssaoBlurDepth(pixel: vec2<i32>, size: vec2<i32>) -> f32 {
  return ssaoDepth((vec2<f32>(pixel) + 0.5) / vec2<f32>(size));
}

// Per-texel depth slope along one axis, taken from the side whose linear
// extrapolation lands closer to the center (keeps the plane off silhouettes).
fn ssaoBlurSlope(pixel: vec2<i32>, axis: vec2<i32>, size: vec2<i32>, z: f32) -> f32 {
  let m2 = ssaoBlurDepth(pixel - 2 * axis, size);
  let m1 = ssaoBlurDepth(pixel - axis, size);
  let p1 = ssaoBlurDepth(pixel + axis, size);
  let p2 = ssaoBlurDepth(pixel + 2 * axis, size);
  return select(p2 - p1, m1 - m2, abs(2.0 * m1 - m2 - z) < abs(2.0 * p1 - p2 - z));
}

@fragment
fn fs_ssao_blur_depth(in: SsaoVsOut) -> @location(0) f32 {
  let size = vec2<i32>(textureDimensions(ssaoRaw));
  let pixel = clamp(vec2<i32>(in.position.xy), vec2<i32>(0), size - 1);
  let z = ssaoBlurDepth(pixel, size);
  if (z <= 0.0) { return 1.0; }
  let slope = vec2<f32>(
    ssaoBlurSlope(pixel, vec2<i32>(1, 0), size, z),
    ssaoBlurSlope(pixel, vec2<i32>(0, 1), size, z),
  );
  // UE scales device-depth error by 20000 at its 10 cm near plane; device depth
  // is ~near/distance, so the same view-space tolerance is 2000 / near (metres).
  let tolerance = 2000.0 / max(ssao_uniform.projection[3].z, 1e-4);
  var total = 0.0;
  var weight = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let tap = pixel + vec2<i32>(x, y);
      if (any(tap < vec2<i32>(0)) || any(tap >= size)) { continue; }
      let d = ssaoBlurDepth(tap, size);
      if (d <= 0.0) { continue; }
      let plane = z + slope.x * f32(x) + slope.y * f32(y);
      let w = 1.0 - saturate(abs(plane - d) * tolerance);
      total += textureLoad(ssaoRaw, tap, 0).r * w;
      weight += w;
    }
  }
  return total / max(weight, 0.00001);
}

// Symmetric depth/normal-aware filter. Never spread a foreground contact
// shadow across a background edge or wrap the opposite screen border.
fn ssaoViewZ(uv: vec2<f32>, depth: f32) -> f32 {
  let p = ssao_uniform.inverseProjection * vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), depth, 1.0);
  return p.z / p.w;
}

// Fixed 5x5 spatial weights, indexed by x*x+y*y. These are shader kernel
// coefficients, independent of content, resolution and authored AO settings.
const SSAO_SPATIAL_WEIGHTS = array<f32, 9>(
  1.0, 0.7788007831, 0.6065306597, 0.4723665527, 0.3678794412,
  0.2865047969, 0.2231301601, 0.1737739435, 0.1353352832,
);

@fragment
fn fs_ssao_blur(in: SsaoVsOut) -> @location(0) f32 {
  if (!ssaoSurfaceValid(in.uv)) { return 1.0; }
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
      let normalDot = max(dot(n, normal), 0.0);
      let normalSquared = normalDot * normalDot;
      let normalFourth = normalSquared * normalSquared;
      let normalEighth = normalFourth * normalFourth;
      let w = SSAO_SPATIAL_WEIGHTS[u32(x*x + y*y)] * exp(-dz / max(0.01, ssao_uniform.intensityPad.y * 0.1)) * normalEighth;
      total += raw.r * w;
      weight += w;
    }
  }
  return total / max(weight, 0.00001);
}

// Desktop Standard SSAO. Depth inputs use positive view distance in meters.
struct ScreenSsaoUniform {
  view: mat4x4f,
  projection: mat4x4f,
  inverseProjection: mat4x4f,
  shape: vec4f, // intensity, power, fade end, fade radius
  kernel: vec4f, // radius, world-space radius flag, normalized bias, quality permutation
  mip: vec4f, // blend, scale, setup similarity threshold, level
  phase: vec4f, // SSAO pattern phase and source-to-setup width ratio
};

@group(0) @binding(14) var<uniform> screenSsao: ScreenSsaoUniform;
@group(0) @binding(15) var ssaoSetup: texture_2d<f32>;
@group(0) @binding(16) var ssaoFurthestDepth: texture_2d<f32>;
@group(0) @binding(17) var ssaoCoarseSetup: texture_2d<f32>;
@group(0) @binding(18) var ssaoCoarseVisibility: texture_2d<f32>;

fn screenSsaoPosition(uv: vec2f, deviceDepth: f32) -> vec3f {
  let h = screenSsao.inverseProjection * vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), deviceDepth, 1.0);
  return h.xyz / h.w;
}

fn screenSsaoPositionAtDistance(uv: vec2f, distance: f32) -> vec3f {
  // The Standard lens has diagonal XY scale and can offset its projection
  // center for stereo and jitter. This avoids device-Z round trips in the taps.
  let projection = screenSsao.projection;
  let z = -distance;
  let clipW = projection[2].w * z + projection[3].w;
  let ndc = uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let xy = (ndc * clipW - projection[2].xy * z - projection[3].xy) /
    vec2f(projection[0].x, projection[1].y);
  return vec3f(xy, z);
}

fn screenSsaoSafeNormal(n: vec3f) -> vec3f {
  return select(vec3f(0.0, 0.0, 1.0), n * inverseSqrt(max(dot(n, n), 1e-12)), dot(n, n) > 1e-12);
}

fn screenSsaoDepthData(pixel: vec2i, depth: f32) -> vec4f {
  let size = vec2i(textureDimensions(hdr_depth));
  let uv = (vec2f(pixel) + 0.5) / vec2f(size);
  let center = screenSsaoPosition(uv, depth);
  let left = max(pixel - vec2i(1, 0), vec2i(0));
  let right = min(pixel + vec2i(1, 0), size - 1);
  let top = max(pixel - vec2i(0, 1), vec2i(0));
  let bottom = min(pixel + vec2i(0, 1), size - 1);
  let dx0 = center - screenSsaoPosition(
    (vec2f(left) + 0.5) / vec2f(size), textureLoad(hdr_depth, left, 0));
  let dx1 = screenSsaoPosition(
    (vec2f(right) + 0.5) / vec2f(size), textureLoad(hdr_depth, right, 0)) - center;
  let dy0 = center - screenSsaoPosition(
    (vec2f(top) + 0.5) / vec2f(size), textureLoad(hdr_depth, top, 0));
  let dy1 = screenSsaoPosition(
    (vec2f(bottom) + 0.5) / vec2f(size), textureLoad(hdr_depth, bottom, 0)) - center;
  let dx = select(dx1, dx0, (pixel.x > 0 && abs(dx0.z) <= abs(dx1.z)) || pixel.x == size.x - 1);
  let dy = select(dy1, dy0, (pixel.y > 0 && abs(dy0.z) <= abs(dy1.z)) || pixel.y == size.y - 1);
  return vec4f(screenSsaoSafeNormal(cross(dy, dx)), -center.z);
}

fn screenSsaoNormalData(pixel: vec2i) -> vec4f {
  let uv = (vec2f(pixel) + 0.5) / vec2f(textureDimensions(hdr_depth));
  let worldNormal = loadStandardSceneNormal(gbuffer_normal, pixel);
  let normal = screenSsaoSafeNormal((screenSsao.view * vec4f(worldNormal, 0.0)).xyz);
  let depth = textureLoad(hdr_depth, pixel, 0);
  return vec4f(normal, max(0.0, -screenSsaoPosition(uv, depth).z));
}

fn screenSsaoDownsample(taps: array<vec4f, 4>) -> vec4f {
  let z = max(max(taps[0].w, taps[1].w), max(taps[2].w, taps[3].w));
  // UE setup scales the inverse threshold by output width divided by scene width.
  let inverseThreshold = 100.0 * screenSsao.mip.z * screenSsao.phase.z;
  var weighted = vec3f(0.0001);
  var weight = 0.0001;
  for (var i = 0u; i < 4u; i++) {
    let similarity = clamp(1.0 - abs(taps[i].w - z) * inverseThreshold, 0.0, 1.0);
    weighted += (taps[i].xyz * 0.5 + 0.5) * similarity;
    weight += similarity;
  }
  return vec4f(weighted / weight * 2.0 - 1.0, z);
}

@fragment
fn fs_ssao_setup(in: SsaoVsOut) -> @location(0) vec4f {
  let maxPixel = vec2i(textureDimensions(hdr_depth)) - 1;
  let base = vec2i(in.position.xy) * 2;
  return screenSsaoDownsample(array(
    screenSsaoNormalData(min(base, maxPixel)),
    screenSsaoNormalData(min(base + vec2i(1, 0), maxPixel)),
    screenSsaoNormalData(min(base + vec2i(0, 1), maxPixel)),
    screenSsaoNormalData(min(base + vec2i(1, 1), maxPixel)),
  ));
}

@fragment
fn fs_ssao_setup_coarse(in: SsaoVsOut) -> @location(0) vec4f {
  let maxPixel = vec2i(textureDimensions(ssaoSetup)) - 1;
  let base = vec2i(in.position.xy) * 2;
  return screenSsaoDownsample(array(
    textureLoad(ssaoSetup, min(base, maxPixel), 0),
    textureLoad(ssaoSetup, min(base + vec2i(1, 0), maxPixel), 0),
    textureLoad(ssaoSetup, min(base + vec2i(0, 1), maxPixel), 0),
    textureLoad(ssaoSetup, min(base + vec2i(1, 1), maxPixel), 0),
  ));
}

fn screenSsaoPattern(position: vec2f) -> vec2f {
  // The 64x64 source RG8 texture repeats this 4x4 point-sampled pattern.
  let pattern = array<u32, 16>(
    0x80f0u, 0xdb43u, 0xe093u, 0xc1e1u,
    0xdd59u, 0xc5c5u, 0x9803u, 0xd926u,
    0xf0aeu, 0xf280u, 0x93e1u, 0xa81eu,
    0xba29u, 0xaff2u, 0xfa67u, 0xe3c2u,
  );
  let texel = vec2u(position + screenSsao.phase.xy) & vec2u(3u);
  let rg = pattern[texel.x + texel.y * 4u];
  return vec2f(f32(rg & 255u), f32(rg >> 8u)) * (2.0 / 255.0) - 1.0;
}

fn screenSsaoWedge(uv: vec2f, center: vec3f, weightedNormal: vec3f) -> f32 {
  let size = vec2i(textureDimensions(ssaoFurthestDepth));
  let pixel = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1);
  // The stock mip factor of 0.5 always selects the first reduced level.
  let distance = textureLoad(ssaoFurthestDepth, pixel, 0).r;
  if (distance <= 0.0) { return 0.0; }
  let delta = screenSsaoPositionAtDistance(uv, distance) - center;
  return clamp(dot(delta, weightedNormal) / max(dot(delta, delta), 1e-12), 0.0, 1.0);
}

fn screenSsaoVisibility(in: SsaoVsOut, surface: vec4f, coarse: bool) -> f32 {
  let depth = surface.w;
  if (depth <= 0.0 || depth >= screenSsao.shape.z) { return 1.0; }
  let normal = screenSsaoSafeNormal(surface.xyz);
  let level = screenSsao.mip.w;
  let center = screenSsaoPositionAtDistance(in.uv, depth) +
    screenSsao.kernel.z * depth * exp2(level) * normal;
  let centerClip = screenSsao.projection * vec4f(center, 1.0);
  let centerUv = centerClip.xy / centerClip.w * vec2f(0.5, -0.5) + 0.5;
  let worldSpace = screenSsao.kernel.y > 0.5;
  let radius = screenSsao.kernel.x * select(depth / 4.0, 1.0, worldSpace) *
    pow(screenSsao.mip.y, level) * 0.25;
  let projectionScale = vec2f(screenSsao.projection[0].x, -screenSsao.projection[1].y);
  let screenRadius = projectionScale * radius * (0.5 / centerClip.w);
  let noise = screenSsaoPattern(in.position.xy);
  let weightedNormal = normal * (0.08 * select(depth, 10.0, worldSpace));
  let smallDisk = array<vec2f, 3>(vec2f(0.0, -0.43), vec2f(0.406, 0.5698), vec2f(-0.58, 0.814));
  let largeDisk = array<vec2f, 6>(
    vec2f(0.0, 0.2), vec2f(0.325, 0.101), vec2f(0.272, -0.396),
    vec2f(-0.385, -0.488), vec2f(-0.711, 0.274), vec2f(0.06, 0.9));
  let quality = u32(screenSsao.kernel.w);
  let large = coarse || quality == 4u;
  let steps = max(1u, min(quality, 3u));
  let directions = select(3u, 6u, large);
  var visibility = 0.0001;
  for (var axis = 0u; axis < directions; axis++) {
    var disk = largeDisk[axis];
    if (!large) { disk = smallDisk[axis]; }
    let direction = (disk.x * noise + disk.y * vec2f(-noise.y, noise.x)) * screenRadius;
    var peak = vec2f(0.0);
    for (var step = 1u; step <= steps; step++) {
      let offset = direction * (f32(step) / f32(steps));
      peak = max(peak, vec2f(screenSsaoWedge(centerUv + offset, center, weightedNormal),
                            screenSsaoWedge(centerUv - offset, center, weightedNormal)));
    }
    let open = 1.0 - peak;
    visibility += dot(open, open);
  }
  return visibility / (f32(directions * 2u) + 0.0001);
}

fn screenSsaoCombine(in: SsaoVsOut, surface: vec4f, fine: f32, coarse: bool) -> f32 {
  let size = vec2i(textureDimensions(ssaoCoarseVisibility));
  let texel = in.uv * vec2f(size);
  let centerNormal = screenSsaoSafeNormal(surface.xyz);
  var sum = 0.0001;
  var weight = 0.0001;
  let taps = select(4, 9, coarse);
  for (var i = 0; i < taps; i++) {
    let offset = select(vec2f(vec2i(i & 1, i >> 1)) - 0.5,
                        vec2f(vec2i(i % 3, i / 3)) - 1.0, coarse);
    let pixel = clamp(vec2i(floor(texel + offset)), vec2i(0), size - 1);
    let tap = textureLoad(ssaoCoarseSetup, pixel, 0);
    let similar = clamp(1.0 - abs(tap.w - surface.w) * 0.3, 0.0, 1.0);
    let w = similar * clamp(dot(centerNormal, tap.xyz), 0.0, 1.0);
    sum += textureLoad(ssaoCoarseVisibility, pixel, 0).r * w;
    weight += w;
  }
  return mix(fine, sum / weight, screenSsao.mip.x);
}

fn screenSsaoQuad(in: SsaoVsOut, normal: vec3f, visibility: f32) -> f32 {
  let center = vec4f(normal, visibility);
  let parity = vec2f(vec2u(in.position.xy) & vec2u(1u)) * 2.0 - 1.0;
  let horizontal = center - dpdxFine(center) * parity.x;
  let vertical = center - dpdyFine(center) * parity.y;
  let alignment = clamp(vec2f(dot(normal, horizontal.xyz), dot(normal, vertical.xyz)), vec2f(0.0), vec2f(1.0));
  let squared = alignment * alignment;
  let weight = squared * squared;
  let filtered = (visibility + dot(vec2f(horizontal.w, vertical.w), weight)) / (1.0 + weight.x + weight.y);
  let quality = u32(screenSsao.kernel.w);
  return select(visibility, filtered, quality == 1u || quality == 2u);
}

fn screenSsaoFinish(in: SsaoVsOut, surface: vec4f, visibility: f32, valid: bool) -> f32 {
  let fade = clamp(1.0 - (screenSsao.shape.z - surface.w) / screenSsao.shape.w, 0.0, 1.0);
  let faded = mix(visibility, 1.0, fade);
  let shaped = 1.0 - (1.0 - pow(abs(faded), screenSsao.shape.y)) * screenSsao.shape.x;
  let normal = select(vec3f(0.0), screenSsaoSafeNormal(surface.xyz), valid);
  let filtered = screenSsaoQuad(in, normal, select(1.0, shaped, valid));
  return select(1.0, filtered, valid && surface.w < screenSsao.shape.z);
}

@fragment
fn fs_ssao_full_depth(in: SsaoVsOut) -> @location(0) f32 {
  let pixel = vec2i(in.position.xy);
  let depth = textureLoad(hdr_depth, pixel, 0);
  let surface = screenSsaoDepthData(pixel, depth);
  return screenSsaoFinish(in, surface, screenSsaoVisibility(in, surface, false), depth > 0.0);
}

@fragment
fn fs_ssao_full_normal(in: SsaoVsOut) -> @location(0) f32 {
  let pixel = vec2i(in.position.xy);
  let surface = screenSsaoNormalData(pixel);
  let visibility = screenSsaoVisibility(in, surface, false);
  return screenSsaoFinish(in, surface, visibility, loadStandardSceneSurfaceValid(gbuffer_normal, pixel));
}

@fragment
fn fs_ssao_full_normal_upsample(in: SsaoVsOut) -> @location(0) f32 {
  let pixel = vec2i(in.position.xy);
  let surface = screenSsaoNormalData(pixel);
  let visibility = screenSsaoCombine(in, surface, screenSsaoVisibility(in, surface, false), false);
  return screenSsaoFinish(in, surface, visibility, loadStandardSceneSurfaceValid(gbuffer_normal, pixel));
}

@fragment
fn fs_ssao_coarse(in: SsaoVsOut) -> @location(0) f32 {
  let surface = textureLoad(ssaoSetup, vec2i(in.position.xy), 0);
  return screenSsaoQuad(in, screenSsaoSafeNormal(surface.xyz), screenSsaoVisibility(in, surface, true));
}

@fragment
fn fs_ssao_coarse_upsample(in: SsaoVsOut) -> @location(0) f32 {
  let surface = textureLoad(ssaoSetup, vec2i(in.position.xy), 0);
  let visibility = screenSsaoCombine(in, surface, screenSsaoVisibility(in, surface, true), true);
  return screenSsaoQuad(in, screenSsaoSafeNormal(surface.xyz), visibility);
}

// GTAO uses the same scene depth and representative far-depth bounds as SSAO.
// The raw and spatial images intentionally differ: distance fade precedes the
// spatial normalization and visibility shaping, as in the desktop renderer.
@group(0) @binding(19) var gtaoPrevious: texture_2d<f32>;
@group(0) @binding(20) var gtaoVelocity: texture_2d<u32>;
@group(0) @binding(21) var gtaoSceneData: texture_2d<f32>;

fn screenAoPixel(uv: vec2f, size: vec2u) -> vec2i {
  return clamp(vec2i(uv * vec2f(size)), vec2i(0), vec2i(size) - 1);
}

fn screenGtaoHorizon(uv: vec2f, center: vec3f, viewRay: vec3f, horizon: f32, lod: u32) -> f32 {
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return horizon; }
  let mip = min(lod, textureNumLevels(ssaoFurthestDepth) - 1u);
  let size = max(textureDimensions(ssaoFurthestDepth, 0) >> vec2u(mip), vec2u(1u));
  let px = screenAoPixel(uv, size);
  let distance = textureLoad(ssaoFurthestDepth, px, i32(mip)).r;
  if (distance <= 0.0) { return horizon; }
  let delta = screenSsaoPositionAtDistance(uv, distance) - center;
  let lengthSquared = dot(delta, delta);
  let radius = screenSsao.kernel.x;
  let falloff = min(1.0, 2.0 * lengthSquared / (radius * radius));
  let candidate = dot(delta, viewRay) * inverseSqrt(lengthSquared + 1e-8);
  let limited = mix(candidate, horizon, falloff);
  return select(mix(limited, horizon, screenSsao.kernel.y), limited, limited > horizon);
}

fn screenGtaoSliceOcclusion(horizons: vec2f, direction: vec2f, viewRay: vec3f, normal: vec3f) -> f32 {
  let halfPi = 1.57079632679;
  let axis = normalize(cross(vec3f(direction, 0.0), viewRay));
  let tangent = cross(viewRay, axis);
  let projected = normal - axis * dot(normal, axis);
  let normalLength = length(projected) + 1e-6;
  let normalTangent = clamp(dot(projected, tangent) / normalLength, -1.0, 1.0);
  let gamma = acos(normalTangent) - halfPi;
  let horizonAngles = acos(clamp(horizons, vec2f(-1.0), vec2f(1.0)));
  let angle = vec2f(
    max(-horizonAngles.x, gamma - halfPi),
    min( horizonAngles.y, gamma + halfPi),
  );
  let cosGamma = dot(projected, viewRay) / normalLength;
  let primitive = angle * (-2.0 * normalTangent) + cosGamma - cos(2.0 * angle - gamma);
  let visible = normalLength * 0.25 * (primitive.x + primitive.y);
  // With a finite set of screen-space directions, the open slice integral
  // depends on the view ray and the projected normal. Subtract the integral
  // with both horizons open before averaging to isolate actual occlusion.
  let open = normalLength * (0.5 * (cosGamma + cos(gamma)) - gamma * normalTangent);
  return max(open - visible, 0.0);
}

fn screenGtaoRaw(in: SsaoVsOut, uv: vec2f, surface: vec4f, sceneSize: vec2u) -> f32 {
  if (surface.w <= 0.0 || surface.w >= screenSsao.shape.z) { return 1.0; }
  let pi = 3.14159265359;
  let center = screenSsaoPositionAtDistance(uv, surface.w);
  let perspective = abs(screenSsao.projection[2].w) > 0.5;
  let viewRay = select(vec3f(0.0, 0.0, 1.0), normalize(-center), perspective);
  let falloffRadius = screenSsao.kernel.x;
  let steps = u32(screenSsao.kernel.z);
  let baseMip = u32(screenSsao.kernel.w);
  let fovScale = abs(screenSsao.projection[0].x) * f32(sceneSize.y);
  let pixelRadius = clamp(falloffRadius * fovScale / select(1.0, surface.w, perspective), f32(steps), 256.0);
  let stepRadius = pixelRadius / f32(steps + 1u);
  let pixel = vec2i(in.position.xy);
  let noise = fract(52.9829189 * fract(dot(vec2f(pixel), vec2f(0.06711056, 0.00583715))));
  let startAngle = noise * pi + screenSsao.phase.x;
  var startOffset = fract(f32((pixel.y - pixel.x) & 3) * 0.25 + screenSsao.phase.y);
  let angles = u32(screenSsao.phase.z);
  var occlusion = 0.0;
  for (var slice = 0u; slice < angles; slice++) {
    let angle = startAngle + f32(slice) * pi / f32(angles);
    let direction = vec2f(cos(angle), sin(angle));
    var horizon = vec2f(-1.0);
    for (var i = 1u; i <= steps; i++) {
      let lod = baseMip + select(0u, 1u, i == 2u) + select(0u, 2u, i >= 4u);
      let step = max(stepRadius * (f32(i) + startOffset), f32(i + 1u));
      let delta = direction * vec2f(step, -step) / vec2f(sceneSize);
      horizon = vec2f(
        screenGtaoHorizon(uv + delta, center, viewRay, horizon.x, lod),
        screenGtaoHorizon(uv - delta, center, viewRay, horizon.y, lod),
      );
    }
    occlusion += screenGtaoSliceOcclusion(horizon, direction, viewRay, surface.xyz);
    startOffset = fract(startOffset + 0.617);
  }
  let fade = clamp(1.0 - (screenSsao.shape.z - surface.w) / screenSsao.shape.w, 0.0, 1.0);
  let visibility = 1.0 - clamp(occlusion / f32(angles), 0.0, 1.0);
  // The spatial pass consumes the integral convention and restores pi/2.
  // The bypass instead publishes visibility directly to temporal/resolve.
  let raw = select(visibility, visibility * (2.0 / pi), screenSsao.mip.x > 0.5);
  return mix(raw, 1.0, fade);
}

fn screenGtaoDepth(in: SsaoVsOut) -> f32 {
  let sceneSize = textureDimensions(hdr_depth);
  let uv = in.uv + 0.125 / vec2f(sceneSize);
  let pixel = screenAoPixel(uv, sceneSize);
  let depth = textureLoad(hdr_depth, pixel, 0);
  if (depth <= 0.0) { return 1.0; }
  return screenGtaoRaw(in, uv, screenSsaoDepthData(pixel, depth), sceneSize);
}

fn screenGtaoNormal(in: SsaoVsOut) -> f32 {
  let sceneSize = textureDimensions(hdr_depth);
  let uv = in.uv + 0.125 / vec2f(sceneSize);
  let pixel = screenAoPixel(uv, sceneSize);
  if (!loadStandardSceneSurfaceValid(gbuffer_normal, pixel)) { return 1.0; }
  return screenGtaoRaw(in, uv, screenSsaoNormalData(pixel), sceneSize);
}

fn screenGtaoDepthAt(pixel: vec2i, aoSize: vec2i) -> f32 {
  let point = (vec2f(clamp(pixel, vec2i(0), aoSize - 1)) + 0.5) / vec2f(aoSize);
  return textureLoad(hdr_depth, screenAoPixel(point, textureDimensions(hdr_depth)), 0);
}

@fragment
fn fs_gtao_spatial(in: SsaoVsOut) -> @location(0) f32 {
  let size = vec2i(textureDimensions(ssaoCoarseVisibility));
  let center = vec2i(in.position.xy);
  let z = screenGtaoDepthAt(center, size);
  if (z <= 0.0 || -screenSsaoPosition(in.uv, z).z >= screenSsao.shape.z) { return 1.0; }
  let left = screenGtaoDepthAt(center - vec2i(1, 0), size);
  let right = screenGtaoDepthAt(center + vec2i(1, 0), size);
  let top = screenGtaoDepthAt(center - vec2i(0, 1), size);
  let bottom = screenGtaoDepthAt(center + vec2i(0, 1), size);
  let dx0 = left - screenGtaoDepthAt(center - vec2i(2, 0), size);
  let dx1 = screenGtaoDepthAt(center + vec2i(2, 0), size) - right;
  let dy0 = top - screenGtaoDepthAt(center - vec2i(0, 2), size);
  let dy1 = screenGtaoDepthAt(center + vec2i(0, 2), size) - bottom;
  let slope = vec2f(
    select(dx1, dx0, abs(left + dx0 - z) < abs(right - dx1 - z)),
    select(dy1, dy0, abs(top + dy0 - z) < abs(bottom - dy1 - z)),
  );
  let width = i32(screenSsao.phase.w);
  var sum = 0.0;
  var weight = 0.0;
  let first = select(-1, -2, width == 5);
  for (var y = first; y < width + first; y++) {
    for (var x = first; x < width + first; x++) {
      let offset = vec2i(x, y);
      let pos = clamp(center + offset, vec2i(0), size - 1);
      let predicted = z + dot(vec2f(pos - center), slope);
      let tapDepth = screenGtaoDepthAt(pos, size);
      let w = select(0.0, clamp(1.0 - abs(tapDepth - predicted) * 20000.0, 0.0, 1.0), tapDepth > 0.0);
      sum += textureLoad(ssaoCoarseVisibility, pos, 0).r * w;
      weight += w;
    }
  }
  let raw = clamp(sum / max(weight, 1e-6) * 1.57079632679, 0.0, 1.0);
  return 1.0 - (1.0 - pow(raw, screenSsao.shape.y * 0.5)) * screenSsao.shape.x;
}

fn screenAoBilinear(tex: texture_2d<f32>, uv: vec2f, limits: vec2f) -> f32 {
  let size = vec2i(textureDimensions(tex));
  let coord = uv * vec2f(size) - 0.5;
  let p = vec2i(floor(coord));
  let f = fract(coord);
  let a = clamp(textureLoad(tex, clamp(p, vec2i(0), size - 1), 0).r, limits.x, limits.y);
  let b = clamp(textureLoad(tex, clamp(p + vec2i(1, 0), vec2i(0), size - 1), 0).r, limits.x, limits.y);
  let c = clamp(textureLoad(tex, clamp(p + vec2i(0, 1), vec2i(0), size - 1), 0).r, limits.x, limits.y);
  let d = clamp(textureLoad(tex, clamp(p + vec2i(1, 1), vec2i(0), size - 1), 0).r, limits.x, limits.y);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

fn screenGtaoCameraMotion(uv: vec2f) -> vec3f {
  let pixel = screenAoPixel(uv, textureDimensions(hdr_depth));
  let deviceDepth = textureLoad(hdr_depth, pixel, 0);
  let current = screenSsaoPosition(uv, deviceDepth);
  let clip = screenSsao.view * vec4f(current, 1.0);
  let previousUv = clip.xy / max(clip.w, 1e-8) * vec2f(0.5, -0.5) + 0.5;
  return vec3f(uv - previousUv, select(0.0, 1.0, deviceDepth > 0.0 && clip.w > 0.0));
}

fn screenGtaoTemporal(in: SsaoVsOut, motion: vec3f, previousMotion: vec2f) -> f32 {
  let current = textureLoad(ssaoCoarseVisibility, vec2i(in.position.xy), 0).r;
  let previousUv = in.uv - motion.xy;
  if (screenSsao.phase.x < 0.5 || motion.z <= 0.0 ||
      any(previousUv < vec2f(0.0)) || any(previousUv >= vec2f(1.0))) { return current; }
  let window = 0.1 * (1.0 - clamp(length(motion.xy) * 100.0, 0.0, 1.0));
  let bounds = clamp(vec2f(current - window, current + window), vec2f(0.0), vec2f(1.0));
  let reprojected = screenAoBilinear(gtaoPrevious, previousUv, bounds);
  let stationary = screenAoBilinear(gtaoPrevious, in.uv, bounds);
  let mismatch = abs((motion.x - previousMotion.x) + (motion.y - previousMotion.y));
  let previous = mix(reprojected, stationary, clamp(mismatch * 100.0, 0.0, 1.0));
  return mix(previous, current, screenSsao.phase.y);
}

@fragment
fn fs_gtao_temporal(in: SsaoVsOut) -> @location(0) f32 {
  let motion = screenGtaoCameraMotion(in.uv);
  return screenGtaoTemporal(in, motion, screenGtaoCameraMotion(in.uv - motion.xy).xy);
}

fn screenGtaoPackedMotion(uv: vec2f) -> vec3f {
  let camera = screenGtaoCameraMotion(uv);
  let word = textureLoad(gtaoVelocity, screenAoPixel(uv, textureDimensions(gtaoVelocity)), 0).r;
  if ((word & 65535u) == 0u) { return camera; }
  let packed = vec2f(f32(word & 65535u), f32(word >> 16u));
  let curved = ((packed - 32767.0) / 65535.0) / 0.2495;
  return vec3f(curved * abs(curved) * vec2f(0.25, -0.25) + screenSsao.phase.zw, 1.0);
}

@fragment
fn fs_gtao_temporal_velocity(in: SsaoVsOut) -> @location(0) f32 {
  let motion = screenGtaoPackedMotion(in.uv);
  return screenGtaoTemporal(in, motion, screenGtaoPackedMotion(in.uv - motion.xy).xy);
}

fn screenGtaoSceneDataMotion(uv: vec2f) -> vec3f {
  let camera = screenGtaoCameraMotion(uv);
  let sampled = textureLoad(gtaoSceneData, screenAoPixel(uv, textureDimensions(gtaoSceneData)), 0);
  if (sampled.w >= 2.0 || sampled.z <= 0.0) { return camera; }
  return vec3f(sampled.xy + screenSsao.phase.zw, 1.0);
}

@fragment
fn fs_gtao_temporal_scene_data(in: SsaoVsOut) -> @location(0) f32 {
  let motion = screenGtaoSceneDataMotion(in.uv);
  return screenGtaoTemporal(in, motion, screenGtaoSceneDataMotion(in.uv - motion.xy).xy);
}

@fragment
fn fs_gtao_resolve(in: SsaoVsOut) -> @location(0) f32 {
  let offset = 0.25 / vec2f(textureDimensions(ssaoCoarseVisibility));
  let fullRange = vec2f(0.0, 1.0);
  return min(
    min(screenAoBilinear(ssaoCoarseVisibility, in.uv - offset, fullRange),
        screenAoBilinear(ssaoCoarseVisibility, in.uv + offset, fullRange)),
    min(screenAoBilinear(ssaoCoarseVisibility, in.uv + vec2f(-offset.x, offset.y), fullRange),
        screenAoBilinear(ssaoCoarseVisibility, in.uv + vec2f(offset.x, -offset.y), fullRange)),
  );
}

@fragment
fn fs_gtao_depth(in: SsaoVsOut) -> @location(0) f32 {
  return screenGtaoDepth(in);
}

@compute @workgroup_size(8, 8)
fn cs_gtao_depth(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(gtaoRawOutput);
  if (any(id.xy >= size)) { return; }
  let position = vec2f(id.xy) + 0.5;
  let value = screenGtaoDepth(SsaoVsOut(vec4f(position, 0.0, 1.0), position / vec2f(size)));
  textureStore(gtaoRawOutput, vec2i(id.xy), vec4f(value, 0.0, 0.0, 1.0));
}

@fragment
fn fs_gtao_normal(in: SsaoVsOut) -> @location(0) f32 {
  return screenGtaoNormal(in);
}

@compute @workgroup_size(8, 8)
fn cs_gtao_normal(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(gtaoRawOutput);
  if (any(id.xy >= size)) { return; }
  let position = vec2f(id.xy) + 0.5;
  let value = screenGtaoNormal(SsaoVsOut(vec4f(position, 0.0, 1.0), position / vec2f(size)));
  textureStore(gtaoRawOutput, vec2i(id.xy), vec4f(value, 0.0, 0.0, 1.0));
}

@group(0) @binding(22) var gtaoRawOutput: texture_storage_2d<rgba8unorm, write>;
