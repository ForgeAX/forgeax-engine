import { ok } from '@forgeax/engine-types';
import type { RenderFeatureFullscreenProgramDeclaration } from '../plan';
import type { RenderFeature } from '../types';

// SMAA 1x Medium, adapted from Three.js r184 SMAANode and SMAA v2.8.
// Copyright and redistribution terms: ./LICENSE.txt.
const vertex = /* wgsl */ `
struct Output { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> Output {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return Output(vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0), vec2<f32>(p.x, 1.0 - p.y));
}
@group(1) @binding(0) var source: texture_2d<f32>;
@group(1) @binding(1) var sourceSampler: sampler;
`;

const edges = /* wgsl */ `${vertex}
fn color(p: vec2<i32>) -> vec3<f32> {
  return textureLoad(source, clamp(p, vec2<i32>(0), vec2<i32>(textureDimensions(source)) - 1), 0).rgb;
}
fn delta(a: vec3<f32>, b: vec3<f32>) -> f32 {
  let d = abs(a - b);
  return max(max(d.r, d.g), d.b);
}
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  let p = vec2<i32>(in.position.xy);
  let c = color(p);
  let d = vec2<f32>(delta(c, color(p + vec2<i32>(-1, 0))), delta(c, color(p + vec2<i32>(0, -1))));
  var edge = step(vec2<f32>(0.1), d);
  if (dot(edge, vec2<f32>(1.0)) == 0.0) { return vec4<f32>(0.0); }
  let opposite = vec2<f32>(delta(c, color(p + vec2<i32>(1, 0))), delta(c, color(p + vec2<i32>(0, 1))));
  let distant = vec2<f32>(delta(c, color(p + vec2<i32>(-2, 0))), delta(c, color(p + vec2<i32>(0, -2))));
  let contrast = max(max(d, opposite), distant);
  edge *= step(vec2<f32>(0.5 * max(contrast.x, contrast.y)), d);
  return vec4<f32>(edge, 0.0, 0.0);
}`;

const weights = /* wgsl */ `${vertex}
@group(1) @binding(2) var areaTexture: texture_2d<f32>;
@group(1) @binding(3) var searchTexture: texture_2d<f32>;
fn edge(uv: vec2<f32>) -> vec2<f32> {
  return textureSampleLevel(source, sourceSampler, uv, 0.0).rg;
}
fn searchLength(e: vec2<f32>, positive: bool) -> f32 {
  let uv = vec2<f32>(select(0.0, 0.5, positive) + 0.5 * e.x, e.y);
  let size = vec2<i32>(textureDimensions(searchTexture));
  let p = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - 1);
  return 255.0 * textureLoad(searchTexture, p, 0).r;
}
// Both axes share the same pseudo-gather search; swizzling selects the crossing edge.
fn search(start: vec2<f32>, vertical: bool, positive: bool, pixel: vec2<f32>) -> f32 {
  let axis = select(vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0), vertical);
  let direction = select(-1.0, 1.0, positive);
  var uv = start;
  var e = vec2<f32>(0.0, 1.0);
  for (var i = 0; i < 8; i++) {
    let sampled = edge(uv);
    e = select(sampled, sampled.gr, vertical);
    uv += 2.0 * direction * axis * pixel;
    if (e.y <= 0.8281 || e.x != 0.0) { break; }
  }
  let coordinate = select(uv.x, uv.y, vertical);
  let stepSize = select(pixel.x, pixel.y, vertical);
  return coordinate + direction * stepSize * (searchLength(e, positive) - 3.25);
}
fn area(distance: vec2<f32>, crossing: vec2<f32>) -> vec2<f32> {
  // Only the 80x80 orthogonal, zero-subsample tile is needed for 1x Medium.
  let p = 16.0 * floor(4.0 * crossing + 0.5) + sqrt(abs(distance));
  return textureSampleLevel(areaTexture, sourceSampler, (p + 0.5) / 80.0, 0.0).rg;
}
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  let pixel = 1.0 / vec2<f32>(textureDimensions(source));
  let uv = in.uv;
  let e = edge(uv);
  var result = vec4<f32>(0.0);
  if (e.g > 0.0) {
    let left = search(uv + pixel * vec2<f32>(-0.25, -0.125), false, false, pixel);
    let right = search(uv + pixel * vec2<f32>(1.25, -0.125), false, true, pixel);
    let y = uv.y - 0.25 * pixel.y;
    let crossing = vec2<f32>(edge(vec2<f32>(left, y)).r, edge(vec2<f32>(right + pixel.x, y)).r);
    let a = area((vec2<f32>(left, right) - uv.x) / pixel.x, crossing);
    result.r = a.x;
    result.g = a.y;
  }
  if (e.r > 0.0) {
    let top = search(uv + pixel * vec2<f32>(-0.125, -0.25), true, false, pixel);
    let bottom = search(uv + pixel * vec2<f32>(-0.125, 1.25), true, true, pixel);
    let x = uv.x - 0.25 * pixel.x;
    let crossing = vec2<f32>(edge(vec2<f32>(x, top)).g, edge(vec2<f32>(x, bottom + pixel.y)).g);
    let a = area((vec2<f32>(top, bottom) - uv.y) / pixel.y, crossing);
    result.b = a.x;
    result.a = a.y;
  }
  return result;
}`;

const blend = /* wgsl */ `${vertex}
@group(1) @binding(2) var blendTexture: texture_2d<f32>;
fn weight(p: vec2<i32>) -> vec4<f32> {
  return textureLoad(blendTexture, clamp(p, vec2<i32>(0), vec2<i32>(textureDimensions(blendTexture)) - 1), 0);
}
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  let p = vec2<i32>(in.position.xy);
  let current = weight(p);
  let a = vec4<f32>(current.r, weight(p + vec2<i32>(0, 1)).g, current.b, weight(p + vec2<i32>(1, 0)).a);
  let color = textureLoad(source, p, 0);
  if (dot(a, vec4<f32>(1.0)) < 0.00001) { return color; }
  var offset = vec2<f32>(select(-a.b, a.a, a.a > a.b), select(-a.r, a.g, a.g > a.r));
  if (abs(offset.x) > abs(offset.y)) { offset.y = 0.0; } else { offset.x = 0.0; }
  let q = clamp(p + vec2<i32>(sign(offset)), vec2<i32>(0), vec2<i32>(textureDimensions(source)) - 1);
  // Standard supplies linear LDR; preserve that domain, including alpha, until its one OETF.
  return mix(color, textureLoad(source, q, 0), max(abs(offset.x), abs(offset.y)));
}`;

export const SMAA_PROGRAMS: readonly RenderFeatureFullscreenProgramDeclaration[] = [
  { kind: 'fullscreen-program', name: 'forgeax.smaa.edges', source: edges, reads: ['scene-color'] },
  {
    kind: 'fullscreen-program',
    name: 'forgeax.smaa.weights',
    source: weights,
    reads: ['smaa-edges', 'smaa-area', 'smaa-search'],
  },
  {
    kind: 'fullscreen-program',
    name: 'forgeax.smaa.blend',
    source: blend,
    reads: ['scene-color', 'smaa-weights'],
  },
];

export function createSmaaRenderFeature(): RenderFeature<readonly string[]> {
  return {
    identity: 'forgeax.smaa',
    requiredCapabilities: ['rgba16floatRenderable'],
    requiredFullscreenPostProcesses: SMAA_PROGRAMS.map((program) => ({
      identity: program.name,
      source: program.source,
    })),
    extract: (context) =>
      ok(
        context.views
          .filter((view) => view.render && view.selectedCamera?.antialias === 'smaa')
          .map((view) => view.identity),
      ),
    plan: (views) =>
      ok({
        work: views.map((view) => ({ scope: { view }, resources: SMAA_PROGRAMS, passes: [] })),
      }),
  };
}

export function isSmaaPostProcess(identity: string): boolean {
  return identity === 'forgeax.smaa' || SMAA_PROGRAMS.some((program) => program.name === identity);
}
