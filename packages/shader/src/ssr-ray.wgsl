#define_import_path forgeax_ssr::ray
#import forgeax_view::common::{View}
#import forgeax_depth_pyramid::sample::{depthPyramidViewportCell, linearizeViewDepth, projectViewDepth}

struct SsrRayHit {
  uv: vec2f,
  depth: f32,
  found: bool,
};

fn ssrVignette(uv: vec2f) -> f32 {
  let border = clamp(abs(uv * 2.0 - 1.0) * 5.0 - 4.0, vec2f(0.0), vec2f(1.0));
  return clamp(1.0 - dot(border, border), 0.0, 1.0);
}

fn ssrClipUv(clip: vec4f) -> vec2f {
  return clip.xy / clip.w * vec2f(0.5, -0.5) + 0.5;
}

// Correlate the pixel and submitted temporal sample, but decorrelate the
// samples within a pixel. Temporal phase zero always takes the mirror ray.
fn ssrRandomBits(value: u32) -> u32 {
  let state = value * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn ssrReflectionDirection(
  normal: vec3f, toCamera: vec3f, roughness: f32, pixel: vec2u, phase: u32, ray: u32,
) -> vec3f {
  if (phase == 0u || roughness < 0.1) {
    return reflect(-toCamera, normal);
  }

  let seed = ssrRandomBits(pixel.x ^ ssrRandomBits(pixel.y) ^ ssrRandomBits(phase * 16u + ray));
  let sample = vec2f(f32(seed & 65535u), f32(seed >> 16u)) / 65536.0;
  let up = select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), abs(normal.z) > 0.99);
  let tangent = normalize(cross(up, normal));
  let bitangent = cross(normal, tangent);
  let view = vec3f(dot(tangent, toCamera), dot(bitangent, toCamera), max(dot(normal, toCamera), 0.0));
  let alpha = roughness * roughness;
  let stretchedView = normalize(vec3f(alpha * view.xy, view.z));

  // Sample the GGX visible-normal distribution on a spherical cap in the
  // stretched frame, then transform the microfacet back into world space.
  let phi = 6.28318530718 * sample.x;
  let capZ = 1.0 - sample.y * (1.0 + stretchedView.z);
  let capRadius = sqrt(max(0.0, 1.0 - capZ * capZ));
  let halfStretched = stretchedView + vec3f(cos(phi) * capRadius, sin(phi) * capRadius, capZ);
  let halfLocal = normalize(vec3f(alpha * halfStretched.xy, max(0.0, halfStretched.z)));
  let halfWorld = tangent * halfLocal.x + bitangent * halfLocal.y + normal * halfLocal.z;
  return reflect(-toCamera, halfWorld);
}

fn ssrCrossingFraction(previousGap: f32, currentGap: f32) -> f32 {
  let denominator = previousGap - currentGap;
  // A ray entering tolerance from behind selects the later sample.
  return clamp(select(1.0, previousGap / denominator, abs(denominator) > 1e-8), 0.0, 1.0);
}

// Fixed-budget screen-space march in reverse device Z. The shared depth
// hierarchy stores linear view distance, so convert each sampled bound back
// to projection depth before comparison.
fn traceSsrRay(
  pyramid: texture_2d<f32>, view: View, size: vec2u, origin: vec3f, direction: vec3f,
  roughness: f32, stepCount: u32,
) -> SsrRayHit {
  let miss = SsrRayHit(vec2f(0.0), 0.0, false);
  let startClip = view.worldViewProj * vec4f(origin, 1.0);
  if (!(startClip.w > 0.0 && startClip.z > 0.0 && startClip.z <= startClip.w && view.ssrParams.x > 0.0)) {
    return miss;
  }

  let projection = view.temporalProjection;
  let start = startClip.xyz / startClip.w;
  let distance = linearizeViewDepth(start.z, projection);
  // UE extends the projected ray to the viewport edge. Here the authored
  // world-space maximum also bounds that extension.
  let travel = view.ssrParams.x;
  let delta = view.worldViewProj * vec4f(direction * travel, 0.0);
  // Keep the projected endpoint on the near side of neither the camera nor
  // its near plane; the same homogeneous clip equation also works in ortho.
  let nearSlope = delta.w - delta.z;
  let nearFactor = min(1.0, 0.95 * (startClip.w - startClip.z) / max(-nearSlope, 1e-7));
  let endFactor = select(1.0, nearFactor, nearSlope < 0.0);
  let to = startClip + delta * endFactor;
  let span = to.xyz / to.w - start;
  let edge = (sign(span.xy) - start.xy) /
    select(vec2f(1.0), span.xy, abs(span.xy) > vec2f(1e-7));
  let clip = clamp(min(
    select(1.0, edge.x, abs(span.x) > 1e-7),
    select(1.0, edge.y, abs(span.y) > 1e-7),
  ), 0.0, 1.0);
  let step = span * clip / f32(stepCount);
  if (length(step.xy * vec2f(size)) < 0.0625) { return miss; }

  let toleranceDistance = min(distance, travel * endFactor);
  let axialDepth = projectViewDepth(distance + toleranceDistance, projection);
  let slope = (start.z - axialDepth) * 4.0 / f32(stepCount);
  let tolerance = max(select(abs(step.z), 0.0, projection.z > 0.5), slope);
  let extent = textureDimensions(pyramid, 0);
  // A complete pyramid's level count can also be derived for WebGL2, which
  // lacks textureQueryLevels in GLSL ES 3.00.
  let lastLevel = u32(floor(log2(f32(max(extent.x, extent.y)))));
  let increment = 8.0 * roughness / f32(stepCount);
  // Interleaved gradient phase spreads fixed-step bands under the main AA.
  // The non-temporal route always uses the same unshifted sample locations.
  var stepOffset = 0.0;
  let phase = view.ssrQuality.w;
  if (phase > 0.0) {
    let startUv = start.xy * vec2f(0.5, -0.5) + 0.5;
    let pixel = floor(startUv * vec2f(size));
    let seededPixel = pixel + 5.588238 * f32(u32(phase - 1.0) % 8u);
    let noise = fract(52.9829189 * fract(dot(seededPixel, vec2f(0.06711056, 0.00583715))));
    stepOffset = noise - 0.5;
  }
  var lastGap = 0.0;

  for (var index = 0u; index < stepCount; index++) {
    let position = start + step * (f32(index + 1u) + stepOffset);
    let uv = position.xy * vec2f(0.5, -0.5) + 0.5;
    if (!(position.z > 0.0 && position.z <= 1.0)) { break; }

    let level = min(lastLevel, u32(1.0 + f32(index / 2u) * increment + 0.5));
    let cell = depthPyramidViewportCell(uv, pyramid, level, size);
    let sceneZ = projectViewDepth(textureLoad(pyramid, vec2i(cell), level).r, projection);
    let gap = position.z - sceneZ;
    if (sceneZ > 0.0 && abs(gap + tolerance) < tolerance) {
      let fraction = ssrCrossingFraction(lastGap, gap);
      let hit = start + step * max(0.0, f32(index) + fraction + stepOffset);
      return SsrRayHit(hit.xy * vec2f(0.5, -0.5) + 0.5, hit.z, true);
    }
    lastGap = gap;
  }
  return miss;
}
