// derive(schema) unit-test matrix — feat-20260613-material-paramschema-driven-binding M1 / w1
//
// Decision anchors (plan-strategy §2):
//   - D-2  derive(schema) signature (single pure function, no side-effect)
//   - D-3  numeric-run merging into a single UBO entry at binding(0)
//   - D-4  filtering sampler auto-pair for every texture* family entry
//   - D-7  17 MaterialParamType literals (9 v1 + 7 new + texture_external)
//   - D-12 empty schema graceful path (bglEntries=[] / totalBytes=0 / userRegionBindingEnd=0)
//
// Acceptance check (plan-tasks w1):
//   - >= 30 it; covers 17 type literals + 7 std140 packing walkthroughs
//     + sampler auto-pair + 4 error-path cases.
//
// std140 alignment rules used in the walkthroughs (WGSL uniform):
//   - f32 / i32 / u32           : size 4,  align 4
//   - vec2<f32>                 : size 8,  align 8
//   - vec3<f32>                 : size 12, align 16
//   - vec4<f32> / color (rgba)  : size 16, align 16
//   - struct round-up           : totalBytes is rounded up to 16-byte alignment

import { describe, expect, it } from 'vitest';
import { derive, findUndeclaredSampledTextures } from '../derive-paramschema';
import type { ParamSchemaEntry } from '../index';
import { MATERIAL_PARAM_TYPES } from '../index';

const FRAGMENT = 0x2 as GPUShaderStageFlags;

describe('MATERIAL_PARAM_TYPES', () => {
  it('contains exactly 17 type literals (D-7 + texture_external)', () => {
    expect(MATERIAL_PARAM_TYPES.length).toBe(17);
  });

  it('exposes the 7 numeric literals', () => {
    for (const t of ['f32', 'i32', 'u32', 'vec2', 'vec3', 'vec4', 'color'] as const) {
      expect(MATERIAL_PARAM_TYPES).toContain(t);
    }
  });

  it('exposes the 8 texture-binding literals (textures + samplers)', () => {
    for (const t of [
      'texture2d',
      'texture2d_array',
      'texture3d',
      'texture_cube',
      'texture_depth_2d',
      'texture_cube_array',
      'sampler',
      'sampler_comparison',
    ] as const) {
      expect(MATERIAL_PARAM_TYPES).toContain(t);
    }
  });

  it('exposes the storage-binding literal', () => {
    expect(MATERIAL_PARAM_TYPES).toContain('storage_buffer');
  });

  it('has no duplicate literals', () => {
    expect(new Set(MATERIAL_PARAM_TYPES).size).toBe(MATERIAL_PARAM_TYPES.length);
  });
});

describe('derive(schema) — empty schema graceful (D-12)', () => {
  it('returns empty bgl + zero ubo on empty input', () => {
    const out = derive([]);
    expect(out.bglEntries).toEqual([]);
    expect(out.uboLayout.entries).toEqual([]);
    expect(out.uboLayout.totalBytes).toBe(0);
    expect(out.textureFieldNames.size).toBe(0);
    expect(out.samplerForTexture.size).toBe(0);
    expect(out.userRegionBindingEnd).toBe(0);
  });
});

describe('derive(schema) — numeric merging (D-3)', () => {
  it('merges single f32 into one UBO entry', () => {
    const out = derive([{ name: 'metallic', type: 'f32', default: 0 }]);
    expect(out.bglEntries.length).toBe(1);
    expect(out.bglEntries[0]?.binding).toBe(0);
    expect(out.bglEntries[0]?.buffer?.type).toBe('uniform');
    expect(out.uboLayout.entries.length).toBe(1);
    expect(out.uboLayout.entries[0]).toEqual({ name: 'metallic', offset: 0, size: 4, type: 'f32' });
    expect(out.uboLayout.totalBytes).toBe(16);
    expect(out.userRegionBindingEnd).toBe(1);
  });

  it('walkthrough 1: [f32,f32,vec3] -> offsets [0,4,16] total=32', () => {
    const out = derive([
      { name: 'a', type: 'f32' },
      { name: 'b', type: 'f32' },
      { name: 'c', type: 'vec3' },
    ]);
    expect(out.uboLayout.entries.map((e) => e.offset)).toEqual([0, 4, 16]);
    expect(out.uboLayout.entries.map((e) => e.size)).toEqual([4, 4, 12]);
    expect(out.uboLayout.totalBytes).toBe(32);
  });

  it('walkthrough 2: [vec3,f32] -> [0,12] total=16', () => {
    const out = derive([
      { name: 'a', type: 'vec3' },
      { name: 'b', type: 'f32' },
    ]);
    expect(out.uboLayout.entries.map((e) => e.offset)).toEqual([0, 12]);
    expect(out.uboLayout.totalBytes).toBe(16);
  });

  it('walkthrough 3: 4 contiguous f32 -> [0,4,8,12] total=16', () => {
    const out = derive([
      { name: 'a', type: 'f32' },
      { name: 'b', type: 'f32' },
      { name: 'c', type: 'f32' },
      { name: 'd', type: 'f32' },
    ]);
    expect(out.uboLayout.entries.map((e) => e.offset)).toEqual([0, 4, 8, 12]);
    expect(out.uboLayout.totalBytes).toBe(16);
  });

  it('walkthrough 4: pure vec4 array [vec4,vec4] -> [0,16] total=32', () => {
    const out = derive([
      { name: 'a', type: 'vec4' },
      { name: 'b', type: 'vec4' },
    ]);
    expect(out.uboLayout.entries.map((e) => e.offset)).toEqual([0, 16]);
    expect(out.uboLayout.totalBytes).toBe(32);
  });

  it('walkthrough 5: color (= rgba vec4) packs as vec4', () => {
    const out = derive([
      { name: 'tint', type: 'color', default: [1, 1, 1, 1] },
      { name: 'k', type: 'f32' },
    ]);
    expect(out.uboLayout.entries[0]).toEqual({ name: 'tint', offset: 0, size: 16, type: 'color' });
    expect(out.uboLayout.entries[1]).toEqual({ name: 'k', offset: 16, size: 4, type: 'f32' });
    expect(out.uboLayout.totalBytes).toBe(32);
  });

  it('walkthrough 6: vec2 align=8 [f32,vec2] -> [0,8] total=16', () => {
    const out = derive([
      { name: 'a', type: 'f32' },
      { name: 'b', type: 'vec2' },
    ]);
    expect(out.uboLayout.entries.map((e) => e.offset)).toEqual([0, 8]);
    expect(out.uboLayout.totalBytes).toBe(16);
  });

  it('walkthrough 7: mixed numerics [f32,vec3,vec2,f32] -> [0,16,28(?),...]', () => {
    // offsets: a@0(f32 sz4) | vec3 needs align16 -> 16 sz12 | vec2 needs align8 -> 28? no, 28 not align8 -> 32 sz8 | f32 -> 40 sz4 -> total round to 48
    const out = derive([
      { name: 'a', type: 'f32' },
      { name: 'b', type: 'vec3' },
      { name: 'c', type: 'vec2' },
      { name: 'd', type: 'f32' },
    ]);
    expect(out.uboLayout.entries.map((e) => e.offset)).toEqual([0, 16, 32, 40]);
    expect(out.uboLayout.totalBytes).toBe(48);
  });

  it('numeric run produces single bgl uniform buffer entry at binding(0)', () => {
    const out = derive([
      { name: 'a', type: 'f32' },
      { name: 'b', type: 'i32' },
      { name: 'c', type: 'u32' },
    ]);
    expect(out.bglEntries.length).toBe(1);
    expect(out.bglEntries[0]?.binding).toBe(0);
    expect(out.bglEntries[0]?.buffer?.type).toBe('uniform');
  });
});

describe('derive(schema) — texture-binding family + sampler auto-pair (D-4)', () => {
  it('texture2d auto-pairs filtering sampler FIRST (binding N), then texture (binding N+1)', () => {
    const out = derive([{ name: 'mainTex', type: 'texture2d' }]);
    expect(out.bglEntries.length).toBe(3);
    expect(out.bglEntries[0]?.buffer?.type).toBe('uniform');
    expect(out.bglEntries[1]?.binding).toBe(1);
    expect(out.bglEntries[1]?.sampler?.type).toBe('filtering');
    expect(out.bglEntries[2]?.binding).toBe(2);
    expect(out.bglEntries[2]?.texture?.sampleType).toBe('float');
    expect(out.bglEntries[2]?.texture?.viewDimension).toBe('2d');
    expect(out.textureFieldNames.has('mainTex')).toBe(true);
    expect(out.samplerForTexture.get('mainTex')).toBe('mainTex_sampler');
    expect(out.userRegionBindingEnd).toBe(3);
  });

  it('texture_cube auto-pairs filtering sampler (sampler-first) with viewDimension=cube', () => {
    const out = derive([{ name: 'envMap', type: 'texture_cube' }]);
    expect(out.bglEntries[1]?.sampler?.type).toBe('filtering');
    expect(out.bglEntries[2]?.texture?.viewDimension).toBe('cube');
  });

  it('texture_depth_2d uses sampleType=depth + filtering sampler auto-pair (sampler-first)', () => {
    const out = derive([{ name: 'shadowMap', type: 'texture_depth_2d' }]);
    expect(out.bglEntries[1]?.sampler?.type).toBe('filtering');
    expect(out.bglEntries[2]?.texture?.sampleType).toBe('depth');
    expect(out.bglEntries[2]?.texture?.viewDimension).toBe('2d');
  });

  it('texture_cube_array sampleType=float viewDimension=cube-array (sampler-first)', () => {
    const out = derive([{ name: 'cubeArr', type: 'texture_cube_array' }]);
    expect(out.bglEntries[1]?.sampler?.type).toBe('filtering');
    expect(out.bglEntries[2]?.texture?.viewDimension).toBe('cube-array');
  });

  it('sampler_comparison is declared explicitly (no auto-pair)', () => {
    const out = derive([{ name: 'shadowSampler', type: 'sampler_comparison' }]);
    expect(out.bglEntries.length).toBe(1);
    expect(out.bglEntries[0]?.sampler?.type).toBe('comparison');
    expect(out.userRegionBindingEnd).toBe(1);
  });

  it('explicit sampler entry maps to filtering binding (no extra auto-pair)', () => {
    const out = derive([{ name: 'sampler', type: 'sampler' }]);
    expect(out.bglEntries.length).toBe(1);
    expect(out.bglEntries[0]?.sampler?.type).toBe('filtering');
  });

  it('mixed numeric + texture: numeric UBO at binding 0, sampler at 1, texture at 2', () => {
    const out = derive([
      { name: 'tint', type: 'color', default: [1, 1, 1, 1] },
      { name: 'mainTex', type: 'texture2d' },
    ]);
    expect(out.bglEntries.length).toBe(3);
    expect(out.bglEntries[0]?.binding).toBe(0);
    expect(out.bglEntries[0]?.buffer?.type).toBe('uniform');
    // sampler-first: sampler @1, texture @2
    expect(out.bglEntries[1]?.binding).toBe(1);
    expect(out.bglEntries[1]?.sampler?.type).toBe('filtering');
    expect(out.bglEntries[2]?.binding).toBe(2);
    expect(out.bglEntries[2]?.texture?.sampleType).toBe('float');
    expect(out.userRegionBindingEnd).toBe(3);
  });

  it('multiple textures each get their own sampler auto-pair (sampler-first interleaving)', () => {
    const out = derive([
      { name: 'a', type: 'texture2d' },
      { name: 'b', type: 'texture2d' },
    ]);
    expect(out.bglEntries.map((e) => e.binding)).toEqual([0, 1, 2, 3, 4]);
    expect(out.bglEntries[1]?.sampler?.type).toBe('filtering');
    expect(out.bglEntries[2]?.texture?.sampleType).toBe('float');
    expect(out.bglEntries[3]?.sampler?.type).toBe('filtering');
    expect(out.bglEntries[4]?.texture?.sampleType).toBe('float');
    expect(out.samplerForTexture.get('a')).toBe('a_sampler');
    expect(out.samplerForTexture.get('b')).toBe('b_sampler');
  });
});

describe('derive(schema) — storage-binding family', () => {
  it('storage_buffer is its own binding (read-only-storage)', () => {
    const out = derive([{ name: 'palette', type: 'storage_buffer' }]);
    expect(out.bglEntries.length).toBe(1);
    expect(out.bglEntries[0]?.binding).toBe(0);
    expect(out.bglEntries[0]?.buffer?.type).toBe('read-only-storage');
    expect(out.userRegionBindingEnd).toBe(1);
  });

  it('storage_buffer between numeric entries keeps one derived uniform binding', () => {
    const out = derive([
      { name: 'tint', type: 'color', default: [1, 1, 1, 1] },
      { name: 'palette', type: 'storage_buffer' },
      { name: 'k', type: 'f32' },
    ]);
    // The numeric members share one continuous derived payload across the resource.
    expect(out.bglEntries.map((e) => e.binding)).toEqual([0, 1]);
    expect(out.bglEntries[0]?.buffer?.type).toBe('uniform');
    expect(out.bglEntries[1]?.buffer?.type).toBe('read-only-storage');
    expect(out.numericMembers.map((member) => member.name)).toEqual(['tint', 'k']);
  });
});

describe('derive(schema) — error paths', () => {
  it('throws on duplicate entry name', () => {
    expect(() =>
      derive([
        { name: 'x', type: 'f32' },
        { name: 'x', type: 'f32' },
      ]),
    ).toThrow(/duplicate/i);
  });

  it('throws on unrecognised type literal', () => {
    expect(() => derive([{ name: 'oops', type: 'mat3' as unknown as 'f32' }])).toThrow(
      /unrecognised|unknown/i,
    );
  });

  it('throws when entry name collides with auto-paired sampler', () => {
    expect(() =>
      derive([
        { name: 'mainTex', type: 'texture2d' },
        { name: 'mainTex_sampler', type: 'sampler' },
      ]),
    ).toThrow(/sampler|collide|duplicate/i);
  });

  it('throws on empty entry name', () => {
    expect(() => derive([{ name: '', type: 'f32' }])).toThrow(/name/i);
  });
});

describe('derive(schema) — 14 type literal coverage smoke', () => {
  // exercise each of the 14 types at least once across constructed schemas
  const cases: ReadonlyArray<{ readonly label: string; readonly schema: ParamSchemaEntry[] }> = [
    { label: 'f32', schema: [{ name: 'a', type: 'f32' }] },
    { label: 'i32', schema: [{ name: 'a', type: 'i32' }] },
    { label: 'u32', schema: [{ name: 'a', type: 'u32' }] },
    { label: 'vec2', schema: [{ name: 'a', type: 'vec2' }] },
    { label: 'vec3', schema: [{ name: 'a', type: 'vec3' }] },
    { label: 'vec4', schema: [{ name: 'a', type: 'vec4' }] },
    { label: 'color', schema: [{ name: 'a', type: 'color', default: [1, 1, 1, 1] }] },
    { label: 'texture2d', schema: [{ name: 't', type: 'texture2d' }] },
    { label: 'texture_cube', schema: [{ name: 't', type: 'texture_cube' }] },
    { label: 'texture_depth_2d', schema: [{ name: 't', type: 'texture_depth_2d' }] },
    { label: 'texture_cube_array', schema: [{ name: 't', type: 'texture_cube_array' }] },
    { label: 'sampler', schema: [{ name: 's', type: 'sampler' }] },
    { label: 'sampler_comparison', schema: [{ name: 's', type: 'sampler_comparison' }] },
    { label: 'storage_buffer', schema: [{ name: 'b', type: 'storage_buffer' }] },
  ];
  for (const c of cases) {
    it(`type=${c.label} derives without error`, () => {
      const out = derive(c.schema);
      expect(out.userRegionBindingEnd).toBeGreaterThan(0);
    });
  }
});

describe('derive(schema) — bgl visibility = FRAGMENT', () => {
  it('numeric ubo entry is FRAGMENT visible', () => {
    const out = derive([{ name: 'a', type: 'f32' }]);
    expect(out.bglEntries[0]?.visibility).toBe(FRAGMENT);
  });
  it('texture/sampler entries are FRAGMENT visible (sampler-first ordering)', () => {
    const out = derive([{ name: 't', type: 'texture2d' }]);
    expect(out.bglEntries[0]?.visibility).toBe(FRAGMENT);
    expect(out.bglEntries[1]?.visibility).toBe(FRAGMENT);
    expect(out.bglEntries[2]?.visibility).toBe(FRAGMENT);
  });
});

// bug-20260619: register-time texture-declaration consistency. The runtime
// counterpart of the build-time superset gate -- a user shader that samples a
// user-region material texture (baseColorTexture / metallicRoughnessTexture /
// normalTexture) but omits it from paramSchema would let extract silently drop
// the handle and bind the default white texture (LO 4.3 blending demo grass +
// windows turned opaque white). See docs/handover/2026-06-19-blending-
// transparency-regression-bisect.md.
describe('findUndeclaredSampledTextures', () => {
  const sampleWgsl = (...texs: string[]): string =>
    texs.map((t) => `let s = textureSample(${t}, ${t}Sampler, in.uv);`).join('\n');

  it('flags baseColorTexture sampled but not declared', () => {
    const schema: ParamSchemaEntry[] = [{ name: 'baseColor', type: 'color' }];
    expect(findUndeclaredSampledTextures(sampleWgsl('baseColorTexture'), schema)).toEqual([
      'baseColorTexture',
    ]);
  });

  it('passes when the sampled texture is declared as texture2d', () => {
    const schema: ParamSchemaEntry[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'baseColorTexture', type: 'texture2d' },
    ];
    expect(findUndeclaredSampledTextures(sampleWgsl('baseColorTexture'), schema)).toEqual([]);
  });

  it('flags all three user-region textures when all sampled-but-undeclared', () => {
    const wgsl = sampleWgsl('baseColorTexture', 'metallicRoughnessTexture', 'normalTexture');
    expect(findUndeclaredSampledTextures(wgsl, [])).toEqual([
      'baseColorTexture',
      'metallicRoughnessTexture',
      'normalTexture',
    ]);
  });

  it('does NOT flag a texture that is declared but never sampled (outline / depth-viz reuse)', () => {
    // WGSL declares the standard binding layout but the fragment never samples
    // baseColorTexture -- dropping the (absent) handle is harmless.
    const wgsl =
      '@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;\n@fragment fn fs() {}';
    expect(findUndeclaredSampledTextures(wgsl, [])).toEqual([]);
  });

  it('ignores commented-out textureSample calls (line + block comments)', () => {
    const lineComment = '// let s = textureSample(baseColorTexture, smp, uv);';
    expect(findUndeclaredSampledTextures(lineComment, [])).toEqual([]);
    const blockComment = '/* textureSample(baseColorTexture, smp, uv) */';
    expect(findUndeclaredSampledTextures(blockComment, [])).toEqual([]);
  });

  it('does NOT flag engine-injected textures (emissive / occlusion) absent from schema', () => {
    // These are engine-owned Standard textures, not user-region fields;
    // default-standard-pbr samples them without a schema entry by design.
    const wgsl = sampleWgsl('emissiveTexture', 'occlusionTexture');
    expect(findUndeclaredSampledTextures(wgsl, [])).toEqual([]);
  });

  it('matches textureSampleLevel / textureSampleCompareLevel variants', () => {
    const wgsl = 'let a = textureSampleLevel(baseColorTexture, smp, uv, 0.0);';
    expect(findUndeclaredSampledTextures(wgsl, [])).toEqual(['baseColorTexture']);
  });
});
