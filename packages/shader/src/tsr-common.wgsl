// Effective reconstruction support, independent of the shared jitter counter.
const TSR_SUPPORT_LIMIT: f32 = 128.0;

struct TsrParams {
  jitter: vec2<f32>,
  previousJitter: vec2<f32>,
  inputSize: vec2<f32>,
  previousInputSize: vec2<f32>,
  historyValid: u32,
  analysisValid: u32,
  frameIndex: u32,
  hasSecondary: u32,
  hasCoverage: u32,
  deltaSeconds: f32,
  padding: vec2<f32>,
};

fn tsrLuma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Bounded analysis encoding; radiance history itself stays linear HDR.
fn tsrGuide(c: vec3<f32>) -> vec3<f32> {
  let safe = clamp(c, vec3<f32>(0.0), vec3<f32>(65504.0));
  // Sixteen stops cover finite positive FP16 radiance without the high-end
  // saturation of c/(1+c), which hides persistent HDR shading changes.
  return log2(vec3<f32>(1.0) + safe) / 16.0;
}

fn tsrInside(uv: vec2<f32>) -> bool {
  return all(uv >= vec2<f32>(0.0)) && all(uv < vec2<f32>(1.0));
}

fn tsrPixel(uv: vec2<f32>, size: vec2<u32>) -> vec2<i32> {
  return clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), vec2<i32>(size) - 1);
}

fn tsrDepthMatches(a: SceneTemporalV1, b: SceneTemporalV1) -> bool {
  return a.validDepth && b.validDepth && a.motionValid && b.motionValid &&
    abs(a.viewDepth - b.viewDepth) <= max(0.02, a.viewDepth * 0.02);
}

struct TsrGeometry {
  packed: vec4<f32>,
  depthEdge: bool,
};

fn tsrGeometryMatches(a: SceneTemporalV1, b: SceneTemporalV1, edge: bool, speed: f32) -> bool {
  if (!a.validDepth || !a.motionValid) { return false; }
  if (b.validDepth) { return tsrDepthMatches(a,b); }
  // A stationary edge can alternate foreground and clear coverage under
  // jitter. New/moving/invalid surfaces still take the hard rejection path.
  return edge && speed < 0.25;
}

// Coverage holes at a jittered silhouette are not new surfaces. Borrow one
// complete nearest-depth tuple; never interpolate depth, motion or validity.
fn tsrClosestTemporal(source: texture_2d<f32>, uv: vec2<f32>, radius: i32) -> TsrGeometry {
  return tsrClosestTemporalAt(source, tsrPixel(uv, textureDimensions(source)), radius);
}

fn tsrClosestTemporalAt(source: texture_2d<f32>, center: vec2<i32>, radius: i32) -> TsrGeometry {
  let size = textureDimensions(source);
  var packed = textureLoad(source, center, 0);
  // Explicit material/motion invalidity is a hard veto, not a coverage hole.
  if (packed.z >= 0.0 && packed.w >= 1.0) { return TsrGeometry(packed,false); }
  var background = packed.z < 0.0;
  var farthest = packed.z;
  for (var y = -radius; y <= radius; y++) {
    for (var x = -radius; x <= radius; x++) {
      let p = clamp(center + vec2<i32>(x,y), vec2<i32>(0), vec2<i32>(size)-1);
      let candidate = textureLoad(source, p, 0);
      background = background || candidate.z < 0.0;
      farthest = max(farthest,candidate.z);
      if (candidate.z >= 0.0 && candidate.w < 2.0 &&
        (packed.z < 0.0 || candidate.z < packed.z)) {
        packed = candidate;
      }
    }
  }
  return TsrGeometry(packed, packed.z >= 0.0 && (background || farthest-packed.z > 0.0025+packed.z*0.01));
}
