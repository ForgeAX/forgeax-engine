import type { RenderFeatureFullscreenProgramDeclaration } from '../plan';
import { DISTANCE_OUTLINE_PROGRAMS } from './distance-shaders';

const vertex = /* wgsl */ `
struct Output { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> Output {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return Output(vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0), vec2<f32>(p.x, 1.0 - p.y));
}
struct Params { visible: vec4<f32>, hidden: vec4<f32> };
@group(1) @binding(0) var source: texture_2d<f32>;
@group(1) @binding(1) var sourceSampler: sampler;
@group(1) @binding(2) var<uniform> params: Params;
`;
const depth = '@group(1) @binding(3) var depth: texture_depth_2d;';
const depthMsaa = '@group(1) @binding(3) var depth: texture_depth_multisampled_2d;';
const packed = /* wgsl */ `${vertex}
${depth}
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  let z = textureLoad(depth, vec2<i32>(in.position.xy), 0);
  // Integer bytes are exact in rgba16float, including distant subnormal depths.
  // The consumer uses textureLoad, so the raw float bits are never filtered.
  let bits = bitcast<u32>(z);
  return vec4<f32>(vec4<u32>(bits, bits >> 8u, bits >> 16u, bits >> 24u) & vec4<u32>(255u));
}`;
const packedMsaa = /* wgsl */ `${vertex}
${depthMsaa}
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  let p = vec2<i32>(in.position.xy);
  return vec4<f32>(textureLoad(depth, p, 0), textureLoad(depth, p, 1),
                  textureLoad(depth, p, 2), textureLoad(depth, p, 3));
}`;
const visibility = /* wgsl */ `
fn isVisible(selected: f32, scene: f32) -> bool {
  return selected >= scene - max(scene * 0.000002, 1e-12);
}
fn scenePixel(uv: vec2<f32>) -> vec2<i32> {
  let size = vec2<i32>(textureDimensions(depth));
  return min(vec2<i32>(uv * vec2<f32>(size)), size - vec2<i32>(1));
}`;
const classify = /* wgsl */ `${vertex}
${depth}
${visibility}
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  let p = vec2<i32>(in.position.xy);
  let packed = vec4<u32>(textureLoad(source, p, 0));
  let selected = bitcast<f32>(packed.x | (packed.y << 8u) | (packed.z << 16u) | (packed.w << 24u));
  if (selected <= 0.0) { return vec4<f32>(0.0); }
  let scene = textureLoad(depth, scenePixel(in.uv), 0);
  let visible = select(0.0, 1.0, isVisible(selected, scene));
  return vec4<f32>(visible, 1.0 - visible, 1.0, 1.0);
}`;
const classifyMsaa = /* wgsl */ `${vertex}
${depthMsaa}
${visibility}
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  let p = scenePixel(in.uv);
  let selected = textureLoad(source, p, 0);
  if (all(selected <= vec4<f32>(0.0))) { return vec4<f32>(0.0); }
  // Cross-sample depth comparisons misclassify sloped surfaces as self-occluded.
  for (var sample = 0; sample < 4; sample++) {
    if (selected[sample] > 0.0 && isVisible(selected[sample], textureLoad(depth, p, sample))) {
      return vec4<f32>(1.0, 0.0, 1.0, 1.0);
    }
  }
  return vec4<f32>(0.0, 1.0, 1.0, 1.0);
}`;
const horizontal = /* wgsl */ `${vertex}
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  let p = vec2<i32>(in.position.xy);
  let size = vec2<i32>(textureDimensions(source));
  var edge = vec2<f32>(0.0);
  for (var x = -i32(params.visible.w); x <= i32(params.visible.w); x++) {
    let q = p + vec2<i32>(x, 0);
    if (all(q >= vec2<i32>(0)) && all(q < size)) { edge = max(edge, textureLoad(source, q, 0).rg); }
  }
  return vec4<f32>(edge, 0.0, 1.0);
}`;
const composite = (edgeAlpha: 'color.a' | '1.0') => /* wgsl */ `${vertex}
@group(1) @binding(3) var mask: texture_2d<f32>;
@group(1) @binding(4) var expanded: texture_2d<f32>;
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  let p = vec2<i32>(in.position.xy);
  let size = vec2<i32>(textureDimensions(source));
  let color = textureLoad(source, p, 0);
  if (textureLoad(mask, p, 0).b > 0.5) { return color; }
  var edge = vec2<f32>(0.0);
  for (var y = -i32(params.visible.w); y <= i32(params.visible.w); y++) {
    let q = p + vec2<i32>(0, y);
    if (all(q >= vec2<i32>(0)) && all(q < size)) { edge = max(edge, textureLoad(expanded, q, 0).rg); }
  }
  let alpha = ${edgeAlpha};
  if (edge.x > 0.5 && params.hidden.w != 1.0) { return vec4<f32>(params.visible.rgb, alpha); }
  if (edge.y > 0.5 && params.hidden.w != 0.0) { return vec4<f32>(params.hidden.rgb, alpha); }
  return color;
}`;
const depthRead = { key: 'scene-depth', sampleType: 'depth' } as const;
const LEGACY_OUTLINE_PROGRAMS: readonly RenderFeatureFullscreenProgramDeclaration[] = [
  {
    kind: 'fullscreen-program' as const,
    name: 'forgeax.outline.depth',
    source: packed,
    reads: ['scene-color', depthRead],
  },
  {
    kind: 'fullscreen-program' as const,
    name: 'forgeax.outline.depth.msaa',
    source: packedMsaa,
    reads: ['scene-color', depthRead],
    depthSampleCount: 4 as const,
  },
  {
    kind: 'fullscreen-program' as const,
    name: 'forgeax.outline.classify',
    source: classify,
    reads: ['scene-color', depthRead],
  },
  {
    kind: 'fullscreen-program' as const,
    name: 'forgeax.outline.classify.msaa',
    source: classifyMsaa,
    reads: [{ key: 'scene-color', sampleType: 'unfilterable-float' as const }, depthRead],
    depthSampleCount: 4 as const,
  },
  {
    kind: 'fullscreen-program' as const,
    name: 'forgeax.outline.horizontal',
    source: horizontal,
    reads: ['scene-color'],
  },
  {
    kind: 'fullscreen-program' as const,
    name: 'forgeax.outline.composite',
    source: composite('color.a'),
    reads: ['scene-color', 'outline-mask', 'outline-expanded'],
  },
  {
    kind: 'fullscreen-program' as const,
    name: 'forgeax.outline.composite.premultiplied',
    // A painted stroke adds coverage even on a transparent Three canvas.
    source: composite('1.0'),
    reads: ['scene-color', 'outline-mask', 'outline-expanded'],
  },
].map((program) => ({ ...program, params: { byteSize: 32, defaultValue: new Uint8Array(32) } }));
export const OUTLINE_PROGRAMS: readonly RenderFeatureFullscreenProgramDeclaration[] = [
  ...LEGACY_OUTLINE_PROGRAMS,
  ...DISTANCE_OUTLINE_PROGRAMS,
];

/** Outline programs are graph-local producers, never encoded-output tail effects. */
export function isOutlinePostProcess(identity: string): boolean {
  return (
    identity === 'forgeax.outline' || OUTLINE_PROGRAMS.some((program) => program.name === identity)
  );
}
