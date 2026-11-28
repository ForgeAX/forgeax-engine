#define_import_path forgeax_material::standard_surface_maps
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::surface_sampling::{sampleSurfaceTexture, surfaceTextureFootprint}
#import forgeax_material::texture_coordinates::{materialUvLinear}
#import forgeax_material::alpha_hash::{alphaCoverageValue, alphaCoverageClipThreshold, applyAlphaHash}

// Raster coverage and the full Surface share slot sampling, UV transforms,
// and channel selection. The raster entry chooses the projection it supports.
// Triplanar projection shared by every base slot of one Surface evaluation.
// Plane coordinates follow Three r184 triplanarTexture (x: yz, y: zx, z: xy);
// weights follow Unreal's world-aligned blend, pow(|n|, sharpness) normalized.
struct SurfaceProjection {
  position : vec3<f32>,
  positionDx : vec3<f32>,
  positionDy : vec3<f32>,
  normal : vec3<f32>,
  weights : vec3<f32>,
};

#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
fn surfaceUv(input : SurfaceInput, transform : vec4<f32>, metadata : vec4<f32>, rotation : vec4<f32>) -> vec2<f32> {
  var source = input.uv0;
  if (metadata.x >= 1.0) { source = input.uv1; }
  if (metadata.x >= 2.0) { source = input.uv2; }
  if (metadata.x >= 3.0) { source = input.uv3; }
  if (metadata.x >= 4.0) { source = input.uv4; }
  if (metadata.x >= 5.0) { source = input.uv5; }
  if (metadata.x >= 6.0) { source = input.uv6; }
  if (metadata.x >= 7.0) { source = input.uv7; }
  return materialUvLinear(source, transform, rotation) + transform.xy;
}

const SURFACE_TRIPLANAR_OBJECT : f32 = 2.0;

// The pipeline specialization bit travels as its own `triplanar` parameter,
// never as a struct field: uniformity analysis taints a whole struct that also
// carries varyings, and the UV branch's implicit-derivative sample needs a
// uniform branch. A contract without the triplanar fields keeps the UV
// projection and never references them.
#ifdef TRIPLANAR_PROJECTION_AVAILABLE
fn surfaceProjection(input : SurfaceInput, materialValue : MaterialParameters) -> SurfaceProjection {
  let objectSpace = materialValue.triplanarSpace > SURFACE_TRIPLANAR_OBJECT - 0.5;
  // n_os is proportional to transpose(M) * n_ws for any invertible M.
  let normalOS = normalize(input.vertexNormalWS * input.objectToWorld);
  let normal = select(normalize(input.vertexNormalWS), normalOS, objectSpace);
  let position = select(input.positionWS, input.positionOS, objectSpace) * materialValue.triplanarScale;
  let blend = pow(abs(normal), vec3<f32>(max(materialValue.triplanarSharpness, 1.0)));
  // Derivatives come from uniform control flow: slot sampling is gated only by
  // the pipeline specialization bit, never by a per-row material value.
#ifdef RAY_SURFACE_CONTEXT
  let dx = vec3<f32>(0.0);
  let dy = vec3<f32>(0.0);
#else
  // UE multiplies the derivatives by 2^bias for derivative-mode sampling.
  let dx = dpdx(position) * exp2(input.materialTextureMipBias);
  let dy = dpdy(position) * exp2(input.materialTextureMipBias);
#endif
  return SurfaceProjection(
    position, dx, dy, normal,
    blend / max(blend.x + blend.y + blend.z, 1e-6),
  );
}

fn surfaceTriplanarObjectSpace(materialValue : MaterialParameters) -> bool {
  return materialValue.triplanarSpace > SURFACE_TRIPLANAR_OBJECT - 0.5;
}
#else
fn surfaceProjection(input : SurfaceInput, materialValue : MaterialParameters) -> SurfaceProjection {
  return SurfaceProjection(vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0), vec3<f32>(0.0));
}

fn surfaceTriplanarObjectSpace(materialValue : MaterialParameters) -> bool {
  return false;
}
#endif

fn surfacePlaneSample(tex : texture_2d<f32>, smp : sampler, uv : vec2<f32>, dx : vec2<f32>, dy : vec2<f32>,
    transform : vec4<f32>, metadata : vec4<f32>, rotation : vec4<f32>) -> vec4<f32> {
  let scale = metadata.zw;
  return textureSampleGrad(tex, smp, (materialUvLinear(uv, transform, rotation) + transform.xy) * scale,
    materialUvLinear(dx, transform, rotation) * scale, materialUvLinear(dy, transform, rotation) * scale);
}

struct SurfaceTriplanarSamples {
  x : vec4<f32>,
  y : vec4<f32>,
  z : vec4<f32>,
};

fn surfaceTriplanarSamples(tex : texture_2d<f32>, smp : sampler, projection : SurfaceProjection,
    transform : vec4<f32>, metadata : vec4<f32>, rotation : vec4<f32>) -> SurfaceTriplanarSamples {
  let p = projection.position;
  let dx = projection.positionDx;
  let dy = projection.positionDy;
  return SurfaceTriplanarSamples(
    surfacePlaneSample(tex, smp, p.yz, dx.yz, dy.yz, transform, metadata, rotation),
    surfacePlaneSample(tex, smp, p.zx, dx.zx, dy.zx, transform, metadata, rotation),
    surfacePlaneSample(tex, smp, p.xy, dx.xy, dy.xy, transform, metadata, rotation),
  );
}

fn surfaceSample(tex : texture_2d<f32>, smp : sampler, input : SurfaceInput, triplanar : bool,
    projection : SurfaceProjection, transform : vec4<f32>, metadata : vec4<f32>, rotation : vec4<f32>) -> vec4<f32> {
  if (triplanar) {
    let samples = surfaceTriplanarSamples(tex, smp, projection, transform, metadata, rotation);
    let w = projection.weights;
    return samples.x * w.x + samples.y * w.y + samples.z * w.z;
  }
  return sampleSurfaceTexture(tex, smp, surfaceUv(input, transform, metadata, rotation) * metadata.zw,
    surfaceTextureFootprint(input, transform, metadata), input.materialTextureMipBias);
}

#endif

fn surfaceChannel(value : vec4<f32>, channel : u32) -> f32 {
  switch (channel) {
    case 0u: { return value.r; }
    case 1u: { return value.g; }
    case 2u: { return value.b; }
    default: { return value.a; }
  }
}

fn sampleStandardBaseColor(input : SurfaceInput, materialValue : MaterialParameters,
    triplanar : bool, projection : SurfaceProjection) -> vec4<f32> {
#ifdef BASE_COLOR_TEXTURE_AVAILABLE
  if (standardUsesBaseColorTexture()) {
    return surfaceSample(baseColorTexture, baseColorTexture_sampler, input, triplanar, projection,
      materialValue.baseColorTextureCoordinatesTransform,
      materialValue.baseColorTextureCoordinatesMetadata,
      materialValue.baseColorTextureCoordinatesRotation);
  }
#endif
  return vec4<f32>(1.0);
}

fn sampleStandardAlpha(input : SurfaceInput, materialValue : MaterialParameters,
    triplanar : bool, projection : SurfaceProjection, base : vec4<f32>,
    reuseLightingSamples : bool, packed : vec4<f32>, metallic : vec4<f32>) -> f32 {
#ifdef ALPHA_TEXTURE_AVAILABLE
  if (standardUsesAlphaTexture()) {
    var alphaSample = base;
    if (!standardReusesAlphaTextureFromBaseColorTexture()) {
      if (reuseLightingSamples && standardReusesAlphaTextureFromMetallicRoughnessTexture()) {
        alphaSample = packed;
      } else if (reuseLightingSamples && standardReusesAlphaTextureFromMetallicTexture()) {
        alphaSample = metallic;
      } else {
        alphaSample = surfaceSample(alphaTexture, alphaTexture_sampler, input, triplanar, projection,
          materialValue.alphaTextureCoordinatesTransform,
          materialValue.alphaTextureCoordinatesMetadata,
          materialValue.alphaTextureCoordinatesRotation);
      }
    }
    return surfaceChannel(alphaSample, u32(materialValue.alphaChannel));
  }
#endif
  return 1.0;
}

fn sampledStandardOpacity(materialAlpha : f32, vertexAlpha : f32, baseAlpha : f32, alpha : f32) -> f32 {
  return materialAlpha * baseAlpha * vertexAlpha * alpha;
}

fn sampleStandardCoverage(input : SurfaceInput, materialValue : MaterialParameters, materialAlpha : f32,
    triplanar : bool, projection : SurfaceProjection) -> f32 {
  let base = sampleStandardBaseColor(input, materialValue, triplanar, projection);
  // A coverage-only entry has no earlier lighting texels to reuse.
  let alpha = sampleStandardAlpha(input, materialValue, triplanar, projection, base,
    false, vec4<f32>(1.0), vec4<f32>(1.0));
  return sampledStandardOpacity(materialAlpha, input.vertexColor.a, base.a, alpha);
}

fn evaluateStandardTemporalAlpha(input : SurfaceInput, materialValue : MaterialParameters, materialAlpha : f32) -> f32 {
  return sampleStandardCoverage(input, materialValue, materialAlpha, false, SurfaceProjection());
}

struct StandardCoverage {
  opacity : f32,
  clipThreshold : f32,
};

fn resolveStandardCoverage(rawAlpha : f32, positionOS : vec3<f32>,
    materialValue : MaterialParameters) -> StandardCoverage {
  let sampledAlpha = clamp(rawAlpha, 0.0, 1.0);
  var alphaClipThreshold = 0.0;
#ifdef ALPHA_CLIPPING_AVAILABLE
#ifdef SURFACE_COVERAGE_DEFERRED
  let coverage = sampledAlpha;
  alphaClipThreshold = materialValue.alphaCutoff;
#else
  let coverage = alphaCoverageValue(sampledAlpha, materialValue.alphaCutoff,
#ifdef ALPHA_TO_COVERAGE_AVAILABLE
    materialValue.alphaToCoverage,
#else
    0.0,
#endif
  );
  alphaClipThreshold = alphaCoverageClipThreshold(materialValue.alphaCutoff,
#ifdef ALPHA_TO_COVERAGE_AVAILABLE
    materialValue.alphaToCoverage,
#else
    0.0,
#endif
  );
#endif
#else
  let coverage = sampledAlpha;
#endif
#ifdef ALPHA_HASH_AVAILABLE
#if ALPHA_MASK == true
  // The hash discard exists only in alpha-mask variants; see alphaTestSurface.
  applyAlphaHash(coverage, positionOS, materialValue.alphaHash);
#endif
#endif
  return StandardCoverage(coverage, alphaClipThreshold);
}

#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
fn evaluateStandardCoverageOnly(sourceInput : SurfaceInput, materialValue : MaterialParameters) -> SurfaceData {
  var input = sourceInput;
#ifdef FLAT_SHADING_AVAILABLE
  input.vertexNormalWS = select(input.vertexNormalWS, input.geometricNormalWS, materialValue.flatShading != 0u);
#endif
#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
  let projection = surfaceProjection(input, materialValue);
#else
  let projection = SurfaceProjection();
#endif
#ifdef TRIPLANAR_PROJECTION_AVAILABLE
  let triplanar = standardUsesTriplanarProjection();
#else
  let triplanar = false;
#endif
  let sampledAlpha = sampleStandardCoverage(input, materialValue, materialValue.baseColor.a, triplanar, projection);
  let coverage = resolveStandardCoverage(sampledAlpha, input.positionOS, materialValue);
  var result = SurfaceData();
  result.opacity = coverage.opacity;
  result.alphaClipThreshold = coverage.clipThreshold;
  return result;
}
#endif
