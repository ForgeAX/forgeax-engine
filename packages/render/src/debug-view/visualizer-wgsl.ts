// Standalone WGSL shaders for `@forgeax/engine-render/debug-view`.
// Kept strictly out of core `@forgeax/engine-render` so production builds without
// `viewportDebugView` tree-shake every byte of debug WGSL.

/**
 * Fullscreen GBuffer & scene buffer visualizer.
 *
 * Output domain contract:
 * - Writes linear LDR values to an `rgba16float` target consumed by the standard
 *   `fs_encode_only` (Linear -> sRGB) output pass.
 * - Color channels (`base-color`, `emissive`, `lit` tile) output linear RGB so the
 *   downstream sRGB OETF produces the exact authored sRGB appearance without tone
 *   mapping or exposure distortion.
 * - Data channels (`world-normal`, `geometric-normal`, `metallic`, `roughness`,
 *   `material-ao`, `screen-ao`, `depth`) pre-apply exact sRGB-to-Linear so that
 *   downstream sRGB OETF cancels out and screen pixels equal exact `[0, 1]` values.
 */
export const VIEWPORT_GBUFFER_VISUALIZER_WGSL = /* wgsl */ `
struct VisualizerParams {
  // x: mode (1=baseColor, 2=worldNormal, 3=geometricNormal, 4=metallic,
  //          5=roughness, 6=materialAo, 7=screenAo, 8=emissive, 9=depth, 10=overview)
  // y: flags (bit0=compact, bit1=hasScreenAo, bit2=hasReceiverGeometry, bit3=hasLitColor)
  // z: width (output pixels)
  // w: height (output pixels)
  modeFlags : vec4<u32>,
  // x: near, y: far, z: isOrtho (0 or 1), w: isInfiniteFar (0 or 1)
  depthParams : vec4<f32>,
  // x: depthContrastScale, y: exposureScale (for overview lit tile), z/w: reserved
  tuning : vec4<f32>,
};

@group(0) @binding(0) var<uniform> params : VisualizerParams;
@group(0) @binding(1) var normalRoughness : texture_2d<u32>;
@group(0) @binding(2) var albedoMetallic : texture_2d<u32>;
@group(0) @binding(3) var dielectricSpecular : texture_2d<u32>;
@group(0) @binding(4) var sceneColor : texture_2d<f32>;
@group(0) @binding(5) var receiverGeometry : texture_2d<u32>;
@group(0) @binding(6) var sceneDepth : texture_depth_2d;
@group(0) @binding(7) var screenAo : texture_2d<f32>;
@group(0) @binding(8) var linearSampler : sampler;
@group(0) @binding(9) var emissiveCopy : texture_2d<f32>;

struct VsOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VsOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out : VsOut;
  let xy = p[vid];
  out.pos = vec4<f32>(xy, 0.0, 1.0);
  out.uv = vec2<f32>(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5);
  return out;
}

const FLAG_COMPACT : u32 = 1u;
const FLAG_HAS_SCREEN_AO : u32 = 2u;
const FLAG_HAS_RECEIVER_GEOMETRY : u32 = 4u;
const FLAG_HAS_LIT_COLOR : u32 = 8u;

const STANDARD_GBUFFER_VALID_BIT : u32 = 0x40000000u;

fn srgbChannelToLinear(c : f32) -> f32 {
  let x = clamp(c, 0.0, 1.0);
  return select(pow((x + 0.055) / 1.055, 2.4), x / 12.92, x <= 0.04045);
}

fn dataToLinear(v : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    srgbChannelToLinear(v.r),
    srgbChannelToLinear(v.g),
    srgbChannelToLinear(v.b),
  );
}

fn decodeCompactBaseColor(srgb : vec3<f32>) -> vec3<f32> {
  return dataToLinear(srgb);
}

fn decodeStandardGBufferNormal(packed : vec2<u32>) -> vec4<f32> {
  let xyz = vec3<f32>(
    f32(packed.x & 1023u),
    f32((packed.x >> 10u) & 1023u),
    f32((packed.x >> 20u) & 1023u),
  ) * (2.0 / 1023.0) - 1.0;
  let lenSq = dot(xyz, xyz);
  let n = select(vec3<f32>(0.0, 0.0, 1.0), xyz * inverseSqrt(lenSq), lenSq > 1e-8);
  return vec4<f32>(n, f32(packed.y & 255u) / 255.0);
}

fn decodeStandardReceiverNormal(packed : u32) -> vec3<f32> {
  let oct = vec2<f32>(f32(packed & 4095u), f32((packed >> 12u) & 2047u)) *
    vec2<f32>(2.0 / 4095.0, 2.0 / 2047.0) - 1.0;
  var n = vec3<f32>(oct, 1.0 - abs(oct.x) - abs(oct.y));
  let fold = max(-n.z, 0.0);
  n = vec3<f32>(n.xy + select(vec2<f32>(fold), vec2<f32>(-fold), n.xy >= vec2<f32>(0.0)), n.z);
  let lenSq = dot(n, n);
  return select(vec3<f32>(0.0, 0.0, 1.0), n * inverseSqrt(lenSq), lenSq > 1e-8);
}

fn compactGBufferLit(word : u32) -> bool {
  let model = (word >> 24u) & 15u;
  return model == 1u || model == 5u || model == 6u;
}

// Crisp dark checkerboard so metallic=0 / emissive=0 black geometry stands out from sky.
fn backgroundChecker(screenPixel : vec2<i32>) -> vec3<f32> {
  let cell = (screenPixel >> vec2<u32>(4u, 4u)) & vec2<i32>(1, 1);
  let odd = (cell.x ^ cell.y) == 1;
  let srgb = select(vec3<f32>(0.09, 0.10, 0.12), vec3<f32>(0.13, 0.145, 0.175), odd);
  return dataToLinear(srgb);
}

// ACES Narkowicz approximation for the compact Lit tile inside Overview.
fn acesPreview(x : vec3<f32>) -> vec3<f32> {
  let v = max(x, vec3<f32>(0.0));
  return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
}

// 3x5 bitmap glyphs (15 bits, row-major MSB -> top-left) for overview tile labels.
fn glyphPixel(ch : u32, gx : i32, gy : i32) -> bool {
  if (gx < 0 || gx >= 3 || gy < 0 || gy >= 5) { return false; }
  // 3x5 rows stored as 5 groups of 3 bits (row 0 = bits 14..12, row 4 = bits 2..0)
  var bits : u32 = 0u;
  switch (ch) {
    case 65u: { bits = (2u << 12u) | (5u << 9u) | (7u << 6u) | (5u << 3u) | 5u; } // A
    case 66u: { bits = (6u << 12u) | (5u << 9u) | (6u << 6u) | (5u << 3u) | 6u; } // B
    case 68u: { bits = (6u << 12u) | (5u << 9u) | (5u << 6u) | (5u << 3u) | 6u; } // D
    case 69u: { bits = (7u << 12u) | (4u << 9u) | (6u << 6u) | (4u << 3u) | 7u; } // E
    case 71u: { bits = (3u << 12u) | (4u << 9u) | (5u << 6u) | (5u << 3u) | 3u; } // G
    case 72u: { bits = (5u << 12u) | (5u << 9u) | (7u << 6u) | (5u << 3u) | 5u; } // H
    case 73u: { bits = (7u << 12u) | (2u << 9u) | (2u << 6u) | (2u << 3u) | 7u; } // I
    case 76u: { bits = (4u << 12u) | (4u << 9u) | (4u << 6u) | (4u << 3u) | 7u; } // L
    case 77u: { bits = (5u << 12u) | (7u << 9u) | (5u << 6u) | (5u << 3u) | 5u; } // M
    case 78u: { bits = (5u << 12u) | (7u << 9u) | (7u << 6u) | (5u << 3u) | 5u; } // N
    case 79u: { bits = (2u << 12u) | (5u << 9u) | (5u << 6u) | (5u << 3u) | 2u; } // O
    case 80u: { bits = (6u << 12u) | (5u << 9u) | (6u << 6u) | (4u << 3u) | 4u; } // P
    case 82u: { bits = (6u << 12u) | (5u << 9u) | (6u << 6u) | (5u << 3u) | 5u; } // R
    case 83u: { bits = (3u << 12u) | (4u << 9u) | (2u << 6u) | (1u << 3u) | 6u; } // S
    case 84u: { bits = (7u << 12u) | (2u << 9u) | (2u << 6u) | (2u << 3u) | 2u; } // T
    default: { bits = 0u; }
  }
  let shift = u32((4 - gy) * 3 + (2 - gx));
  return ((bits >> shift) & 1u) != 0u;
}

fn tileLabelChar(tileIndex : u32, charIdx : i32) -> u32 {
  // 4-char labels for 9 tiles (0 = blank):
  // 0: LIT  1: BASE  2: NORM  3: MET  4: RGH  5: MAO  6: SAO  7: EMIS  8: DPTH
  switch (tileIndex) {
    case 0u: {
      if (charIdx == 0) { return 76u; }
      if (charIdx == 1) { return 73u; }
      if (charIdx == 2) { return 84u; }
      return 0u;
    }
    case 1u: {
      if (charIdx == 0) { return 66u; }
      if (charIdx == 1) { return 65u; }
      if (charIdx == 2) { return 83u; }
      if (charIdx == 3) { return 69u; }
      return 0u;
    }
    case 2u: {
      if (charIdx == 0) { return 78u; }
      if (charIdx == 1) { return 79u; }
      if (charIdx == 2) { return 82u; }
      if (charIdx == 3) { return 77u; }
      return 0u;
    }
    case 3u: {
      if (charIdx == 0) { return 77u; }
      if (charIdx == 1) { return 69u; }
      if (charIdx == 2) { return 84u; }
      return 0u;
    }
    case 4u: {
      if (charIdx == 0) { return 82u; }
      if (charIdx == 1) { return 71u; }
      if (charIdx == 2) { return 72u; }
      return 0u;
    }
    case 5u: {
      if (charIdx == 0) { return 77u; }
      if (charIdx == 1) { return 65u; }
      if (charIdx == 2) { return 79u; }
      return 0u;
    }
    case 6u: {
      if (charIdx == 0) { return 83u; }
      if (charIdx == 1) { return 65u; }
      if (charIdx == 2) { return 79u; }
      return 0u;
    }
    case 7u: {
      if (charIdx == 0) { return 69u; }
      if (charIdx == 1) { return 77u; }
      if (charIdx == 2) { return 73u; }
      if (charIdx == 3) { return 83u; }
      return 0u;
    }
    default: {
      if (charIdx == 0) { return 68u; }
      if (charIdx == 1) { return 80u; }
      if (charIdx == 2) { return 84u; }
      if (charIdx == 3) { return 72u; }
      return 0u;
    }
  }
}

fn evaluateChannel(mode : u32, sampleUv : vec2<f32>, screenPixel : vec2<i32>) -> vec3<f32> {
  let flags = params.modeFlags.y;
  let compact = (flags & FLAG_COMPACT) != 0u;
  let hasScreenAo = (flags & FLAG_HAS_SCREEN_AO) != 0u;
  let hasReceiverGeom = (flags & FLAG_HAS_RECEIVER_GEOMETRY) != 0u;
  let hasLitColor = (flags & FLAG_HAS_LIT_COLOR) != 0u;

  let dims = textureDimensions(normalRoughness);
  let maxPixel = vec2<i32>(dims) - vec2<i32>(1, 1);
  let pixel = clamp(vec2<i32>(floor(sampleUv * vec2<f32>(dims))), vec2<i32>(0, 0), maxPixel);

  // Mode 0 is reserved for the LIT tile inside overview.
  if (mode == 0u) {
    let lit = textureLoad(sceneColor, pixel, 0).rgb;
    return acesPreview(lit * params.tuning.y);
  }

  let depth = textureLoad(sceneDepth, pixel, 0);
  let packedNormal = textureLoad(normalRoughness, pixel, 0).rg;
  let albedoWord = textureLoad(albedoMetallic, pixel, 0).r;
  let specWord = textureLoad(dielectricSpecular, pixel, 0).r;

  var valid = false;
  if (compact) {
    valid = depth > 0.0 && packedNormal.x != 0u && compactGBufferLit(specWord);
  } else {
    valid = depth > 0.0 && ((packedNormal.x & STANDARD_GBUFFER_VALID_BIT) != 0u);
  }

  if (!valid) {
    return backgroundChecker(screenPixel);
  }

  // Decode surface attributes for both Full and Compact GBuffer layouts.
  var baseColorLinear = vec3<f32>(0.0);
  var metallic = 0.0;
  var roughness = 0.0;
  var materialAo = 1.0;
  let normalDecoded = decodeStandardGBufferNormal(packedNormal);
  let worldNormal = normalDecoded.xyz;

  if (compact) {
    let b = unpack4x8unorm(specWord);
    let c = unpack4x8unorm(albedoWord);
    baseColorLinear = decodeCompactBaseColor(c.rgb);
    metallic = b.r;
    roughness = b.b;
    materialAo = c.a;
  } else {
    let am = unpack4x8unorm(albedoWord);
    baseColorLinear = am.rgb * am.rgb;
    metallic = am.a;
    roughness = normalDecoded.w;
    materialAo = f32((packedNormal.y >> 8u) & 255u) / 255.0;
  }

  switch (mode) {
    // 1: base-color (linear RGB -> downstream sRGB encode)
    case 1u: {
      return clamp(baseColorLinear, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    // 2: world-normal (data channel: exact n*0.5+0.5 display values)
    case 2u: {
      return dataToLinear(clamp(worldNormal * 0.5 + 0.5, vec3<f32>(0.0), vec3<f32>(1.0)));
    }
    // 3: geometric-normal (oct X12/Y11 from receiverGeometry, fallback to worldNormal)
    case 3u: {
      var geomNormal = worldNormal;
      if (hasReceiverGeom) {
        let rec = textureLoad(receiverGeometry, pixel, 0);
        let word = select(rec.x, rec.z, compact);
        geomNormal = decodeStandardReceiverNormal(word);
      }
      return dataToLinear(clamp(geomNormal * 0.5 + 0.5, vec3<f32>(0.0), vec3<f32>(1.0)));
    }
    // 4: metallic (data grayscale)
    case 4u: {
      return dataToLinear(vec3<f32>(clamp(metallic, 0.0, 1.0)));
    }
    // 5: roughness (data grayscale)
    case 5u: {
      return dataToLinear(vec3<f32>(clamp(roughness, 0.0, 1.0)));
    }
    // 6: material-ao (data grayscale)
    case 6u: {
      return dataToLinear(vec3<f32>(clamp(materialAo, 0.0, 1.0)));
    }
    // 7: screen-ao (data grayscale, bilinear sampled because GTAO/SSAO may be half-res)
    case 7u: {
      let sao = select(1.0, clamp(textureSampleLevel(screenAo, linearSampler, sampleUv, 0.0).r, 0.0, 1.0), hasScreenAo);
      return dataToLinear(vec3<f32>(sao));
    }
    // 8: emissive (linear RGB -> downstream sRGB encode)
    case 8u: {
      let emissive = select(
        textureLoad(sceneColor, pixel, 0).rgb,
        textureLoad(emissiveCopy, pixel, 0).rgb,
        hasLitColor,
      );
      return clamp(emissive, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    // 9: depth (exact Reverse-Z view-space distance -> readable monotonic contrast curve)
    case 9u: {
      let nearP = max(params.depthParams.x, 1e-4);
      let farP = max(params.depthParams.y, nearP + 1e-3);
      var dist = nearP / max(depth, 1e-6);
      if (params.depthParams.z > 0.5) {
        dist = farP - depth * (farP - nearP);
      } else if (params.depthParams.w < 0.5) {
        dist = (nearP * farP) / max(nearP + depth * (farP - nearP), 1e-6);
      }
      let vis = clamp(1.0 / (1.0 + max(dist, 0.0) * params.tuning.x), 0.0, 1.0);
      return dataToLinear(vec3<f32>(vis));
    }
    default: {
      return clamp(baseColorLinear, vec3<f32>(0.0), vec3<f32>(1.0));
    }
  }
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let mode = params.modeFlags.x;
  let screenPixel = vec2<i32>(floor(in.pos.xy));

  if (mode != 10u) {
    return vec4<f32>(evaluateChannel(mode, in.uv, screenPixel), 1.0);
  }

  // Overview: 3x3 grid with crisp borders and compact corner labels.
  let grid = vec2<f32>(3.0, 3.0);
  let scaled = in.uv * grid;
  let tileCoord = clamp(vec2<u32>(floor(scaled)), vec2<u32>(0u, 0u), vec2<u32>(2u, 2u));
  let localUv = fract(scaled);
  let tileIndex = tileCoord.y * 3u + tileCoord.x;

  // Map 9 tiles: 0=lit, 1=base, 2=worldNormal, 3=metallic, 4=roughness, 5=materialAo, 6=screenAo, 7=emissive, 8=depth
  var tileMode : u32 = 0u;
  switch (tileIndex) {
    case 0u: { tileMode = 0u; }
    case 1u: { tileMode = 1u; }
    case 2u: { tileMode = 2u; }
    case 3u: { tileMode = 4u; }
    case 4u: { tileMode = 5u; }
    case 5u: { tileMode = 6u; }
    case 6u: { tileMode = 7u; }
    case 7u: { tileMode = 8u; }
    default: { tileMode = 9u; }
  }

  let outSize = vec2<f32>(f32(max(params.modeFlags.z, 1u)), f32(max(params.modeFlags.w, 1u)));
  let tileSize = outSize / grid;
  let tilePx = vec2<i32>(floor(localUv * tileSize));
  let tileMax = vec2<i32>(floor(tileSize));

  // 1px dark separator border around each tile.
  if (tilePx.x <= 0 || tilePx.y <= 0 || tilePx.x >= tileMax.x - 1 || tilePx.y >= tileMax.y - 1) {
    return vec4<f32>(dataToLinear(vec3<f32>(0.22, 0.25, 0.30)), 1.0);
  }

  var color = evaluateChannel(tileMode, localUv, screenPixel);

  // Compact top-left label pill (scale 2x for crisp readability).
  let pillX = tilePx.x - 6;
  let pillY = tilePx.y - 6;
  let pillW = 36;
  let pillH = 14;
  if (pillX >= 0 && pillX < pillW && pillY >= 0 && pillY < pillH) {
    // Darken backing pill.
    color = color * 0.22;
    let tx = (pillX - 3) / 2;
    let ty = (pillY - 2) / 2;
    if (tx >= 0 && ty >= 0 && ty < 5) {
      let charIdx = tx / 4;
      let gx = tx % 4;
      if (charIdx >= 0 && charIdx < 4 && gx < 3) {
        let ch = tileLabelChar(tileIndex, charIdx);
        if (ch != 0u && glyphPixel(ch, gx, ty)) {
          color = dataToLinear(vec3<f32>(0.96, 0.92, 0.55));
        }
      }
    }
  }

  return vec4<f32>(color, 1.0);
}
`;

/**
 * Fullscreen GBuffer neutral-clay override pass for `lighting-only` mode.
 *
 * Reads the unmodified GBuffer + SceneColor (emissive / sky) and writes fresh
 * RenderGraph targets with neutral 18% linear diffuse reflectance, zero metallic,
 * standard 0.04 dielectric F0, and zero emissive on valid geometry pixels while
 * preserving sky pixels, Material AO, roughness, and shading models.
 */
export const VIEWPORT_LIGHTING_ONLY_OVERRIDE_WGSL = /* wgsl */ `
struct OverrideParams {
  // x: compact (0 = full GBuffer, 1 = compact GBuffer)
  flags : vec4<u32>,
};

@group(0) @binding(0) var<uniform> params : OverrideParams;
@group(0) @binding(1) var normalRoughness : texture_2d<u32>;
@group(0) @binding(2) var albedoMetallic : texture_2d<u32>;
@group(0) @binding(3) var dielectricSpecular : texture_2d<u32>;
@group(0) @binding(4) var sceneColor : texture_2d<f32>;

struct VsOut {
  @builtin(position) pos : vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vid : u32) -> VsOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out : VsOut;
  out.pos = vec4<f32>(p[vid], 0.0, 1.0);
  return out;
}

struct OverrideOut {
  @location(0) scene : vec4<f32>,
  @location(1) albedo : u32,
  @location(2) specular : u32,
};

const STANDARD_GBUFFER_VALID_BIT : u32 = 0x40000000u;

fn encodeStandardReflectance(rgb : vec3<f32>, alpha : f32) -> u32 {
  return pack4x8unorm(vec4<f32>(sqrt(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0))), alpha));
}

fn encodeCompactBaseColor(baseColor : vec3<f32>, ao : f32) -> u32 {
  let linear = clamp(baseColor, vec3<f32>(0.0), vec3<f32>(1.0));
  let srgb = select(1.055 * pow(linear, vec3<f32>(1.0 / 2.4)) - 0.055,
    linear * 12.92, linear <= vec3<f32>(0.0031308));
  return pack4x8unorm(vec4<f32>(srgb, ao));
}

fn compactGBufferLit(word : u32) -> bool {
  let model = (word >> 24u) & 15u;
  return model == 1u || model == 5u || model == 6u;
}

@fragment
fn fs_main(in : VsOut) -> OverrideOut {
  let pixel = vec2<i32>(floor(in.pos.xy));
  let compact = params.flags.x != 0u;
  let packedNormal = textureLoad(normalRoughness, pixel, 0).rg;
  let origAlbedo = textureLoad(albedoMetallic, pixel, 0).r;
  let origSpec = textureLoad(dielectricSpecular, pixel, 0).r;
  let origScene = textureLoad(sceneColor, pixel, 0);

  let valid = select(
    (packedNormal.x & STANDARD_GBUFFER_VALID_BIT) != 0u,
    packedNormal.x != 0u && compactGBufferLit(origSpec),
    compact,
  );

  if (!valid) {
    return OverrideOut(origScene, origAlbedo, origSpec);
  }

  let clay = vec3<f32>(0.18, 0.18, 0.18);
  if (compact) {
    let origC = unpack4x8unorm(origAlbedo);
    let origB = unpack4x8unorm(origSpec);
    // Preserve AO in C.a and roughness + shading model in B.b / B.a; zero metallic, 0.04 F0 (0.5).
    let outAlbedo = encodeCompactBaseColor(clay, origC.a);
    let outSpec = pack4x8unorm(vec4<f32>(0.0, 0.5, origB.b, origB.a));
    return OverrideOut(vec4<f32>(0.0, 0.0, 0.0, origScene.a), outAlbedo, outSpec);
  }

  let outAlbedo = encodeStandardReflectance(clay, 0.0);
  let outSpec = encodeStandardReflectance(vec3<f32>(0.04), 1.0);
  return OverrideOut(vec4<f32>(0.0, 0.0, 0.0, origScene.a), outAlbedo, outSpec);
}
`;
