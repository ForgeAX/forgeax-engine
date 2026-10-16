import { ok } from '@forgeax/engine-types';
import type { RenderFeatureFullscreenProgramDeclaration } from '../plan';
import type { RenderFeature } from '../types';

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
const packed = /* wgsl */ `${vertex}
${depth}
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  let z = textureLoad(depth, vec2<i32>(in.position.xy), 0);
  // Integer bytes are exact in rgba16float, including distant subnormal depths.
  // The consumer uses textureLoad, so the raw float bits are never filtered.
  let bits = bitcast<u32>(z);
  return vec4<f32>(vec4<u32>(bits, bits >> 8u, bits >> 16u, bits >> 24u) & vec4<u32>(255u));
}`;
function classify(msaa: boolean): string {
  return /* wgsl */ `${vertex}
@group(1) @binding(3) var depth: ${msaa ? 'texture_depth_multisampled_2d' : 'texture_depth_2d'};
@fragment fn fs_main(in: Output) -> @location(0) vec4<f32> {
  let p = vec2<i32>(in.position.xy);
  let packed = vec4<u32>(textureLoad(source, p, 0));
  let selected = bitcast<f32>(packed.x | (packed.y << 8u) | (packed.z << 16u) | (packed.w << 24u));
  if (selected <= 0.0) { return vec4<f32>(0.0); }
  let q = min(vec2<i32>(in.uv * vec2<f32>(textureDimensions(depth))), vec2<i32>(textureDimensions(depth)) - vec2<i32>(1));
  var scene = textureLoad(depth, q, 0);
  ${msaa ? 'for (var s = 1; s < 4; s++) { scene = max(scene, textureLoad(depth, q, s)); }' : ''}
  let visible = select(0.0, 1.0, selected >= scene - max(scene * 0.000002, 1e-12));
  return vec4<f32>(visible, 1.0 - visible, 1.0, 1.0);
}`;
}
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
const composite = /* wgsl */ `${vertex}
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
  if (edge.x > 0.5 && params.hidden.w != 1.0) { return vec4<f32>(params.visible.rgb, color.a); }
  if (edge.y > 0.5 && params.hidden.w != 0.0) { return vec4<f32>(params.hidden.rgb, color.a); }
  return color;
}`;
const depthRead = { key: 'scene-depth', sampleType: 'depth' } as const;
export const OUTLINE_PROGRAMS: readonly RenderFeatureFullscreenProgramDeclaration[] = [
  {
    kind: 'fullscreen-program' as const,
    name: 'forgeax.outline.depth',
    source: packed,
    reads: ['scene-color', depthRead],
  },
  {
    kind: 'fullscreen-program' as const,
    name: 'forgeax.outline.classify',
    source: classify(false),
    reads: ['scene-color', depthRead],
  },
  {
    kind: 'fullscreen-program' as const,
    name: 'forgeax.outline.classify.msaa',
    source: classify(true),
    reads: ['scene-color', depthRead],
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
    source: composite,
    reads: ['scene-color', 'outline-mask', 'outline-expanded'],
  },
].map((program) => ({ ...program, params: { byteSize: 32, defaultValue: new Uint8Array(32) } }));

/** Ordinary shader registration; Standard owns topology and all GPU lifetimes. */
export function createOutlineRenderFeature(): RenderFeature<boolean> {
  return {
    identity: 'forgeax.outline',
    requiredCapabilities: ['rgba16floatRenderable'],
    requiredFullscreenPostProcesses: OUTLINE_PROGRAMS.map((program) => ({
      identity: program.name,
      source: program.source,
    })),
    extract: (context) =>
      ok(context.views.some((view) => view.render && view.selectedCamera?.outline !== undefined)),
    plan: (active) =>
      ok({ work: active ? [{ scope: 'frame', resources: OUTLINE_PROGRAMS, passes: [] }] : [] }),
  };
}

/** Outline programs are graph-local producers, never encoded-output tail effects. */
export function isOutlinePostProcess(identity: string): boolean {
  return (
    identity === 'forgeax.outline' || OUTLINE_PROGRAMS.some((program) => program.name === identity)
  );
}
