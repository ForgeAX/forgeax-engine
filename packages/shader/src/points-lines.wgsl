#define_import_path forgeax_material::points_lines
#import forgeax_clipping::planes::{applyViewClipping}
#import forgeax_view::fog::{translucent_fog}
#import forgeax_view::common::{view}

// Portable triangle expansion for square/circle points and independent
// line-list segments and joined line-strip paths. Line width uses physical
// pixels or world units (style.w carries the projection focal factor, converted
// per endpoint by its clip w); dash distances use mesh-local units. Round caps
// extend open ends by the half width and trim every segment end beyond its
// perpendicular to a circle, which also rounds miter joins without overlap.
// No native wide primitive state is required.

struct PointsLinesView {
  worldViewProj : mat4x4<f32>,
  model : mat4x4<f32>,
  physicalViewport : vec2<f32>,
  style : vec4<f32>,
  dash : vec4<f32>,
};

@group(0) @binding(10) var<uniform> pointsLinesView : PointsLinesView;

struct PointsLinesMaterial {
  baseColor : vec4<f32>,
  alphaCutoff : f32,
  alphaHash : f32,
  _materialPadding : vec3<f32>,
  baseColorTextureCoordinatesTransform : vec4<f32>,
  baseColorTextureCoordinatesMetadata : vec4<f32>,
  baseColorTextureCoordinatesRotation : vec4<f32>,
};

@group(1) @binding(0) var<uniform> material : PointsLinesMaterial;
@group(1) @binding(1) var baseColorSampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;

struct PointsLinesVertex {
  @location(0) position : vec3<f32>,
  @location(1) otherPosition : vec3<f32>,
  @location(2) corner : vec2<f32>,
  @location(3) neighborDistance : vec4<f32>,
};

struct PointsLinesFragment {
  @location(3) @interpolate(flat) segmentPixels : vec4<f32>,
  @location(5) @interpolate(flat) segmentDistances : vec4<f32>,
  @location(4) @interpolate(flat) dash : vec3<f32>,
  @location(2) clippingPositionWS : vec3<f32>,
  @builtin(position) position : vec4<f32>,
  @location(0) @interpolate(flat) shape : f32,
  // Point corners share clip.w, so perspective interpolation keeps the
  // circular coverage while remaining valid on WebGL2. Lines use the
  // fragment position directly for exact physical-pixel coverage.
  @location(1) @interpolate(perspective) sampleCenter : vec2<f32>,
  @location(7) @interpolate(flat) capRadii : vec2<f32>,
};

fn clipPixelDelta(clip : vec4<f32>, pixels : vec2<f32>) -> vec2<f32> {
  let viewport = max(pointsLinesView.physicalViewport, vec2<f32>(1.0, 1.0));
  let ndcPerPixel = vec2<f32>(2.0 / viewport.x, -2.0 / viewport.y);
  return pixels * ndcPerPixel * clip.w;
}

fn expandPoint(position : vec3<f32>, corner : vec2<f32>, sizePx : f32) -> vec4<f32> {
  let clip = pointsLinesView.worldViewProj * pointsLinesView.model * vec4<f32>(position, 1.0);
  let offset = clipPixelDelta(clip, corner * (sizePx * 0.5));
  return vec4<f32>(clip.xy + offset, clip.z, clip.w);
}

fn projectedPixel(clip : vec4<f32>) -> vec2<f32> {
  return clip.xy / max(clip.w, 0.000001) * pointsLinesView.physicalViewport * vec2<f32>(0.5, -0.5);
}

fn safeDirection(delta : vec2<f32>, fallback : vec2<f32>) -> vec2<f32> {
  let squared = dot(delta, delta);
  return select(fallback, delta * inverseSqrt(max(squared, 0.00000001)), squared > 0.00000001);
}

struct ProjectedLine {
  start : vec4<f32>,
  end : vec4<f32>,
  fractions : vec2<f32>,
};

fn projectLine(input : PointsLinesVertex) -> ProjectedLine {
  let transform = pointsLinesView.worldViewProj * pointsLinesView.model;
  var line : ProjectedLine;
  line.start = transform * vec4<f32>(input.position, 1.0);
  line.end = transform * vec4<f32>(input.otherPosition, 1.0);
  line.fractions = vec2<f32>(0.0, 1.0);
  // Clip before the perspective divide; retain the original local arc length.
  if (line.start.z < 0.0) != (line.end.z < 0.0) {
    let t = -line.start.z / (line.end.z - line.start.z);
    let intersection = mix(line.start, line.end, t);
    if line.start.z < 0.0 { line.start = intersection; line.fractions.x = t; }
    else { line.end = intersection; line.fractions.y = t; }
  }
  return line;
}

// Physical-pixel half width at one projected endpoint.
fn lineHalfWidthPx(clip : vec4<f32>) -> f32 {
  let halfWidth = pointsLinesView.style.x * 0.5;
  let worldScale = pointsLinesView.style.w;
  return select(halfWidth, halfWidth * worldScale / max(clip.w, 0.000001), worldScale > 0.0);
}

fn expandLine(input : PointsLinesVertex, line : ProjectedLine) -> vec4<f32> {
  let startClip = line.start;
  let endClip = line.end;
  let atEnd = input.corner.x > 0.0;
  let transform = pointsLinesView.worldViewProj * pointsLinesView.model;
  let startPixel = projectedPixel(startClip);
  let endPixel = projectedPixel(endClip);
  let axis = safeDirection(endPixel - startPixel, vec2<f32>(1.0, 0.0));
  let endpoint = select(startClip, endClip, atEnd);
  var neighborClip = transform * vec4<f32>(input.neighborDistance.xyz, 1.0);
  if neighborClip.z < 0.0 && endpoint.z > 0.0 {
    neighborClip = mix(endpoint, neighborClip, endpoint.z / (endpoint.z - neighborClip.z));
  }
  let neighborPixel = projectedPixel(neighborClip);
  let adjacentDelta = select(startPixel - neighborPixel, neighborPixel - endPixel, atEnd);
  let adjacent = safeDirection(adjacentDelta, axis);
  let tangent = safeDirection(axis + adjacent, axis);
  let normal = vec2<f32>(-axis.y, axis.x);
  let miter = vec2<f32>(-tangent.y, tangent.x);
  // Shared bounded miters meet at the same two vertices. Open ends and
  // independent line-list pairs have butt caps. Near-clipped ends have no join.
  var offsetDirection = miter / max(dot(miter, normal), 0.25);
  let clipped = select(line.fractions.x > 0.0, line.fractions.y < 1.0, atEnd);
  if clipped { offsetDirection = normal; }
  // An open end repeats its own endpoint as the neighbor (duplicates are collapsed).
  let endpointLocal = select(input.position, input.otherPosition, atEnd);
  let open = all(input.neighborDistance.xyz == endpointLocal);
  let roundCap = pointsLinesView.dash.w > 0.5 && open && !clipped;
  let capOffset = select(vec2<f32>(0.0, 0.0), axis * input.corner.x, roundCap);
  let offset = clipPixelDelta(
    endpoint,
    (offsetDirection * input.corner.y + capOffset) * lineHalfWidthPx(endpoint),
  );
  return vec4<f32>(endpoint.xy + offset, endpoint.z, endpoint.w);
}

fn circleCoverage(sampleCenter : vec2<f32>) -> bool {
  return dot(sampleCenter, sampleCenter) <= 1.0;
}

// Beyond a segment end's perpendicular, keep only the end's circle. A segment
// with no projected length becomes one disc of the larger radius.
fn roundEndCoverage(input : PointsLinesFragment) -> bool {
  let linePixel = input.position.xy;
  let start = input.segmentPixels.xy;
  let end = input.segmentPixels.zw;
  let delta = end - start;
  let lengthSquared = dot(delta, delta);
  if lengthSquared <= 0.000001 {
    return distance(linePixel, start) <= max(input.capRadii.x, input.capRadii.y);
  }
  let t = dot(linePixel - start, delta) / lengthSquared;
  if t < 0.0 { return distance(linePixel, start) <= input.capRadii.x; }
  if t > 1.0 { return distance(linePixel, end) <= input.capRadii.y; }
  return true;
}

@vertex
fn vs_main(input : PointsLinesVertex) -> PointsLinesFragment {
  let isLine = pointsLinesView.style.y > 0.5;
  let isCircle = pointsLinesView.style.z > 0.5 && !isLine;
  var output : PointsLinesFragment;
  output.position = expandPoint(input.position, input.corner, pointsLinesView.style.x);
  var clippingPosition = input.position;
  if isLine {
    let line = projectLine(input);
    output.position = expandLine(input, line);
    let atEnd = input.corner.x > 0.0;
    clippingPosition = mix(input.position, input.otherPosition, select(line.fractions.x, line.fractions.y, atEnd));
    let length = distance(input.position, input.otherPosition);
    let startDistance = input.neighborDistance.w - select(0.0, length, atEnd);
    let origin = pointsLinesView.physicalViewport * 0.5;
    output.segmentPixels = vec4<f32>(projectedPixel(line.start) + origin, projectedPixel(line.end) + origin);
    output.segmentDistances = vec4<f32>(startDistance + line.fractions * length, line.start.w, line.end.w);
    output.capRadii = vec2<f32>(lineHalfWidthPx(line.start), lineHalfWidthPx(line.end));
  }
  output.clippingPositionWS = (pointsLinesView.model * vec4<f32>(clippingPosition, 1.0)).xyz;
  output.dash = select(vec3<f32>(1.0, 0.0, 0.0), pointsLinesView.dash.xyz, isLine);
  output.shape = select(0.0, 1.0, isCircle);
  output.sampleCenter = select(input.corner, vec2<f32>(0.0, 0.0), isLine);
  return output;
}

fn shadePointsLines(input : PointsLinesFragment) -> vec4<f32> {
  applyViewClipping(input.clippingPositionWS, false);
  if input.dash.y > 0.0 {
    let period = input.dash.x + input.dash.y;
    // Project the fragment onto the centerline, not the miter's diagonal edge.
    // Undo perspective interpolation to recover the original local path distance.
    let delta = input.segmentPixels.zw - input.segmentPixels.xy;
    let t = clamp(dot(input.position.xy - input.segmentPixels.xy, delta) / max(dot(delta, delta), 0.000001), 0.0, 1.0);
    let localT = t * input.segmentDistances.z / max(mix(input.segmentDistances.w, input.segmentDistances.z, t), 0.000001);
    let distance = mix(input.segmentDistances.x, input.segmentDistances.y, localT) + input.dash.z;
    let phase = distance - floor(distance / period) * period;
    if phase >= input.dash.x { discard; }
  }
  if input.shape > 0.5 && !circleCoverage(input.sampleCenter) {
    discard;
  }
  let uv = material.baseColorTextureCoordinatesMetadata.xy;
  let textureColor = textureSample(baseColorTexture, baseColorSampler, uv);
  let color = material.baseColor * textureColor;
  if material.alphaCutoff > 0.0 && color.a < material.alphaCutoff {
    discard;
  }
  return vec4<f32>(translucent_fog(view, input.clippingPositionWS, color.rgb, color.a), color.a);
}

@fragment
fn fs_main(input : PointsLinesFragment) -> @location(0) vec4<f32> {
  return shadePointsLines(input);
}

// Round caps are a separate entry so butt lines compile without the end test.
@fragment
fn fs_round(input : PointsLinesFragment) -> @location(0) vec4<f32> {
  if !roundEndCoverage(input) { discard; }
  return shadePointsLines(input);
}
