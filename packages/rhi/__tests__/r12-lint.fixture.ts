// R12 lint fixture (w15): three intentionally-drifted descriptor aliases.
// The lint script must flag every drifted field. This file lives outside
// `src/` so `tsc -b` (whose `include` targets `src/**/*`) ignores it; the
// fixture is loaded by ts-morph through `--fixture` only, never imported by
// runtime code.
//
// Drift catalogue:
//   1. BufferDescriptor:           field "byteSize" (spec is "size").
//   2. BindGroupLayoutDescriptor:  field "entrys"   (spec is "entries").
//   3. RenderPipelineDescriptor:   extra field "customField" not in spec.
//
// Adding new drift cases here is a one-line edit; the corresponding test
// asserts the lint reports >= 3 violations on this fixture.

/// <reference types="@webgpu/types" />

export type BufferDescriptor = {
  label?: string | undefined;
  byteSize: number;
  usage: number;
  mappedAtCreation?: boolean | undefined;
};

export type BindGroupLayoutDescriptor = {
  label?: string | undefined;
  entrys: Iterable<GPUBindGroupLayoutEntry>;
};

export type RenderPipelineDescriptor = {
  label?: string | undefined;
  layout: GPUPipelineLayout | 'auto';
  vertex: GPUVertexState;
  primitive?: GPUPrimitiveState | undefined;
  depthStencil?: GPUDepthStencilState | undefined;
  multisample?: GPUMultisampleState | undefined;
  fragment?: GPUFragmentState | undefined;
  customField: string;
};
