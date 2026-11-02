import {
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
} from '@forgeax/engine-shader';
import type {
  ManifestEntry,
  ShaderProgramContract,
  ShaderReflectionBoundGlobal,
  ShaderReflectionMember,
  ShaderReflectionTypeDescriptor,
} from '@forgeax/engine-types';
import computeAdapter from '../../../shader/src/light-texture-resample-compute.wgsl?raw';
import fragmentAdapter from '../../../shader/src/light-texture-resample-fragment.wgsl?raw';
import kernel from '../../../shader/src/light-texture-resample-kernel.wgsl?raw';

const kernelBody = kernel.replace(/^#define_import_path[^\n]*\n/m, '');
const computeBody = computeAdapter.replace(/^#import[^\n]*\n/m, '');
const fragmentBody = fragmentAdapter.replace(/^#import[^\n]*\n/m, '');

const u32Layout: ShaderReflectionTypeDescriptor = {
  kind: 'scalar',
  scalarKind: 'uint',
  width: 4,
  byteSize: 4,
  alignment: 4,
};
const vec2u32Layout: ShaderReflectionTypeDescriptor = {
  kind: 'vector',
  scalarKind: 'uint',
  width: 4,
  components: 2,
  byteSize: 8,
  alignment: 8,
};
const vec4f32Layout: ShaderReflectionTypeDescriptor = {
  kind: 'vector',
  scalarKind: 'float',
  width: 4,
  components: 4,
  byteSize: 16,
  alignment: 16,
};

const RESAMPLE_PARAMS: readonly ShaderReflectionMember[] = [
  {
    name: 'sourceSize',
    type: 'vec2<u32>',
    offset: 0,
    size: 8,
    alignment: 8,
    typeDescriptor: vec2u32Layout,
  },
  {
    name: 'grayscale',
    type: 'u32',
    offset: 8,
    size: 4,
    alignment: 4,
    typeDescriptor: u32Layout,
  },
  {
    name: 'level',
    type: 'u32',
    offset: 12,
    size: 4,
    alignment: 4,
    typeDescriptor: u32Layout,
  },
  {
    name: 'viewportOrigin',
    type: 'vec2<u32>',
    offset: 16,
    size: 8,
    alignment: 8,
    typeDescriptor: vec2u32Layout,
  },
  {
    name: 'outputSizeAndRowAlignWords',
    type: 'vec2<u32>',
    offset: 24,
    size: 8,
    alignment: 8,
    typeDescriptor: vec2u32Layout,
  },
];

const resampleParamsType: ShaderReflectionTypeDescriptor = {
  kind: 'struct',
  name: 'ResampleParams',
  span: 32,
  byteSize: 32,
  alignment: 8,
  members: RESAMPLE_PARAMS,
};

const dynamicArray = (
  element: ShaderReflectionTypeDescriptor,
  stride: number,
): ShaderReflectionTypeDescriptor => ({
  kind: 'array',
  size: { kind: 'dynamic' },
  stride,
  byteSize: stride,
  alignment: element.alignment,
  element,
});

const NUMERICAL_CONTRACT = {
  intermediatePrecision: 'f32',
  outputRange: [0, 1],
  reduction: 'box2x2-mean',
  mipLevelCount: 9,
  quantization: 'unorm8',
} as const;

const COMPUTE_PROGRAM_CONTRACT: ShaderProgramContract = {
  schemaVersion: 'shader-program-contract/1',
  colorTargets: [],
  publicationFormat: 'rgba8unorm',
  numerical: NUMERICAL_CONTRACT,
};
const FRAGMENT_PROGRAM_CONTRACT: ShaderProgramContract = {
  schemaVersion: 'shader-program-contract/1',
  colorTargets: [
    { location: 0, format: 'rgba32float', numericType: 'float' },
    { location: 1, format: 'rgba8unorm', numericType: 'float' },
  ],
  publicationFormat: 'rgba8unorm',
  numerical: NUMERICAL_CONTRACT,
};

function reflectedGlobal(
  binding: number,
  resourceKind: string,
  visibility: number,
  extra: Partial<ShaderReflectionBoundGlobal> = {},
): ShaderReflectionBoundGlobal {
  return {
    group: 0,
    binding,
    addressSpace:
      resourceKind === 'buffer'
        ? 'uniform'
        : resourceKind === 'storage-buffer'
          ? 'storage'
          : 'handle',
    resourceKind,
    resourceAccess: resourceKind === 'storage-buffer' ? 'read-write' : 'read-only',
    ...(resourceKind === 'texture'
      ? {
          textureClass: 'sampled' as const,
          sampleType: 'unfilterable-float' as const,
          viewDimension: '2d' as const,
          multisampled: false,
        }
      : {}),
    visibility,
    ...extra,
  };
}

function entry(
  hash: string,
  identifier: string,
  wgsl: string,
  bindings: readonly Readonly<Record<string, unknown>>[],
  globals: readonly ShaderReflectionBoundGlobal[],
  entryPoints: NonNullable<ManifestEntry['entryPoints']>,
  programContract: ShaderProgramContract,
): ManifestEntry {
  return {
    hash,
    identifier,
    defines: {},
    sourceDigest: hash.padEnd(64, '0'),
    compilerProfile: {
      id: 'forgeax-material-wgsl-v1',
      language: 'wgsl',
      profileVersion: '1',
      adapterVersion: '1',
      compilerVersion: '1',
      nagaVersion: '30.0.1',
    },
    programContract,
    wgsl,
    glsl: '',
    bindings: JSON.stringify(bindings),
    reflection: {
      schemaVersion: 'shader-reflection/3',
      uvSetCount: 0,
      boundGlobals: globals,
      entryPoints,
    },
    entryPoints,
  };
}

const computeBindings = [
  {
    label: '@group(0)',
    entries: [
      {
        binding: 0,
        visibility: 4,
        buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: 0 },
      },
      {
        binding: 1,
        visibility: 4,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false },
      },
      {
        binding: 2,
        visibility: 4,
        buffer: { type: 'storage', hasDynamicOffset: false, minBindingSize: 0 },
      },
      {
        binding: 3,
        visibility: 4,
        buffer: { type: 'storage', hasDynamicOffset: false, minBindingSize: 0 },
      },
    ],
  },
] as const;
const fragmentBindings = [
  {
    label: '@group(0)',
    entries: [
      {
        binding: 0,
        visibility: 2,
        buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: 0 },
      },
      {
        binding: 1,
        visibility: 2,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false },
      },
      {
        binding: 2,
        visibility: 2,
        texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: false },
      },
    ],
  },
] as const;

export const LIGHT_TEXTURE_RESAMPLE_TEST_PROGRAMS = {
  compute: entry(
    'a0000001',
    LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
    `${kernelBody}\n${computeBody}`,
    computeBindings,
    [
      reflectedGlobal(0, 'buffer', 4, {
        members: RESAMPLE_PARAMS,
        span: 32,
        typeDescriptor: resampleParamsType,
      }),
      reflectedGlobal(1, 'texture', 4),
      reflectedGlobal(2, 'storage-buffer', 4, {
        members: [],
        span: 0,
        elementStride: 16,
        elementType: 'vec4<f32>',
        typeDescriptor: dynamicArray(vec4f32Layout, 16),
      }),
      reflectedGlobal(3, 'storage-buffer', 4, {
        members: [],
        span: 0,
        elementStride: 4,
        elementType: 'u32',
        typeDescriptor: dynamicArray(u32Layout, 4),
      }),
    ],
    [
      { name: 'light_texture_resample', stage: 'compute', bindings: [] },
      { name: 'light_texture_reduce', stage: 'compute', bindings: [] },
    ],
    COMPUTE_PROGRAM_CONTRACT,
  ),
  fragment: entry(
    'b0000002',
    LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
    `${kernelBody}\n${fragmentBody}`,
    fragmentBindings,
    [
      reflectedGlobal(0, 'buffer', 2, {
        members: RESAMPLE_PARAMS,
        span: 32,
        typeDescriptor: resampleParamsType,
      }),
      reflectedGlobal(1, 'texture', 2),
      reflectedGlobal(2, 'texture', 2),
    ],
    [
      { name: 'light_texture_fullscreen', stage: 'vertex', bindings: [] },
      { name: 'light_texture_resample_fragment', stage: 'fragment', bindings: [] },
    ],
    FRAGMENT_PROGRAM_CONTRACT,
  ),
} satisfies { compute: ManifestEntry; fragment: ManifestEntry };
