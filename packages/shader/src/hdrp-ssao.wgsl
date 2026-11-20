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
// clusterPack is used only by the no-storage integer-texture AO packer.

struct SsaoUniform {
  view              : mat4x4<f32>,  // world -> view
  projection        : mat4x4<f32>,  // view -> clip
  inverseProjection : mat4x4<f32>,  // NDC -> view
  intensityPad      : vec4<f32>,    // intensity, radius, bias, sample budget
  algorithmPad      : vec4<f32>,    // algorithm, thickness, radial exponent, distance falloff
  clusterPack       : vec4<u32>,   // physical base origin, Cluster width, packed AO row width
  viewportPad       : vec4<f32>,  // resolution scale, scene strength, manual exposure, auto fallback
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

// Spiral SSAO uses the original game's depth-only estimator and two seven-tap
// bilateral filters. It shares the AO owner and 256-byte uniform, not a PBR variant.
@group(0) @binding(12) var ssaoLinearDepth: texture_2d<f32>;
@group(0) @binding(13) var ssaoMsaaDepth: texture_depth_multisampled_2d;

fn spiralAoSize() -> vec2<i32> {
  return vec2<i32>(textureDimensions(ssaoLinearDepth));
}

fn spiralSnappedUv(uv: vec2<f32>, sourceSize: vec2<u32>) -> vec2<f32> {
  let size = max(vec2<i32>(1), vec2<i32>(floor(vec2<f32>(sourceSize) * ssao_uniform.viewportPad.x + 0.5)));
  let pixel = clamp(vec2<i32>(floor(uv * vec2<f32>(size))), vec2<i32>(0), size - 1);
  return (vec2<f32>(pixel) + 0.5) / vec2<f32>(size);
}

fn spiralLinearDistance(uv: vec2<f32>, depth: f32) -> f32 {
  if (depth <= 0.0) { return 300.1; }
  return min(-ssaoViewZ(uv, depth), 300.1);
}

fn spiralDeviceDepth(uv: vec2<f32>) -> f32 {
  let snapped = spiralSnappedUv(uv, textureDimensions(hdr_depth));
  return spiralLinearDistance(snapped, ssaoDepth(snapped));
}

// Read the same nearest-covered Reverse-Z sample as the standalone resolver.
// The half-depth producer and full-resolution composite need no intermediate image.
fn ssaoNearestMsaaDepth(uv: vec2<f32>) -> f32 {
  let size = vec2<i32>(textureDimensions(ssaoMsaaDepth));
  let pixel = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - 1);
  var nearest = 0.0;
  for (var sample = 0u; sample < textureNumSamples(ssaoMsaaDepth); sample++) {
    nearest = max(nearest, textureLoad(ssaoMsaaDepth, pixel, i32(sample)));
  }
  return nearest;
}

@fragment
fn fs_ssao_linear_depth(in: SsaoVsOut) -> @location(0) f32 {
  return spiralDeviceDepth(in.uv);
}

@fragment
fn fs_ssao_linear_depth_msaa(in: SsaoVsOut) -> @location(0) f32 {
  let uv = spiralSnappedUv(in.uv, textureDimensions(ssaoMsaaDepth));
  return spiralLinearDistance(uv, ssaoNearestMsaaDepth(uv));
}

fn spiralDepth(uv: vec2<f32>) -> f32 {
  let size = spiralAoSize();
  let pixel = clamp(vec2<i32>(floor(uv * vec2<f32>(size))), vec2<i32>(0), size - 1);
  return textureLoad(ssaoLinearDepth, pixel, 0).r;
}

fn spiralPosition(uv: vec2<f32>, distance: f32) -> vec3<f32> {
  // Solve homogeneous view Z directly: one inverse-projection product supports
  // perspective, orthographic and jittered lenses without two ray endpoints.
  let base = ssao_uniform.inverseProjection * vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
  let axis = ssao_uniform.inverseProjection[2];
  let deviceDepth = (-distance * base.w - base.z) / (axis.z + distance * axis.w);
  let point = base + axis * deviceDepth;
  return point.xyz / point.w;
}

@fragment
fn fs_ssao_spiral(in: SsaoVsOut) -> @location(0) f32 {
  let z = spiralDepth(in.uv);
  if (z > 140.0 || z < 0.0 || ssao_uniform.intensityPad.x == 0.0) { return 1.0; }
  let position = spiralPosition(in.uv, z);
  let texel = 1.0 / vec2<f32>(spiralAoSize());
  let ox = vec2<f32>(texel.x, 0.0);
  let oy = vec2<f32>(0.0, texel.y);
  let zl = spiralDepth(in.uv - ox);
  let zr = spiralDepth(in.uv + ox);
  let zu = spiralDepth(in.uv - oy);
  let zd = spiralDepth(in.uv + oy);
  let dx = select(spiralPosition(in.uv + ox, zr) - position, position - spiralPosition(in.uv - ox, zl), abs(zl - z) < abs(zr - z));
  let dy = select(spiralPosition(in.uv + oy, zd) - position, position - spiralPosition(in.uv - oy, zu), abs(zu - z) < abs(zd - z));
  let normal = normalize(cross(dy, dx));
  let radius = ssao_uniform.intensityPad.y * (0.6 + 0.4 * clamp(z / 12.0, 0.0, 1.0));
  let radius2 = radius * radius;
  let perspective = abs(ssao_uniform.projection[3][3]) < 0.5;
  let projectedRadius = radius * abs(ssao_uniform.projection[1][1]) * 0.5 / select(1.0, z, perspective);
  let radiusUv = clamp(projectedRadius, 3.0 * texel.y, 0.14);
  let aspect = abs(ssao_uniform.projection[1][1] / ssao_uniform.projection[0][0]);
  let rotation = fract(52.9829189 * fract(dot(in.position.xy, vec2<f32>(0.06711056, 0.00583715)))) * 6.2831853;
  let count = u32(ssao_uniform.intensityPad.w);
  var sum = 0.0;
  for (var i = 0u; i < count; i++) {
    let a = (f32(i) + 0.5) / f32(count);
    let angle = a * 18.8495559 + rotation;
    let uv = in.uv + vec2<f32>(cos(angle) / aspect, sin(angle)) * a * radiusUv;
    let delta = spiralPosition(uv, spiralDepth(uv)) - position;
    let distance2 = dot(delta, delta);
    let falloff = max(radius2 - distance2, 0.0);
    sum += falloff * falloff * falloff * max((dot(delta, normal) - (0.015 + 0.004 * z + ssao_uniform.intensityPad.z)) / (distance2 + 0.004), 0.0);
  }
  let visibility = max(0.0, 1.0 - ssao_uniform.intensityPad.x * sum * 5.0 / (radius2 * radius2 * radius2 * f32(count)));
  return mix(visibility, 1.0, smoothstep(70.0, 140.0, z));
}

fn spiralBilateral(uv: vec2<f32>, axis: vec2<f32>) -> f32 {
  let direction = axis / vec2<f32>(textureDimensions(ssaoRaw));
  let z = min(spiralDepth(uv), 300.0);
  var total = 0.0;
  var weight = 0.0;
  for (var i = -3; i <= 3; i++) {
    let tap = uv + direction * f32(i);
    let tapZ = min(spiralDepth(tap), 300.0);
    let w = (1.0 - abs(f32(i)) * 0.22) * max(0.0, 1.0 - abs(tapZ - z) / (0.04 * z + 0.02));
    total += textureSampleLevel(ssaoRaw, ssao_depth_sampler, tap, 0.0).r * w;
    weight += w;
  }
  return total / max(weight, 1e-4);
}

@fragment
fn fs_ssao_spiral_blur_x(in: SsaoVsOut) -> @location(0) f32 {
  return spiralBilateral(in.uv, vec2<f32>(1.0, 0.0));
}

@fragment
fn fs_ssao_spiral_blur_y(in: SsaoVsOut) -> @location(0) f32 {
  return spiralBilateral(in.uv, vec2<f32>(0.0, 1.0));
}


// Scene-color application reads the accepted previous exposure, before this
// frame meters the occluded scene. No exposure copy or CPU readback is needed.
@group(0) @binding(10) var ssaoScene: texture_2d<f32>;
@group(0) @binding(11) var<uniform> ssaoPreviousExposure: vec4<f32>;

fn ssaoSceneTapUv(uv: vec2<f32>, index: i32) -> vec2<f32> {
  let size = vec2<i32>(textureDimensions(ssaoRaw));
  let base = vec2<i32>(floor(uv * vec2<f32>(size) - 0.5));
  let tap = clamp(base + vec2<i32>(index & 1, index >> 1), vec2<i32>(0), size - 1);
  return (vec2<f32>(tap) + 0.5) / vec2<f32>(size);
}

fn ssaoApplySceneColor(in: SsaoVsOut, depth: f32, tapDepths: vec4<f32>) -> vec4<f32> {
  let sceneSize = vec2<i32>(textureDimensions(ssaoScene));
  let pixel = clamp(vec2<i32>(in.position.xy), vec2<i32>(0), sceneSize - 1);
  let source = textureLoad(ssaoScene, pixel, 0);
  var color = max(source.rgb, vec3<f32>(0.0));
  if (depth > 0.0 && ssao_uniform.viewportPad.y > 0.0) {
    let z = min(-ssaoViewZ(in.uv, depth), 300.0);
    let aoSize = vec2<i32>(textureDimensions(ssaoRaw));
    let hp = in.uv * vec2<f32>(aoSize) - 0.5;
    let f = fract(hp);
    let base = vec2<i32>(floor(hp));
    var total = 0.0;
    var weight = 0.0;
    for (var k = 0; k < 4; k++) {
      let offset = vec2<i32>(k & 1, k >> 1);
      let tap = clamp(base + offset, vec2<i32>(0), aoSize - 1);
      let tapZ = min(tapDepths[k], 300.0);
      let bilinear = select(1.0 - f, f, offset == vec2<i32>(1));
      let w = max(1e-5, bilinear.x * bilinear.y / (0.015 + abs(tapZ - z) / max(z, 1e-6)));
      total += textureLoad(ssaoRaw, tap, 0).r * w;
      weight += w;
    }
    var exposure = ssao_uniform.viewportPad.z;
    if (ssao_uniform.viewportPad.w > 0.0) {
      exposure = select(ssao_uniform.viewportPad.w, ssaoPreviousExposure.x, ssaoPreviousExposure.y > 0.5 && ssaoPreviousExposure.x > 0.0);
    }
    let lit = smoothstep(0.16, 0.85, dot(color, vec3<f32>(0.2126, 0.7152, 0.0722)) * exposure);
    let a = mix(1.0, total / max(weight, 1e-6), ssao_uniform.viewportPad.y * (1.0 - 0.8 * lit));
    color *= mix(vec3<f32>(a), vec3<f32>(1.0), vec3<f32>(0.0, 0.03, 0.07));
  }
  return vec4<f32>(color, source.a);
}

@fragment
fn fs_ssao_scene_color(in: SsaoVsOut) -> @location(0) vec4<f32> {
  let depth = ssaoDepth(in.uv);
  var taps = vec4<f32>(300.1);
  if (depth > 0.0 && ssao_uniform.viewportPad.y > 0.0) {
    for (var k = 0; k < 4; k++) {
      let uv = ssaoSceneTapUv(in.uv, k);
      if (ssao_uniform.algorithmPad.x == 2.0) { taps[k] = spiralDepth(uv); }
      else { taps[k] = spiralDeviceDepth(uv); }
    }
  }
  return ssaoApplySceneColor(in, depth, taps);
}

@fragment
fn fs_ssao_scene_color_msaa(in: SsaoVsOut) -> @location(0) vec4<f32> {
  let depth = ssaoNearestMsaaDepth(in.uv);
  var taps = vec4<f32>(300.1);
  if (depth > 0.0 && ssao_uniform.viewportPad.y > 0.0) {
    for (var k = 0; k < 4; k++) { taps[k] = spiralDepth(ssaoSceneTapUv(in.uv, k)); }
  }
  return ssaoApplySceneColor(in, depth, taps);
}
