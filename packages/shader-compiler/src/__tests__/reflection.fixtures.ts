// reflection.fixtures.ts — oracle data for 9 boundary cases
// (research §g2 / plan-strategy §S-9).
//
// Each fixture = { name, wgsl, expected }:
// - wgsl: minimal WGSL source declaring only the BGL entry under test plus one
//   dummy entry point so that GlobalUse static analysis can lock visibility
//   deterministically (FRAGMENT only / VERTEX only / VERTEX|FRAGMENT, etc.).
// - expected: BindGroupLayoutDescriptor[], fully explicit output (including
//   hasDynamicOffset / minBindingSize defaults); the visibility field is an
//   integer bitmask (VERTEX=0x1 / FRAGMENT=0x2 / COMPUTE=0x4).
//
// The 9 cases cover: 1 uniform buffer / 2 storage read / 3 storage rw /
// 4 sampler filtering / 5 sampler non-filtering / 6 sampler comparison /
// 7 texture 2D / 8 storage texture / 9 dynamic offset uniform
// (research §g2 table-driven 1:1 oracle).
//
// Case 9 dynamic offset is not expressed in Naga IR — forgeax's upper layer
// annotates it via options.dynamicOffsets; this fixture marks
// hasDynamicOffset:true in expected, and at runtime the forgeax reflection
// derivation consumes the options signal (landed in w8).

import type { BindGroupLayoutDescriptor } from '@forgeax/engine-types';

export const DERIVED_REFLECTION_SCHEMA = [
  { name: 'exposure', type: 'f32' },
  { name: 'albedo', type: 'texture2d' },
  { name: 'tint', type: 'vec4' },
] as const;

export const DERIVED_REFLECTION_FACTS = {
  members: [
    { name: 'exposure', type: 'f32', offset: 0, size: 4, alignment: 4 },
    {
      name: 'albedoCoordinatesTransform',
      type: 'vec4<f32>',
      offset: 16,
      size: 16,
      alignment: 16,
    },
    {
      name: 'albedoCoordinatesMetadata',
      type: 'vec4<f32>',
      offset: 32,
      size: 16,
      alignment: 16,
    },
    { name: 'albedoCoordinatesRotation', type: 'vec4<f32>', offset: 48, size: 16, alignment: 16 },
    { name: 'tint', type: 'vec4<f32>', offset: 64, size: 16, alignment: 16 },
  ],
  resources: [
    { name: 'albedo_sampler', kind: 'sampler', binding: 1 },
    { name: 'albedo', kind: 'texture', binding: 2 },
  ],
  totalBytes: 80,
} as const;

export interface ReflectionFixture {
  readonly name: string;
  readonly wgsl: string;
  /** Optional reflection options forwarded to compileShader (e.g., dynamicOffsets). */
  readonly options?: {
    readonly dynamicOffsets?: readonly { readonly group: number; readonly binding: number }[];
  };
  readonly expected: readonly BindGroupLayoutDescriptor[];
}

// === Shared fragment =====================================================

/**
 * Minimal fragment entry point used to anchor `GlobalUse = FRAGMENT` for the
 * declared bindings. Each fixture references all module-scope vars from inside
 * `fs_main` so visibility = 0x2 (FRAGMENT) deterministically.
 */
const FRAGMENT_ANCHOR = `
@vertex fn vs_main() -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0, 0.0, 0.0, 1.0);
}
`;

// === 1. uniform buffer ===================================================

const F1: ReflectionFixture = {
  name: '1-uniform-buffer',
  wgsl: `
struct U { value: f32 }
@group(0) @binding(0) var<uniform> u: U;

${FRAGMENT_ANCHOR}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(u.value, 0.0, 0.0, 1.0);
}
`,
  expected: [
    {
      label: '@group(0)',
      entries: [
        {
          binding: 0,
          visibility: 0x2, // FRAGMENT
          buffer: {
            type: 'uniform',
            hasDynamicOffset: false,
            minBindingSize: 0,
          },
        },
      ],
    },
  ],
};

// === 2. storage buffer (read-only) =======================================

const F2: ReflectionFixture = {
  name: '2-storage-read',
  wgsl: `
struct S { values: array<f32, 4> }
@group(0) @binding(0) var<storage, read> s: S;

${FRAGMENT_ANCHOR}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(s.values[0], 0.0, 0.0, 1.0);
}
`,
  expected: [
    {
      label: '@group(0)',
      entries: [
        {
          binding: 0,
          visibility: 0x2,
          buffer: {
            type: 'read-only-storage',
            hasDynamicOffset: false,
            minBindingSize: 0,
          },
        },
      ],
    },
  ],
};

// === 3. storage buffer (read+write) ======================================

const F3: ReflectionFixture = {
  name: '3-storage-rw',
  wgsl: `
struct RW { values: array<f32, 4> }
@group(0) @binding(0) var<storage, read_write> rw: RW;

@compute @workgroup_size(1) fn cs_main() {
  rw.values[0] = 1.0;
}
`,
  expected: [
    {
      label: '@group(0)',
      entries: [
        {
          binding: 0,
          visibility: 0x4, // COMPUTE
          buffer: {
            type: 'storage',
            hasDynamicOffset: false,
            minBindingSize: 0,
          },
        },
      ],
    },
  ],
};

// === 4. sampler (filtering) ==============================================

const F4: ReflectionFixture = {
  name: '4-sampler-filtering',
  wgsl: `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

${FRAGMENT_ANCHOR}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return textureSample(tex, samp, vec2<f32>(0.0, 0.0));
}
`,
  expected: [
    {
      label: '@group(0)',
      entries: [
        {
          binding: 0,
          visibility: 0x2,
          sampler: { type: 'filtering' },
        },
        {
          binding: 1,
          visibility: 0x2,
          texture: {
            sampleType: 'float',
            viewDimension: '2d',
            multisampled: false,
          },
        },
      ],
    },
  ],
};

// === 5. sampler (non-filtering) ==========================================

const F5: ReflectionFixture = {
  name: '5-sampler-non-filtering',
  // Naga IR only expresses sampler{comparison:false}; filtering vs non-filtering
  // is annotated explicitly at the forgeax layer via options.samplerKinds
  // (research Finding 2 + g2 table note: unfilterable-float comes from the
  // sampleType signal; this fixture locks non-filtering via options).
  wgsl: `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;

${FRAGMENT_ANCHOR}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return textureSampleLevel(tex, samp, vec2<f32>(0.0, 0.0), 0.0);
}
`,
  options: { dynamicOffsets: [] },
  expected: [
    {
      label: '@group(0)',
      entries: [
        {
          binding: 0,
          visibility: 0x2,
          sampler: { type: 'non-filtering' },
        },
        {
          binding: 1,
          visibility: 0x2,
          texture: {
            sampleType: 'unfilterable-float',
            viewDimension: '2d',
            multisampled: false,
          },
        },
      ],
    },
  ],
};

// === 6. sampler (comparison) =============================================

const F6: ReflectionFixture = {
  name: '6-sampler-comparison',
  wgsl: `
@group(0) @binding(0) var samp: sampler_comparison;
@group(0) @binding(1) var tex: texture_depth_2d;

${FRAGMENT_ANCHOR}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  let d = textureSampleCompare(tex, samp, vec2<f32>(0.0, 0.0), 0.5);
  return vec4<f32>(d, 0.0, 0.0, 1.0);
}
`,
  expected: [
    {
      label: '@group(0)',
      entries: [
        {
          binding: 0,
          visibility: 0x2,
          sampler: { type: 'comparison' },
        },
        {
          binding: 1,
          visibility: 0x2,
          texture: {
            sampleType: 'depth',
            viewDimension: '2d',
            multisampled: false,
          },
        },
      ],
    },
  ],
};

// === 7. texture_2d<f32> (single, no sampler) =============================

const F7: ReflectionFixture = {
  name: '7-texture-2d-f32',
  wgsl: `
@group(0) @binding(0) var tex: texture_2d<f32>;

${FRAGMENT_ANCHOR}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return textureLoad(tex, vec2<i32>(0, 0), 0);
}
`,
  expected: [
    {
      label: '@group(0)',
      entries: [
        {
          binding: 0,
          visibility: 0x2,
          texture: {
            sampleType: 'unfilterable-float',
            viewDimension: '2d',
            multisampled: false,
          },
        },
      ],
    },
  ],
};

// === 8. texture_storage_2d<rgba8unorm,write> =============================

const F8: ReflectionFixture = {
  name: '8-storage-texture',
  wgsl: `
@group(0) @binding(0) var tex: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(1) fn cs_main() {
  textureStore(tex, vec2<i32>(0, 0), vec4<f32>(1.0, 0.0, 0.0, 1.0));
}
`,
  expected: [
    {
      label: '@group(0)',
      entries: [
        {
          binding: 0,
          visibility: 0x4,
          storageTexture: {
            access: 'write-only',
            format: 'rgba8unorm',
            viewDimension: '2d',
          },
        },
      ],
    },
  ],
};

// === 9. dynamic offset uniform ===========================================

const F9: ReflectionFixture = {
  name: '9-dynamic-offset-uniform',
  wgsl: `
struct U { value: f32 }
@group(0) @binding(0) var<uniform> u: U;

${FRAGMENT_ANCHOR}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(u.value, 0.0, 0.0, 1.0);
}
`,
  // forgeax explicitly marks (group=0, binding=0) as a dynamic offset (Naga IR
  // does not express this dimension; the caller injects it via options;
  // plan-strategy §S-9 / research Finding 2 footnote).
  options: { dynamicOffsets: [{ group: 0, binding: 0 }] },
  expected: [
    {
      label: '@group(0)',
      entries: [
        {
          binding: 0,
          visibility: 0x2,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: 0,
          },
        },
      ],
    },
  ],
};

// === Aggregate collection ===============================================

export const REFLECTION_FIXTURES: readonly ReflectionFixture[] = [
  F1,
  F2,
  F3,
  F4,
  F5,
  F6,
  F7,
  F8,
  F9,
];
