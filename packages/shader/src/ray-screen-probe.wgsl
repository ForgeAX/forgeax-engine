#define_import_path forgeax_ray::screen_probe
#import forgeax_view::common::{View}
#import forgeax_pbr::gbuffer::{loadStandardGBufferNormalRoughness, loadStandardGBufferValid, decodeStandardGBufferNormal, standardGBufferValid, STANDARD_GBUFFER_SCREEN_TRACE_CLASSIFIED_BIT, STANDARD_GBUFFER_SCREEN_TRACE_BACKFACE_DIFFUSE_BIT, STANDARD_GBUFFER_SCREEN_TRACE_MASK, decodeStandardReflectance, decodeCompactBaseColor}
#import forgeax_depth_pyramid::sample::{depthPyramidCell, depthPyramidDepthOrEmpty, depthPyramidLevelSize, projectViewDepth}
#import forgeax_ray::irradiance_field_sample::{sampleIrradianceField, sampleRadianceCacheAt, irradianceFieldOctWrap, prepareIrradianceFieldProbeVisibility}
#ifdef IRRADIANCE_FIELD_RADIANCE_ATLAS
#import forgeax_ray::irradiance_field_sample::{ScreenRadianceCoverage, screenRadianceCoverage, screenRadianceCoverageFromTrace, sampleScreenRadianceCache}
#endif
#import forgeax_ray::screen_candidate::{RAY_SCREEN_CANDIDATE, screenCandidatePack}
#import forgeax_ray::screen_reconstruction::{spCurrentSupport, spReconstructionConfidence, spReconstructionSignal, spReconstructionSource, spReconstructionTemporalAlpha}
#import forgeax_scene_temporal::{decodeSceneVelocity, sceneTemporalUv, sceneVelocityPreviousDepth, SCENE_VELOCITY_INVALID_DEPTH, unpackSceneTemporalV1}
#ifdef IRRADIANCE_FIELD_VISIBILITY
#import forgeax_ray::irradiance_field_sample::{fieldSegmentVisibility}
#endif

// Screen Probe gather (UE LumenScreenProbeGather). Probes are placed on the
// G-buffer, trace an 8x8 world-space octahedron through the previous frame's
// scene color (HZB) and then the Global SDF/Card world (render owner kernel),
// and are integrated per pixel with the Irradiance Field as world fallback.

// Must match packScreenProbeFrame() in render/raytracing/screen-probe-plan.ts.
struct ScreenProbeFrame {
  // width, height, tilesX, tilesY
  extent: vec4u,
  // uniform probes, adaptive capacity, downsample, frame index
  probes: vec4u,
  // brdf importance, screen steps, history flags (1 scene, 2 pixel, 4 probe), max frames
  control: vec4u,
  // rgb environment radiance, w max trace distance
  environment: vec4f,
  // thickness, short-range AO radius, world origin bias, Card margin
  tuning: vec4f,
  // Global SDF query settings, receiver revision, adaptive candidates per tile.
  query: vec4u,
  // Last accepted view geometry, kept across lighting-only temporal resets;
  // all zero (w included) after a geometric reset, which rejects every pixel.
  previousViewProj: mat4x4f,
  previousCameraPos: vec4f,
  // Independent accepted source tuple.
  expectedSource: vec4u,
}
// pixel == SCREEN_PROBE_NONE marks an empty probe slot.
struct ScreenProbe {
 position:vec3f, distance:f32, normal:vec3f, pixel:u32,
 canonicalLo:vec3u, receiverRow:u32, canonicalHi:vec3u, receiverPrimitive:u32,
 receiverExpected:vec4u, receiverControl:vec4u
}
// Preserve actual sampled directions until query-time cosine clipping.
// The private 40-byte packet retains exact points or four refined directions.
// Mixed packets retain linear moments plus a bounded-mass PPS residual sample.
struct ProbeRadiance {
  samples: array<vec2u, 4>,
  support: f32,
  hitDistance: f32,
}
struct DistributionBeam { radiance: vec3f, availability: u32, direction: vec3f, measure: f32 }
struct DistributionQuery { weighted: vec4f, support: f32 }
const DISTRIBUTION_SCENE_UNKNOWN = 0xffffffffu;
const DISTRIBUTION_RADIANCE_UNKNOWN = 0xfffffffeu;

// Three signed 10-bit vector coordinates leave two spare bits per beam.
// Keep mode/count/depth there, preserving every support/age and hit-distance bit.
fn setDistributionMetadata(p:ptr<function,ProbeRadiance>,sampleSet:bool,count:u32,depth:u32){
 (*p).samples[2].y=((*p).samples[2].y&0x3fffffffu)|((depth&3u)<<30u);
 (*p).samples[3].y=((*p).samples[3].y&0x3fffffffu)|select(0u,0x80000000u,sampleSet);
 if(sampleSet){(*p).samples[1].y=((*p).samples[1].y&0x3fffffffu)|((count-1u)<<30u);}
}
fn distributionUnsupported(p:ProbeRadiance)->bool{return (p.samples[3].y>>30u)==1u;}
fn distributionAge(p:ProbeRadiance)->f32{return p.support;}
fn distributionIsSet(p:ProbeRadiance)->bool{return (p.samples[3].y&0x80000000u)!=0u;}
fn distributionCount(p:ProbeRadiance)->u32{return (p.samples[1].y>>30u)+1u;}
fn distributionDepth(p:ProbeRadiance)->u32{if(cvIs(p)){return (p.samples[3].y>>26u)&3u;}return p.samples[2].y>>30u;}

fn distributionOctEncode(d: vec3f, resolution: f32) -> u32 {
  let unit = d / dot(abs(d), vec3f(1.0));
  var p = unit.xy;
  if (unit.z < 0.0) { p = (vec2f(1.0) - abs(p.yx)) * select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0)); }
  let xy = vec2u(round(clamp(p * 0.5 + vec2f(0.5), vec2f(0.0), vec2f(1.0)) * resolution));
  let shift = select(8u, 10u, resolution > 255.0);
  return xy.x | (xy.y << shift);
}
fn distributionOctDecode(code: u32, resolution: f32) -> vec3f {
  let shift = select(8u, 10u, resolution > 255.0);
  let p = vec2f(f32(code & u32(resolution)), f32((code >> shift) & u32(resolution))) * (2.0 / resolution) - vec2f(1.0);
  var d = vec3f(p, 1.0 - abs(p.x) - abs(p.y));
  if (d.z < 0.0) { d = vec3f((vec2f(1.0) - abs(p.yx)) * select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0)), d.z); }
  return normalize(d);
}
fn distributionRgbEncode(rgb: vec3f) -> u32 {
  if (!all(rgb >= vec3f(0.0)) || any((bitcast<vec3u>(rgb) & vec3u(0x7f800000u)) == vec3u(0x7f800000u))) { return DISTRIBUTION_RADIANCE_UNKNOWN; }
  let peak = max(max(rgb.x, rgb.y), rgb.z);
  if (!(peak > 0.0)) { return 0u; }
  var exponent = (bitcast<u32>(peak) >> 23u) & 255u;
  var scale = bitcast<f32>(max(exponent, 1u) << 23u);
  var mantissa = vec3u(round((rgb / scale) * 128.0));
  if (any(mantissa > vec3u(255u)) && exponent < 254u) {
    exponent++;
    scale = bitcast<f32>(max(exponent, 1u) << 23u);
    mantissa = vec3u(round((rgb / scale) * 128.0));
  }
  mantissa = min(mantissa, vec3u(255u));
  return (exponent << 24u) | (mantissa.x << 16u) | (mantissa.y << 8u) | mantissa.z;
}
fn distributionRgbDecode(word: u32) -> vec3f {
  let exponent = word >> 24u;
  let scale = bitcast<f32>(max(exponent, 1u) << 23u);
  return vec3f(f32((word >> 16u) & 255u), f32((word >> 8u) & 255u), f32(word & 255u)) * (scale / 128.0);
}
fn distributionPoint(weighted: vec4f, direction: vec3f, age: f32, distance: f32, depth: u32) -> ProbeRadiance {
  var p: ProbeRadiance;
  p.samples[0] = bitcast<vec2u>(weighted.xy);
  p.samples[1] = bitcast<vec2u>(weighted.zw);
  p.samples[2] = vec2u(distributionOctEncode(direction, 1023.0), 0u);
  p.samples[3] = vec2u(0u);
  p.support=age;setDistributionMetadata(&p,false,1u,depth);
  p.hitDistance = distance;
  return p;
}
fn distributionPointWeighted(p: ProbeRadiance) -> vec4f { return vec4f(bitcast<vec2f>(p.samples[0]), bitcast<vec2f>(p.samples[1])); }
fn distributionBeamEncode(b: DistributionBeam) -> vec2u {
  var color = distributionRgbEncode(b.radiance);
  if (b.availability == 1u) { color = DISTRIBUTION_RADIANCE_UNKNOWN; }
  if (b.availability == 2u) { color = DISTRIBUTION_SCENE_UNKNOWN; }
  // Convex means of physical J*d retain the component bound below 4.
  let v=vec3i(round(clamp(b.direction*b.measure/4.0,vec3f(-1.0),vec3f(1.0))*511.0));
  let bits=bitcast<vec3u>(v)&vec3u(1023u);
  return vec2u(color,bits.x|(bits.y<<10u)|(bits.z<<20u));
}
fn distributionWeightedDirection(word:u32)->vec3f{
 return vec3f(f32(bitcast<i32>(word<<22u)>>22u),f32(bitcast<i32>(word<<12u)>>22u),f32(bitcast<i32>(word<<2u)>>22u))*(4.0/511.0);
}

fn distributionBeamDecode(word: vec2u) -> DistributionBeam {
  let weighted=distributionWeightedDirection(word.y);let measure=length(weighted);
  let direction=weighted/max(measure,1e-30);
  var availability = 0u;
  if (word.x == DISTRIBUTION_RADIANCE_UNKNOWN) { availability = 1u; }
  if (word.x == DISTRIBUTION_SCENE_UNKNOWN) { availability = 2u; }
  var rgb = vec3f(0.0);
  if (availability == 0u) { rgb = distributionRgbDecode(word.x); }
  return DistributionBeam(rgb, availability, direction, measure);
}
fn distributionSet(beams: array<DistributionBeam, 4>, age: f32, distance: f32, depth: u32) -> ProbeRadiance {
  var p: ProbeRadiance;
  for (var i = 0u; i < 4u; i++) { p.samples[i] = distributionBeamEncode(beams[i]); }
  p.support=age;setDistributionMetadata(&p,true,4u,depth);
  p.hitDistance = distance;
  return p;
}
fn distributionQuery(p: ProbeRadiance, normal: vec3f) -> DistributionQuery {if(cvIs(p)){return cvQuery(p,normal);}
  if(distributionUnsupported(p)){return DistributionQuery(vec4f(0.0),-1.0);}
  var result = DistributionQuery(vec4f(0.0), 1.0);
  let norm = length(normal);
  if (!distributionIsSet(p)) {
    let d = distributionOctDecode(p.samples[2].x, 1023.0);
    let cosine = dot(d, normal);
    if (!(distributionAge(p) > 0.0)) {
      if (distributionAge(p) == -2.0 && cosine < -(2.0 * sqrt(18.0) / 1023.0 + 2e-6) * norm) { return result; }
      result.support = select(0.0, -1.0, distributionAge(p) < 0.0);
      return result;
    }
    result.weighted = distributionPointWeighted(p) * max(cosine, 0.0);
    return result;
  }
  for(var i=0u;i<distributionCount(p);i++){
    let word=p.samples[i];let weightedDirection=distributionWeightedDirection(word.y);let projected=dot(weightedDirection,normal);
    if(word.x==DISTRIBUTION_SCENE_UNKNOWN||word.x==DISTRIBUTION_RADIANCE_UNKNOWN){
      if(projected < -(sqrt(3.0)*2.0/511.0+4e-6)*norm){continue;}
      result.support=min(result.support,select(0.0,-1.0,word.x==DISTRIBUTION_SCENE_UNKNOWN));continue;
    }
    var rgb=vec3f(0.0);if(word.x!=0u){rgb=distributionRgbDecode(word.x);}
    result.weighted+=vec4f(rgb,1.0)*(max(projected,0.0)/f32(distributionCount(p)));
  }
  return result;
}

// Expose the mixture phase so GPU tests can integrate independent phases and
// falsify fixed-phase bias. Dense linear statistics retain global 12-bit axes;
// the PPS sample retains the actual selected direction for cosine clipping.

fn momentAxis(v:vec3f)->vec4f{
 let scale=max(abs(v.x),max(abs(v.y),abs(v.z)));if(!(scale>0.0)){return vec4f(0,0,1,0);}
 let unit=v/scale;let size=length(unit);return vec4f(unit/size,scale*size);
}




fn distributionMomentDirection(code:u32)->vec3f{
 return spOctDecode(vec2f(f32(code&4095u),f32(code>>12u))*(2.0/4095.0)-vec2f(1.0));
}

fn distributionMoments(p:ProbeRadiance)->mat3x4f{if(cvIs(p)){return cvMoments(p);}

 if(!distributionIsSet(p)){
  let value=distributionPointWeighted(p);let d=distributionOctDecode(p.samples[2].x,1023.0);
  return mat3x4f(value*d.x,value*d.y,value*d.z);
 }
 var result=mat3x4f();let count=distributionCount(p);
 for(var i=0u;i<count;i++){
  let word=p.samples[i];let d=distributionWeightedDirection(word.y);let value=vec4f(distributionRgbDecode(word.x),1.0)/f32(count);
  result+=mat3x4f(value*d.x,value*d.y,value*d.z);
 }
 return result;
}







fn probeRadianceValue(p:ProbeRadiance)->vec4f {if(cvIs(p)){return vec4f(0,0,0,p.support);}
  if(distributionUnsupported(p)){return vec4f(0.0,0.0,0.0,-1.0);}
  if(distributionIsSet(p)){return vec4f(0,0,0,distributionAge(p));}
  return vec4f(distributionPointWeighted(p).xyz,distributionAge(p));
}
fn probeRadianceMeasure(p:ProbeRadiance)->f32 {if(cvIs(p)){return bitcast<f32>(p.samples[3].x);}
  if(distributionUnsupported(p)){return 0.0;}
  if(distributionIsSet(p)){return 1.0;}return distributionPointWeighted(p).w;
}
fn probeMixturePhase(probe:u32,texel:u32,stage:u32,depth:u32)->f32 {
 return spUnit(probesIn[probe].pixel ^ spHash(probeFrame.probes.w+stage) ^ spHash(texel+depth*64u));
}
struct ProbeHistory { probe: ScreenProbe, radiance: array<ProbeRadiance, 64> }
// info: texel (6) | sub (2) << 6 | refined << 8 | used << 9 | status << 12
// hitDistance uses the existing trailing 4-byte padding: the ray stays 32 bytes.
// Negative means no resolved distance; zero is a supported immediate blocker.
struct ProbeRay { direction: vec3f, info: u32, radiance: vec3f, hitDistance: f32 }

const SCREEN_PROBE_NONE = 0xffffffffu;
const STATUS_RESOLVED = 0u;
const STATUS_WORLD = 1u;
const STATUS_FALLBACK = 2u;
const STATUS_CULLED = 3u;
const STATUS_INCOMPLETE = 4u;
const STATUS_CACHE_BOUNDARY = 5u;
// Bits 16..18 carry the authenticated clipmap index plus one; zero means
// the generator did not qualify a cache boundary for this frame's atlas.
const RAY_CACHE_LEVEL_SHIFT = 16u;
const RAY_CACHE_LEVEL_MASK = 7u;
// Scratch support: -1 missing scene, 0 missing radiance, 1 complete transport.
// Missing scene propagates to the pixel; it cannot request another cache fallback.
const SUPPORT_INCOMPLETE = -1.0;
// A single unresolved sample retains its actual direction in the measure
// moment. Queries may exclude it only with a certified nonpositive cosine.
const SUPPORT_DIRECTIONAL_INCOMPLETE = -2.0;
const RAY_USED = 512u;
const RAY_REFINED = 256u;
// SCREEN_PROBE_HIT_MOVING in the private trace record.
const RAY_HIT_MOVING = 1u << 20u;
// Private zero-payload policy marker, not radiance, probability or known black.
// Default/unavailable packets remain unmarked and keep their ordinary rejection.
const SUPPORT_POLICY_CULL = -3.0;
const SUPPORT_SCATTER_EMPTY = -4.0;
const SUPPORT_SPATIAL_ESTIMATE = 0.5;
fn distributionPolicyCull(texel:u32)->ProbeRadiance {
  var p:ProbeRadiance;
  p.samples[2].x=texel;p.support=SUPPORT_POLICY_CULL;p.hitDistance=-1.0;
  return p;
}
fn distributionIsPolicyCull(p:ProbeRadiance,texel:u32)->bool {
  return p.support==SUPPORT_POLICY_CULL&&p.hitDistance==-1.0&&
    p.samples[0].x==0u&&p.samples[0].y==0u&&p.samples[1].x==0u&&p.samples[1].y==0u&&
    p.samples[2].x==texel&&p.samples[2].y==0u&&p.samples[3].x==0u&&p.samples[3].y==0u;
}
// Generation and canonical receiver preparation preserve the same shading
// normal. Only its current BRDF policy can explain an unassigned cell.
fn probePolicyCull(probe:u32,texel:u32)->bool {
  let receiver=probesIn[probe];
  return probeLive(probe)&&probeFrame.control.x!=0u&&
    all((bitcast<vec3u>(receiver.normal)&vec3u(0x7fffffffu))<vec3u(0x40000000u))&&dot(receiver.normal,receiver.normal)>0.0&&
    spReconstructionSource(receiver.receiverExpected,receiver.receiverControl,probeFrame.probes.w,
      probeFrame.query.z,probeFrame.expectedSource,probeFrame.control.z)&&
    !probeCellMayContribute(texel,receiver.normal);
}
// Each folded oct cell is piecewise affine; 8-grid seams cross its vertices.
// For unnormalized v, |v|_1=1 and |v|>=1/sqrt(3), hence J*cos<=9*max(dot(v,n),0).
// The 256u allowance (u=2^-24) also covers the inherited f32 oct construction,
// normalize and J*cos errors, not just the corner dot/final scaling. Its 9x
// expansion exceeds their conservative unit-scale absolute error bound.
// Sixteen min-normal units cover
// optional subnormal flushes. Inputs |n|_infinity<2 keep intermediates below54.
// This bounds only missing projected measure, never an unobserved RGB value.
fn probePolicyCullProjectedBound(texel:u32,normal:vec3f)->f32 {
  if(!all((bitcast<vec3u>(normal)&vec3u(0x7fffffffu))<vec3u(0x40000000u))){return -1.0;}
  let allowance=(abs(normal.x)+abs(normal.y)+abs(normal.z))*0x1p-16+0x1p-122;
  var bound=0.0;
  for(var corner=0u;corner<4u;corner++){
    let x=f32(texel%8u+(corner&1u))*0.25-1.0;
    let y=f32(texel/8u+(corner>>1u))*0.25-1.0;
    let z=1.0-abs(x)-abs(y);
    let vx=select(x,(1.0-abs(y))*select(-1.0,1.0,x>=0.0),z<0.0);
    let vy=select(y,(1.0-abs(x))*select(-1.0,1.0,y>=0.0),z<0.0);
    bound=max(bound,vx*normal.x+vy*normal.y+z*normal.z+allowance);
  }
  if(!(bound>0.0)){return 0.0;}
  bound*=9.0;
  return bitcast<f32>(bitcast<u32>(bound)+1u);
}

// Unique group-0 bindings; each pipeline layout names only its entry's roster.
@group(0) @binding(0) var<uniform> probeFrame: ScreenProbeFrame;
@group(0) @binding(1) var<uniform> view: View;
@group(0) @binding(2) var gbufferDepth: texture_depth_2d;
@group(0) @binding(3) var gbufferNormal: texture_2d<u32>;
@group(0) @binding(4) var depthPyramid: texture_2d<f32>;
@group(0) @binding(5) var sceneColor: texture_2d<f32>;
@group(0) @binding(42) var directionalReflection: texture_2d<f32>;
@group(0) @binding(6) var<storage, read_write> probes: array<ScreenProbe>;
@group(0) @binding(7) var<storage, read> probesIn: array<ScreenProbe>;
@group(0) @binding(8) var<storage, read_write> adaptiveCount: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read> adaptiveCountIn: array<u32>;
@group(0) @binding(10) var<storage, read_write> tileAdaptive: array<u32>;
@group(0) @binding(11) var<storage, read> tileAdaptiveIn: array<u32>;
@group(0) @binding(12) var<storage, read_write> rays: array<ProbeRay>;
@group(0) @binding(13) var<storage, read> raysIn: array<ProbeRay>;
@group(0) @binding(14) var<storage, read> previousScene: array<vec2u>;
@group(0) @binding(15) var<storage, read_write> previousSceneOut: array<vec2u>;
@group(0) @binding(33) var<storage, read> previousScreenDepth: array<f32>;
@group(0) @binding(34) var<storage, read_write> previousScreenDepthOut: array<f32>;
@group(0) @binding(35) var screenMotion: texture_2d<f32>;
@group(0) @binding(44) var motionWithDepth: texture_2d<u32>;
@group(0) @binding(45) var<storage, read_write> receiverMotionOut: array<vec2f>;
@group(0) @binding(46) var<storage, read> receiverMotionIn: array<vec2f>;
@group(0) @binding(47) var<storage, read_write> probeMovingOut: array<f32>;
@group(0) @binding(48) var<storage, read> probeMovingIn: array<f32>;
@group(0) @binding(49) var<storage, read_write> pixelMovingOut: array<u32>;
@group(0) @binding(50) var<storage, read> pixelMovingIn: array<u32>;
@group(0) @binding(16) var<storage, read> radianceIn: array<ProbeRadiance>;
// w is directional support, including an admitted retained cache estimate.
// Ray status still distinguishes actual resolved rays from cache reconstruction.
@group(0) @binding(17) var<storage, read_write> radianceOut: array<ProbeRadiance>;
@group(0) @binding(19) var<storage, read> filteredProbeRadiance: array<ProbeRadiance>;
@group(0) @binding(20) var<storage, read_write> integratedOut: array<vec4f>;
@group(0) @binding(21) var<storage, read> integrated: array<vec4f>;
@group(0) @binding(22) var<storage, read> historyIn: array<vec4f>;
@group(0) @binding(23) var<storage, read_write> historyOut: array<vec4f>;
@group(0) @binding(24) var<storage, read> metaIn: array<vec4u>;
@group(0) @binding(25) var<storage, read_write> metaOut: array<vec4u>;
@group(0) @binding(26) var<storage, read> probeHistoryIn: array<ProbeHistory>;
@group(0) @binding(27) var<storage, read_write> probeHistoryOut: array<ProbeHistory>;
@group(0) @binding(39) var<storage, read_write> shortRangeAoOut: array<vec4f>;
@group(0) @binding(40) var<storage, read> shortRangeAoIn: array<vec4f>;
@group(0) @binding(41) var scatterNoise: texture_2d<f32>;
@group(0) @binding(43) var gbufferAlbedo: texture_2d<u32>;

struct TraceFallbackList { count: atomic<u32>, slots: array<u32> }
struct TraceCell { color: u32, stateDistance: u32 }
@group(0) @binding(28) var<storage, read_write> fallbackList: TraceFallbackList;
@group(0) @binding(29) var<storage, read> fallbackListIn: array<u32>;
@group(0) @binding(30) var<storage, read_write> traceDispatch: array<u32>;
@group(0) @binding(31) var<storage, read_write> traceCells: array<TraceCell>;
@group(0) @binding(32) var<storage, read> traceCellsIn: array<TraceCell>;

fn spLinearId(gid: vec3u, groups: vec3u) -> u32 { return gid.x + gid.y * groups.x * 64u; }
fn spGroupId(wid: vec3u, groups: vec3u) -> u32 { return wid.x + wid.y * groups.x; }

fn spHash(x: u32) -> u32 {
  var v = x * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (v >> 22u) ^ v;
}
fn spUnit(x: u32) -> f32 { return f32(spHash(x) >> 8u) / 16777216.0; }

fn spOctEncode(direction: vec3f) -> vec2f {
  let n = direction / (abs(direction.x) + abs(direction.y) + abs(direction.z));
  if (n.z >= 0.0) { return n.xy; }
  return (vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
}
fn spOctDecode(p: vec2f) -> vec3f {
  var n = vec3f(p, 1.0 - abs(p.x) - abs(p.y));
  if (n.z < 0.0) {
    n = vec3f((vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0)), n.z);
  }
  return normalize(n);
}
// Center direction of an 8x8 world-space octahedral texel.
fn texelDirection(texel: u32) -> vec3f {
  let xy = (vec2f(f32(texel % 8u), f32(texel / 8u)) + vec2f(0.5)) / 8.0;
  return spOctDecode(xy * 2.0 - vec2f(1.0));
}

fn extentSize() -> vec2u { return probeFrame.extent.xy; }
fn pixelIndex(pixel: vec2u) -> u32 { return pixel.y * probeFrame.extent.x + pixel.x; }
fn packPixel(pixel: vec2u) -> u32 { return pixel.x | (pixel.y << 16u); }
fn unpackPixel(packed: u32) -> vec2u { return vec2u(packed & 0xffffu, packed >> 16u); }
fn validDepth(z: f32) -> bool { return z > 0.0 && z < 1.0; }
fn gbufferMatches() -> bool { return all(textureDimensions(gbufferDepth) == extentSize()); }

fn worldPositionAtUv(uv: vec2f, z: f32) -> vec3f {
  let p = view.inverseViewProj * vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), z, 1.0);
  return p.xyz / p.w;
}

fn worldPosition(pixel: vec2u, z: f32) -> vec3f {
  return worldPositionAtUv((vec2f(pixel) + vec2f(0.5)) / vec2f(extentSize()), z);
}

fn emptyProbe() -> ScreenProbe { var p:ScreenProbe;p.normal=vec3f(0,0,1);p.pixel=SCREEN_PROBE_NONE;return p; }

fn probeAt(pixel: vec2u) -> ScreenProbe {
  let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
  if (!validDepth(z)) { return emptyProbe(); }
  let position = worldPosition(pixel, z);
  if (!loadStandardGBufferValid(gbufferNormal, vec2i(pixel))) { return emptyProbe(); }
  let normal = loadStandardGBufferNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  var p=emptyProbe();p.position=position;p.distance=length(view.cameraPos-position);p.normal=normal;p.pixel=packPixel(pixel);return p;
}

fn tileCount() -> vec2u { return probeFrame.extent.zw; }

// All tiles share one Hammersley offset. The interpolation lattice and its
// previous-frame projection use the same placement phase, not nominal centers.
fn probeSequence(frameIndex: u32) -> vec2f {
  let phase = frameIndex % 8u;
  let reversed = ((phase & 1u) << 2u) | (phase & 2u) | ((phase & 4u) >> 2u);
  return vec2f(f32(phase), f32(reversed)) * 0.125;
}
// A prefix-preserving permutation of binary digits. Addition, odd
// multiplication and left XOR shifts are bijections on every low-bit prefix;
// reversing on both sides therefore preserves every high-bit sample stratum.
fn probeDigitalScramble(bits: u32, seed: u32) -> u32 {
  var value = reverseBits(bits);
  value ^= value << 13u;
  value *= 747796405u;
  value += seed;
  value ^= value << 11u;
  value *= 277803737u;
  value ^= value << 7u;
  return reverseBits(value);
}
fn probeAngularSample(frameIndex: u32, seed: u32) -> vec2f {
  // The first two Sobol dimensions form a base-2 (0,2)-sequence. Unlike a
  // continuously shifted eight-point pattern, every aligned binary block
  // stratifies both coordinates jointly. Placement keeps its separate cycle.
  // Shuffle sample order separately from coordinate scrambling. Both preserve
  // aligned binary blocks, but only the shuffle decorrelates access order from
  // the repeated screen placement and its finite reconstruction history.
  let index = probeDigitalScramble(frameIndex, spHash(seed ^ 0x3c6ef372u));
  // Pascal's binary transform evaluates the second Sobol dimension without a
  // frame-dependent loop. These subset-XOR stages equal its direction matrix.
  var second = index;
  second ^= (second >> 1u) & 0x55555555u;
  second ^= (second >> 2u) & 0x33333333u;
  second ^= (second >> 4u) & 0x0f0f0f0fu;
  second ^= (second >> 8u) & 0x00ff00ffu;
  second ^= (second >> 16u) & 0x0000ffffu;
  let bits = vec2u(probeDigitalScramble(reverseBits(index), spHash(seed)),
    probeDigitalScramble(reverseBits(second), spHash(seed ^ 0x9e3779b9u)));
  // Retain exactly representable f32 coordinates in [0,1), including u32 wrap.
  return vec2f(bits >> vec2u(8u)) / 16777216.0;
}
fn probeDirectionTileSample(tile: vec2u, frameIndex: u32) -> vec2f {
  // Lumen's texture-free directional jitter uses tile-seeded Hammersley16.
  var seed = vec3u(tile, 0u) * 1664525u + vec3u(1013904223u);
  for (var round = 0u; round < 2u; round++) {
    seed.x += seed.y * seed.z;
    seed.y += seed.z * seed.x;
    seed.z += seed.x * seed.y;
  }
  let phase = frameIndex % 8u;
  let offset = seed.xy >> vec2u(16u);
  return vec2f(fract(f32(phase) / 8.0 + f32(offset.x) / 65536.0),
    f32((reverseBits(phase) >> 16u) ^ offset.y) / 65536.0);
}

fn uniformProbeJitter(frameIndex: u32) -> vec2u {
  return vec2u(probeSequence(3u) * f32(probeFrame.probes.z));
}
// Anchor the outermost samples to pixel centers at the viewport edges.
// Interior tiles retain their shared jitter; invert the two boundary intervals
// explicitly so nominal weights also follow placement on incompatible geometry.
fn uniformProbeAxis(pixel: f32, jitter: u32, extent: u32, tiles: u32) -> f32 {
  if (tiles == 1u) { return 0.0; }
  if (tiles == 2u) { return clamp((pixel - 0.5) / f32(extent - 1u), 0.0, 1.0); }
  let ds = f32(probeFrame.probes.z);
  let interior = (pixel - f32(jitter) - 0.5) / ds;
  if (interior < 1.0) {
    return clamp((pixel - 0.5) / (ds + f32(jitter)), 0.0, 1.0);
  }
  let lastInterior = f32(tiles - 2u);
  if (interior > lastInterior) {
    let start = lastInterior * ds + f32(jitter);
    return lastInterior + clamp((pixel - 0.5 - start) / (f32(extent - 1u) - start), 0.0, 1.0);
  }
  return interior;
}
fn uniformProbeGrid(pixel: vec2f, frameIndex: u32) -> vec2f {
  let jitter = uniformProbeJitter(frameIndex);
  let extent = extentSize();
  let tiles = tileCount();
  return vec2f(uniformProbeAxis(pixel.x, jitter.x, extent.x, tiles.x),
    uniformProbeAxis(pixel.y, jitter.y, extent.y, tiles.y));
}

// Plane and normal agreement between a probe and a receiver (UE
// ScreenProbeInterpolation depth/normal weights). Relative to view distance.
fn probeAgreement(probe: ScreenProbe, position: vec3f, normal: vec3f, distance: f32) -> f32 {
  if (probe.pixel == SCREEN_PROBE_NONE) { return 0.0; }
  let plane = abs(dot(probe.position - position, normal)) / max(0.03 * distance, 1e-4);
  let facing = max(dot(probe.normal, normal), 0.0);
  return exp(-plane * plane) * facing * facing * facing * facing;
}

// Coplanar surfaces can belong to separate rooms. Geometry agreement alone
// cannot admit transport between them: check the shared live scene projection
// from normal-biased endpoints, preserving unavailable coverage as rejection.
fn probeVisibility(probe: ScreenProbe, position: vec3f, normal: vec3f) -> f32 {
#ifdef IRRADIANCE_FIELD_VISIBILITY
  return fieldSegmentVisibility(position + normal * probeFrame.tuning.z,
    probe.position + probe.normal * probeFrame.tuning.z);
#else
  return 1.0;
#endif
}

struct UniformTaps { probes: vec4u, weights: vec4f }

// Invert the actual four placed positions; a nominal tile only selects taps.
// Incompatible or degenerate geometry keeps the existing covered weights.
fn probeInterpolationWeights(position: vec3f, fraction: vec2f,
    source: ptr<function, array<ScreenProbe, 4>>, agreement: vec4f) -> vec4f {
  let nominal = vec4f((1.0 - fraction.x) * (1.0 - fraction.y),
    fraction.x * (1.0 - fraction.y), (1.0 - fraction.x) * fraction.y,
    fraction.x * fraction.y);
  if (any(agreement < vec4f(0.05))) { return nominal; }
  let p0 = (*source)[0].position;
  let a = (*source)[1].position - p0;
  let b = (*source)[2].position - p0;
  let c = (*source)[3].position - p0 - a - b;
  let tiles = tileCount();
  if (tiles.y == 1u || tiles.x == 1u) {
    let edge = select(a, b, tiles.x == 1u);
    let square = dot(edge, edge);
    if (square < 1e-8) { return nominal; }
    let value = clamp(dot(position - p0, edge) / square, 0.0, 1.0);
    return select(vec4f(1.0 - value, value, 0.0, 0.0),
      vec4f(1.0 - value, 0.0, value, 0.0), tiles.x == 1u);
  }
  var uv = fraction;
  let scale = max(dot(a, a) + dot(b, b), 1e-8);
  for (var iteration = 0u; iteration < 6u; iteration++) {
    let residual = position - (p0 + a * uv.x + b * uv.y + c * uv.x * uv.y);
    if (dot(residual, residual) <= 1e-10 * scale) { break; }
    let x = a + c * uv.y; let y = b + c * uv.x;
    let xx = dot(x, x); let xy = dot(x, y); let yy = dot(y, y);
    let determinant = xx * yy - xy * xy;
    if (determinant <= 1e-6 * xx * yy) { return nominal; }
    let xr = dot(x, residual); let yr = dot(y, residual);
    uv = clamp(uv + vec2f(yy * xr - xy * yr, xx * yr - xy * xr) / determinant,
      vec2f(0.0), vec2f(1.0));
  }
  let residual = position - (p0 + a * uv.x + b * uv.y + c * uv.x * uv.y);
  if (dot(residual, residual) > 1e-8 * scale) { return nominal; }
  return vec4f((1.0 - uv.x) * (1.0 - uv.y), uv.x * (1.0 - uv.y),
    (1.0 - uv.x) * uv.y, uv.x * uv.y);
}

// Bilinear uniform probes around a pixel; empty taps carry zero weight.
fn uniformTaps(pixel: vec2u, position: vec3f, normal: vec3f, distance: f32,
    source: ptr<function, array<ScreenProbe, 4>>) -> UniformTaps {
  let tiles = tileCount();
  let g = uniformProbeGrid(vec2f(pixel) + vec2f(0.5), probeFrame.probes.w);
  let base = vec2u(min(floor(g), vec2f(max(tiles, vec2u(2u)) - vec2u(2u))));
  let f = g - vec2f(base);
  var out = UniformTaps(vec4u(SCREEN_PROBE_NONE), vec4f(0.0));
  var agreement = vec4f(0.0);
  for (var tap = 0u; tap < 4u; tap++) {
    let offset = vec2u(tap & 1u, tap >> 1u);
    let tile = min(base + offset, tiles - vec2u(1u));
    let index = tile.y * tiles.x + tile.x;
    out.probes[tap] = index;
    agreement[tap] = probeAgreement((*source)[tap], position, normal, distance);
  }
  out.weights = probeInterpolationWeights(position, f, source, agreement) * agreement;
  return out;
}

fn adaptiveSlots() -> u32 { return max(probeFrame.query.w & 31u, 4u); }
fn adaptiveGrid() -> vec2u {
  let slots = adaptiveSlots();
  let x = select(2u, 4u, slots >= 8u);
  return vec2u(x, slots / x);
}
fn adaptiveTileExtent(tile: vec2u) -> vec2u {
  let ds = probeFrame.probes.z;
  return min(vec2u(ds), extentSize() - tile * ds);
}
fn adaptiveSlotForPixel(tile: vec2u, pixel: vec2u) -> u32 {
  let grid = adaptiveGrid();
  let origin = tile * probeFrame.probes.z;
  let size = adaptiveTileExtent(tile);
  let local = clamp(pixel, origin, origin + size - vec2u(1u)) - origin;
  let cell = ((2u * local + vec2u(1u)) * grid) / (2u * size);
  return (tile.y * tileCount().x + tile.x) * adaptiveSlots() + cell.x + cell.y * grid.x;
}

// One thread per uniform tile; it also empties the matching adaptive slots so
// stale adaptive probes from the previous frame never reach later stages.
#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
@compute @workgroup_size(64) fn placeUniformProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let uniformCount = probeFrame.probes.x;
  if (i == 0u) { atomicStore(&adaptiveCount[0], 0u); }
  if (i >= uniformCount) { return; }
  if (i < probeFrame.probes.y) { probes[uniformCount + i] = emptyProbe(); }
  let slots = adaptiveSlots();
  for (var s = 0u; s < slots; s++) { tileAdaptive[i * slots + s] = SCREEN_PROBE_NONE; }
  probes[i] = emptyProbe();
  if (!gbufferMatches()) { return; }
  let tiles = tileCount();
  let ds = probeFrame.probes.z;
  let tile = vec2u(i % tiles.x, i / tiles.x);
  let extent = extentSize();
  let jitter = uniformProbeJitter(probeFrame.probes.w);
  var sample = min(tile * ds + jitter, extent - vec2u(1u));
  sample = select(sample, vec2u(0u), (tile == vec2u(0u)) & (tiles > vec2u(1u)));
  sample = select(sample, extent - vec2u(1u), (tile == tiles - vec2u(1u)) & (tiles > vec2u(1u)));
  let candidates = array<vec2u, 2>(sample, tile * ds + vec2u(ds / 2u));
  for (var c = 0u; c < 2u; c++) {
    let pixel = min(candidates[c], extent - vec2u(1u));
    let probe = probeAt(pixel);
    if (probe.pixel != SCREEN_PROBE_NONE) { probes[i] = probe; return; }
  }
}
#endif

// Candidates are enumerated in raster order to retain binary-searchable
// adaptive history. Partial tiles admit each physical pixel at most once.
fn adaptiveCandidateCell(i: u32) -> vec2u {
  let stride = tileCount().x * adaptiveGrid().x;
  return vec2u(i % stride, i / stride);
}
fn adaptivePixel(i: u32) -> vec2u {
  let grid = adaptiveGrid();
  let cell = adaptiveCandidateCell(i);
  let tile = cell / grid;
  return tile * probeFrame.probes.z +
    ((2u * (cell % grid) + vec2u(1u)) * adaptiveTileExtent(tile)) / (2u * grid);
}
fn adaptiveTileSlot(i: u32) -> u32 {
  let grid = adaptiveGrid();
  let cell = adaptiveCandidateCell(i);
  let tile = cell / grid;
  let local = cell % grid;
  return (tile.y * tileCount().x + tile.x) * adaptiveSlots() + local.x + local.y * grid.x;
}
fn adaptiveEligible(i: u32) -> bool {
  if (i >= probeFrame.probes.x * adaptiveSlots() || probeFrame.probes.y == 0u || !gbufferMatches()) { return false; }
  let pixel = adaptivePixel(i);
  if (adaptiveSlotForPixel(pixel / probeFrame.probes.z, pixel) != adaptiveTileSlot(i)) { return false; }
  let candidate = probeAt(pixel);
  if (candidate.pixel == SCREEN_PROBE_NONE) { return false; }
  let tiles = tileCount();
  var source: array<ScreenProbe, 4>;
  let g = uniformProbeGrid(vec2f(pixel) + vec2f(0.5), probeFrame.probes.w);
  let base = vec2u(min(floor(g), vec2f(max(tiles, vec2u(2u)) - vec2u(2u))));
  for (var tap = 0u; tap < 4u; tap++) {
    let tile = min(base + vec2u(tap & 1u, tap >> 1u), tiles - vec2u(1u));
    source[tap] = probes[tile.y * tiles.x + tile.x];
  }
  let taps = uniformTaps(pixel, candidate.position, candidate.normal, candidate.distance, &source);
  return dot(taps.weights, vec4f(1.0)) < 0.25;
}
var<workgroup> adaptivePrefix: array<u32, 64>;
var<workgroup> adaptiveBase: u32;

#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
@compute @workgroup_size(64) fn placeAdaptiveProbes(@builtin(workgroup_id) wid: vec3u,
    @builtin(num_workgroups) groups: vec3u, @builtin(local_invocation_index) lane: u32) {
  let group = spGroupId(wid, groups);
  let i = group * 64u + lane;
  let eligible = select(0u, 1u, adaptiveEligible(i));
  adaptivePrefix[lane] = eligible;
  let candidateCount = probeFrame.probes.x * adaptiveSlots();
  if (i < candidateCount) { tileAdaptive[adaptiveTileSlot(i)] = eligible; }
  workgroupBarrier();
  if (lane == 0u && group < (candidateCount + 63u) / 64u) {
    var count = 0u;
    for (var j = 0u; j < 64u; j++) { count += adaptivePrefix[j]; }
    atomicStore(&adaptiveCount[group + 1u], count);
    atomicAdd(&adaptiveCount[0], count);
  }
}
#endif

// Row-major receiver order determines both physical slots and admission when
// capacity is exhausted. Workgroup scheduling never selects a different tail.
#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
@compute @workgroup_size(64) fn compactAdaptiveProbes(@builtin(workgroup_id) wid: vec3u,
    @builtin(num_workgroups) groups: vec3u, @builtin(local_invocation_index) lane: u32) {
  let group = spGroupId(wid, groups);
  let i = group * 64u + lane;
  var eligible = 0u;
  let candidateCount = probeFrame.probes.x * adaptiveSlots();
  if (i < candidateCount) { eligible = tileAdaptive[adaptiveTileSlot(i)]; }
  adaptivePrefix[lane] = eligible;
  workgroupBarrier();
  if (lane == 0u) {
    var base = 0u;
    for (var g = 0u; g < min(group, (candidateCount + 63u) / 64u); g++) {
      base += atomicLoad(&adaptiveCount[g + 1u]);
    }
    adaptiveBase = base;
    var prefix = 0u;
    for (var j = 0u; j < 64u; j++) {
      let flag = adaptivePrefix[j];
      adaptivePrefix[j] = prefix;
      prefix += flag;
    }
  }
  workgroupBarrier();
  if (i >= candidateCount) { return; }
  let slot = adaptiveTileSlot(i);
  tileAdaptive[slot] = SCREEN_PROBE_NONE;
  let ordinal = adaptiveBase + adaptivePrefix[lane];
  if (eligible == 0u || ordinal >= probeFrame.probes.y) { return; }
  let probe = probeFrame.probes.x + ordinal;
  probes[probe] = probeAt(adaptivePixel(i));
  tileAdaptive[slot] = probe;
}
#endif

fn probeLive(probe: u32) -> bool {
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return false; }
  if (probe >= probeFrame.probes.x && probe - probeFrame.probes.x >= adaptiveCountIn[0]) { return false; }
  return probesIn[probe].pixel != SCREEN_PROBE_NONE;
}

var<workgroup> texelPdf: array<f32, 64>;
var<workgroup> texelSlots: array<u32, 64>;
var<workgroup> rayProbeLive: bool;

// One workgroup per probe. All positive-cosine texels retain a base ray;
// the unused back-facing budget refines the highest contribution into 2x2.
fn generateProbeRaySlots(probe: u32, texel: u32, record: ScreenProbe, live: bool, priority: f32,
    cacheBoundary: f32, cacheLevelBits: u32) {
  let required = probeFrame.control.x == 0u || probeCellMayContribute(texel, record.normal);
  texelPdf[texel] = select(-1.0, priority, required);
  // Publish eligibility with the existing PDF synchronization. A missing
  // receiver only needs inert slots for the fixed-capacity trace dispatch.
  if (texel == 0u) { rayProbeLive = live; }
  let base = probe * 64u;
  if (!workgroupUniformLoad(&rayProbeLive)) {
    rays[base + texel] = ProbeRay(vec3f(0.0, 0.0, 1.0), STATUS_CULLED << 12u, vec3f(0.0), -1.0);
    return;
  }
  var culled = 0u;
  var rank = 0u;
  for (var t = 0u; t < 64u; t++) {
    let other = texelPdf[t];
    if (other < 0.0) { culled++; continue; }
    if (other > texelPdf[texel] || (other == texelPdf[texel] && t < texel)) { rank++; }
  }
  let mine = texelPdf[texel];
  let refined = mine >= 0.0 && rank < culled / 3u;
  texelSlots[texel] = select(select(1u, 4u, refined), 0u, mine < 0.0);
  workgroupBarrier();
  var first = 0u;
  for (var t = 0u; t < texel; t++) { first += texelSlots[t]; }
  var used = 0u;
  for (var t = 0u; t < 64u; t++) { used += texelSlots[t]; }
  let jitter = probeDirectionTileSample(unpackPixel(record.pixel) / probeFrame.probes.z, probeFrame.probes.w);
  let count = texelSlots[texel];
  for (var s = 0u; s < count; s++) {
    var xy = vec2f(f32(texel % 8u), f32(texel / 8u));
    var size = 8.0;
    if (refined) { xy = xy * 2.0 + vec2f(f32(s & 1u), f32(s >> 1u)); size = 16.0; }
    let direction = spOctDecode((xy + jitter) / size * 2.0 - vec2f(1.0));
    let info = texel | (s << 6u) | select(0u, RAY_REFINED, refined) | RAY_USED | (STATUS_WORLD << 12u) | cacheLevelBits;
    // A WORLD slot can carry a proposed cache boundary until world trace consumes it.
    rays[base + first + s] = ProbeRay(direction, info, vec3f(0.0), cacheBoundary);
  }
  // Unassigned tail slots (at most two) stay inert.
  if (texel >= used) { rays[base + texel] = ProbeRay(vec3f(0.0, 0.0, 1.0), STATUS_CULLED << 12u, vec3f(0.0), -1.0); }
}

fn probeGuideLuminance(rgb: vec3f) -> f32 {
  return max(dot(rgb, vec3f(0.2126, 0.7152, 0.0722)), 0.0);
}

fn probeGuideCache(record: ScreenProbe, direction: vec3f) -> vec4f {
  return sampleRadianceCacheAt(record.position, record.normal, vec3f(0.0), direction, 0.25);
}

@compute @workgroup_size(64)
#ifdef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
fn generateCachedProbeRays
#else
fn generateProbeRays
#endif
(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let live = probeLive(probe);
  let record = probesIn[probe];
  let brdf = probeFrame.control.x != 0u;
  prepareIrradianceFieldProbeVisibility(record.position, record.normal, vec3f(0.0), live && brdf, texel);
  let direction = texelDirection(texel);
  let pdf = select(1.0, max(dot(record.normal, direction), 0.0), brdf);
  var priority = pdf;
  if (live && brdf && pdf > 0.0) {
    let cached = probeGuideCache(record, direction);
    if (cached.w > 0.0) { priority = pdf * probeGuideLuminance(cached.xyz); }
  }
  generateProbeRaySlots(probe, texel, record, live, priority, -1.0, 0u);
}

var<workgroup> guideHistoryIndices: vec4u;

fn guidePreviousProbes(record: ScreenProbe) -> vec4u {
  var indices = vec4u(SCREEN_PROBE_NONE);
  if (!(record.distance > 0.0) || !(probeFrame.previousCameraPos.w > 0.0)) { return indices; }
  let clip = probeFrame.previousViewProj * vec4f(record.position, 1.0);
  if (!(clip.w > 0.0) || !validDepth(clip.z / clip.w)) { return indices; }
  let pixel = unpackPixel(record.pixel);
  let extent = vec2f(extentSize());
  let motion = unpackSceneTemporalV1(textureLoad(screenMotion, vec2i(pixel), 0));
  let projected = clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let uv = select(projected, (vec2f(pixel) + vec2f(0.5)) / extent - motion.motionUv,
    motion.validDepth && motion.motionValid && all(abs(motion.motionUv) < vec2f(4.0)));
  if (!(all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0)))) { return indices; }
  let tiles = tileCount();
  let base = vec2u(floor(uniformProbeGrid(uv * extent, (probeFrame.probes.w + 7u) & 7u)));
  for (var tap = 0u; tap < 4u; tap++) {
    let tile = min(base + vec2u(tap & 1u, tap >> 1u), tiles - vec2u(1u));
    let index = tile.y * tiles.x + tile.x;
    let old = probeHistoryIn[index].probe;
    if (old.pixel == SCREEN_PROBE_NONE || !(old.distance > 0.0)) { continue; }
    let relativePlaneDistance = dot(old.position - record.position, record.normal) / record.distance;
    if (exp2(-10000.0 * relativePlaneDistance * relativePlaneDistance) > 0.1) {
      indices[tap] = index;
    }
  }
  return indices;
}

fn probeGuidePacket(packet: ProbeRadiance, direction: vec3f) -> vec2f {
  if (!(packet.support > 0.0)) { return vec2f(0.0); }
  // All directions in one octahedral cell face its center. Projecting the
  // packet's retained directional moments there gives its mean radiance.
  var value = vec4f(0.0);
  if (cvIs(packet)) {
    value = cvProjected(packet, direction);
  } else if (distributionIsSet(packet)) {
    let count = distributionCount(packet);
    for (var beam = 0u; beam < count; beam++) {
      let sampleWord = packet.samples[beam];
      if (sampleWord.x >= DISTRIBUTION_RADIANCE_UNKNOWN) { return vec2f(0.0); }
      let weight = max(dot(distributionWeightedDirection(sampleWord.y), direction), 0.0);
      value += vec4f(distributionRgbDecode(sampleWord.x), 1.0) * weight;
    }
  } else if (!distributionUnsupported(packet)) {
    value = distributionPointWeighted(packet);
  }
  if (!(value.w > 0.0)) { return vec2f(0.0); }
  let luminance = probeGuideLuminance(value.xyz / value.w);
  if (!(luminance < 1e30)) { return vec2f(0.0); }
  return vec2f(luminance, 1.0);
}

fn probeHistoryGuide(texel: u32, direction: vec3f) -> vec2f {
  var known = vec2f(0.0);
  for (var tap = 0u; tap < 4u; tap++) {
    let index = guideHistoryIndices[tap];
    if (index == SCREEN_PROBE_NONE) { continue; }
    known += probeGuidePacket(radianceIn[index * 64u + texel], direction);
  }
  return known;
}

#ifdef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
var<workgroup> guideCacheNeeded: atomic<u32>;
@compute @workgroup_size(64)
fn generateHistoryProbeRays(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let live = probeLive(probe);
  let record = probesIn[probe];
  let brdf = probeFrame.control.x != 0u;
  let retain = brdf && (probeFrame.control.z & 4u) != 0u;
  let direction = texelDirection(texel);
  let pdf = select(1.0, max(dot(record.normal, direction), 0.0), brdf);
  let guide = live && brdf && pdf > 0.0;
  var known = vec2f(0.0);
  if (retain) {
    if (texel == 0u) {
      atomicStore(&guideCacheNeeded, 0u);
      guideHistoryIndices = vec4u(SCREEN_PROBE_NONE);
      if (live) { guideHistoryIndices = guidePreviousProbes(record); }
    }
    workgroupBarrier();
    if (guide) {
      known = probeHistoryGuide(texel, direction);
      if (known.y < 4.0) { atomicOr(&guideCacheNeeded, 1u); }
    }
    workgroupBarrier();
  }
  let cacheNeeded = !retain || atomicLoad(&guideCacheNeeded) != 0u;
  prepareIrradianceFieldProbeVisibility(record.position, record.normal, vec3f(0.0),
    live && brdf && cacheNeeded, texel);
  var priority = pdf;
  if (guide) {
    if (known.y == 4.0) {
      priority = pdf * (known.x * 0.25);
    } else {
      let cached = probeGuideCache(record, direction);
      if (cached.w > 0.0) {
        priority = pdf * (known.x * 0.25 + probeGuideLuminance(cached.xyz) * (1.0 - known.y * 0.25));
      }
    }
  }
  generateProbeRaySlots(probe, texel, record, live, priority, -1.0, 0u);
}
#endif

#ifdef IRRADIANCE_FIELD_RADIANCE_ATLAS
var<workgroup> hardwareCacheCoverage: ScreenRadianceCoverage;

fn generateHardwareCacheRays(probe: u32, texel: u32) {
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let live = probeLive(probe);
  let record = probesIn[probe];
  let brdf = probeFrame.control.x != 0u;
  let retain = brdf && (probeFrame.control.z & 4u) != 0u;
  if (texel == 0u) {
    guideHistoryIndices = vec4u(SCREEN_PROBE_NONE);
    hardwareCacheCoverage = ScreenRadianceCoverage();
    if (live) {
      if (retain) { guideHistoryIndices = guidePreviousProbes(record); }
      hardwareCacheCoverage = screenRadianceCoverage(record.position);
    }
  }
  workgroupBarrier();
  let direction = texelDirection(texel);
  let pdf = select(1.0, max(dot(record.normal, direction), 0.0), brdf);
  let coverage = hardwareCacheCoverage;
  var priority = pdf;
  if (live && brdf && pdf > 0.0) {
    let known = probeHistoryGuide(texel, direction);
    if (known.y == 4.0) {
      priority = pdf * known.x * 0.25;
    } else if (coverage.traceDistance > 0.0) {
      let cache = sampleScreenRadianceCache(coverage, record.position, direction);
      priority = pdf * (known.x * 0.25 + probeGuideLuminance(cache.rgb) * (1.0 - known.y * 0.25));
    }
  }
  let covered = coverage.traceDistance > 0.0;
  let cacheLevelBits = select(0u, (coverage.level + 1u) << RAY_CACHE_LEVEL_SHIFT, covered);
  generateProbeRaySlots(probe, texel, record, live, priority,
    select(-1.0, coverage.traceDistance, covered), cacheLevelBits);
}
#endif

fn rayStatus(info: u32) -> u32 { return (info >> 12u) & 7u; }
fn withStatus(info: u32, status: u32) -> u32 { return (info & ~(7u << 12u)) | (status << 12u); }

fn traceViewDistance(clip: vec4f) -> f32 {
  return select(clip.w,
    view.temporalProjection.y - (clip.z / clip.w) * (view.temporalProjection.y - view.temporalProjection.x),
    view.temporalProjection.z > 0.5);
}

fn screenTraceExit(edge: vec2f, start: vec2f, inverseDelta: vec2f, moving: vec2<bool>) -> f32 {
  let times = select(vec2f(1.0), (edge - start) * inverseDelta, moving);
  return min(times.x, times.y);
}

fn previousRadiance(position: vec3f) -> vec4f {
  let clip = probeFrame.previousViewProj * vec4f(position, 1.0);
  if (!(clip.w > 0.0)) { return vec4f(0.0); }
  let uv = clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return vec4f(0.0); }
  let pixel = min(vec2u(uv * vec2f(extentSize())), extentSize() - vec2u(1u));
  return screenHistoryColor(pixel);
}

fn screenHistoryColor(pixel: vec2u) -> vec4f {
  let packed = previousScene[pixelIndex(pixel)];
  let rg = unpack2x16float(packed.x);
  let ba = unpack2x16float(packed.y);
  return vec4f(rg, ba.x, ba.y);
}

// One thread per ray: closest-depth HZB march through the previous frame's
// scene color (UE ScreenProbeTraceScreenTexture). Misses and unresolved rays
// keep status WORLD. Raster-empty space cannot certify world visibility: a thin
// or edge-on occluder may have no depth sample, so the world ray starts at its
// original receiver even when the screen march advanced through empty cells.
#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
struct ScreenTraceHit { pixel: vec2u, depth: f32, normal: vec3f, rayUvDepth: vec3f }

fn traceScreenHit(origin: vec3f, d: vec3f, maxDistance: f32, hardware: bool) -> ScreenTraceHit {
  let steps = probeFrame.control.y;
  let extent = vec2f(extentSize());
  var tMax = maxDistance;
  let c0 = view.worldViewProj * vec4f(origin, 1.0);
  let dc = view.worldViewProj * vec4f(d, 0.0);
  // Keep the segment in front of the near plane.
  let near = view.temporalProjection.x;
  if (view.temporalProjection.z < 0.5 && dc.w < 0.0) {
    tMax = min(tMax, max((c0.w - 1.5 * near) / -dc.w, 0.0));
  }
  if (!(c0.w > 0.0) || tMax <= 0.0) { return ScreenTraceHit(); }
  let c1 = c0 + dc * tMax;
  let uv0 = c0.xy / c0.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let uv1 = c1.xy / c1.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let delta = uv1 - uv0;
  let pixels = length(delta * extent);
  if (!(pixels > 0.0) || any(uv0 < vec2f(0.0)) || any(uv0 >= vec2f(1.0))) { return ScreenTraceHit(); }
  let moving = abs(delta) > vec2f(1e-8);
  let inverseDelta = 1.0 / select(vec2f(1.0), delta, moving);
  let towardMax = select(vec2f(0.0), vec2f(1.0), delta > vec2f(0.0));
  let endU = min(1.0, screenTraceExit(towardMax, uv0, inverseDelta, moving));
  let w0 = traceViewDistance(c0);
  let w1 = traceViewDistance(c1);
  let perspective = view.temporalProjection.z < 0.5;
  // View distance is monotone along a projected segment. Perspective uses
  // affine reciprocal distance, orthographic uses affine distance directly.
  let depth0 = select(w0, 1.0 / w0, perspective);
  let depth1 = select(w1, 1.0 / w1, perspective);
  let away = w1 >= w0;
  let thickness = probeFrame.tuning.x;
  let size0 = textureDimensions(depthPyramid, 0);
  let maxLevel = textureNumLevels(depthPyramid) - 1u;
  let originCell = depthPyramidCell(uv0, size0);
  let originEdge = (vec2f(originCell) + towardMax) / vec2f(size0);
  let crossEpsilon = 0.005 / max(1.0, pixels);
  // Leave just the receiver texel. A full screen pixel of travel can skip
  // the first candidate when the projected ray starts near an edge.
  var u = max(0.0, screenTraceExit(originEdge, uv0, inverseDelta, moving)) + crossEpsilon;
  var level = 0u;
  for (var step = 0u; step < steps; step++) {
    if (u >= endU) { break; }
    let uv = uv0 + delta * u;
    // WebGPU levels floor-halve the base extent, including odd dimensions.
    let size = max(size0 >> vec2u(level), vec2u(1u));
    let cell = depthPyramidCell(uv, size);
    let edge = (vec2f(cell) + towardMax) / vec2f(size);
    let exitU = clamp(screenTraceExit(edge, uv0, inverseDelta, moving), u, endU);
    let farDepth = mix(depth0, depth1, select(u, exitU, away));
    let rayFar = select(farDepth, 1.0 / farDepth, perspective);
    let scene = depthPyramidDepthOrEmpty(textureLoad(depthPyramid, vec2i(cell), i32(level)).r);
    // Free only if the whole segment is in front of the cell's closest depth.
    if (rayFar < scene) {
      u = exitU + crossEpsilon;
      level = min(level + 1u, maxLevel);
      continue;
    }
    if (level > 0u) { level--; continue; }
    let nearDepth = mix(depth0, depth1, select(exitU, u, away));
    let rayNear = select(nearDepth, 1.0 / nearDepth, perspective);
    // UE HZB tests thickness at the first crossing or at tile entry if
    // already behind its depth plane. A ray moving toward the camera can
    // emerge before the tile exit without ever proving the hidden prefix.
    let rayAtEntry = select(rayFar, rayNear, away);
    let entryWithinThickness = max(rayAtEntry - scene, 0.0) < thickness * max(scene, 0.00001);
    if (select(rayNear <= scene * (1.0 + thickness), entryWithinThickness, hardware)) {
      let pixel = min(vec2u(uv * extent), extentSize() - vec2u(1u));
      let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
      let packed = textureLoad(gbufferNormal, vec2i(pixel), 0).rg;
      if (!standardGBufferValid(packed)) { return ScreenTraceHit(); }
      let normal = decodeStandardGBufferNormal(packed).xyz;
      // UE Screen Trace skips backface-diffuse materials. Keep the facing
      // guard when the producer did not classify the material.
      let classified = hardware && (packed.y & STANDARD_GBUFFER_SCREEN_TRACE_CLASSIFIED_BIT) != 0u;
      let allowsTrace = select(dot(normal, d) < 0.0,
        (packed.y & STANDARD_GBUFFER_SCREEN_TRACE_BACKFACE_DIFFUSE_BIT) == 0u, classified);
      if (validDepth(z) && allowsTrace) {
        var hitU = u;
        if (hardware && away && rayAtEntry < scene && depth1 != depth0) {
          // Intersect the pixel depth plane in screen space. Reciprocal
          // distance is affine under perspective and distance under ortho.
          let plane = select(scene, 1.0 / scene, perspective);
          hitU = clamp((plane - depth0) / (depth1 - depth0), u, exitU);
        }
        let rayUvDepth = vec3f(uv0 + delta * hitU, mix(c0.z / c0.w, c1.z / c1.w, hitU));
        return ScreenTraceHit(pixel, z, normal, rayUvDepth);
      }
      break;
    }
    // An out-of-thickness crossing leaves the original World ray intact.
    break;
  }
  return ScreenTraceHit();
}

@compute @workgroup_size(64) fn traceScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  if (i >= (probeFrame.probes.x + probeFrame.probes.y) * 64u) { return; }
  var ray = rays[i];
  if (rayStatus(ray.info) != STATUS_WORLD || probeFrame.control.y == 0u || !gbufferMatches()) { return; }
  let canonical = probeFrame.expectedSource.w != 0u;
  if (!canonical && (probeFrame.control.z & 1u) == 0u) { return; }
  let probe = probesIn[i / 64u];
  // A normal-biased origin can see the receiver's own history from behind
  // its shading hemisphere. Such rays remain available to World.
  if (dot(probe.normal, ray.direction) <= 0.0) { return; }
  let origin = select(probe.position + probe.normal * probeFrame.tuning.z, probe.position, canonical);
  let hit = traceScreenHit(origin, ray.direction, probeFrame.environment.w, false);
  if (!validDepth(hit.depth)) { return; }
  if (canonical) {
    if (any(hit.pixel >= vec2u(16384u))) { return; }
    // World reconstructs the current-source primitive and proves the prefix.
    ray.radiance = screenCandidatePack(hit.pixel, probeFrame.probes.w, probeFrame.query.z);
    ray.info = ray.info | RAY_SCREEN_CANDIDATE;
    rays[i] = ray;
    return;
  }
  let hitPosition = worldPosition(hit.pixel, hit.depth);
#ifdef IRRADIANCE_FIELD_VISIBILITY
  if (fieldSegmentVisibility(origin, hitPosition + hit.normal * probeFrame.tuning.z) < 1.0) { return; }
#endif
  let radiance = previousRadiance(hitPosition);
  if (radiance.w > 0.0) {
    ray.radiance = radiance.xyz;
    ray.hitDistance = length(hitPosition - probe.position);
    ray.info = withStatus(ray.info, STATUS_RESOLVED);
    rays[i] = ray;
  }
}

fn screenHitVignette(uv: vec2f) -> f32 {
  let border = clamp(abs(uv * 2.0 - vec2f(1.0)) * 5.0 - vec2f(4.0), vec2f(0.0), vec2f(1.0));
  return clamp(1.0 - dot(border, border), 0.0, 1.0);
}

fn hardwareScreenTraceHit(i: u32) -> ScreenTraceHit {
  if (i >= (probeFrame.probes.x + probeFrame.probes.y) * 64u) { return ScreenTraceHit(); }
  let ray = rays[i];
  if (rayStatus(ray.info) != STATUS_WORLD || probeFrame.control.y == 0u ||
      (probeFrame.control.z & 1u) == 0u || !gbufferMatches()) { return ScreenTraceHit(); }
  let probe = probesIn[i / 64u];
  if (dot(probe.normal, ray.direction) <= 0.0) { return ScreenTraceHit(); }
  let maxDistance = select(probeFrame.environment.w, min(probeFrame.environment.w, ray.hitDistance),
    ray.hitDistance > 0.0);
  return traceScreenHit(probe.position + probe.normal * probeFrame.tuning.z, ray.direction, maxDistance, true);
}

fn hardwareScreenTraceRadiance(i: u32, hit: ScreenTraceHit, previous: vec3f) -> vec4f {
  let previousUv = previous.xy;
  if (!(all(previousUv >= vec2f(0.0)) && all(previousUv < vec2f(1.0)) && validDepth(previous.z))) { return vec4f(0.0); }
  let tile = vec2u(i / 64u % probeFrame.extent.z, i / 64u / probeFrame.extent.z);
  let sampleCoord = tile * 8u + vec2u(i % 8u, i / 8u % 8u);
  let sample = vec2f(sampleCoord) + vec2f(0.5) + vec2f(47.0, 17.0) * (0.695 * f32(probeFrame.probes.w % 8u));
  let noise = fract(52.9829189 * fract(dot(sample, vec2f(0.06711056, 0.00583715))));
  if (min(screenHitVignette(hit.rayUvDepth.xy), screenHitVignette(previousUv)) < noise) { return vec4f(0.0); }
  let previousPixel = min(vec2u(previousUv * vec2f(extentSize())), extentSize() - vec2u(1u));
  let depth = previousScreenDepth[pixelIndex(previousPixel)];
  if (!validDepth(depth) || !(abs(depth - previous.z) < 0.005 * mix(0.5, 2.0, noise))) { return vec4f(0.0); }
  return screenHistoryColor(previousPixel);
}

fn resolveHardwareScreenTrace(i: u32, position: vec3f, radiance: vec4f, moving: bool) {
  if (!(radiance.w > 0.0)) { return; }
  var ray = rays[i];
  ray.radiance = radiance.xyz;
  ray.hitDistance = length(position - probesIn[i / 64u].position);
  ray.info = withStatus(ray.info, STATUS_RESOLVED) | select(0u, RAY_HIT_MOVING, moving);
  rays[i] = ray;
}

@compute @workgroup_size(64) fn traceHardwareScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let hit = hardwareScreenTraceHit(i);
  if (!validDepth(hit.depth)) { return; }
  let position = worldPositionAtUv(hit.rayUvDepth.xy, hit.rayUvDepth.z);
  let clip = probeFrame.previousViewProj * vec4f(position, 1.0);
  if (!(clip.w > 0.0)) { return; }
  let motion = unpackSceneTemporalV1(textureLoad(screenMotion, vec2i(hit.pixel), 0));
  let previousUv = select(sceneTemporalUv(clip), hit.rayUvDepth.xy - motion.motionUv,
    motion.validDepth && motion.motionValid && all(abs(motion.motionUv) < vec2f(4.0)));
  let radiance = hardwareScreenTraceRadiance(i, hit, vec3f(previousUv, clip.z / clip.w));
  resolveHardwareScreenTrace(i, position, radiance, false);
}

fn traceHardwareScreenProbeVelocity(i: u32, receiverMotion: vec2f) {
  let hit = hardwareScreenTraceHit(i);
  if (!validDepth(hit.depth)) { return; }
  let position = worldPositionAtUv(hit.rayUvDepth.xy, hit.rayUvDepth.z);
  let clip = probeFrame.previousViewProj * vec4f(position, 1.0);
  if (!(clip.w > 0.0)) { return; }
  let velocity = textureLoad(motionWithDepth, vec2i(hit.pixel), 0).xy;
  var previous = vec3f(sceneTemporalUv(clip), clip.z / clip.w);
  if (velocity.y != 0u) {
    // Apply the raster texel's geometry motion to the continuous HZB hit.
    // Lumen's history position corrects the difference from the static
    // projection at the raster depth, including the previous device Z.
    if (velocity.y == SCENE_VELOCITY_INVALID_DEPTH || velocity.x == 0u) { return; }
    let raster = vec4f(worldPosition(hit.pixel, hit.depth), 1.0);
    let currentRaster = view.temporalCurrentViewProj * raster;
    let previousRaster = probeFrame.previousViewProj * raster;
    if (!(currentRaster.w > 0.0 && previousRaster.w > 0.0)) { return; }
    let previousRasterZ = sceneVelocityPreviousDepth(velocity.y);
    let uvCorrection = sceneTemporalUv(currentRaster) - decodeSceneVelocity(velocity.x) - sceneTemporalUv(previousRaster);
    previous += vec3f(uvCorrection, previousRasterZ - previousRaster.z / previousRaster.w);
  }
  let radiance = hardwareScreenTraceRadiance(i, hit, previous);
  if (!(radiance.w > 0.0)) { return; }
  var moving = false;
  if (receiverMotion.x >= 0.0) {
    var speed = -1.0;
    if (all(velocity == vec2u(0u))) {
      speed = 0.0;
    } else if (velocity.y != 0u) {
      let last = screenProbePreviousWorld(vec3f(previous.xy * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), previous.z));
      if (last.w > 0.0) { speed = length(position - last.xyz); }
    }
    moving = speed >= 0.0 && abs(speed - receiverMotion.x) > 0.005 * max(receiverMotion.y, 1.0);
  }
  resolveHardwareScreenTrace(i, position, radiance, moving);
}

@compute @workgroup_size(64) fn traceHardwareScreenProbesWithVelocity(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  traceHardwareScreenProbeVelocity(spLinearId(gid, groups), vec2f(-1.0, 0.0));
}

@compute @workgroup_size(64) fn traceHardwareScreenProbesWithMotion(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let probe = i / 64u;
  if (probe < probeFrame.probes.x + probeFrame.probes.y) {
    traceHardwareScreenProbeVelocity(i, receiverMotionIn[probe]);
  }
}
#endif

// One workgroup per probe, one thread per texel: average the texel's rays.
// Culled or unresolved texels sample the world radiance cache along the texel's
// direction; an 8x8 octahedral texel subtends the cache's finest (0.25 rad) cone.
fn screenProbeAngularMeasure(direction: vec3f) -> f32 {
  // Octahedral UV strata sample projected area, not solid angle.
  // For a unit direction, dOmega / du / dv = (|x|+|y|+|z|)^3.
  let l1 = dot(abs(direction), vec3f(1.0));
  return l1 * l1 * l1;
}

// Per-cell membership only: enumerate physical slots in their original order.
// Two halves cover all 64 rays with 512 bytes of shared storage per workgroup.
var<workgroup> resolveRayMaskLo: array<atomic<u32>,64>;
var<workgroup> resolveRayMaskHi: array<atomic<u32>,64>;

#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
@compute @workgroup_size(64) fn resolveProbeRays(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  let inRange=probe<probeFrame.probes.x+probeFrame.probes.y;
  atomicStore(&resolveRayMaskLo[texel],0u);
  atomicStore(&resolveRayMaskHi[texel],0u);
  workgroupBarrier();
  if(inRange){
    if(probeLive(probe)){
      let info=raysIn[probe*64u+texel].info;
      if((info&RAY_USED)!=0u){
        if(texel<32u){atomicOr(&resolveRayMaskLo[info&63u],1u<<(texel&31u));}
        else{atomicOr(&resolveRayMaskHi[info&63u],1u<<(texel&31u));}
      }
    }
  }
  workgroupBarrier();
  if(!inRange){return;}
  let index = probe * 64u + texel;

  if(!probeLive(probe)){
    radianceOut[index]=distributionPoint(vec4f(0.0),texelDirection(texel),0.0,-1.0,0u);return;
  }
  var beams:array<DistributionBeam,4>;var assigned=0u;var incomplete=false;var missingRadiance=false;var overflow=false;
  var hitDistance=-1.0;
  let reconstruct=spCurrentSupport(probeFrame.control.z);
  var lower=atomicLoad(&resolveRayMaskLo[texel]);
  var upper=atomicLoad(&resolveRayMaskHi[texel]);
  let unassigned=(lower|upper)==0u;
  for(var slot=0u;slot<64u;slot++){
    if((lower|upper)==0u){break;}
    var r=0u;
    if(lower!=0u){r=firstTrailingBit(lower);lower=lower&(lower-1u);}
    else{r=32u+firstTrailingBit(upper);upper=upper&(upper-1u);}
    let ray=raysIn[probe*64u+r];
    if((ray.info&RAY_USED)==0u||(ray.info&63u)!=texel){continue;}
    if(assigned>=4u){overflow=true;continue;}
    let status=rayStatus(ray.info);let measure=screenProbeAngularMeasure(ray.direction);
    var availability=0u;var radiance=ray.radiance;
    if(status==STATUS_INCOMPLETE||!(measure>0.0)){availability=2u;incomplete=true;}
    else if(status==STATUS_FALLBACK&&reconstruct){
      // Preserve the actual assigned direction and quadrature measure even
      // when the qualified Field cache cannot supply its radiance.
      let receiver=probesIn[probe];
      let cached=sampleRadianceCacheAt(receiver.position,receiver.normal,vec3f(0.0),ray.direction,0.25);
      if(cached.w>0.0){radiance=cached.xyz;}else{availability=1u;missingRadiance=true;radiance=vec3f(0.0);}
    }
    else if(status!=STATUS_RESOLVED){continue;}
    beams[assigned]=DistributionBeam(radiance,availability,ray.direction,measure);assigned++;
    if(status==STATUS_RESOLVED&&ray.hitDistance>=0.0&&(hitDistance<0.0||ray.hitDistance<hitDistance)){hitDistance=ray.hitDistance;}
  }
  if(overflow){radianceOut[index]=distributionPoint(vec4f(0.0),texelDirection(texel),-1.0,-1.0,0u);return;}
  if(incomplete){hitDistance=-1.0;}
  if(assigned==1u){
    let beam=beams[0];let value=vec4f(select(beam.radiance,vec3f(0.0),beam.availability!=0u),1.0)*beam.measure;
    radianceOut[index]=distributionPoint(value,beam.direction,select(select(1.0,0.0,beam.availability==1u),-2.0,incomplete),hitDistance,0u);return;
  }
  if(assigned>0u){
    var sameDirection=!incomplete;var weighted=vec4f(0.0);
    for(var i=0u;i<assigned;i++){
      sameDirection=sameDirection&&beams[i].availability==0u&&all(beams[i].direction==beams[0].direction);
      weighted+=vec4f(beams[i].radiance,1.0)*beams[i].measure;
    }
    if(sameDirection){radianceOut[index]=distributionPoint(weighted/f32(assigned),beams[0].direction,1.0,hitDistance,0u);return;}
    // A mixed unresolved set retains its beams but cannot enter strict history
    // or the known-only spatial merge, which would discard that missing plan.
    var packet=distributionSet(beams,select(select(1.0,0.0,missingRadiance),-1.0,incomplete),hitDistance,0u);
    setDistributionMetadata(&packet,true,assigned,0u);
    radianceOut[index]=packet;return;
  }
  if(incomplete){radianceOut[index]=distributionPoint(vec4f(0.0),texelDirection(texel),-1.0,-1.0,0u);return;}
  let receiver=probesIn[probe];let direction=texelDirection(texel);
  let fallback=sampleRadianceCacheAt(receiver.position,receiver.normal,vec3f(0.0),direction,0.25);
  if(reconstruct&&unassigned&&probePolicyCull(probe,texel)&&!(fallback.w>0.0)&&all((bitcast<vec4u>(fallback)&vec4u(0x7fffffffu))<vec4u(bitcast<u32>(1e30)))){
    radianceOut[index]=distributionPolicyCull(texel);return;
  }
  // No assigned sample and no cache observation is not a fabricated plan.
  if(reconstruct&&!(fallback.w>0.0)){radianceOut[index]=distributionPoint(vec4f(0.0),direction,fallback.w,-1.0,0u);return;}
  radianceOut[index]=distributionPoint(vec4f(fallback.xyz,1.0)*screenProbeAngularMeasure(direction),direction,fallback.w,-1.0,0u);

}
#endif

// Trace completion writes the ray list. Resolve consumes radiance and distance
// only, and an unassigned angular cell never requests additional transport.
#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
fn traceResolveProbeCount() -> u32 {
  return probeFrame.probes.x + min(adaptiveCountIn[0], probeFrame.probes.y);
}

fn traceResolveDispatch(offset: u32, count: u32) {
  let width = max(1u, min(count, 65535u));
  traceDispatch[offset] = width;
  traceDispatch[offset + 1u] = (count + width - 1u) / width;
  traceDispatch[offset + 2u] = 1u;
}

@compute @workgroup_size(1) fn beginTraceResolve() {
  atomicStore(&fallbackList.count, 0u);
  traceResolveDispatch(0u, traceResolveProbeCount());
}

@compute @workgroup_size(1) fn resetTraceList() {
  atomicStore(&fallbackList.count, 0u);
}

var<workgroup> fallbackGroupCount: atomic<u32>;
var<workgroup> fallbackGroupBase: u32;

fn compactTraceList(probe: u32, lane: u32, status: u32) {
  if (lane == 0u) { atomicStore(&fallbackGroupCount, 0u); }
  workgroupBarrier();
  let slot = probe * 64u + lane;
  var local = SCREEN_PROBE_NONE;
  if (probe < traceResolveProbeCount() && probeLive(probe)) {
    let info = raysIn[slot].info;
    let actual = rayStatus(info);
    let cacheBoundary = status == STATUS_FALLBACK && actual == STATUS_CACHE_BOUNDARY;
    if ((info & RAY_USED) != 0u && (actual == status || cacheBoundary)) {
      local = atomicAdd(&fallbackGroupCount, 1u);
    }
  }
  workgroupBarrier();
  if (lane == 0u) {
    fallbackGroupBase = atomicAdd(&fallbackList.count, atomicLoad(&fallbackGroupCount));
  }
  let base = workgroupUniformLoad(&fallbackGroupBase);
  if (local != SCREEN_PROBE_NONE) { fallbackList.slots[base + local] = slot; }
}

@compute @workgroup_size(64)
fn compactWorldTraces(@builtin(workgroup_id) group: vec3u,
    @builtin(local_invocation_index) lane: u32, @builtin(num_workgroups) groups: vec3u) {
  compactTraceList(spGroupId(group, groups), lane, STATUS_WORLD);
}

@compute @workgroup_size(64)
fn compactTraceFallbacks(@builtin(workgroup_id) group: vec3u,
    @builtin(local_invocation_index) lane: u32, @builtin(num_workgroups) groups: vec3u) {
  compactTraceList(spGroupId(group, groups), lane, STATUS_FALLBACK);
}

@compute @workgroup_size(1) fn prepareTraceFallbackDispatch() {
  traceResolveDispatch(3u, (fallbackListIn[0] + 63u) / 64u);
}

@compute @workgroup_size(64)
fn lightTraceFallbacks(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
  lightProbeFallback(spLinearId(gid, groups));
}

fn lightProbeFallback(i: u32) {
  if (i >= fallbackListIn[0]) { return; }
  let slot = fallbackListIn[i + 1u];
  var ray = rays[slot];
  let receiver = probesIn[slot / 64u];
  var cached = vec4f(0.0);
#ifdef IRRADIANCE_FIELD_RADIANCE_ATLAS
  if (rayStatus(ray.info) == STATUS_CACHE_BOUNDARY) {
    let levelTag = (ray.info >> RAY_CACHE_LEVEL_SHIFT) & RAY_CACHE_LEVEL_MASK;
    if (levelTag != 0u) {
      let coverage = screenRadianceCoverageFromTrace(receiver.position, levelTag - 1u, ray.hitDistance);
      cached = sampleScreenRadianceCache(coverage, receiver.position, ray.direction);
    }
  } else
#endif
  {
    // A real near-field hit with no Card radiance still needs the existing
    // qualified reconstruction. It did not reach the cache boundary.
    cached = sampleRadianceCacheAt(receiver.position, receiver.normal, vec3f(0.0), ray.direction, 0.25);
  }
  if (cached.w > 0.0) {
    ray.radiance = cached.xyz;
    if (rayStatus(ray.info) == STATUS_CACHE_BOUNDARY) { ray.hitDistance = -1.0; }
    ray.info = withStatus(ray.info, STATUS_RESOLVED);
    rays[slot] = ray;
  }
}

// As in Lumen's scatter, refinements contribute their octahedral area and
// a stochastic choice of a bilinear tap. Fixed-point sums fit u32 even if
// all 64 rays land in one cell at the firefly cap.
const TRACE_SCATTER_SCALE = 1048576.0;
const TRACE_SCATTER_MAX_RADIANCE = 10.0;
const TRACE_SCATTER_MISSING_LIGHT = 1u;
const TRACE_SCATTER_MISSING_SCENE = 2u;
const TRACE_SCATTER_KNOWN = 4u;
const TRACE_SCATTER_CULLED = 8u;
const TRACE_SCATTER_STATE_MASK = 15u;
const TRACE_SCATTER_MASS_SHIFT = 20u;
struct TraceScatter {
  red: atomic<u32>, green: atomic<u32>, blue: atomic<u32>,
  weight: atomic<u32>, unknown: atomic<u32>, distance: atomic<u32>,
}
var<workgroup> traceScatter: array<TraceScatter,64>;
var<workgroup> traceScatterSample: vec2f;
var<workgroup> traceDirectionJitter: vec2f;
var<workgroup> traceMovingMass: atomic<u32>;

fn scatterTraceCell(info: u32, directionJitter: vec2f, samplePoint: vec2f) -> u32 {
  let baseTexel = info & 63u;
  let refined = (info & RAY_REFINED) != 0u;
  let child = (info >> 6u) & 3u;
  let parent = vec2f(f32(baseTexel & 7u), f32(baseTexel >> 3u));
  let childOffset = vec2f(f32(child & 1u), f32(child >> 1u));
  let gatherPosition = select(parent + directionJitter, parent + (childOffset + directionJitter) * 0.5, refined) - vec2f(0.5);
  let offset = select(vec2i(0), vec2i(1), fract(gatherPosition) >= samplePoint);
  let wrapped = irradianceFieldOctWrap(vec2i(floor(gatherPosition)) + offset, 8);
  return wrapped.y * 8u + wrapped.x;
}

fn scatterProbeTracesAt(probe: u32, lane: u32, gatherMoving: bool) -> f32 {
  if (gatherMoving && lane == 0u) { atomicStore(&traceMovingMass, 0u); }
  atomicStore(&traceScatter[lane].red, 0u);
  atomicStore(&traceScatter[lane].green, 0u);
  atomicStore(&traceScatter[lane].blue, 0u);
  atomicStore(&traceScatter[lane].weight, 0u);
  atomicStore(&traceScatter[lane].unknown, 0u);
  atomicStore(&traceScatter[lane].distance, 0x7f800000u);
  let live = probe < traceResolveProbeCount() && probeLive(probe);
  if (lane == 0u && live) {
    // Lumen offsets scatter noise from its ray-direction phase. The baked
    // texture contains only the eight offset slices, stacked vertically.
    let probeTile = unpackPixel(probesIn[probe].pixel) / probeFrame.probes.z;
    traceDirectionJitter = probeDirectionTileSample(probeTile, probeFrame.probes.w);
    let tile = probeTile & vec2u(127u);
    let row = tile.y + (probeFrame.probes.w % 8u) * 128u;
    traceScatterSample = textureLoad(scatterNoise, vec2i(i32(tile.x), i32(row)), 0).xy;
  }
  workgroupBarrier();
  if (live) {
    let ray = raysIn[probe * 64u + lane];
    if ((ray.info & RAY_USED) != 0u) {
      let cell = scatterTraceCell(ray.info, traceDirectionJitter, traceScatterSample);
      let status = rayStatus(ray.info);
      if (status == STATUS_RESOLVED) {
        let refined = (ray.info & RAY_REFINED) != 0u;
        let weight = select(1.0, 0.25, refined);
        // Each assigned ray scatters to exactly one angular bin. The sum over
        // those bins is identical to the group sum of moving input mass.
        if (gatherMoving && (ray.info & RAY_HIT_MOVING) != 0u) {
          atomicAdd(&traceMovingMass, select(4u, 1u, refined));
        }
        let weighted = ray.radiance * weight;
        let peak = max(max(weighted.x, weighted.y), weighted.z);
        let color = weighted * (TRACE_SCATTER_MAX_RADIANCE / max(peak, TRACE_SCATTER_MAX_RADIANCE));
        let fixed = vec3u(round(clamp(color, vec3f(0.0), vec3f(TRACE_SCATTER_MAX_RADIANCE)) * TRACE_SCATTER_SCALE));
        atomicAdd(&traceScatter[cell].red, fixed.x);
        atomicAdd(&traceScatter[cell].green, fixed.y);
        atomicAdd(&traceScatter[cell].blue, fixed.z);
        atomicAdd(&traceScatter[cell].weight, u32(weight * TRACE_SCATTER_SCALE));
        if (ray.hitDistance >= 0.0) { atomicMin(&traceScatter[cell].distance, bitcast<u32>(ray.hitDistance)); }
      } else {
        atomicOr(&traceScatter[cell].unknown, select(TRACE_SCATTER_MISSING_SCENE, TRACE_SCATTER_MISSING_LIGHT, status == STATUS_FALLBACK));
      }
    }
  }
  workgroupBarrier();
  if (!live) { return 0.0; }
  let weight = atomicLoad(&traceScatter[lane].weight);
  let unknown = atomicLoad(&traceScatter[lane].unknown);
  let rgb = vec3u(atomicLoad(&traceScatter[lane].red), atomicLoad(&traceScatter[lane].green), atomicLoad(&traceScatter[lane].blue));
  let color = distributionRgbEncode(vec3f(rgb) / f32(max(1u, weight)));
  let hit = atomicLoad(&traceScatter[lane].distance);
  let distance = select(min(bitcast<f32>(hit), 65504.0), -1.0, hit == 0x7f800000u);
  var state = unknown | select(0u, TRACE_SCATTER_KNOWN, weight != 0u);
  if (state == 0u && probePolicyCull(probe, lane)) { state = TRACE_SCATTER_CULLED; }
  // Each ray contributes one or one-quarter base-texel areas. Carry that
  // mass alongside the mean so bin occupancy cannot create angular support.
  let quarterTexels = weight / u32(TRACE_SCATTER_SCALE * 0.25);
  let stateDistance = pack2x16float(vec2f(distance, 0.0)) | (state << 16u) | (quarterTexels << TRACE_SCATTER_MASS_SHIFT);
  traceCells[probe * 64u + lane] = TraceCell(color, stateDistance);
  if (gatherMoving && lane == 0u) {
    // UE normalizes over the 8×8 angular lattice, with quarter area for refinements.
    return f32(atomicLoad(&traceMovingMass)) / 256.0;
  }
  return 0.0;
}

@compute @workgroup_size(64)
fn scatterProbeTraces(@builtin(workgroup_id) group: vec3u,
    @builtin(local_invocation_index) lane: u32, @builtin(num_workgroups) groups: vec3u) {
  _ = scatterProbeTracesAt(spGroupId(group, groups), lane, false);
}

@compute @workgroup_size(64)
fn scatterProbeTracesWithMotion(@builtin(workgroup_id) group: vec3u,
    @builtin(local_invocation_index) lane: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(group, groups);
  let moving = scatterProbeTracesAt(probe, lane, true);
  if (lane == 0u && probe < probeFrame.probes.x + probeFrame.probes.y) {
    probeMovingOut[probe] = moving;
  }
}

fn unpackTraceCell(probe: u32, lane: u32) -> ProbeRadiance {
  let direction = texelDirection(lane);
  // Placement clears every unused lane of the reserved adaptive range.
  if (probesIn[probe].pixel == SCREEN_PROBE_NONE) {
    return distributionPoint(vec4f(0.0), direction, 0.0, -1.0, 0u);
  }
  let cell = traceCellsIn[probe * 64u + lane];
  let state = (cell.stateDistance >> 16u) & TRACE_SCATTER_STATE_MASK;
  let distance = unpack2x16float(cell.stateDistance & 65535u).x;
  if (state == TRACE_SCATTER_KNOWN) {
    let mass = f32(cell.stateDistance >> TRACE_SCATTER_MASS_SHIFT) * 0.25;
    let weighted = vec4f(distributionRgbDecode(cell.color), 1.0) * (screenProbeAngularMeasure(direction) * mass);
    return distributionPoint(weighted, direction, 1.0, distance, 0u);
  }
  if (state == TRACE_SCATTER_CULLED) { return distributionPolicyCull(lane); }
  if (state == 0u && (probeFrame.query.w & 32u) != 0u && !spUsesSh3()) {
    return distributionPoint(vec4f(0.0), direction, SUPPORT_SCATTER_EMPTY, -1.0, 0u);
  }
  let support = select(0.0, -1.0, (state & TRACE_SCATTER_MISSING_SCENE) != 0u);
  return distributionPoint(vec4f(0.0), direction, support, distance, 0u);
}
#endif

// Cascaded EMA mean age is the sum of each stage's (cap - 1).
// Share the author's reconstruction budget instead of doubling its response
// delay when both histories are active. A single active lane keeps the full cap.
fn probeHistoryCap() -> u32 {
  let cap = probeFrame.control.w;
  if ((probeFrame.query.w & 512u) != 0u) { return 1u; }
  return select(cap, max(1u, cap / 2u), (probeFrame.control.z & 2u) != 0u);
}
fn pixelHistoryCap() -> u32 {
  let cap = probeFrame.control.w;
  // This count includes the current sample in addition to Lumen's history age.
  if ((probeFrame.query.w & 512u) != 0u) { return cap + 1u; }
  return select(cap, cap - max(1u, cap / 2u) + 1u, (probeFrame.control.z & 4u) != 0u);
}

// Same-direction transport at a different receiver describes a shifted hit.
// Both spatial filtering and temporal reuse use the current/old closest known
// endpoint and the equivalent circular cone of the octahedral texel. Unknown
// endpoints preserve the existing geometric admission; zero is a real blocker.
fn probeParallaxWeight(deltaPosition: vec3f, texel: u32, currentDistance: f32, sourceDistance: f32) -> f32 {
  var distance = currentDistance;
  if (distance < 0.0 || (sourceDistance >= 0.0 && sourceDistance < distance)) { distance = sourceDistance; }
  if (distance < 0.0) { return 1.0; }
  let direction = texelDirection(texel);
  let delta = deltaPosition + direction * distance;
  let separation = length(delta);
  let angle = select(0.0, acos(clamp(dot(delta, direction) / max(separation, 1e-20), -1.0, 1.0)), separation > 1e-20);
  let cone = acos(clamp(1.0 - (0.0625 * octTexelSolidAngle(texel)) / 6.28318530718, -1.0, 1.0));
  return 1.0 - clamp(angle / cone, 0.0, 1.0);
}

var<workgroup> historyProbeIndices: array<u32, 4>;
var<workgroup> historyProbeWeights: array<f32, 4>;
var<workgroup> historyAdaptiveIndex: u32;

// Compaction stores adaptive receivers in packed-pixel order, with empty tails.
// Search the previous projection, never a physical adaptive allocation ordinal.
fn adaptiveHistoryAt(pixel: vec2u, record: ScreenProbe) -> u32 {
  let key = packPixel(pixel);
  var low = probeFrame.probes.x;
  var high = low + probeFrame.probes.y;
  let end = high;
  while (low < high) {
    let middle = low + (high - low) / 2u;
    if (probeHistoryIn[middle].probe.pixel < key) { low = middle + 1u; }
    else { high = middle; }
  }
  if (low == end) { return SCREEN_PROBE_NONE; }
  let source = probeHistoryIn[low].probe;
  if (source.pixel != key || source.distance <= 0.0 ||
      probeAgreement(source, record.position, record.normal, record.distance) < 0.99 ||
      probeVisibility(source, record.position, record.normal) != 1.0) {
    return SCREEN_PROBE_NONE;
  }
  return low;
}

// Retain resolved radiance before spatial filtering and cosine convolution.
// Reprojection follows geometry rather than adaptive slot identity. Only the
// previous uniform lattice supplies fallback history. Adaptive receivers first
// retain their own valid reprojected history. Missing current transport stays missing.
#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
fn probeHistoryUvValid(uv: vec2f) -> bool {
  // Previous pixel centers span [0.5 / extent, 1 - 0.5 / extent].
  // Their half-pixel footprint includes the closed view edges, not a probe tile.
  return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0;
}

@compute @workgroup_size(64) fn temporalProbeRadiance(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  accumulateProbeHistory(probe, texel, radianceIn[probe * 64u + texel]);
}

@compute @workgroup_size(64) fn temporalTraceRadiance(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  accumulateProbeHistory(probe, texel, unpackTraceCell(probe, texel));
}

fn accumulateProbeHistory(probe: u32, texel: u32, currentRecord: ProbeRadiance) {
  let index = probe * 64u + texel;
  let record = probesIn[probe];
  if (texel == 0u) { probeHistoryOut[probe].probe = record; }
  // Geometry and scene visibility are independent of radiance direction.
  // One invocation derives the four actual-position weights for all 64 texels.
  if (texel == 0u) {
    historyAdaptiveIndex = SCREEN_PROBE_NONE;
    for (var tap = 0u; tap < 4u; tap++) {
      historyProbeIndices[tap] = SCREEN_PROBE_NONE;
      historyProbeWeights[tap] = 0.0;
    }
    if (record.pixel != SCREEN_PROBE_NONE && record.distance > 0.0 &&
        (probeFrame.control.z & 4u) != 0u && probeHistoryCap() > 1u &&
        probeFrame.previousCameraPos.w > 0.0) {
      let clip = probeFrame.previousViewProj * vec4f(record.position, 1.0);
      if (clip.w > 0.0) {
        let uv = clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
        // Reject newly exposed surfaces before clamping history probe taps.
        // Plane, segment visibility and endpoint parallax still qualify each tap.
        let tiles=tileCount();
        if(probeHistoryUvValid(uv)){
          if (probe >= probeFrame.probes.x&&all(uv>=vec2f(0.0))&&all(uv<vec2f(1.0))) {
            historyAdaptiveIndex = adaptiveHistoryAt(vec2u(uv * vec2f(extentSize())), record);
          }

          let g = uniformProbeGrid(uv * vec2f(extentSize()), (probeFrame.probes.w % 8u + 7u) % 8u);
          let base = vec2u(min(floor(g), vec2f(max(tiles, vec2u(2u)) - vec2u(2u))));
          var source: array<ScreenProbe, 4>;
          var indices = vec4u(0u);
          var agreement = vec4f(0.0);
          for (var tap = 0u; tap < 4u; tap++) {
            let tile = min(base + vec2u(tap & 1u, tap >> 1u), tiles - vec2u(1u));
            indices[tap] = tile.y * tiles.x + tile.x;
            source[tap] = probeHistoryIn[indices[tap]].probe;
            agreement[tap] = probeAgreement(source[tap], record.position, record.normal, record.distance);
          }
          let weights = probeInterpolationWeights(record.position, clamp(g-vec2f(base),vec2f(0.0),vec2f(1.0)), &source, agreement) * agreement;
          for (var tap = 0u; tap < 4u; tap++) {
            if (weights[tap] >= 1e-4 && source[tap].distance > 0.0 &&
                probeVisibility(source[tap], record.position, record.normal) == 1.0) {
              historyProbeIndices[tap] = indices[tap];
              historyProbeWeights[tap] = weights[tap];
            }
          }
        }
      }
    }
  }
  workgroupBarrier();
  let current = probeRadianceValue(currentRecord);
  if(distributionIsPolicyCull(currentRecord,texel)){
    radianceOut[index]=currentRecord;
    probeHistoryOut[probe].radiance[texel]=currentRecord;return;
  }
  if (record.pixel == SCREEN_PROBE_NONE || record.distance <= 0.0 || current.w != 1.0) {
    radianceOut[index] = currentRecord;
    probeHistoryOut[probe].radiance[texel] = distributionPoint(vec4f(0.0),texelDirection(texel),0.0,-1.0,0u);
    return;
  }

  var inputs:array<ProbeRadiance,9>;var weights:array<f32,9>;var inputCount=0u;
  var total = 0.0;
  var geometricSupport = 0.0;
  var youngest = f32(probeHistoryCap());
  var exact = SCREEN_PROBE_NONE;
  if (historyAdaptiveIndex != SCREEN_PROBE_NONE) {
    let retained = probeHistoryIn[historyAdaptiveIndex].radiance[texel];
    if (retained.support > 0.0 && probeRadianceMeasure(retained) > 0.0) {
      exact = historyAdaptiveIndex;
    }
  }
  for (var tap = 0u; tap < 4u; tap++) {
    var weight = historyProbeWeights[tap];
    var sourceIndex = historyProbeIndices[tap];
    if (exact != SCREEN_PROBE_NONE) {
      if (tap != 0u) { continue; }
      weight = 1.0;
      sourceIndex = exact;
    }
    if (weight == 0.0) { continue; }
    let sourceProbe = probeHistoryIn[sourceIndex].probe;
    let retained = probeHistoryIn[sourceIndex].radiance[texel];
    let value = probeRadianceValue(retained);
    if (value.w <= 0.0 || !(probeRadianceMeasure(retained) > 0.0)) { continue; }
    geometricSupport += weight;

    weight *= probeParallaxWeight(sourceProbe.position - record.position, texel,
      currentRecord.hitDistance, retained.hitDistance);
    if (weight <= 0.0) { continue; }
    inputs[inputCount]=retained;weights[inputCount]=weight;inputCount++;
    total += weight;
    youngest = min(youngest, value.w);
  }
  var age = 1.0;

  if (total > 0.0) {
    // Moment normalization must not promote a tiny surviving footprint to a
    // full history sample count. Reuse only the supported fraction of the
    // youngest history; the current resolved sample always contributes one.
    let overlap = clamp(total / geometricSupport, 0.0, 1.0);
    age = min(youngest * overlap + 1.0, f32(probeHistoryCap()));
    for(var i=0u;i<inputCount;i++){weights[i]*=(1.0-1.0/age)/total;}
  }

  if (total == 0.0) {
    // No history was admitted. Preserve the current directional estimator
    // instead of quantizing or resampling it through a one-input mixture.
    var complete = !distributionUnsupported(currentRecord);
    if (distributionIsSet(currentRecord) && !cvIs(currentRecord)) {
      for (var beam = 0u; beam < distributionCount(currentRecord); beam++) {
        complete = complete && currentRecord.samples[beam].x < DISTRIBUTION_RADIANCE_UNKNOWN;
      }
    }
    if (complete) {
      radianceOut[index] = currentRecord;
      probeHistoryOut[probe].radiance[texel] = currentRecord;
      return;
    }
  }

  inputs[inputCount]=currentRecord;weights[inputCount]=1.0/age;inputCount++;
  let depth=distributionDepth(currentRecord)+1u;
  var merged=distributionMerge(&inputs,&weights,inputCount,probeMixturePhase(probe,texel,0x741c9u,depth),1.0,currentRecord.hitDistance,depth,texel);
  radianceOut[index]=merged;merged.support=age;
  probeHistoryOut[probe].radiance[texel]=merged;
}
#endif

// Lumen's ordinary spatial filter uses a four-neighbor cross, a linear view
// depth weight, and a fixed 10-degree radiance hit cone.
var<workgroup> filterProbeIndices: array<u32, 4>;
var<workgroup> filterProbeWeights: array<f32, 4>;

#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
fn spatialProbeViewDepth(position: vec3f) -> f32 {
  let projection = view.worldViewProj;
  return screenProbeLinearViewDepth(projection * vec4f(position, 1.0), projection, view.cameraPos, position);
}

fn spatialProbePositionWeight(center: vec3f, neighbor: vec3f) -> f32 {
  let depth = spatialProbeViewDepth(center);
  let neighborDepth = spatialProbeViewDepth(neighbor);
  if (!(depth > 0.0 && depth < 1e30 && neighborDepth >= 0.0 && neighborDepth < 1e30)) { return 0.0; }
  let relative = (neighborDepth - depth) / depth;
  return exp2(-1000.0 * relative * relative);
}

fn spatialProbeHitWeight(delta: vec3f, texel: u32, center: f32, neighbor: f32) -> f32 {
  // Transport without a measured endpoint retains its existing support policy.
  if (center < 0.0 && neighbor < 0.0) { return 1.0; }
  var distance = max(center, neighbor);
  if (center >= 0.0 && neighbor >= 0.0) { distance = min(center, neighbor); }
  let direction = texelDirection(texel);
  let endpoint = delta + direction * distance;
  let magnitude = length(endpoint);
  if (magnitude < 1e-20) { return 1.0; }
  let angle = acos(clamp(dot(endpoint, direction) / magnitude, -1.0, 1.0));
  return 1.0 - saturate(angle / 0.1745329252);
}

@compute @workgroup_size(64) fn filterProbeRadiance(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let index = probe * 64u + texel;
  if (texel < 4u) {
    filterProbeIndices[texel] = SCREEN_PROBE_NONE;
    filterProbeWeights[texel] = 0.0;
    if (probe < probeFrame.probes.x && probeLive(probe)) {
      let record = probesIn[probe];
      let tiles = tileCount();
      let tile = vec2i(vec2u(probe % tiles.x, probe / tiles.x));
      let offsets = array<vec2i, 4>(vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1));
      let other = tile + offsets[texel];
      if (all(other >= vec2i(0)) && all(other < vec2i(tiles))) {
        let neighbor = u32(other.y) * tiles.x + u32(other.x);
        if (probeLive(neighbor)) {
          let candidate = probesIn[neighbor];
          let agreement = probeAgreement(candidate, record.position, record.normal, record.distance);
          if (agreement >= 0.05 && probeVisibility(candidate, record.position, record.normal) == 1.0) {
            filterProbeIndices[texel] = neighbor;
            filterProbeWeights[texel] = spatialProbePositionWeight(record.position, candidate.position);
          }
        }
      }
    }
  }
  workgroupBarrier();
  let centerRecord = radianceIn[index];
  let center = probeRadianceValue(centerRecord);
  let empty = centerRecord.support == SUPPORT_SCATTER_EMPTY || centerRecord.support == SUPPORT_SPATIAL_ESTIMATE;
  if (probe >= probeFrame.probes.x || !probeLive(probe) ||
      (!empty && (center.w != 1.0 || !(probeRadianceMeasure(centerRecord) > 0.0)))) {
    radianceOut[index] = centerRecord;
    return;
  }

  if (empty) {
    let direction = texelDirection(texel);
    let position = probesIn[probe].position;
    var projected = vec4f(0.0);
    var totalWeight = 0.0;
    for (var k = 0u; k < 4u; k++) {
      var weight = filterProbeWeights[k];
      if (!(weight > 0.0)) { continue; }
      let neighborIndex = filterProbeIndices[k];
      let neighbor = radianceIn[neighborIndex * 64u + texel];
      if (probeRadianceValue(neighbor).w != 1.0 || !(probeRadianceMeasure(neighbor) > 0.0)) { continue; }
      weight *= spatialProbeHitWeight(probesIn[neighborIndex].position - position,
        texel, centerRecord.hitDistance, neighbor.hitDistance);
      if (!(weight > 0.0)) { continue; }

      if (distributionIsSet(neighbor) && !cvIs(neighbor)) {
        for (var beam = 0u; beam < distributionCount(neighbor); beam++) {
          if (neighbor.samples[beam].x >= 0xfffffffeu) {
            radianceOut[index] = centerRecord;
            return;
          }
        }
      }
      let query = distributionQuery(neighbor, direction);
      if (query.support != 1.0 || !all(query.weighted >= vec4f(0.0)) || !all(query.weighted < vec4f(1e30))) {
        radianceOut[index] = centerRecord;
        return;
      }
      projected += query.weighted * weight;
      totalWeight += weight;
    }
    if (!(projected.w > 0.0 && totalWeight > 0.0)) {
      radianceOut[index] = centerRecord;
      return;
    }
    let boundedMass = min(projected.w / totalWeight, screenProbeAngularMeasure(direction)) *
      totalWeight / (1.0 + totalWeight);
    radianceOut[index] = distributionPoint(
      vec4f(projected.xyz / projected.w, 1.0) * boundedMass,
      direction, SUPPORT_SPATIAL_ESTIMATE, -1.0, distributionDepth(centerRecord) + 1u);
    return;
  }

  var inputs:array<ProbeRadiance,9>;var weights:array<f32,9>;inputs[0]=centerRecord;weights[0]=1.0;var count=1u;
  for (var k = 0u; k < 4u; k++) {
    var weight = filterProbeWeights[k];
    if (weight == 0.0) { continue; }
    let neighbor = radianceIn[filterProbeIndices[k] * 64u + texel];
    let value = probeRadianceValue(neighbor);

    if (value.w != 1.0 || !(probeRadianceMeasure(neighbor) > 0.0)) { continue; }
    weight *= spatialProbeHitWeight(probesIn[filterProbeIndices[k]].position - probesIn[probe].position,
      texel, centerRecord.hitDistance, neighbor.hitDistance);
    inputs[count]=neighbor;weights[count]=weight;count++;
  }

  let depth=distributionDepth(centerRecord)+1u;
  radianceOut[index]=distributionMerge(&inputs,&weights,count,probeMixturePhase(probe,texel,0xf177eu,depth),1.0,centerRecord.hitDistance,depth,texel);
}
#endif

// Octahedral texels are not equal-area: solid angle is proportional to
// 1 / |v|^3 at the (folded, unnormalized) octahedron point, so texels around
// the poles cover up to 2.8x less than texels at the equator.
fn octTexelSolidAngle(texel: u32) -> f32 {
  let p = (vec2f(f32(texel % 8u), f32(texel / 8u)) + vec2f(0.5)) / 4.0 - vec2f(1.0);
  var v = vec3f(p, 1.0 - abs(p.x) - abs(p.y));
  if (v.z < 0.0) { v = vec3f((vec2f(1.0) - abs(p.yx)) * select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0)), v.z); }
  let r = length(v);
  return 1.0 / (r * r * r);
}

// D(n) = E/pi at the actual receiver direction. Angular interpolation of
// preconvolved normal bins needs directions outside this cosine lobe and can
// reject a completely supported query. Only positive-cosine texels own support.
fn probeCellMayContribute(texel:u32, normal:vec3f)->bool {
  let cell=vec2f(f32(texel%8u),f32(texel/8u));
  for(var corner=0u;corner<4u;corner++){
    let uv=(cell+vec2f(f32(corner&1u),f32(corner>>1u)))/4.0-vec2f(1.0);
    if(dot(normal,spOctDecode(uv))>0.0){return true;}
  }
  return false;
}
fn probeIrradianceAt(probe:u32,direction:vec3f)->vec4f {
 if(spCurrentSupport(probeFrame.control.z)){return probeCurrentSupportAt(probe,direction);}
 var weighted=vec4f(0.0);var support=1.0;
 for(var texel=0u;texel<64u;texel++){
  let record=filteredProbeRadiance[probe*64u+texel];
  if(!distributionIsSet(record)&&distributionAge(record)<=0.0&&distributionAge(record)!=-2.0){
   if(probeCellMayContribute(texel,direction)){support=min(support,select(0.0,-1.0,distributionAge(record)<0.0));}continue;
  }
  let query=distributionQuery(record,direction);support=min(support,query.support);weighted+=query.weighted;
 }
 if(support!=1.0){return vec4f(0,0,0,support);}if(!(weighted.w>0.0)){return vec4f(0.0);}
 return vec4f(weighted.xyz/weighted.w,1.0);
}

// Current-frame conditional estimate and its measured projected-mass coverage.
// Unknown beams keep their original packet/status. No angular cell is filled,
// and confidence is neither a physical error bound nor a new observation.
fn distributionProjectedMeasure(record:ProbeRadiance,direction:vec3f)->f32{
 if(distributionUnsupported(record)){return -1.0;}
 if(cvIs(record)){return distributionQuery(record,direction).weighted.w;}
 if(!distributionIsSet(record)){
  let axis=distributionOctDecode(record.samples[2].x,1023.0);
  return distributionPointWeighted(record).w*max(dot(axis,direction),0.0);
 }
 var measure=0.0;
 for(var i=0u;i<distributionCount(record);i++){
  measure+=max(dot(distributionWeightedDirection(record.samples[i].y),direction),0.0)/f32(distributionCount(record));
 }
 return measure;
}
// This checks same-frame hardware placement resources, not an exact geometry
// or contact claim. Renderer graph generation and source fences own their age.
fn probeCurrentSupportHardware(probe:u32)->bool{
 if(!probeLive(probe)||!gbufferMatches()){return false;}
 let receiver=probesIn[probe];let pixel=unpackPixel(receiver.pixel);
 if(any(pixel>=extentSize())||!(receiver.distance>0.0&&receiver.distance<1e30)){return false;}
 return validDepth(textureLoad(gbufferDepth,vec2i(pixel),0));
}
fn probeCurrentSupportAt(probe:u32,direction:vec3f)->vec4f{
 let receiver=probesIn[probe];
 if(!spReconstructionSource(receiver.receiverExpected,receiver.receiverControl,probeFrame.probes.w,probeFrame.query.z,probeFrame.expectedSource,probeFrame.control.z)){return vec4f(0.0);}
 if(probeFrame.expectedSource.w==0u&&!probeCurrentSupportHardware(probe)){return vec4f(0.0);}
 var weighted=vec4f(0.0);var planned=0.0;
 for(var texel=0u;texel<64u;texel++){
  let record=filteredProbeRadiance[probe*64u+texel];
  if(record.support==SUPPORT_POLICY_CULL){
   // Only the current resolver mints this shape. Temporal/filter retain it
   // unchanged and never import it as supported history; source was checked
   // above. Re-running generation's hemisphere policy per pixel adds no fact.
   if(!distributionIsPolicyCull(record,texel)){return vec4f(0.0);}
   let debt=probePolicyCullProjectedBound(texel,direction);
   if(!(debt>=0.0&&debt<1e30)){return vec4f(0.0);}
   planned+=debt;continue;
  }
  let query=distributionQuery(record,direction);
  let measure=distributionProjectedMeasure(record,direction);
  let mass=cvMass(record);
  if(!(measure>=0.0&&measure<1e30)||!all(query.weighted>=vec4f(0.0))||!all(query.weighted<vec4f(1e30))){return vec4f(0.0);}
  if(!(mass>=0.0&&mass<1e30)||(cvIs(record)&&!(record.support>0.0))){return vec4f(0.0);}
  // An encoded assigned point/set can lie wholly behind this query. Its
  // clipped projected mass is zero, not an absent angular plan. Unplanned
  // contributing cells remain unavailable; no missing direction becomes known.
  if(query.support!=1.0&&!(mass>0.0)&&probeCellMayContribute(texel,direction)){return vec4f(0.0);}
  planned+=measure;weighted+=query.weighted;
 }
 if(!(weighted.w>0.0&&planned>0.0)){return vec4f(0.0);}
 return spReconstructionSignal(weighted.xyz/weighted.w,clamp(weighted.w/planned,0.0,1.0));
}

struct ShortRange { occlusion: f32, bent: vec3f }

#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
// Preconvolve a small octahedral map once per probe. The filtered radiance
// packet and the irradiance map occupy opposite scratch buffers after filtering.
const SP_IRRADIANCE_SIDE = 4u;
const SP_IRRADIANCE_TEXELS = SP_IRRADIANCE_SIDE * SP_IRRADIANCE_SIDE;
const SP_IRRADIANCE_SH_COEFFICIENTS = 9u;

fn spUsesSh3() -> bool { return (probeFrame.query.w & 64u) != 0u; }

fn shBasis(coefficient: u32, d: vec3f) -> f32 {
  switch coefficient {
    case 0u: { return 0.2820947918; }
    case 1u: { return 0.4886025119 * d.x; }
    case 2u: { return 0.4886025119 * d.y; }
    case 3u: { return 0.4886025119 * d.z; }
    case 4u: { return 1.0925484306 * d.x * d.y; }
    case 5u: { return 1.0925484306 * d.y * d.z; }
    case 6u: { return 0.3153915653 * (3.0 * d.z * d.z - 1.0); }
    case 7u: { return 1.0925484306 * d.x * d.z; }
    default: { return 0.5462742153 * (d.x * d.x - d.y * d.y); }
  }
}

// Project radiance and observed solid angle separately. Missing directions
// cannot masquerade as fully observed black when evaluating the cosine lobe.
fn projectProbeSh3(probe: u32, coefficient: u32) -> vec4f {
  let receiver = probesIn[probe];
  if (!spReconstructionSource(receiver.receiverExpected, receiver.receiverControl, probeFrame.probes.w,
      probeFrame.query.z, probeFrame.expectedSource, probeFrame.control.z)) { return vec4f(0.0); }
  if (probeFrame.expectedSource.w == 0u && !probeCurrentSupportHardware(probe)) { return vec4f(0.0); }
  var projected = vec4f(0.0);
  for (var texel = 0u; texel < 64u; texel++) {
    let packet = filteredProbeRadiance[probe * 64u + texel];
    if (!(packet.support > 0.0)) { continue; }
    if (cvIs(packet)) {
      if (coefficient >= 1u && coefficient <= 3u) {
        projected += 0.4886025119 * cvMoments(packet)[coefficient - 1u];
      } else {
        let direction = distributionOctDecode(packet.samples[3].y & 0xfffffu, 1023.0);
        let radiance = distributionRgbDecode(packet.samples[2].y);
        projected += vec4f(radiance, 1.0) * cvMass(packet) * shBasis(coefficient, direction);
      }
    } else if (distributionIsSet(packet)) {
      let count = distributionCount(packet);
      for (var i = 0u; i < count; i++) {
        let beam = distributionBeamDecode(packet.samples[i]);
        if (beam.availability != 0u || !(beam.measure > 0.0)) { continue; }
        projected += vec4f(beam.radiance, 1.0) * (beam.measure / f32(count)) *
          shBasis(coefficient, beam.direction);
      }
    } else {
      let direction = distributionOctDecode(packet.samples[2].x, 1023.0);
      projected += distributionPointWeighted(packet) * shBasis(coefficient, direction);
    }
  }
  return projected;
}

// Scatter is stochastic and does not populate every destination each frame.
// Empty and unresolved cells carry coverage debt but contribute no observed
// radiance. An entirely unsupported hemisphere has no reconstruction signal.
fn scatteredProbeSupportAt(probe: u32, direction: vec3f) -> vec4f {
  let receiver = probesIn[probe];
  if (!spReconstructionSource(receiver.receiverExpected, receiver.receiverControl, probeFrame.probes.w,
      probeFrame.query.z, probeFrame.expectedSource, probeFrame.control.z)) { return vec4f(0.0); }
  if (probeFrame.expectedSource.w == 0u && !probeCurrentSupportHardware(probe)) { return vec4f(0.0); }
  var weighted = vec4f(0.0);
  var inferred = vec4f(0.0);
  var missingMeasure = 0.0;
  for (var texel = 0u; texel < 64u; texel++) {
    let packet = filteredProbeRadiance[probe * 64u + texel];
    let query = distributionQuery(packet, direction);
    let estimated = packet.support == SUPPORT_SPATIAL_ESTIMATE;
    let valid = query.support == 1.0 && all(query.weighted >= vec4f(0.0)) && all(query.weighted < vec4f(1e30));
    if (valid && !estimated) {
      weighted += query.weighted;
    } else {
      missingMeasure += octTexelSolidAngle(texel) * max(dot(texelDirection(texel), direction), 0.0);
      if (valid && estimated) { inferred += query.weighted; }
    }
  }
  if (!(weighted.w > 0.0 && weighted.w < 1e30)) { return vec4f(0.0); }
  // Spatial estimates can influence the conditional RGB while observed mass stays separate.
  let combined = weighted + inferred;
  return spReconstructionSignal(combined.xyz / combined.w, weighted.w / (weighted.w + missingMeasure));
}

@compute @workgroup_size(64)
fn preintegrateScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  preintegrateProbe(spLinearId(gid, groups), false);
}

@compute @workgroup_size(64)
fn preintegrateScatteredScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  preintegrateProbe(spLinearId(gid, groups), true);
}

fn preintegrateProbe(i: u32, scattered: bool) {
  let sh3 = spUsesSh3();
  let stride = select(SP_IRRADIANCE_TEXELS, SP_IRRADIANCE_SH_COEFFICIENTS, sh3);
  let probe = i / stride;
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let texel = i % stride;
  let coord = vec2u(texel % SP_IRRADIANCE_SIDE, texel / SP_IRRADIANCE_SIDE);
  let uv = (vec2f(coord) + vec2f(0.5)) / f32(SP_IRRADIANCE_SIDE);
  var value = vec4f(0.0);
  if (probeLive(probe) && spCurrentSupport(probeFrame.control.z)) {
    if (sh3) {
      value = projectProbeSh3(probe, texel);
    } else {
      let direction = spOctDecode(uv * 2.0 - vec2f(1.0));
      if (scattered) { value = scatteredProbeSupportAt(probe, direction); }
      else { value = probeCurrentSupportAt(probe, direction); }
    }
  }
  let packed = bitcast<vec4u>(value);
  radianceOut[i] = ProbeRadiance(
    array<vec2u, 4>(packed.xy, packed.zw, vec2u(0u), vec2u(0u)), 0.0, 0.0);
}

fn spIrradianceTexel(position: vec2i) -> u32 {
  var p = position;
  let n = i32(SP_IRRADIANCE_SIDE);
  if (p.x < 0 || p.x >= n) { p = vec2i(clamp(p.x, 0, n - 1), n - 1 - p.y); }
  if (p.y < 0 || p.y >= n) { p = vec2i(n - 1 - p.x, clamp(p.y, 0, n - 1)); }
  return u32(p.y * n + p.x);
}

fn samplePreintegratedIrradiance(probe: u32, direction: vec3f) -> vec4f {
  if (spUsesSh3()) {
    let offset = probe * SP_IRRADIANCE_SH_COEFFICIENTS;
    var irradiance = vec4f(0.0);
    for (var i = 0u; i < SP_IRRADIANCE_SH_COEFFICIENTS; i++) {
      let packet = filteredProbeRadiance[offset + i];
      let coeff = bitcast<vec4f>(vec4u(packet.samples[0], packet.samples[1]));
      // Cosine transfer divided by pi for the DC, linear and quadratic bands.
      let transfer = select(select(0.25, 2.0 / 3.0, i < 4u), 1.0, i == 0u);
      irradiance += coeff * (transfer * shBasis(i, direction));
    }
    if (!(irradiance.w > 1e-5) || !all(abs(irradiance) < vec4f(1e30))) { return vec4f(0.0); }
    return spReconstructionSignal(max(irradiance.xyz / irradiance.w, vec3f(0.0)), min(irradiance.w, 1.0));
  }
  let uv = (spOctEncode(direction) * 0.5 + vec2f(0.5)) * f32(SP_IRRADIANCE_SIDE) - vec2f(0.5);
  let base = vec2i(floor(uv));
  let f = fract(uv);
  var integrated = vec4f(0.0);
  for (var tap = 0u; tap < 4u; tap++) {
    let corner = vec2u(tap & 1u, tap >> 1u);
    let factors = select(vec2f(1.0) - f, f, corner != vec2u(0u));
    let record = filteredProbeRadiance[probe * SP_IRRADIANCE_TEXELS + spIrradianceTexel(base + vec2i(corner))];
    let value = bitcast<vec4f>(vec4u(record.samples[0], record.samples[1]));
    let confidence = spReconstructionConfidence(value) * factors.x * factors.y;
    if (confidence > 0.0) {
      integrated += vec4f(value.xyz * confidence, confidence);
    }
  }
  if (!(integrated.w > 0.0)) { return vec4f(0.0); }
  return spReconstructionSignal(integrated.xyz / integrated.w, min(integrated.w, 1.0));
}

fn screenProbePixelIrradiance(probe: u32, direction: vec3f, preintegrated: bool) -> vec4f {
  if (preintegrated) { return samplePreintegratedIrradiance(probe, direction); }
  return probeIrradianceAt(probe, direction);
}
#endif

// Short-range screen-space horizon AO and bent normal within `radius` world
// units. The probes cannot resolve contact occlusion below their spacing.
fn shortRange(pixel: vec2u, position: vec3f, normal: vec3f) -> ShortRange {
  let radius = probeFrame.tuning.y;
  if (radius <= 0.0 || (probeFrame.query.w & 256u) != 0u) { return ShortRange(1.0, normal); }
  let extent = vec2f(extentSize());
  let toView = normalize(view.cameraPos - position);
  var tangent = cross(toView, normal);
  if (dot(tangent, tangent) < 1e-6) { tangent = cross(vec3f(0.0, 1.0, 0.0), normal); }
  if (dot(tangent, tangent) < 1e-6) { tangent = vec3f(1.0, 0.0, 0.0); }
  let c0 = view.worldViewProj * vec4f(position, 1.0);
  let c1 = view.worldViewProj * vec4f(position + normalize(tangent) * radius, 1.0);
  let span = length((c1.xy / c1.w - c0.xy / c0.w) * 0.5 * extent);
  if (!(span >= 1.0)) { return ShortRange(1.0, normal); }
  let rotation = spUnit(packPixel(pixel) ^ (probeFrame.probes.w * 2654435761u)) * 6.28318530718;
  var occlusion = 0.0;
  var bent = vec3f(0.0);
  var samples = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let angle = rotation + f32(k) * 1.57079632679;
    let direction = vec2f(cos(angle), sin(angle));
    for (var s = 1u; s <= 6u; s++) {
      let offset = direction * span * (f32(s) - 0.5) / 6.0;
      let q = vec2i(vec2f(pixel) + vec2f(0.5) + offset);
      if (any(q < vec2i(0)) || any(q >= vec2i(extentSize()))) { continue; }
      let z = textureLoad(gbufferDepth, q, 0);
      if (!validDepth(z)) { continue; }
      let v = worldPosition(vec2u(q), z) - position;
      let len = length(v);
      samples += 1.0;
      if (len <= 1e-5 || len >= radius) { continue; }
      let h = max(dot(normal, v / len) - 0.1, 0.0) * (1.0 - (len * len) / (radius * radius));
      occlusion += h;
      bent += v / len * h;
    }
  }
  if (samples == 0.0) { return ShortRange(1.0, normal); }
  let ao = clamp(1.0 - 2.0 * occlusion / samples, 0.0, 1.0);
  let bentNormal = normalize(normal - bent / samples);
  return ShortRange(ao, select(normal, bentNormal, dot(bentNormal, normal) > 0.0));
}

#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
fn spAoFactor() -> u32 { return select(1u, 2u, (probeFrame.query.w & 128u) != 0u); }
fn spAoExtent() -> vec2u { return (extentSize() + vec2u(spAoFactor() - 1u)) / spAoFactor(); }
fn spAoPixel(cell: vec2u) -> vec2u {
  return min(cell * spAoFactor() + vec2u(spAoFactor() / 2u), extentSize() - vec2u(1u));
}
fn spAoDepth(pixel: vec2u) -> f32 {
  let size = textureDimensions(gbufferDepth);
  let uv = (vec2f(pixel) + 0.5) / vec2f(size);
  let cell = depthPyramidCell(uv, textureDimensions(depthPyramid, 0));
  return projectViewDepth(textureLoad(depthPyramid, vec2i(cell), 0).x, view.temporalProjection);
}

fn spAoSlicePrimitive(h: f32, normalAngle: f32) -> f32 {
  return (cos(normalAngle) + 2.0 * h * sin(normalAngle) - cos(2.0 * h - normalAngle)) * 0.25;
}

// Two azimuthal slices and three steps on each side. Integrate the visible
// cosine arcs against their open-surface references to avoid grazing darkening.
@compute @workgroup_size(64)
fn computeScreenProbeShortRangeAo(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = spAoExtent();
  if (i >= extent.x * extent.y) { return; }
  shortRangeAoOut[i] = vec4f(0.0, 0.0, 0.0, -1.0);
  if (!gbufferMatches()) { return; }
  let pixel = spAoPixel(vec2u(i % extent.x, i / extent.x));
  let depth = textureLoad(gbufferDepth, vec2i(pixel), 0);
  if (!validDepth(depth)) { return; }
  let p = worldPosition(pixel, depth);
  let n = loadStandardGBufferNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  let toView = view.cameraPos - p;
  let distance = length(toView);
  if (!(distance > 1e-5 && distance < 1e30)) { return; }
  let v = toView / distance;
  let axis = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(v.y) > 0.99);
  let right = normalize(cross(axis, v));
  let up = cross(v, right);
  let radius = probeFrame.tuning.y;
  let blueNoisePixel = pixel & vec2u(127u);
  let blueNoiseRow = blueNoisePixel.y + (probeFrame.probes.w & 7u) * 128u;
  let aoBlueNoiseAzimuth = textureLoad(scatterNoise, vec2i(i32(blueNoisePixel.x), i32(blueNoiseRow)), 0).x;
  let rotation = aoBlueNoiseAzimuth * 1.57079632679;
  let projection = view.worldViewProj;
  let eyeAxis = vec3f(projection[0].w, projection[1].w, projection[2].w);
  let perspective = any(eyeAxis != vec3f(0.0));
  var depthAxis = eyeAxis;
  var sceneDepth = (projection * vec4f(p, 1.0)).w;
  if (!perspective) {
    depthAxis = -normalize(vec3f(projection[0].z, projection[1].z, projection[2].z));
    sceneDepth = dot(p - view.cameraPos, depthAxis);
  }
  if (!(sceneDepth > 1e-5 && sceneDepth < 1e30)) { return; }
  let invForegroundDistance = 1.0 / (0.3 * sceneDepth);
  // The normalized 10-bit G-buffer normal can deviate by twice the
  // Euclidean half-quantization step. Such a sample may still be coplanar.
  let normalUncertainty = 2.0 * sqrt(3.0) / 1023.0;
  var visible = 0.0;
  var open = 0.0;
  var bent = vec3f(0.0);
  for (var slice = 0u; slice < 2u; slice++) {
    let angle = rotation + f32(slice) * 1.57079632679;
    let t = right * cos(angle) + up * sin(angle);
    let n2 = vec2f(dot(n, v), dot(n, t));
    let projected = length(n2);
    if (!(projected > 1e-5)) { continue; }
    let normalAngle = atan2(n2.y, max(n2.x, 0.0));
    let bounds = vec2f(normalAngle - 1.57079632679, normalAngle + 1.57079632679);
    let low = cos(bounds);
    var horizon = low;
    for (var side = 0u; side < 2u; side++) {
      let direction = t * select(-1.0, 1.0, side == 1u);
      for (var step = 1u; step <= 3u; step++) {
        let fraction = f32(step) / 3.0;
        let samplePoint = p + direction * (radius * fraction * fraction);
        let clip = view.worldViewProj * vec4f(samplePoint, 1.0);
        if (!(clip.w > 0.0)) { continue; }
        let uv = clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
        if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { continue; }
        let q = vec2u(uv * vec2f(extentSize()));
        if (all(q / spAoFactor() == pixel / spAoFactor())) { continue; }
        let z = spAoDepth(q);
        if (!validDepth(z)) { continue; }
        let delta = worldPositionAtUv(uv, z) - p;
        let span = length(delta);
        if (!(span > 1e-5 && span <= radius * 1.5)) { continue; }
        if (dot(n, delta) <= span * normalUncertainty) { continue; }
        let toward = dot(delta, v);
        let reject = saturate(abs(dot(delta, depthAxis)) * invForegroundDistance);
        // Full weight through the inner radius, smoothly reject beyond it.
        let fade = max(reject, clamp((span / radius - 0.5) * 1.0, 0.0, 1.0));
        horizon[side] = max(horizon[side], mix(clamp(toward / span, -1.0, 1.0), low[side], fade));
      }
    }
    let h = vec2f(-acos(horizon.x), acos(horizon.y));
    let contribution = projected * (spAoSlicePrimitive(h.x, normalAngle) + spAoSlicePrimitive(h.y, normalAngle));
    visible += contribution;
    open += projected * (cos(normalAngle) + normalAngle * sin(normalAngle));
    let mid = (h.x + h.y) * 0.5;
    bent += (v * cos(mid) + t * sin(mid)) * max(contribution, 0.0);
  }
  let ao = select(1.0, clamp(visible / max(open, 1e-5), 0.03, 1.0), open > 1e-5);
  let direction = normalize(n * 1e-4 + bent);
  shortRangeAoOut[i] = vec4f(select(n, direction,
    spAoFactor() == 1u && ao < 0.999 && dot(direction, n) > 0.0), ao);
}

fn loadScreenProbeShortRangeAo(i: u32, extent: vec2u) -> f32 {
  if (spAoFactor() == 1u) {
    let ao = shortRangeAoIn[i];
    return select(1.0, ao.w, ao.w >= 0.0);
  }
  let pixel = vec2u(i % extent.x, i / extent.x);
  let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
  if (!validDepth(z)) { return 1.0; }
  let p = worldPosition(pixel, z);
  let n = loadStandardGBufferNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  let threshold = max(0.015 * length(p - view.cameraPos), 1e-4);
  let grid = (vec2f(pixel) - vec2f(1.0)) / 2.0;
  let base = vec2i(floor(grid));
  let f = fract(grid);
  let cells = spAoExtent();
  var weighted = vec2f(0.0);
  for (var tap = 0u; tap < 4u; tap++) {
    let corner = vec2u(tap & 1u, tap >> 1u);
    let cell = vec2u(clamp(base + vec2i(corner), vec2i(0), vec2i(cells) - vec2i(1)));
    let ao = shortRangeAoIn[cell.y * cells.x + cell.x];
    if (ao.w < 0.0 || dot(ao.xyz, n) < 0.8) { continue; }
    let q = spAoPixel(cell);
    let sampleZ = textureLoad(gbufferDepth, vec2i(q), 0);
    let plane = abs(dot(worldPosition(q, sampleZ) - p, n));
    if (plane >= threshold) { continue; }
    let factor = select(vec2f(1.0) - f, f, corner != vec2u(0u));
    let weight = factor.x * factor.y * (1.0 - plane / threshold);
    weighted += vec2f(ao.w, 1.0) * weight;
  }
  return select(1.0, weighted.x / max(weighted.y, 1e-5), weighted.y > 1e-5);
}

// Clamp the reprojected AO to the current neighbourhood mean +/- sigma.
// AO keeps its own signal and uses the diffuse reprojection's geometry weights.
fn screenAoNeighborhood(pixel: vec2u, center: f32) -> vec2f {
  let limit = vec2i(spAoExtent()) - vec2i(1);
  let cell = vec2i(pixel / spAoFactor());
  var sum = center;
  var sumSquared = center * center;
  var weight = 1.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let tap = cell + vec2i(x, y);
      if ((x == 0 && y == 0) || any(tap < vec2i(0)) || any(tap > limit)) { continue; }
      let v = shortRangeAoIn[u32(tap.y) * spAoExtent().x + u32(tap.x)].w;
      if (!(v >= 0.0 && v <= 1.0)) { continue; }
      sum += v;
      sumSquared += v * v;
      weight += 1.0;
    }
  }
  let mean = sum / weight;
  let sigma = sqrt(max(sumSquared / weight - mean * mean, 0.0));
  return vec2f(mean - sigma, mean + sigma);
}

const SP_META_KIND_MASK = 3u;
const SP_META_AO_VALID = 4u;
const SP_META_FAST_UPDATE_SHIFT = 5u;
const SP_META_MATERIAL_SHIFT = 13u;
const SP_FAST_UPDATE_LIMIT = 0.9;


// Pixel-owned history uses Lumen's four-bit normalized age. Reserve word
// zero for invalid metadata; a newly exposed receiver starts at age zero.
fn encodeScreenProbeHistoryAge(age: f32, limit: u32) -> u32 {
  let range = min(f32(limit), 15.0);
  return 1u + u32(round(clamp(age / max(1.0, range), 0.0, 1.0) * 15.0));
}

fn decodeScreenProbeHistoryAge(word: u32, limit: u32) -> f32 {
  let code = word - 1u;
  return select(f32(code) * min(f32(limit), 15.0) / 15.0, f32(limit), code == 15u);
}

fn screenProbeFastUpdate(pixelMoving: f32) -> f32 {
  // Lumen compares against 10% coverage and removes the lowest fifth of that range.
  return clamp((min(pixelMoving * 10.0, 1.0) - 0.2) / 0.8, 0.0, SP_FAST_UPDATE_LIMIT);
}
const SP_META_MATERIAL_CLASSIFIED = STANDARD_GBUFFER_SCREEN_TRACE_CLASSIFIED_BIT >> SP_META_MATERIAL_SHIFT;
const SP_META_MATERIAL_BACKFACE_DIFFUSE = STANDARD_GBUFFER_SCREEN_TRACE_BACKFACE_DIFFUSE_BIT >> SP_META_MATERIAL_SHIFT;

fn screenProbeMetaAo(kind: u32, ao: f32) -> u32 {
  if (!(ao >= 0.0)) { return kind; }
  return kind | SP_META_AO_VALID | pack2x16float(vec2f(0.0, clamp(ao, 0.0, 1.0)));
}

fn screenProbeMultibounceOcclusion(visibility: f32, pixel: vec2i, compact: bool) -> vec3f {
  let encoded = textureLoad(gbufferAlbedo, pixel, 0).r;
  // The Default GBuffer stores sRGB, while the full Standard GBuffer uses
  // its square-root reflectance codec. Lumen limits the bounce albedo to 0.5.
  var baseColor: vec3f;
  if (compact) {
    baseColor = decodeCompactBaseColor(unpack4x8unorm(encoded).rgb);
  } else {
    baseColor = decodeStandardReflectance(encoded).rgb;
  }
  let albedo = min(baseColor, vec3f(0.5));
  // Jimenez et al. multi-bounce approximation, used by Lumen's diffuse composite.
  let a = 2.0404 * albedo - vec3f(0.3324);
  let b = -4.7951 * albedo + vec3f(0.6417);
  let c = 2.7552 * albedo + vec3f(0.6903);
  return max(vec3f(visibility), ((a * visibility + b) * visibility + c) * visibility);
}

fn applyScreenProbeCurrentAo(i: u32, compact: bool) {
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  let value = integrated[i];
  integratedOut[i] = value;
  if (spReconstructionConfidence(value) <= 0.0 || !gbufferMatches()) { return; }
  let ao = loadScreenProbeShortRangeAo(i, extent);
  let pixel = vec2i(vec2u(i % extent.x, i / extent.x));
  integratedOut[i] = vec4f(value.xyz * screenProbeMultibounceOcclusion(ao, pixel, compact), value.w);
}

fn applyScreenProbeRetainedAo(i: u32, compact: bool) {
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  let value = integrated[i];
  let ao = metaIn[i].w;
  integratedOut[i] = value;
  if ((ao & SP_META_AO_VALID) == 0u) { return; }
  let pixel = vec2i(vec2u(i % extent.x, i / extent.x));
  let visibility = unpack2x16float(ao).y;
  integratedOut[i] = vec4f(value.xyz * screenProbeMultibounceOcclusion(visibility, pixel, compact), value.w);
}

@compute @workgroup_size(64)
fn applyScreenProbeShortRangeAo(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  applyScreenProbeCurrentAo(spLinearId(gid, groups), false);
}

@compute @workgroup_size(64)
fn applyScreenProbeShortRangeAoCompact(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  applyScreenProbeCurrentAo(spLinearId(gid, groups), true);
}

@compute @workgroup_size(64)
fn applyScreenProbeAoHistory(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  applyScreenProbeRetainedAo(spLinearId(gid, groups), false);
}

@compute @workgroup_size(64)
fn applyScreenProbeAoHistoryCompact(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  applyScreenProbeRetainedAo(spLinearId(gid, groups), true);
}
#endif

// One thread per pixel: blend the bilinear uniform probes and the tile's
// adaptive probes, sample D at the bent normal and apply short-range AO once.
#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
fn integrateScreenProbePixel(i: u32, preintegrated: bool) {
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  integratedOut[i] = vec4f(0.0);
  if (!gbufferMatches()) { return; }
  let pixel = vec2u(i % extent.x, i / extent.x);
  let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
  if (!validDepth(z)) { return; }
  let position = worldPosition(pixel, z);
  if (!loadStandardGBufferValid(gbufferNormal, vec2i(pixel))) { return; }
  let normal = loadStandardGBufferNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  let distance = length(view.cameraPos - position);
  let near = shortRange(pixel, position, normal);
  let tiles = tileCount();
  let g = uniformProbeGrid(vec2f(pixel) + vec2f(0.5), probeFrame.probes.w);
  let base = vec2u(min(floor(g), vec2f(max(tiles, vec2u(2u)) - vec2u(2u))));
  var source: array<ScreenProbe, 4>;
  for (var tap = 0u; tap < 4u; tap++) {
    let tile = min(base + vec2u(tap & 1u, tap >> 1u), tiles - vec2u(1u));
    source[tap] = probesIn[tile.y * tiles.x + tile.x];
  }
  let taps = uniformTaps(pixel, position, normal, distance, &source);
  var sum = vec3f(0.0);
  var total = 0.0;
  var incomplete = false;
  var footprint = 0.0;
  let reconstruct = spCurrentSupport(probeFrame.control.z);
  for (var tap = 0u; tap < 4u; tap++) {
    let w = taps.weights[tap];
    if (w > 1e-4) {
      if (probeVisibility(source[tap], position, normal) != 1.0) { continue; }
      let value = screenProbePixelIrradiance(taps.probes[tap], near.bent, preintegrated);
      footprint += w;
      if(reconstruct){let confidence=spReconstructionConfidence(value);sum+=value.xyz*(w*confidence);total+=w*confidence;continue;}
      incomplete = incomplete || value.w == SUPPORT_INCOMPLETE;
      if (value.w == 1.0) { sum += value.xyz * w; total += w; }
    }
  }
  let ownTile = min(pixel / probeFrame.probes.z, tiles - vec2u(1u));
  let adaptive = tileAdaptiveIn[adaptiveSlotForPixel(ownTile, pixel)];
  if (adaptive != SCREEN_PROBE_NONE && probeLive(adaptive)) {
    let w = probeAgreement(probesIn[adaptive], position, normal, distance);
    if (w > 1e-4 && probeVisibility(probesIn[adaptive], position, normal) == 1.0) {
      let value = screenProbePixelIrradiance(adaptive, near.bent, preintegrated);
      footprint += w;
      if(reconstruct){let confidence=spReconstructionConfidence(value);sum+=value.xyz*(w*confidence);total+=w*confidence;}
      else {
      incomplete = incomplete || value.w == SUPPORT_INCOMPLETE;
      if (value.w == 1.0) { sum += value.xyz * w; total += w; }
      }
    }
  }
  if(reconstruct&&footprint>0.0){
    if(total>1e-3){integratedOut[i]=spReconstructionSignal(sum/total*near.occlusion,clamp(total/footprint,0.0,1.0));}
    return;
  }
  if (incomplete) { return; }
  if (total > 1e-3) {
    integratedOut[i] = vec4f(sum / total * near.occlusion, 1.0);
    return;
  }
  // World fallback: the persistent Irradiance Field.
  let toView = view.cameraPos - position;
  let value = sampleIrradianceField(position, normal, toView / max(length(toView), 1e-8));
  if (value.w > 0.0) {
    integratedOut[i] = select(vec4f(value.xyz * near.occlusion, 1.0),spReconstructionSignal(value.xyz * near.occlusion,1.0),reconstruct);
  }
}

@compute @workgroup_size(64) fn integrateScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  integrateScreenProbePixel(spLinearId(gid, groups), false);
}

@compute @workgroup_size(64) fn integratePreintegratedScreenProbes(
    @builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
  integrateScreenProbePixel(spLinearId(gid, groups), true);
}

const SP_MIN_SCREEN_PROBE_WEIGHT = 0.01;

struct ScreenSpaceProbeContribution {
  preferred: vec4f,
  fallback: vec4f,
}

fn screenSpaceProbeWeights(probe: ScreenProbe, position: vec3f, normal: vec3f,
    viewDepth: f32) -> vec2f {
  if (probe.pixel == SCREEN_PROBE_NONE || !(viewDepth > 0.0)) { return vec2f(0.0); }
  let plane = dot(probe.position - position, normal) / viewDepth;
  return exp2(vec2f(-10000.0, -1000.0) * (plane * plane));
}

fn screenSpaceProbeContribution(index: u32, position: vec3f, normal: vec3f,
    viewDistance: f32, direction: vec3f) -> ScreenSpaceProbeContribution {
  let weights = screenSpaceProbeWeights(probesIn[index], position, normal, viewDistance);
  if (!(weights.y > 1e-4)) { return ScreenSpaceProbeContribution(); }
  let signal = samplePreintegratedIrradiance(index, direction);
  let coverage = spReconstructionConfidence(signal);
  if (!(coverage > 0.0)) { return ScreenSpaceProbeContribution(); }
  let value = vec4f(signal.xyz, 1.0) * coverage;
  return ScreenSpaceProbeContribution(value * weights.x, value * weights.y);
}

// Choose from the receiver's normalized preferred weights before fetching
// irradiance. An adaptive candidate or uncertain directional coverage requires
// the ordinary supported blend rather than a single black or partial sample.
struct ScreenSpaceProbeSample {
  signal: vec4f,
  probe: u32,
}

fn stochasticScreenSpaceProbe(pixel: vec2u, base: vec2u, f: vec2f, position: vec3f,
    normal: vec3f, distance: f32, direction: vec3f) -> ScreenSpaceProbeSample {
  let tiles = tileCount();
  var indices = vec4u(0u);
  var weights = vec4f(0.0);
  for (var tap = 0u; tap < 4u; tap++) {
    let offset = vec2u(tap & 1u, tap >> 1u);
    let factor = select(vec2f(1.0) - f, f, offset != vec2u(0u));
    let weight = factor.x * factor.y;
    if (!(weight > 0.0)) { continue; }
    let tile = min(base + offset, tiles - vec2u(1u));
    if (probeFrame.probes.y > 0u &&
        tileAdaptiveIn[adaptiveSlotForPixel(tile, pixel)] != SCREEN_PROBE_NONE) {
      return ScreenSpaceProbeSample();
    }
    let index = tile.y * tiles.x + tile.x;
    indices[tap] = index;
    weights[tap] = weight * screenSpaceProbeWeights(probesIn[index], position, normal, distance).x;
  }
  let sum = dot(weights, vec4f(1.0));
  if (sum < SP_MIN_SCREEN_PROBE_WEIGHT) { return ScreenSpaceProbeSample(); }
  let phase = spUnit(packPixel(pixel) ^ spHash(probeFrame.probes.w + 0xc4ab1387u));
  let threshold = phase * sum;
  let cumulative = vec3f(weights.x, weights.x + weights.y, weights.x + weights.y + weights.z);
  let tap = u32(threshold >= cumulative.x) + u32(threshold >= cumulative.y) +
    u32(threshold >= cumulative.z);
  if (!(weights[tap] > 0.0)) { return ScreenSpaceProbeSample(); }
  let probe = indices[tap];
  let signal = samplePreintegratedIrradiance(probe, direction);
  if (spReconstructionConfidence(signal) < 0.9999) { return ScreenSpaceProbeSample(); }
  return ScreenSpaceProbeSample(vec4f(signal.xyz, min(sum, 1.0)), probe);
}

// Screen-space reconstruction uses the existing probe atlas and the receiver
// plane. World tracing and probe filtering own the shared lighting data.
@compute @workgroup_size(64)
fn integrateScreenSpaceScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  _ = integrateScreenSpaceProbeAt(spLinearId(gid, groups), false);
}

@compute @workgroup_size(64)
fn integrateScreenSpaceScreenProbesWithMotion(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  let inputs = integrateScreenSpaceProbeAt(i, true);
  var moving = 0.0;
  for (var tap = 0u; tap < 4u; tap++) {
    let weight = inputs.weights[tap];
    if (weight > 0.0) { moving += weight * probeMovingIn[inputs.probes[tap]]; }
  }
  // Match the precision of UE's LightIsMoving R8 channel. Validity remains in
  // the independent reconstruction confidence field.
  pixelMovingOut[i] = u32(round(clamp(moving, 0.0, 1.0) * 255.0));
}

struct ScreenSpaceMotionInputs {
  probes: vec4u,
  weights: vec4f,
}

fn integrateScreenSpaceProbeAt(i: u32, gatherMoving: bool) -> ScreenSpaceMotionInputs {
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return ScreenSpaceMotionInputs(); }
  integratedOut[i] = vec4f(0.0);
  if (!gbufferMatches()) { return ScreenSpaceMotionInputs(); }
  let pixel = vec2u(i % extent.x, i / extent.x);
  let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
  if (!validDepth(z)) { return ScreenSpaceMotionInputs(); }
  let position = worldPosition(pixel, z);
  let normal = loadStandardGBufferNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  let distance = traceViewDistance(view.worldViewProj * vec4f(position, 1.0));
  let near = shortRange(pixel, position, normal);
  let tiles = tileCount();
  let grid = uniformProbeGrid(vec2f(pixel) + vec2f(0.5), probeFrame.probes.w);
  let base = vec2u(floor(grid));
  let f = fract(grid);
  if ((probeFrame.query.w & 32u) != 0u && (probeFrame.control.z & 2u) != 0u) {
    let sample = stochasticScreenSpaceProbe(pixel, base, f, position, normal, distance, near.bent);
    if (sample.signal.w > 0.0) {
      integratedOut[i] = spReconstructionSignal(sample.signal.xyz * near.occlusion, sample.signal.w);
      return ScreenSpaceMotionInputs(vec4u(sample.probe, 0u, 0u, 0u), vec4f(1.0, 0.0, 0.0, 0.0));
    }
  }
  var lighting = vec4f(0.0);
  var fallback = vec4f(0.0);
  var usedProbes = vec4u(0u);
  var preferredWeights = vec4f(0.0);
  var fallbackWeights = vec4f(0.0);
  for (var tap = 0u; tap < 4u; tap++) {
    let offset = vec2u(tap & 1u, tap >> 1u);
    let factor = select(vec2f(1.0) - f, f, offset != vec2u(0u));
    let weight = factor.x * factor.y;
    if (!(weight > 0.0)) { continue; }
    let tile = min(base + offset, tiles - vec2u(1u));
    let index = tile.y * tiles.x + tile.x;
    var selected = index;
    var influence = vec2f(weight);
    if (probeFrame.probes.y > 0u) {
      let strength = screenSpaceProbeWeights(probesIn[index], position, normal, distance) * weight;
      var best = strength.x;
      if (best < SP_MIN_SCREEN_PROBE_WEIGHT) {
        let slots = adaptiveSlots();
        let base = (tile.y * tiles.x + tile.x) * slots;
        for (var candidate = 0u; candidate < slots; candidate++) {
          let adaptive = tileAdaptiveIn[base + candidate];
          if (adaptive == SCREEN_PROBE_NONE || !probeLive(adaptive)) { continue; }
          let probe = probesIn[adaptive];
          let d = abs(vec2f(unpackPixel(probe.pixel)) - vec2f(pixel));
          let proximity = 1.0 - saturate(min(d.x, d.y) / f32(probeFrame.probes.z));
          let score = screenSpaceProbeWeights(probe, position, normal, distance).x * proximity;
          if (score > best) {
            selected = adaptive;
            best = score;
            influence = vec2f(proximity);
          }
        }
      }
    }
    var contribution = screenSpaceProbeContribution(selected, position, normal, distance, near.bent);
    if (selected != index && contribution.preferred.w == 0.0 && contribution.fallback.w == 0.0) {
      selected = index;
      contribution = screenSpaceProbeContribution(selected, position, normal, distance, near.bent);
      influence = vec2f(weight);
    }
    lighting += contribution.preferred * influence.x;
    fallback += contribution.fallback * influence.y;
    if (gatherMoving) {
      usedProbes[tap] = selected;
      preferredWeights[tap] = contribution.preferred.w * influence.x;
      fallbackWeights[tap] = contribution.fallback.w * influence.y;
    }
  }
  if (lighting.w >= SP_MIN_SCREEN_PROBE_WEIGHT) {
    integratedOut[i] = spReconstructionSignal(lighting.xyz / lighting.w * near.occlusion, min(lighting.w, 1.0));
    return ScreenSpaceMotionInputs(usedProbes, preferredWeights / lighting.w);
  }
  if (fallback.w >= SP_MIN_SCREEN_PROBE_WEIGHT) {
    integratedOut[i] = spReconstructionSignal(fallback.xyz / fallback.w * near.occlusion, 0.5 * min(fallback.w, 1.0));
    return ScreenSpaceMotionInputs(usedProbes, fallbackWeights / fallback.w);
  }
  return ScreenSpaceMotionInputs();
}
#endif

fn packNormal(n: vec3f) -> u32 { return pack2x16snorm(spOctEncode(n)); }
fn unpackNormal(p: u32) -> vec3f { return spOctDecode(unpack2x16snorm(p)); }

// One thread per pixel: reproject last frame's accumulated irradiance and
// reject each bilinear tap on distance/normal disagreement, then normalize
// only supported taps (UE ScreenProbeTemporalReprojection).
#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
@compute @workgroup_size(64) fn temporalScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  temporalScreenProbeAt(spLinearId(gid, groups), vec3f(-1.0), vec2u(0u), 0u, false);
}

@compute @workgroup_size(64) fn temporalScreenProbesWithAo(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  temporalScreenProbeAt(i, screenProbeCurrentAo(i, extent), vec2u(0u), 0u, false);
}

@compute @workgroup_size(64) fn temporalScreenProbesWithVelocity(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  let velocity = textureLoad(motionWithDepth, vec2i(vec2u(i % extent.x, i / extent.x)), 0).xy;
  temporalScreenProbeAt(i, vec3f(-1.0), velocity, 0u, false);
}

@compute @workgroup_size(64) fn temporalScreenProbesWithAoAndVelocity(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  let velocity = textureLoad(motionWithDepth, vec2i(vec2u(i % extent.x, i / extent.x)), 0).xy;
  temporalScreenProbeAt(i, screenProbeCurrentAo(i, extent), velocity, 0u, false);
}

@compute @workgroup_size(64) fn temporalScreenProbesWithMotion(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  let velocity = textureLoad(motionWithDepth, vec2i(vec2u(i % extent.x, i / extent.x)), 0).xy;
  temporalScreenProbeAt(i, vec3f(-1.0), velocity, pixelMovingIn[i], true);
}

@compute @workgroup_size(64) fn temporalScreenProbesWithAoAndMotion(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  let velocity = textureLoad(motionWithDepth, vec2i(vec2u(i % extent.x, i / extent.x)), 0).xy;
  temporalScreenProbeAt(i, screenProbeCurrentAo(i, extent), velocity, pixelMovingIn[i], true);
}

fn screenProbeCurrentAo(i: u32, extent: vec2u) -> vec3f {
  let ao = loadScreenProbeShortRangeAo(i, extent);
  var bounds = vec2f(ao);
  if ((probeFrame.control.z & 2u) != 0u) {
    bounds = screenAoNeighborhood(vec2u(i % extent.x, i / extent.x), ao);
  }
  return vec3f(ao, bounds);
}

// Solve the three clip-space planes for a previous world point. This is
// inverse projection, evaluated only for receivers with a written 3D velocity.
fn screenProbePreviousWorld(ndc: vec3f) -> vec4f {
  let m = probeFrame.previousViewProj;
  let w = vec4f(m[0].w, m[1].w, m[2].w, m[3].w);
  let x = vec4f(m[0].x, m[1].x, m[2].x, m[3].x) - ndc.x * w;
  let y = vec4f(m[0].y, m[1].y, m[2].y, m[3].y) - ndc.y * w;
  let z = vec4f(m[0].z, m[1].z, m[2].z, m[3].z) - ndc.z * w;
  let yz = cross(y.xyz, z.xyz);
  let det = dot(x.xyz, yz);
  if (!(abs(det) > 0.0)) { return vec4f(0.0); }
  let world = -(x.w * yz + y.w * cross(z.xyz, x.xyz) + z.w * cross(x.xyz, y.xyz)) / det;
  let clipW = dot(w, vec4f(world, 1.0));
  if (!(clipW > 0.0) || !all(abs(world) < vec3f(1e30))) { return vec4f(0.0); }
  return vec4f(world, 1.0);
}

@compute @workgroup_size(64) fn prepareScreenProbeReceiverMotion(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  if (i >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  receiverMotionOut[i] = vec2f(-1.0, 0.0);
  if (!probeLive(i) || !(probeFrame.previousCameraPos.w > 0.0)) { return; }
  let probe = probesIn[i];
  let clip = view.temporalCurrentViewProj * vec4f(probe.position, 1.0);
  let depth = traceViewDistance(clip);
  if (!(depth > 0.0 && depth < 1e30)) { return; }
  let word = textureLoad(motionWithDepth, vec2i(unpackPixel(probe.pixel)), 0).xy;
  // The Compact velocity attachment clears unmodified static geometry.
  // Camera motion alone does not give this world point a displacement.
  if (all(word == vec2u(0u))) {
    receiverMotionOut[i] = vec2f(0.0, depth);
    return;
  }
  if (word.y == SCENE_VELOCITY_INVALID_DEPTH || word.y == 0u || word.x == 0u) { return; }
  let z = sceneVelocityPreviousDepth(word.y);
  if (!(z >= 0.0 && z <= 1.0)) { return; }
  let uv = sceneTemporalUv(clip) - decodeSceneVelocity(word.x);
  let previous = screenProbePreviousWorld(vec3f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), z));
  if (previous.w > 0.0) {
    receiverMotionOut[i] = vec2f(length(probe.position - previous.xyz), depth);
  }
}

fn screenProbeLinearViewDepth(clip: vec4f, viewProjection: mat4x4f, camera: vec3f, position: vec3f) -> f32 {
  // Perspective clip W is eye depth. The orthographic reverse-Z row
  // supplies the camera depth axis without borrowing the other frame lens.
  let perspectiveAxis = vec3f(viewProjection[0].w, viewProjection[1].w, viewProjection[2].w);
  if (any(perspectiveAxis != vec3f(0.0))) { return clip.w; }
  let depthAxis = vec3f(viewProjection[0].z, viewProjection[1].z, viewProjection[2].z);
  return dot(camera - position, normalize(depthAxis));
}

// Recover previous linear view depth using the previous projection's own
// reverse-Z scale, including when the current camera lens has changed.
fn screenProbeDepthFromPreviousDeviceZ(deviceZ: f32) -> f32 {
  let projection = probeFrame.previousViewProj;
  let zAxis = vec3f(projection[0].z, projection[1].z, projection[2].z);
  let wAxis = vec3f(projection[0].w, projection[1].w, projection[2].w);
  let perspective = dot(wAxis, wAxis);
  if (perspective > 0.0) {
    let scale = dot(zAxis, wAxis) / perspective;
    let bias = projection[3].z - scale * projection[3].w;
    return bias / (deviceZ - scale);
  }
  let cameraZ = (projection * vec4f(probeFrame.previousCameraPos.xyz, 1.0)).z;
  return (cameraZ - deviceZ) / length(zAxis);
}

fn temporalScreenProbeAt(i: u32, currentAo: vec3f, velocity: vec2u, pixelMoving: u32, useFastUpdate: bool) {
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  let current = integrated[i];
  historyOut[i] = vec4f(0.0);
  metaOut[i] = vec4u(0u);
  let reconstruct = spCurrentSupport(probeFrame.control.z);
  let currentConfidence = spReconstructionConfidence(current);
  let missingCurrent = all(current == vec4f(0.0));
  if (!gbufferMatches()) { return; }
  if (reconstruct) {
    if (!(currentConfidence > 0.0) && !missingCurrent) { return; }
  } else if (current.w != 1.0) { return; }
  let kind = select(1u, 2u, reconstruct);
  let pixel = vec2u(i % extent.x, i / extent.x);
  let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
  if (reconstruct && !validDepth(z)) { return; }
  let position = worldPosition(pixel, z);
  let packedReceiver = textureLoad(gbufferNormal, vec2i(pixel), 0).rg;
  if (!standardGBufferValid(packedReceiver)) { return; }
  let normal = decodeStandardGBufferNormal(packedReceiver).xyz;
  if (reconstruct && (!all(abs(position) < vec3f(1e30)) ||
      !all(abs(normal) < vec3f(1e30)) || !(dot(normal, normal) > 0.0))) { return; }
  // The forensic current-only policy never seeds or consumes pixel history.
  if (reconstruct && (probeFrame.control.z & 2u) == 0u) {
    historyOut[i] = current;
    metaOut[i].w = screenProbeMetaAo(0u, currentAo.x);
    return;
  }
  let pixelOwnedHistory = (probeFrame.query.w & 512u) != 0u;
  let materialFlags = select(0u,
    (packedReceiver.y & STANDARD_GBUFFER_SCREEN_TRACE_MASK) >> SP_META_MATERIAL_SHIFT, pixelOwnedHistory);
  var count = 1u;
  var currentFastUpdate = 0.0;
  var value = current.xyz;
  var ao = currentAo.x;
  var estimateConfidence = currentConfidence;
  if ((probeFrame.control.z & 2u) != 0u) {
    if (pixelOwnedHistory && useFastUpdate && currentConfidence > 0.0) {
      currentFastUpdate = screenProbeFastUpdate(f32(pixelMoving) / 255.0);
    }
    let clip = probeFrame.previousViewProj * vec4f(position, 1.0);
    var uv = clip.xy / max(clip.w, 1e-8) * vec2f(0.5, -0.5) + vec2f(0.5);
    var expected = length(probeFrame.previousCameraPos.xyz - position);
    if (pixelOwnedHistory) {
      expected = screenProbeLinearViewDepth(clip, probeFrame.previousViewProj, probeFrame.previousCameraPos.xyz, position);
      if (velocity.y == SCENE_VELOCITY_INVALID_DEPTH) { expected = -1.0; }
      else if (velocity.y != 0u && velocity.x != 0u) {
        let point = vec4f(position, 1.0);
        let currentUnjittered = sceneTemporalUv(view.temporalCurrentViewProj * point);
        let previousUnjittered = sceneTemporalUv(view.temporalPreviousViewProj * point);
        // Match the jitter lattice of the retained history, while excluding
        // raster jitter from the geometry writer's motion vector.
        uv += currentUnjittered - previousUnjittered - decodeSceneVelocity(velocity.x);
        expected = screenProbeDepthFromPreviousDeviceZ(sceneVelocityPreviousDepth(velocity.y));
      }
    }
    if (clip.w > 0.0 && expected > 0.0 && expected < 1e30 &&
        all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0))) {
      let texel = uv * vec2f(extent) - vec2f(0.5);
      let base = vec2i(floor(texel));
      let fraction = fract(texel);

      var supported = 0.0;
      var retainedCoverage = 0.0;
      var history = vec3f(0.0);
      var aoHistory = vec2f(0.0);
      let cap = pixelHistoryCap();
      let minimumHistoryTapWeight = select(0.0, 0.01, pixelOwnedHistory);
      var youngest = cap;
      var weightedAge = 0.0;
      var weightedFastUpdate = 0.0;
      for (var tap = 0u; tap < 4u; tap++) {
        let offset = vec2u(tap & 1u, tap >> 1u);
        let previous = base + vec2i(offset);
        if (any(previous < vec2i(0)) || any(previous >= vec2i(extent))) { continue; }
        let weight = select(1.0 - fraction.x, fraction.x, offset.x == 1u) *
          select(1.0 - fraction.y, fraction.y, offset.y == 1u);
        if (weight <= minimumHistoryTapWeight) { continue; }
        let index = pixelIndex(vec2u(previous));
        let state = metaIn[index];
        let stored = bitcast<f32>(state.x);
        // UE validates the backface diffuse class as well as depth and normal.
        // Unclassified receivers retain the geometric history check.
        let incompatibleMaterial = (state.w & materialFlags & SP_META_MATERIAL_CLASSIFIED) != 0u &&
          ((state.w ^ materialFlags) & SP_META_MATERIAL_BACKFACE_DIFFUSE) != 0u;
        if (incompatibleMaterial || (state.w & SP_META_KIND_MASK) != kind || state.z == 0u || abs(stored - expected) > 0.02 * expected ||
            dot(unpackNormal(state.y), normal) <= 0.7071) { continue; }
        if (reconstruct && !(stored > 0.0 && stored < 1e30 && expected > 0.0 && expected < 1e30)) { continue; }
        let retained = historyIn[index];
        let retainedConfidence = select(1.0, spReconstructionConfidence(retained), reconstruct);
        if (!(retainedConfidence > 0.0)) { continue; }
        let coveredWeight = weight * retainedConfidence;
        // In the pixel-owned path, Lumen's qualified bilinear taps determine
        // both history radiance and age. Coverage still qualifies the estimate
        // and is retained for receivers that have no new contribution.
        let contribution = select(coveredWeight, weight, pixelOwnedHistory);
        retainedCoverage += coveredWeight;
        history += retained.xyz * contribution;
        supported += contribution;
        if (ao >= 0.0 && (state.w & SP_META_AO_VALID) != 0u) {
          aoHistory += vec2f(unpack2x16float(state.w).y * contribution, contribution);
        }
        if (pixelOwnedHistory) {
          weightedAge += (1.0 + decodeScreenProbeHistoryAge(state.z, cap - 1u)) * contribution;
          if (useFastUpdate) {
            weightedFastUpdate += f32((state.w >> SP_META_FAST_UPDATE_SHIFT) & 15u) * contribution;
          }
        } else {
          youngest = min(youngest, state.z);
        }
      }
      if (supported > 0.0) {
        // Blend with the unquantized reprojected age, as Lumen does before storing history.
        let retainedAge = select(f32(youngest), weightedAge / supported, pixelOwnedHistory);
        var reprojectedSampleCount = min(retainedAge + 1.0, f32(cap));
        if (pixelOwnedHistory && useFastUpdate) {
          let retainedFastUpdate = min(weightedFastUpdate / (15.0 * supported), SP_FAST_UPDATE_LIMIT);
          let effectiveFastUpdate = max(currentFastUpdate, retainedFastUpdate);
          // The stored count includes the current sample. UE caps history age.
          reprojectedSampleCount = min(reprojectedSampleCount,
            1.0 + (1.0 - effectiveFastUpdate) * f32(cap - 1u));
        }
        if (pixelOwnedHistory) {
          count = encodeScreenProbeHistoryAge(reprojectedSampleCount - 1.0, cap - 1u);
        } else {
          count = u32(round(reprojectedSampleCount));
        }
        var alpha = 1.0 / reprojectedSampleCount;
        if (reconstruct) {
          if (missingCurrent) {
            // Lumen reduces the missing sample's weight after a full retained
            // frame. Younger Fast Update history keeps the regular blend.
            let retainedFrames = reprojectedSampleCount - 1.0;
            let downweightMissing = !pixelOwnedHistory || retainedFrames >= 1.0;
            alpha = select(alpha, 1.0 / (1.0 + 4.0 * max(retainedFrames, 1.0)), downweightMissing);
            estimateConfidence = min(retainedCoverage, 1.0);
          } else if (!pixelOwnedHistory) {
            alpha = spReconstructionTemporalAlpha(currentConfidence, supported, count);
          }
        }
        value = mix(history / supported, current.xyz, alpha);
        if (aoHistory.y > 0.0) {
          let retainedAo = clamp(aoHistory.x / aoHistory.y, currentAo.y, currentAo.z);
          let currentAoAlpha = 0.5 * alpha;
          ao = mix(retainedAo, ao, currentAoAlpha);
        }
      }
    }
  }
  // Reprojected radiance is an estimate. It never changes the source sample
  // or its ray provenance.
  if (reconstruct && !(estimateConfidence > 0.0)) { return; }
  historyOut[i] = select(vec4f(value, 1.0), spReconstructionSignal(value, estimateConfidence), reconstruct);
  var historyDepth = length(view.cameraPos - position);
  if (pixelOwnedHistory) {
    historyDepth = screenProbeLinearViewDepth(view.worldViewProj * vec4f(position, 1.0), view.worldViewProj, view.cameraPos, position);
  }
  // Persist only the current amount. Retained motion accelerates history for
  // one extra frame as the source leaves this receiver.
  let storedFastUpdate = u32(ceil(currentFastUpdate * 15.0)) << SP_META_FAST_UPDATE_SHIFT;
  metaOut[i] = vec4u(bitcast<u32>(historyDepth), packNormal(normal), count, screenProbeMetaAo(kind | materialFlags | storedFastUpdate, ao));
}
#endif

// After the composite: keep this frame's linear HDR scene for next frame's screen trace.
#ifndef IRRADIANCE_FIELD_PROBE_VISIBILITY_CACHE
@compute @workgroup_size(64) fn copySceneHistory(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  if (any(textureDimensions(sceneColor) != extent)) { previousSceneOut[i] = vec2u(0u); return; }
  let color = textureLoad(sceneColor, vec2i(vec2u(i % extent.x, i / extent.x)), 0);
  let valid = all(color.xyz >= vec3f(0.0)) && all(color.xyz <= vec3f(65504.0));
  let safe = select(vec3f(0.0), color.xyz, valid);
  previousSceneOut[i] = vec2u(pack2x16float(safe.xy), pack2x16float(vec2f(safe.z, select(0.0, 1.0, valid))));
}

@compute @workgroup_size(64) fn copyDiffuseSceneHistory(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  if (any(textureDimensions(sceneColor) != extent) ||
      any(textureDimensions(directionalReflection) != extent)) {
    previousSceneOut[i] = vec2u(0u);
    return;
  }
  let pixel = vec2i(vec2u(i % extent.x, i / extent.x));
  let scene = textureLoad(sceneColor, pixel, 0).rgb;
  let reflection = textureLoad(directionalReflection, pixel, 0).rgb;
  let color = max(scene - reflection, vec3f(0.0));
  let valid = all(scene >= vec3f(0.0)) && all(scene <= vec3f(65504.0)) &&
    all(reflection >= vec3f(0.0)) && all(reflection <= vec3f(65504.0));
  let safe = select(vec3f(0.0), color, valid);
  previousSceneOut[i] = vec2u(pack2x16float(safe.xy), pack2x16float(vec2f(safe.z, select(0.0, 1.0, valid))));
}

@compute @workgroup_size(64) fn copyScreenTraceDepth(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  let matches = all(textureDimensions(gbufferDepth) == extent);
  var depth = 0.0;
  if (matches) { depth = textureLoad(gbufferDepth, vec2i(vec2u(i % extent.x, i / extent.x)), 0); }
  previousScreenDepthOut[i] = depth;
}
#endif

// Mixed packets preserve linear statistics and a PPS-J sample of the clipped residual.
struct CvSample { color: u32, direction: u32 }
fn cvIs(p:ProbeRadiance)->bool{return (p.samples[3].y>>30u)==3u;}

fn cvMass(p:ProbeRadiance)->f32{
 if(cvIs(p)){return bitcast<f32>(p.samples[3].x);}
 if(distributionUnsupported(p)){return 0.0;}
 if(!distributionIsSet(p)){return distributionPointWeighted(p).w;}
 var total=0.0;let count=distributionCount(p);for(var i=0u;i<count;i++){total+=length(distributionWeightedDirection(p.samples[i].y));}return total/f32(count);
}
fn cvValues(p:ProbeRadiance)->vec4f{
 let a=p.samples[0];let b=p.samples[1];let c=p.samples[2].x;
 let codes=vec4u(a.x&65535u,(a.y>>8u)&65535u,b.x>>16u,(b.y>>24u)|((c&255u)<<8u));
 return bitcast<vec4f>(codes<<vec4u(15u));
}
fn cvCodes(p:ProbeRadiance)->vec4u{
 let a=p.samples[0];let b=p.samples[1];let c=p.samples[2].x;
 return vec4u((a.x>>16u)|((a.y&255u)<<16u),(a.y>>24u)|((b.x&65535u)<<8u),b.y&0xffffffu,c>>8u);
}
fn cvMoments(p:ProbeRadiance)->mat3x4f{
 let c=cvCodes(p);let v=cvValues(p);let r=distributionMomentDirection(c.r)*v.r;let g=distributionMomentDirection(c.g)*v.g;let b=distributionMomentDirection(c.b)*v.b;let w=distributionMomentDirection(c.w)*v.w;
 return mat3x4f(vec4f(r.x,g.x,b.x,w.x),vec4f(r.y,g.y,b.y,w.y),vec4f(r.z,g.z,b.z,w.z));
}
fn cvAxis(d:vec3f)->u32{let uv=vec2u(round(clamp(spOctEncode(d)*0.5+vec2f(0.5),vec2f(0.0),vec2f(1.0))*4095.0));return uv.x|(uv.y<<12u);}
fn cvAmplitude(a:f32)->u32{return min(bitcast<u32>(a)+16384u,0x7f7f8000u)>>15u;}
fn cvMake(m:mat3x4f,s:CvSample,mass:f32,age:f32,distance:f32,texel:u32,depth:u32)->ProbeRadiance{
 let r=momentAxis(vec3f(m[0].r,m[1].r,m[2].r));let g=momentAxis(vec3f(m[0].g,m[1].g,m[2].g));let b=momentAxis(vec3f(m[0].b,m[1].b,m[2].b));let w=momentAxis(vec3f(m[0].w,m[1].w,m[2].w));
 let a=vec4u(cvAmplitude(r.w),cvAmplitude(g.w),cvAmplitude(b.w),cvAmplitude(w.w));let c=vec4u(cvAxis(r.xyz),cvAxis(g.xyz),cvAxis(b.xyz),cvAxis(w.xyz));var p:ProbeRadiance;
 p.samples[0]=vec2u(a.r|((c.r&65535u)<<16u),(c.r>>16u)|(a.g<<8u)|((c.g&255u)<<24u));
 p.samples[1]=vec2u((c.g>>8u)|(a.b<<16u),c.b|((a.w&255u)<<24u));
 p.samples[2]=vec2u((a.w>>8u)|(c.w<<8u),s.color);p.samples[3]=vec2u(bitcast<u32>(mass),s.direction|((texel&63u)<<20u)|((depth&3u)<<26u)|0xc0000000u);
 p.support=age;p.hitDistance=distance;return p;
}
fn cvPick(p:ProbeRadiance,phase:f32)->CvSample{
 if(cvIs(p)){return CvSample(p.samples[2].y,p.samples[3].y&0xfffffu);}
 if(!distributionIsSet(p)){let value=distributionPointWeighted(p);return CvSample(distributionRgbEncode(value.xyz/max(value.w,1e-30)),p.samples[2].x);}
 let count=distributionCount(p);let position=phase*cvMass(p)*f32(count);var sum=0.0;var selected=count-1u;
 for(var i=0u;i<count;i++){sum+=length(distributionWeightedDirection(p.samples[i].y));if(position<sum){selected=i;break;}}
 let word=p.samples[selected];let direction=normalize(distributionWeightedDirection(word.y));return CvSample(word.x,distributionOctEncode(direction,1023.0));
}
fn distributionMerge(packets:ptr<function,array<ProbeRadiance,9>>,weights:ptr<function,array<f32,9>>,count:u32,phase:f32,age:f32,distance:f32,depth:u32,texel:u32)->ProbeRadiance{
 var total=0.0;var massSum=0.0;var m=mat3x4f();var weighted=vec4f(0.0);var allPoint=true;var axis=0xffffffffu;var last=0u;
 for(var i=0u;i<count;i++){
  let p=(*packets)[i];let w=(*weights)[i];if(!(w>0.0)||!(p.support>0.0)){continue;}
  if(distributionIsSet(p)&&!cvIs(p)){for(var beam=0u;beam<distributionCount(p);beam++){if(p.samples[beam].x>=0xfffffffeu){return distributionPoint(vec4f(0.0),texelDirection(texel),-1.0,-1.0,depth);}}}
  if(distributionUnsupported(p)){return distributionPoint(vec4f(0.0),texelDirection(texel),-1.0,-1.0,depth);}
  total+=w;m+=distributionMoments(p)*w;
  let mass=cvMass(p);if(mass>0.0){massSum+=w*mass;last=i;}
  if(distributionIsSet(p)){allPoint=false;continue;}
  let code=p.samples[2].x;if(axis==0xffffffffu){axis=code;}if(axis!=code){allPoint=false;}weighted+=distributionPointWeighted(p)*w;
 }
 if(!(total>0.0)){return distributionPoint(vec4f(0.0),texelDirection(texel),0.0,-1.0,depth);}
 if(allPoint){var result=distributionPoint(weighted/total,distributionOctDecode(axis,1023.0),age,distance,depth);result.samples[2].x=axis;return result;}
 var sample=CvSample(0u,distributionOctEncode(texelDirection(texel),1023.0));
 if(massSum>0.0){let position=phase*massSum;var sum=0.0;var picked=last;var local=1.0;
  for(var i=0u;i<count;i++){let p=(*packets)[i];let w=(*weights)[i]*cvMass(p);if(!(p.support>0.0)||!(w>0.0)){continue;}if(position<sum+w){picked=i;local=clamp((position-sum)/w,0.0,1.0);break;}sum+=w;}
  sample=cvPick((*packets)[picked],local);
 }
 return cvMake(m*(1.0/total),sample,massSum/total,age,distance,texel,depth);
}
fn cvProjected(p:ProbeRadiance,n:vec3f)->vec4f{
 let codes=cvCodes(p);let values=cvValues(p);let w=dot(distributionMomentDirection(codes.w),n);var r=w;var g=w;var b=w;
 if(values.r>0.0&&codes.r!=codes.w){r=dot(distributionMomentDirection(codes.r),n);}
 if(values.g>0.0&&codes.g!=codes.w){if(values.r>0.0&&codes.g==codes.r){g=r;}else{g=dot(distributionMomentDirection(codes.g),n);}}
 if(values.b>0.0&&codes.b!=codes.w){if(values.r>0.0&&codes.b==codes.r){b=r;}else if(values.g>0.0&&codes.b==codes.g){b=g;}else{b=dot(distributionMomentDirection(codes.b),n);}}
 return values*vec4f(r,g,b,w);
}
fn cvQuery(p:ProbeRadiance,n:vec3f)->DistributionQuery{
 if(!(p.support>0.0)){return DistributionQuery(vec4f(0.0),select(0.0,-1.0,p.support<0.0));}
 // The residual estimator already vanishes on the irrelevant half-space.
 // Query the encoded directions directly; no per-pixel four-corner scan or
 // assumption that quantized axes remain inside their original cell is needed.
 let projected=cvProjected(p,n);

 let direction=distributionOctDecode(p.samples[3].y&0xfffffu,1023.0);let cosine=dot(direction,n);let mass=bitcast<f32>(p.samples[3].x);let rgb=distributionRgbDecode(p.samples[2].y);
 let back=vec4f(rgb,1.0)*(mass*max(-cosine,0.0));let front=vec4f(rgb,1.0)*(mass*max(cosine,0.0));
 // The deterministic linear-part sign chooses an unbiased nonnegative estimator.
 // Never clamp a signed stochastic residual: that would introduce positive bias.
 return DistributionQuery(select(projected+back,front,projected<vec4f(0.0)),1.0);
}
