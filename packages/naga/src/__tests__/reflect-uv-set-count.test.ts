// feat-20260629-multi-uv-set-support m4-w1: naga reflection uvSetCount unit test.
//
// Tests that naga emit_reflection returns uvSetCount derived from vertex
// @location declarations (D-4 convention: uv0 at location 2, uv1..7 at
// location 6..12, counting only vec2<f32> vertex input arguments).
//
// This test calls through the real @forgeax/engine-naga TS wrapper (parse
// -> validate -> emit_reflection), not mocked wasm. It starts RED because
// the current emit_reflection (pre m4-w2) does not include uvSetCount in
// the reflection JSON output. After m4-w2 (naga.rs modification) + m4-w4
// (wasm rebuild), this test should go GREEN.
//
// Wgsl snippets avoid trailing commas inside struct definitions (WGSL
// spec permits them but being conservative avoids naga parser edge cases).

import { isShaderReflection } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { emit_reflection, parse, parseReflectionWire, validate } from '../index.js';

// --- wgsl test fixtures --------------------------------------------------

const WGSL_UV0_ONLY = `\
struct VsIn {
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>
};
@vertex fn vs(in: VsIn) -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}`;

const WGSL_UV0_UV1 = `\
struct VsIn {
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @location(6) uv1: vec2<f32>
};
@vertex fn vs(in: VsIn) -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}`;

const WGSL_UV0_UV1_UV2 = `\
struct VsIn {
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @location(6) uv1: vec2<f32>,
  @location(7) uv2: vec2<f32>
};
@vertex fn vs(in: VsIn) -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}`;

const WGSL_UV0_SKIP_UV7 = `\
struct VsIn {
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @location(8) uv3: vec2<f32>
};
@vertex fn vs(in: VsIn) -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}`;

// Also test a skin-aware WGSL with 0 extra UV
const WGSL_SKIN_UV0_ONLY = `\
struct VsIn {
  @location(0) pos: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
  @location(4) skinIndex: vec4<u32>,
  @location(5) skinWeight: vec4<f32>
};
@vertex fn vs(in: VsIn) -> @builtin(position) vec4<f32> {
  return vec4<f32>(0.0);
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}`;

const WGSL_RESOURCE_CLASSES = `\
@group(0) @binding(0) var<storage, read> inputWords: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputWords: array<u32>;
@group(0) @binding(2) var sourceTexture: texture_2d<f32>;
@group(0) @binding(3) var targetTexture: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(1) fn main() {
  let sample = textureLoad(sourceTexture, vec2<i32>(0), 0);
  outputWords[0] = inputWords[0] + u32(sample.x);
  textureStore(targetTexture, vec2<i32>(0), sample);
}`;

const WGSL_BOUNDED_LAYOUT = `\
struct Data {
  m: mat3x3<f32>,
  a: array<vec4<u32>, 2>,
  tail: vec4<f32>
};
struct Matrix32 { value: mat3x2<f32> };
struct Matrix23 { value: mat2x3<f32> };
struct Vec2Array { value: array<vec2<u32>, 2> };
struct MatrixArray { value: array<mat3x3<f32>, 2> };
@group(0) @binding(0) var<storage, read> data: array<Data>;
@group(0) @binding(1) var<storage, read> matrix32: array<Matrix32>;
@group(0) @binding(2) var<storage, read> matrix23: array<Matrix23>;
@group(0) @binding(3) var<storage, read> vec2Array: array<Vec2Array>;
@group(0) @binding(4) var<storage, read> matrixArray: array<MatrixArray>;
@compute @workgroup_size(1) fn main() {
  let keep = data[0].m[0][0] + f32(data[0].a[0].x) + data[0].tail.x +
    matrix32[0].value[0][0] + matrix23[0].value[0][0] +
    f32(vec2Array[0].value[0].x) + matrixArray[0].value[0][0][0];
}
`;

// --- test body -----------------------------------------------------------

describe('reflect-uv-set-count.test.ts', () => {
  interface ReflectionOutput {
    bindings: unknown;
    uvSetCount: number;
    schemaVersion: 'shader-reflection/3';
    boundGlobals: readonly {
      group: number;
      binding: number;
      addressSpace: string;
      resourceKind: string;
      resourceAccess?: string;
      textureClass?: string;
      sampleType?: string;
      viewDimension?: string;
      multisampled?: boolean;
      storageFormat?: string;
      samplerType?: string;
      name?: string;
      members?: readonly {
        name: string;
        type: string;
        offset: number;
        size: number;
        alignment: number;
        typeDescriptor: unknown;
      }[];
      span?: number;
      elementStride?: number;
      elementType?: string;
      arrayLength?: number;
      typeDescriptor?: unknown;
    }[];
  }

  async function reflectWgsl(wgsl: string): Promise<ReflectionOutput> {
    const parsed = await parse(wgsl);
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.error.message}`);
    const validated = await validate(parsed.value);
    if (!validated.ok) throw new Error(`validate failed: ${validated.error.message}`);
    const reflection = await emit_reflection(validated.value, '{}');
    if (!reflection.ok) throw new Error(`emit_reflection failed: ${reflection.error.message}`);
    const parsedObj = JSON.parse(reflection.value);
    // After m4-w2 the reflection JSON format is { bindings: [...], uvSetCount: N }.
    if (Array.isArray(parsedObj)) {
      throw new Error(
        'Reflection output is still the old array format; m4-w2 naga.rs changes not yet applied or wasm not rebuilt.',
      );
    }
    return parsedObj as ReflectionOutput;
  }

  describe('naga emit_reflection uvSetCount derivation (D-4: uv0@loc2, extra@loc6+)', () => {
    it('uv0 only -> uvSetCount=1', async () => {
      const r = await reflectWgsl(WGSL_UV0_ONLY);
      expect(r.uvSetCount).toBe(1);
      expect(Array.isArray(r.bindings)).toBe(true);
    });

    it('uv0 + uv1 (locations 2 and 6) -> uvSetCount=2', async () => {
      const r = await reflectWgsl(WGSL_UV0_UV1);
      expect(r.uvSetCount).toBe(2);
    });

    it('uv0 + uv1 + uv2 (locations 2, 6, 7) -> uvSetCount=3', async () => {
      const r = await reflectWgsl(WGSL_UV0_UV1_UV2);
      expect(r.uvSetCount).toBe(3);
    });

    it('uv0 + skip to uv3 at location 8 -> uvSetCount=4 (max(location>=6)-5=3 extra)', async () => {
      const r = await reflectWgsl(WGSL_UV0_SKIP_UV7);
      // Per D-4 jump convention: max(location>=6) = 8, so uvSetCount = 1 + (8-5) = 4.
      // The shader declares uv3 at @location(8) which implies uv1(loc6) and
      // uv2(loc7) also exist in the packing convention even if not physically
      // present in VsIn — clamp-to-last handles the gap.
      expect(r.uvSetCount).toBe(4);
    });

    it('skin shader with uv0 only -> uvSetCount=1 (skinIndex/skinWeight not counted as UV)', async () => {
      const r = await reflectWgsl(WGSL_SKIN_UV0_ONLY);
      expect(r.uvSetCount).toBe(1);
    });
  });

  describe('generic shader-reflection/3 bound globals', () => {
    const WGSL_GENERIC_GLOBALS = `\
struct MaterialBlock {
  tint: vec4<f32>,
  roughness: f32
};
@group(0) @binding(0) var<uniform> renamedView: vec4<f32>;
@group(1) @binding(0) var<storage, read> unrelatedStorage: array<u32>;
@group(2) @binding(0) var<uniform> renamedMaterial: MaterialBlock;
@group(2) @binding(2) var materialTexture: texture_2d<f32>;
@group(2) @binding(5) var materialSampler: sampler;
@vertex fn vs() -> @builtin(position) vec4<f32> {
  return renamedView + renamedMaterial.tint;
}
@fragment fn fs() -> @location(0) vec4<f32> {
  return textureSample(materialTexture, materialSampler, vec2<f32>(0.0));
}`;

    it('emits every bound global with generic facts, including binding gaps', async () => {
      const r = await reflectWgsl(WGSL_GENERIC_GLOBALS);
      expect(r.schemaVersion).toBe('shader-reflection/3');
      expect(r.boundGlobals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ group: 0, binding: 0 }),
          expect.objectContaining({ group: 1, binding: 0 }),
          expect.objectContaining({ group: 2, binding: 0, addressSpace: 'uniform' }),
          expect.objectContaining({ group: 2, binding: 2, resourceKind: 'texture' }),
          expect.objectContaining({ group: 2, binding: 5, resourceKind: 'sampler' }),
        ]),
      );
      expect(r.boundGlobals).toHaveLength(5);
      const material = r.boundGlobals.find((global) => global.group === 2 && global.binding === 0);
      expect(material?.members).toEqual([
        expect.objectContaining({ name: 'tint', type: 'vec4<f32>' }),
        expect.objectContaining({ name: 'roughness', type: 'f32' }),
      ]);
      expect(material).toMatchObject({ resourceAccess: 'read-only' });
      expect(material?.span).toBeGreaterThan(0);
      const storage = r.boundGlobals.find((global) => global.group === 1 && global.binding === 0);
      expect(storage).toMatchObject({ resourceAccess: 'read-only', elementStride: 4 });
      expect(
        r.boundGlobals.find((global) => global.group === 2 && global.binding === 2),
      ).toMatchObject({
        resourceAccess: 'read-only',
        textureClass: 'sampled',
        sampleType: 'float',
        viewDimension: '2d',
        multisampled: false,
      });
      expect(
        r.boundGlobals.find((global) => global.group === 2 && global.binding === 5),
      ).toMatchObject({
        resourceAccess: 'read-only',
        samplerType: 'filtering',
      });
    });

    it('does not identify the material by global name', async () => {
      const renamed = WGSL_GENERIC_GLOBALS.replaceAll('renamedMaterial', 'surfaceBlock');
      const original = await reflectWgsl(WGSL_GENERIC_GLOBALS);
      const changed = await reflectWgsl(renamed);
      expect(changed.boundGlobals.map(({ name: _name, ...global }) => global)).toEqual(
        original.boundGlobals.map(({ name: _name, ...global }) => global),
      );
    });

    it.each([
      ['mat4x4<f32>', 64],
      ['vec4<f32>', 16],
    ] as const)('retains the Naga array stride for fixed uniform %s arrays', async (type, stride) => {
      const reflection = await reflectWgsl(`
@group(2) @binding(1) var<uniform> palette: array<${type}, 4>;
@compute @workgroup_size(1) fn main() { let value = palette[0]; }
`);
      const wire = parseReflectionWire(JSON.stringify(reflection));
      expect(
        wire.boundGlobals.find((global) => global.group === 2 && global.binding === 1),
      ).toMatchObject({
        addressSpace: 'uniform',
        resourceKind: 'buffer',
        elementStride: stride,
        arrayLength: 4,
      });
    });

    it('publishes a fixed storage-array capacity and leaves runtime arrays unbounded', async () => {
      const reflection = await reflectWgsl(`
@group(2) @binding(3) var<storage, read> fixed: array<vec4<f32>, 256>;
@group(2) @binding(4) var<storage, read> runtime: array<vec4<f32>>;
@compute @workgroup_size(1) fn main() { let value = fixed[0] + runtime[0]; }
`);
      const wire = parseReflectionWire(JSON.stringify(reflection));
      expect(
        wire.boundGlobals.find((global) => global.group === 2 && global.binding === 3),
      ).toMatchObject({
        resourceKind: 'storage-buffer',
        elementStride: 16,
        elementType: 'vec4<f32>',
        arrayLength: 256,
      });
      expect(
        wire.boundGlobals.find((global) => global.group === 2 && global.binding === 4),
      ).toMatchObject({
        resourceKind: 'storage-buffer',
        elementStride: 16,
        elementType: 'vec4<f32>',
      });
      expect(
        wire.boundGlobals.find((global) => global.group === 2 && global.binding === 4),
      ).not.toHaveProperty('arrayLength');
    });

    it('publishes Naga bounded type layout for matrices and recursive arrays', async () => {
      const reflection = await reflectWgsl(WGSL_BOUNDED_LAYOUT);
      const wire = parseReflectionWire(JSON.stringify(reflection));
      const data = wire.boundGlobals.find((global) => global.binding === 0);
      expect(data?.members).toEqual([
        expect.objectContaining({
          name: 'm',
          type: 'mat3x3<f32>',
          offset: 0,
          size: 48,
          alignment: 16,
        }),
        expect.objectContaining({
          name: 'a',
          offset: 48,
          size: 32,
          alignment: 16,
          typeDescriptor: {
            kind: 'array',
            size: { kind: 'constant', count: 2 },
            stride: 16,
            byteSize: 32,
            alignment: 16,
            element: {
              kind: 'vector',
              scalarKind: 'uint',
              width: 4,
              components: 4,
              byteSize: 16,
              alignment: 16,
            },
          },
        }),
        expect.objectContaining({
          name: 'tail',
          type: 'vec4<f32>',
          offset: 80,
          size: 16,
          alignment: 16,
        }),
      ]);
      expect(data).toMatchObject({ span: 96, elementStride: 96 });
      const cases = wire.boundGlobals.slice(1);
      expect(cases[0]?.members?.[0]).toMatchObject({
        offset: 0,
        size: 24,
        alignment: 8,
        typeDescriptor: {
          kind: 'matrix',
          scalarKind: 'float',
          width: 4,
          columns: 3,
          rows: 2,
          columnStride: 8,
          byteSize: 24,
          alignment: 8,
        },
      });
      expect(cases[1]?.members?.[0]).toMatchObject({
        offset: 0,
        size: 32,
        alignment: 16,
        typeDescriptor: {
          kind: 'matrix',
          scalarKind: 'float',
          width: 4,
          columns: 2,
          rows: 3,
          columnStride: 16,
          byteSize: 32,
          alignment: 16,
        },
      });
      expect(cases[2]?.members?.[0]).toMatchObject({
        size: 16,
        alignment: 8,
        typeDescriptor: {
          kind: 'array',
          size: { kind: 'constant', count: 2 },
          stride: 8,
          byteSize: 16,
          alignment: 8,
          element: {
            kind: 'vector',
            scalarKind: 'uint',
            width: 4,
            components: 2,
            byteSize: 8,
            alignment: 8,
          },
        },
      });
      expect(cases[3]?.members?.[0]).toMatchObject({
        size: 96,
        alignment: 16,
        typeDescriptor: {
          kind: 'array',
          size: { kind: 'constant', count: 2 },
          stride: 48,
          byteSize: 96,
          alignment: 16,
          element: {
            kind: 'matrix',
            scalarKind: 'float',
            width: 4,
            columns: 3,
            rows: 3,
            columnStride: 16,
            byteSize: 48,
            alignment: 16,
          },
        },
      });
    });
  });

  it('reflects buffer access and sampled versus storage texture declarations', async () => {
    const reflection = await reflectWgsl(WGSL_RESOURCE_CLASSES);
    const wire = parseReflectionWire(JSON.stringify(reflection));
    expect(wire.boundGlobals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          binding: 0,
          resourceKind: 'storage-buffer',
          resourceAccess: 'read-only',
        }),
        expect.objectContaining({
          binding: 1,
          resourceKind: 'storage-buffer',
          resourceAccess: 'read-write',
        }),
        expect.objectContaining({
          binding: 2,
          resourceKind: 'texture',
          resourceAccess: 'read-only',
          textureClass: 'sampled',
          sampleType: 'unfilterable-float',
          viewDimension: '2d',
          multisampled: false,
        }),
        expect.objectContaining({
          binding: 3,
          resourceKind: 'texture',
          resourceAccess: 'write-only',
          textureClass: 'storage',
          viewDimension: '2d',
          storageFormat: 'rgba8unorm',
        }),
      ]),
    );
  });

  it('rejects real-emitter flat projections that contradict recursive buffer descriptors', async () => {
    const reflected = await reflectWgsl(`\
struct UniformData { value: vec4<u32> };
@group(0) @binding(0) var<storage, read> values: array<vec4<f32>, 2>;
@group(0) @binding(1) var<uniform> uniformData: UniformData;`);
    const valid = JSON.parse(JSON.stringify(reflected)) as {
      schemaVersion: string;
      uvSetCount: number;
      boundGlobals: Array<Record<string, unknown>>;
    };
    expect(isShaderReflection(valid)).toBe(true);
    expect(parseReflectionWire(JSON.stringify(valid)).boundGlobals).toHaveLength(2);

    const mutations: readonly [string, (wire: typeof valid) => void][] = [
      [
        'element type',
        (wire) => {
          const global = wire.boundGlobals[0];
          if (global === undefined) throw new Error('expected the reflected array resource');
          global.elementType = 'vec4<u32>';
        },
      ],
      [
        'array stride',
        (wire) => {
          const global = wire.boundGlobals[0];
          if (global === undefined) throw new Error('expected the reflected array resource');
          global.elementStride = 32;
        },
      ],
      [
        'array count',
        (wire) => {
          const global = wire.boundGlobals[0];
          if (global === undefined) throw new Error('expected the reflected array resource');
          global.arrayLength = 3;
        },
      ],
      [
        'array metadata on a struct',
        (wire) => {
          const global = wire.boundGlobals[1];
          if (global === undefined) throw new Error('expected the reflected struct resource');
          global.arrayLength = 2;
        },
      ],
    ];
    for (const [label, mutate] of mutations) {
      const malformed = structuredClone(valid);
      mutate(malformed);
      expect(isShaderReflection(malformed), label).toBe(false);
      expect(() => parseReflectionWire(JSON.stringify(malformed)), label).toThrow(
        /shader-reflection\/3 is malformed/,
      );
    }
  });
});
