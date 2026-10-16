import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { compileShader } from '../index.js';
import { generateParameterModule } from '../material/cook.js';
import { compareDerivedMaterialInterface, parseReflection } from '../reflection.js';
import { DERIVED_REFLECTION_FACTS, DERIVED_REFLECTION_SCHEMA } from './reflection.fixtures.js';

const reflectionJson = JSON.stringify({
  schemaVersion: 'shader-reflection/2',
  boundGlobals: [
    {
      group: 1,
      binding: 0,
      addressSpace: 'uniform',
      resourceKind: 'buffer',
      visibility: 2,
      members: DERIVED_REFLECTION_FACTS.members,
      span: 80,
    },
    { group: 1, binding: 1, addressSpace: 'handle', resourceKind: 'sampler', visibility: 2 },
    { group: 1, binding: 2, addressSpace: 'handle', resourceKind: 'texture', visibility: 2 },
  ],
  uvSetCount: 1,
  bindings: [
    {
      label: '@group(1)',
      entries: [
        { binding: 0, visibility: 2, buffer: { type: 'uniform' } },
        { binding: 1, visibility: 2, sampler: { type: 'filtering' } },
        {
          binding: 2,
          visibility: 2,
          texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
        },
      ],
    },
  ],
});

describe('derived material reflection equality', () => {
  it('accepts a Pass without any material bindings', () => {
    expect(
      compareDerivedMaterialInterface(derive(DERIVED_REFLECTION_SCHEMA), { boundGlobals: [] }).ok,
    ).toBe(true);
  });

  it('accepts a texture subset without renumbering the root resources', () => {
    const parsed = parseReflection(reflectionJson);
    const boundGlobals = parsed.boundGlobals.filter(
      (global) => global.binding !== 1 && global.binding !== 2,
    );
    expect(
      compareDerivedMaterialInterface(derive(DERIVED_REFLECTION_SCHEMA), { boundGlobals }).ok,
    ).toBe(true);
  });

  it('rejects undeclared material bindings instead of treating a wrong coordinate as unused', () => {
    const parsed = parseReflection(reflectionJson);
    const boundGlobals = parsed.boundGlobals.map((global) =>
      global.binding === 0 ? { ...global, binding: 8 } : global,
    );
    const result = compareDerivedMaterialInterface(derive(DERIVED_REFLECTION_SCHEMA), {
      boundGlobals,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { detail: { actual: { group: 1, binding: 8 } } },
    });
  });

  it('keeps scene row declarations outside direct material artifacts', () => {
    const schema = [{ name: 'value', type: 'f32' }] as const;
    expect(generateParameterModule(schema)).not.toContain('MATERIAL_SCENE_ROW_VEC4_COUNT');
    expect(generateParameterModule(schema, { sceneIndex: true, sceneRowStride: 560 })).toContain(
      'const MATERIAL_SCENE_ROW_VEC4_COUNT: u32 = 35u;',
    );
  });

  it('generates coordinate members from the derived material interface', () => {
    const module = generateParameterModule(DERIVED_REFLECTION_SCHEMA);

    expect(module).toContain('albedoCoordinatesTransform');
    expect(module).toContain('albedoCoordinatesMetadata');
    expect(module).toContain('@binding(1) var albedo_sampler');
    expect(module).toContain('@binding(2) var albedo');
  });

  it('compares generated material facts with independent raw reflection facts', () => {
    const derived = derive(DERIVED_REFLECTION_SCHEMA);
    const parsed = parseReflection(reflectionJson);

    const result = compareDerivedMaterialInterface(derived, parsed);

    expect(result.ok).toBe(true);
  });

  it('accepts material resources used by both vertex and fragment stages', () => {
    const parsed = parseReflection(reflectionJson.replaceAll('"visibility":2', '"visibility":3'));
    const result = compareDerivedMaterialInterface(derive(DERIVED_REFLECTION_SCHEMA), parsed);
    expect(result.ok).toBe(true);
  });

  it('accepts a material UBO consumed only by the vertex stage', () => {
    const parsed = parseReflection(reflectionJson.replace('"visibility":2', '"visibility":1'));
    const result = compareDerivedMaterialInterface(derive(DERIVED_REFLECTION_SCHEMA), parsed);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['f32', 'vec4<f32>(material.value, 0.0, 0.0, 1.0)', 4],
    ['vec2', 'vec4<f32>(material.value, 0.0, 1.0)', 8],
    ['vec3', 'vec4<f32>(material.value, 1.0)', 16],
  ] as const)('compares raw Naga span with the rounded derived span for %s', async (type, expression, rawSpan) => {
    const schema = [{ name: 'value', type }] as const;
    const generated = generateParameterModule(schema);
    const source = `#define_import_path game::raw-span-${type}\n${generated.replace(/^#define_import_path[^\n]+\n/, '')}\n@fragment fn fs_main() -> @location(0) vec4<f32> { return ${expression}; }`;
    const compiled = await compileShader(source, { id: `game::raw-span-${type}` });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const uniform = compiled.value.reflection.boundGlobals.find(
      (global) => global.group === 1 && global.binding === 0,
    );
    expect(uniform?.span).toBe(rawSpan);
    expect(derive(schema).totalBytes).toBe(16);
    expect(compareDerivedMaterialInterface(derive(schema), compiled.value.reflection).ok).toBe(
      true,
    );
  });

  it('matches Naga struct span for a color followed by scalar members', async () => {
    const schema: readonly ParamSchemaEntry[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
    ];
    const generated = generateParameterModule(schema);
    const source = `#define_import_path game::raw-span-color-scalars\n${generated.replace(/^#define_import_path[^\n]+\n/, '')}\n@fragment fn fs_main() -> @location(0) vec4<f32> { return material.baseColor; }`;
    const compiled = await compileShader(source, { id: 'game::raw-span-color-scalars' });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const uniform = compiled.value.reflection.boundGlobals.find(
      (global) => global.group === 1 && global.binding === 0,
    );
    expect(uniform?.span).toBe(32);
    expect(derive(schema).totalBytes).toBe(32);
    expect(compareDerivedMaterialInterface(derive(schema), compiled.value.reflection).ok).toBe(
      true,
    );
  });

  it('matches Naga struct span for adjacent vec2 members and a scalar', async () => {
    const schema: readonly ParamSchemaEntry[] = [
      { name: 'first', type: 'vec2' },
      { name: 'second', type: 'vec2' },
      { name: 'weight', type: 'f32' },
    ];
    const generated = generateParameterModule(schema);
    const source = `#define_import_path game::raw-span-vec2-scalars\n${generated.replace(/^#define_import_path[^\n]+\n/, '')}\n@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(material.first, material.second.x, 1.0); }`;
    const compiled = await compileShader(source, { id: 'game::raw-span-vec2-scalars' });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const uniform = compiled.value.reflection.boundGlobals.find(
      (global) => global.group === 1 && global.binding === 0,
    );
    expect(uniform?.span).toBe(24);
    expect(derive(schema).totalBytes).toBe(32);
    expect(compareDerivedMaterialInterface(derive(schema), compiled.value.reflection).ok).toBe(
      true,
    );
  });

  it('accepts a generated material binding that no entry point reads', async () => {
    const schema: readonly ParamSchemaEntry[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
    ];
    const generated = generateParameterModule(schema);
    const source = `#define_import_path game::unused-material\n${generated.replace(/^#define_import_path[^\n]+\n/, '')}\n@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }`;
    const compiled = await compileShader(source, { id: 'game::unused-material' });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const uniform = compiled.value.reflection.boundGlobals.find(
      (global) => global.group === 1 && global.binding === 0,
    );
    expect(uniform?.visibility).toBe(0);
    expect(compareDerivedMaterialInterface(derive(schema), compiled.value.reflection).ok).toBe(
      true,
    );
  });

  it('reflects arrayed textures as their array view dimensions', async () => {
    const source = `#define_import_path game::arrayed-reflection
@group(1) @binding(0) var arraySampler: sampler;
@group(1) @binding(1) var layers: texture_2d_array<f32>;
@group(1) @binding(2) var cubes: texture_cube_array<f32>;
@group(1) @binding(3) var volume: texture_3d<f32>;
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return textureSample(layers, arraySampler, vec2<f32>(0.5), 1)
    + textureSample(cubes, arraySampler, vec3<f32>(1.0, 0.0, 0.0), 1)
    + textureSample(volume, arraySampler, vec3<f32>(0.5));
}`;
    const compiled = await compileShader(source, { id: 'game::arrayed-reflection' });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const entries = compiled.value.bindings.find((group) => group.label === '@group(1)')?.entries;
    expect(entries?.map((entry) => entry.texture?.viewDimension)).toEqual([
      undefined,
      '2d-array',
      'cube-array',
      '3d',
    ]);
  });

  it('rejects a tampered raw f32 span even when the rounded allocation span is unchanged', async () => {
    const schema = [{ name: 'value', type: 'f32' }] as const;
    const generated = generateParameterModule(schema);
    const source = `#define_import_path game::raw-span-tampered\n${generated.replace(/^#define_import_path[^\n]+\n/, '')}\n@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(material.value, 0.0, 0.0, 1.0); }`;
    const compiled = await compileShader(source, { id: 'game::raw-span-tampered' });

    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const tampered = parseReflection(
      JSON.stringify({
        schemaVersion: 'shader-reflection/2',
        boundGlobals: compiled.value.reflection.boundGlobals.map((global) =>
          global.group === 1 && global.binding === 0 ? { ...global, span: 8 } : global,
        ),
        uvSetCount: compiled.value.reflection.uvSetCount,
      }),
    );
    expect(compareDerivedMaterialInterface(derive(schema), tampered).ok).toBe(false);
  });

  it.each([
    ['offset', { ...DERIVED_REFLECTION_FACTS.members[0], offset: 4 }],
    ['type', { ...DERIVED_REFLECTION_FACTS.members[0], type: 'vec4<f32>' }],
  ])('rejects an independent member %s mismatch', (_kind, member) => {
    const parsed = parseReflection(
      JSON.stringify({
        schemaVersion: 'shader-reflection/2',
        boundGlobals: [
          {
            group: 1,
            binding: 0,
            addressSpace: 'uniform',
            resourceKind: 'buffer',
            visibility: 2,
            members: [member, ...DERIVED_REFLECTION_FACTS.members.slice(1)],
            span: 80,
          },
        ],
        uvSetCount: 0,
      }),
    );

    const result = compareDerivedMaterialInterface(derive(DERIVED_REFLECTION_SCHEMA), parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('material-derived-interface-mismatch');
      expect(result.error.detail.parameter).toBe('exposure');
      expect(result.error.detail.expected).toMatchObject({ offset: 0, type: 'f32' });
      expect(result.error.detail.actual).toMatchObject({
        offset: member.offset,
        type: member.type,
      });
    }
  });

  it('rejects a resource binding mismatch while tolerating engine injection', () => {
    const parsed = parseReflection(
      JSON.stringify({
        schemaVersion: 'shader-reflection/2',
        boundGlobals: [
          {
            group: 1,
            binding: 0,
            addressSpace: 'uniform',
            resourceKind: 'buffer',
            visibility: 2,
            members: DERIVED_REFLECTION_FACTS.members,
            span: 80,
          },
          { group: 1, binding: 1, addressSpace: 'handle', resourceKind: 'texture', visibility: 2 },
          { group: 1, binding: 2, addressSpace: 'handle', resourceKind: 'texture', visibility: 2 },
        ],
        uvSetCount: 0,
      }),
    );

    const result = compareDerivedMaterialInterface(derive(DERIVED_REFLECTION_SCHEMA), parsed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('material-derived-interface-mismatch');
      expect(result.error.detail.parameter).toBe('albedo');
    }
  });
});
