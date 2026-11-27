import { SMAA_BLEND_WGSL } from '@forgeax/engine-shader';
import type { PostProcessShaderEntry } from '../../fullscreen-post-process-pass';
import type { RenderFeatureFullscreenProgramDeclaration } from '../plan';

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
fn color(uv: vec2<f32>, size: vec2<i32>) -> vec3<f32> {
  let p = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - 1);
  return textureLoad(source, p, 0).rgb;
}
fn delta(a: vec3<f32>, b: vec3<f32>) -> f32 {
  let d = abs(a - b);
  return max(max(d.r, d.g), d.b);
}
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  let size = vec2<i32>(textureDimensions(source));
  // Search at the display extent, with point samples from the pre-Tonemap view.
  let dx = vec2<f32>(dpdx(in.uv.x), 0.0);
  let dy = vec2<f32>(0.0, dpdy(in.uv.y));
  let uv = in.uv;
  let c = color(uv, size);
  let d = vec2<f32>(delta(c, color(uv - dx, size)), delta(c, color(uv - dy, size)));
  var edge = step(vec2<f32>(0.1), d);
  if (dot(edge, vec2<f32>(1.0)) == 0.0) { discard; }
  let opposite = vec2<f32>(delta(c, color(uv + dx, size)), delta(c, color(uv + dy, size)));
  let distant = vec2<f32>(delta(c, color(uv - 2.0 * dx, size)), delta(c, color(uv - 2.0 * dy, size)));
  let contrast = max(max(d, opposite), distant);
  edge *= step(vec2<f32>(0.5 * max(contrast.x, contrast.y)), d);
  if (dot(edge, vec2<f32>(1.0)) == 0.0) { discard; }
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
  let e = textureLoad(source, vec2<i32>(in.position.xy), 0).rg;
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
${SMAA_BLEND_WGSL}
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  return smaaBlend(source, blendTexture, vec2<i32>(in.position.xy));
}`;

export const SMAA_PROGRAMS: readonly (RenderFeatureFullscreenProgramDeclaration &
  Pick<PostProcessShaderEntry, 'stencilMask'>)[] = [
  {
    kind: 'fullscreen-program',
    name: 'forgeax.smaa.edges',
    source: edges,
    reads: ['scene-color'],
    stencilMask: 'write',
  },
  {
    kind: 'fullscreen-program',
    name: 'forgeax.smaa.weights',
    source: weights,
    stencilMask: 'test',
    reads: ['smaa-edges', 'smaa-area', 'smaa-search'],
  },
  {
    kind: 'fullscreen-program',
    name: 'forgeax.smaa.blend',
    source: blend,
    reads: ['scene-color', 'smaa-weights'],
  },
];

export function isSmaaPostProcess(identity: string): boolean {
  return identity === 'forgeax.smaa' || SMAA_PROGRAMS.some((program) => program.name === identity);
}
