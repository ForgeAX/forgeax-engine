#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis ATMOSPHERE_AVAILABLE

#import forgeax_view::common::{View, Mesh, view, meshes, sampleMaterialTexture}
#import forgeax_view::fog::{translucent_fog}

// @forgeax/engine-shader - msdf-text.wgsl
// (feat-20260531-world-space-msdf-text-rendering M5 / w20).
//
// World-space MSDF text material -- the 5th MaterialAsset shader after
// 'unlit' / 'standard' / 'sprite'. Text entities are baked into a standard
// mesh entity (glyph quads in local layout space; position.xy = layout x/y,
// position.z = 0; uv = atlas UV) and ride the existing forward path via
// `materialShaderId='forgeax::msdf-text'` (D-7 -- zero new pipelineTag,
// reuses the 'unlit' pipeline tag + transparent bucket + premultiplied
// alpha blend ONE / ONE_MINUS_SRC_ALPHA).
//
// Anchors:
//   - plan-strategy D-3 (GPU billboard; WGSL has no inverse(), camera basis
//     reconstructed without inverse() -- Finding 5/6/7)
//   - plan-strategy D-7 (premultiplied output vec4(tint.rgb*alpha, alpha);
//     ONE / ONE_MINUS_SRC_ALPHA; writes hdrColor so bloom catches it -- R-7)
//   - knowledge-base/wiki/msdf-text-rendering.md section 6 (median + screenPxRange
//     SSOT) + section 2 (median-of-three corner preservation)
//   - requirements AC-10 (GPU billboard not degenerate to a line) + AC-12
//     (bloom / premultiplied) + C3 (materialShaderId path, zero pipelineTag)
//     + C4 (billboard x pick orientation independence)
//
// Billboard construction (D-3 / Finding 5/6/7):
//   The mesh vertex.pos.xy carries the per-glyph layout coordinate (already
//   includes intra-line advance + multi-line \n offset baked by the layout
//   system). The quad is expanded along the camera's right / up basis vectors
//   in WORLD space so the text always faces the camera (Finding 7: the quad
//   normal is the camera forward direction, so "text plane parallel to view
//   ray" never happens -- no NaN / flip flicker). WGSL exposes no inverse()
//   built-in (Finding 5); the camera right / up are reconstructed from the
//   world-space anchor and `view.cameraPos` (a look-at frame) with only
//   normalize / cross -- zero matrix inverse, zero per-frame CPU rewrite of
//   the mesh. `anchor` = the model matrix translation column
//   (meshes[idx].worldFromLocal column 3).
//
// Bindings (mirror sprite.wgsl / unlit.wgsl byte-for-byte so the shared
// 4-BindGroupLayout chain is reused without a per-pipeline BGL; the
// metallicRoughness / normal slots 3..6 stay declared-but-unused, bound to
// pipelineState defaults at the host side -- D-1 candidate b):
//
//   @group(0) @binding(0) view                       uniform   (msdf-text reads
//                                                               worldViewProj +
//                                                               cameraPos)
//   @group(1) @binding(0) material                   uniform   (tintColor vec4
//                                                               + distanceRange
//                                                               f32 + atlas dims)
//   @group(1) @binding(1) baseColorSampler           sampler   (atlas sampler)
//   @group(1) @binding(2) baseColorTexture           texture_2d<f32> (MSDF atlas)
//   @group(2) @binding(0) meshes                     storage   (msdf-text reads
//                                                               meshes[idx]
//                                                               .worldFromLocal
//                                                               translation
//                                                               column = anchor)

struct Material {
  // tintColor: per-text color multiplied onto the reconstructed coverage
  // alpha. Maps to the `tintColor` paramSchema entry (default opaque white).
  tintColor : vec4<f32>,
  // distanceRange: atlas-space distance-field width (msdfgen -pxrange output,
  // = sidecar.common.distanceRange). atlasSize.xy carries the atlas pixel
  // dimensions so screenPxRange can convert atlas units to screen pixels.
  // distanceRange in .x; atlasSize in .yz; .w padding (std140 vec4 align).
  distanceRange : vec4<f32>,
  baseColorTextureCoordinatesTransform : vec4<f32>,
  baseColorTextureCoordinatesMetadata : vec4<f32>,
  baseColorTextureCoordinatesRotation : vec4<f32>,
};

@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
// Preserve filtering reflection for the bound texture passed to the helper.
fn materialTextureFilteringWitness() {
  let base = baseColorTexture;
  let baseWitness = textureSample(base, baseColorSampler, vec2<f32>(0.0));
}

struct VsIn {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv         : vec2<f32>,
  @location(1) worldPos   : vec3<f32>,
};

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  // anchor = the entity world-matrix translation column (D-3). The layout
  // system bakes the glyph quads in local layout space (Y-up), so the model
  // matrix is a pure Translate (Rotate / Scale folded into the layout) and
  // its 4th column is the world-space anchor.
  let model = meshes[idx].worldFromLocal;
  let anchor = model[3].xyz;
  // Camera look-at frame (Finding 5/6/7): forward = anchor -> camera. WGSL
  // has no inverse() built-in; the right / up basis is reconstructed from
  // `view.cameraPos` + the world up reference (0,1,0) with normalize / cross
  // only -- zero matrix inverse, the quad normal is always the camera
  // forward direction so the billboard never degenerates to a line.
  let forward = normalize(view.cameraPos - anchor);
  // Guard against the camera looking straight down/up the world-up axis
  // (forward parallel to (0,1,0)): fall back to a +Z up reference so cross()
  // stays well-conditioned. This is the only degenerate case (Finding 7) and
  // is resolved here rather than producing a NaN basis.
  let upRef = select(
    vec3<f32>(0.0, 1.0, 0.0),
    vec3<f32>(0.0, 0.0, 1.0),
    abs(forward.y) > 0.999,
  );
  let right = normalize(cross(upRef, forward));
  let up = cross(forward, right);
  // Expand the glyph quad's local layout coordinate along the world-space
  // right / up basis (Finding 6: billboard-rotate then translate). pos.z is
  // 0 for every baked glyph vertex so it contributes nothing.
  let world_pos = anchor + right * in.pos.x + up * in.pos.y;
  var out : VsOut;
  out.clip = view.worldViewProj * vec4<f32>(world_pos, 1.0);
  out.uv = in.uv;
  out.worldPos = world_pos;
  return out;
}

// median(R, G, B): corner-preserving MSDF reconstruction operator (wiki
// section 2). Picks the distance supported by two-or-more edges so sharp
// corners survive bilinear upscaling (median = max(min, min(max)) form).
fn median(r : f32, g : f32, b : f32) -> f32 {
  return max(min(r, g), min(max(r, g), b));
}

// screenPxRange: converts the atlas-space distanceRange into a screen-pixel
// ramp width using fwidth() of the atlas UV (wiki section 3.3 / section 6). The
// `max(., 1.0)` floor keeps the anti-aliasing ramp at least half a pixel wide
// (msdfgen README: ramp < 1 px degrades back to a hard step / aliasing).
fn screen_px_range(uv : vec2<f32>) -> f32 {
  let atlas_dims = material.distanceRange.yz;
  let unit_range = vec2<f32>(material.distanceRange.x) / atlas_dims;
  let screen_tex_size = vec2<f32>(1.0) / fwidth(uv);
  return max(0.5 * dot(unit_range, screen_tex_size), 1.0);
}

// fs_main_hdr: outputs linear premultiplied alpha for the rgba16float
// offscreen target (D-7 / R-7). The tonemap fullscreen pass handles sRGB
// encoding; writing hdrColor lets Bloom extraction catch the text.
@fragment
fn fs_main_hdr(in : VsOut) -> @location(0) vec4<f32> {
  let msd = sampleMaterialTexture(baseColorTexture, baseColorSampler, in.uv, material.baseColorTextureCoordinatesMetadata.zw).rgb;
  let sd = median(msd.r, msd.g, msd.b);
  // wiki section 3.3: opacity = clamp((sd - 0.5) * screenPxRange + 0.5, 0, 1)
  // (linear ramp; equivalent to smoothstep(0.5 - delta, 0.5 + delta, sd) at
  // sub-pixel error -- wiki section 3.2 form-equivalence callout).
  let dist = (sd - 0.5) * screen_px_range(in.uv);
  let alpha = clamp(dist + 0.5, 0.0, 1.0) * material.tintColor.a;
  // Premultiplied output: rgb already multiplied by alpha for srcFactor=ONE /
  // dstFactor=ONE_MINUS_SRC_ALPHA (wiki section 6 SSOT).
  return vec4<f32>(translucent_fog(view, in.worldPos, material.tintColor.rgb * alpha, alpha), alpha);
}

// linear_to_srgb: per-channel IEC 61966-2-1 transfer function for the LDR
// bgra8unorm swap-chain target (not hardware-sRGB-encoded). Alpha is NOT
// encoded -- the blend equation operates on raw alpha.
fn linear_to_srgb(linear : f32) -> f32 {
  let c = clamp(linear, 0.0, 1.0);
  return select(c * 12.92, pow(c, 1.0 / 2.4) * 1.055 - 0.055, c > 0.0031308);
}

// fs_main: LDR variant for the bgra8unorm target. Same coverage math as the
// HDR variant; encodes RGB through the sRGB transfer function (the LDR target
// is not hardware-sRGB-encoded), alpha stays linear through the blend.
@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let msd = sampleMaterialTexture(baseColorTexture, baseColorSampler, in.uv, material.baseColorTextureCoordinatesMetadata.zw).rgb;
  let sd = median(msd.r, msd.g, msd.b);
  let dist = (sd - 0.5) * screen_px_range(in.uv);
  let alpha = clamp(dist + 0.5, 0.0, 1.0) * material.tintColor.a;
  let premult = translucent_fog(view, in.worldPos, material.tintColor.rgb * alpha, alpha);
  return vec4<f32>(
    linear_to_srgb(premult.r),
    linear_to_srgb(premult.g),
    linear_to_srgb(premult.b),
    alpha,
  );
}
