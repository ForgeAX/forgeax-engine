// @forgeax/engine-debug-draw -- the one WGSL program and vertex layout of the line overlay.
//
// The low-path DebugDraw compiles it itself; a Renderer compiles the same source
// through `DebugDrawSource.shader`, so there is one batch format and one program.

import { VERTEX_STRIDE_BYTES } from './constants';

const VERTEX_WGSL = /* wgsl */ `
struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) color: vec4<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

struct Uniforms {
  viewProj: mat4x4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = uniforms.viewProj * vec4<f32>(in.position, 1.0);
  out.color = in.color;
  return out;
}
`;

const FRAGMENT_WGSL = /* wgsl */ `
struct FragmentInput {
  @location(0) color: vec4<f32>,
}

@fragment
fn fs_main(in: FragmentInput) -> @location(0) vec4<f32> {
  return in.color;
}
`;

/** Line-list overlay program: `@group(0) @binding(0)` is a 64-byte view-projection uniform. */
export const DEBUG_OVERLAY_SHADER = Object.freeze({
  vertexWgsl: VERTEX_WGSL,
  fragmentWgsl: FRAGMENT_WGSL,
  vertexEntry: 'vs_main',
  fragmentEntry: 'fs_main',
  vertexStrideBytes: VERTEX_STRIDE_BYTES,
  attributes: Object.freeze([
    Object.freeze({ format: 'float32x3', offset: 0, shaderLocation: 0 }),
    Object.freeze({ format: 'unorm8x4', offset: 12, shaderLocation: 1 }),
  ] as const),
});
