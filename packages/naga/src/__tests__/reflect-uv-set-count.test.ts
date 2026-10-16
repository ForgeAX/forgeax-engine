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

import { describe, expect, it } from 'vitest';
import { emit_reflection, parse, readReflectionWire, validate } from '../index.js';

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

// --- test body -----------------------------------------------------------

describe('reflect-uv-set-count.test.ts', () => {
  interface ReflectionOutput {
    bindings: unknown;
    uvSetCount: number;
    schemaVersion: 'shader-reflection/2';
    boundGlobals: readonly {
      group: number;
      binding: number;
      addressSpace: string;
      resourceKind: string;
      name?: string;
      members?: readonly {
        name: string;
        type: string;
        offset: number;
        size: number;
        alignment: number;
      }[];
      span?: number;
      elementStride?: number;
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

  describe('generic shader-reflection/2 bound globals', () => {
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
      expect(r.schemaVersion).toBe('shader-reflection/2');
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
      expect(material?.span).toBeGreaterThan(0);
      const storage = r.boundGlobals.find((global) => global.group === 1 && global.binding === 0);
      expect(storage?.elementStride).toBe(4);
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
      const wire = readReflectionWire(JSON.stringify(reflection)).unwrap();
      expect(
        wire.boundGlobals.find((global) => global.group === 2 && global.binding === 1),
      ).toMatchObject({
        addressSpace: 'uniform',
        resourceKind: 'buffer',
        elementStride: stride,
      });
    });
  });
});
