import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MATERIAL_MODULES,
  type BuiltinMaterialKind,
  createBuiltinMaterialAsset,
  isEngineMaterial,
  isEngineMaterialModule,
} from '../index.js';
import type { MaterialShaderArtifact } from '../material/artifact-types.js';
import { createMaterialShaderProgram } from '../material/program';
import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '../material-schemas.js';

const builtinSources = [
  'default-standard-pbr.wgsl',
  'default-standard-pbr-skin.wgsl',
  'unlit.wgsl',
  'sprite.wgsl',
  'sprite-lit.wgsl',
  'msdf-text.wgsl',
] as const;

const kinds: readonly BuiltinMaterialKind[] = ['standard', 'unlit', 'sprite'];

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
}

describe('built-in MaterialAsset sources', () => {
  it('keeps Engine-owned module identity in one shared predicate', () => {
    expect(isEngineMaterial(createBuiltinMaterialAsset('standard'))).toBe(true);
    expect(isEngineMaterialModule('forgeax::default-standard-pbr')).toBe(true);
    expect(isEngineMaterialModule('game::custom')).toBe(false);
    expect(
      isEngineMaterial({
        ...createBuiltinMaterialAsset('standard'),
        parameters: [{ name: 'clippingControl', type: 'vec4' }],
      }),
    ).toBe(false);
    expect(
      isEngineMaterial({
        passes: [{ name: 'forward', program: { module: 'game::custom' } }],
      }),
    ).toBe(false);
  });

  it.each([true, false])('requires cooking an explicit static choice of %s', (enabled) => {
    expect(
      isEngineMaterial({
        ...createBuiltinMaterialAsset('standard'),
        staticSwitches: { clearcoat: enabled },
      }),
    ).toBe(false);
    expect(
      isEngineMaterial({
        ...createBuiltinMaterialAsset('standard'),
        staticSwitches: {},
      }),
    ).toBe(true);
  });

  it.each(kinds)('uses one authored MaterialAsset contract for %s', (kind) => {
    const material = createBuiltinMaterialAsset(kind);
    const pass = material.passes?.[0];

    expect(material.kind).toBe('material');
    expect(pass?.program.module).toBe(BUILTIN_MATERIAL_MODULES[kind]);
    expect(pass?.renderState?.tags).toEqual({ LightMode: 'Forward' });
    expect(pass).not.toHaveProperty('shader');
    expect(material.parameters?.length).toBeGreaterThan(0);
    expect(material.values).toBeDefined();
  });

  it('keeps cooked artifact identity separate from authored values', () => {
    const material = createBuiltinMaterialAsset('standard');
    const artifact: MaterialShaderArtifact = {
      material: 'builtin-standard',
      pass: material.passes?.[0]?.name ?? 'forward',
      program: createMaterialShaderProgram('builtin-standard-wgsl'),
      layoutIdentity: 'sha256-builtin-standard-layout',
      bindings: [],
      deps: [BUILTIN_MATERIAL_MODULES.standard],
      vertexInputs: [],
      specializationKey: 'builtin-standard-key',
    };

    expect(artifact.specializationKey).toBe('builtin-standard-key');
    expect(artifact.deps).toEqual([BUILTIN_MATERIAL_MODULES.standard]);
    expect(material.values?.baseColor).toEqual([1, 1, 1, 1]);
    expect(
      { ...material, values: { ...material.values, baseColor: [0.2, 0.3, 0.4, 1] } }.values,
    ).toMatchObject({ baseColor: [0.2, 0.3, 0.4, 1] });
  });

  it.each([
    'default-standard-pbr.wgsl',
    'default-standard-pbr-skin.wgsl',
  ] as const)('keeps the Standard user-region ABI before Skylight in %s', (file) => {
    const text = source(file);
    const bindings = [
      'baseColorTexture_sampler',
      'baseColorTexture',
      'metallicRoughnessTexture_sampler',
      'metallicRoughnessTexture',
      'normalTexture_sampler',
      'normalTexture',
      'emissiveTexture_sampler',
      'emissiveTexture',
      'occlusionTexture_sampler',
      'occlusionTexture',
      'transmissionSampler',
      'transmissionTexture',
      'thicknessSampler',
      'thicknessTexture',
      'irradianceMap',
    ];
    let previous = -1;
    for (const name of bindings) {
      const index = new RegExp(`\\bvar\\s+${name}\\s*:`).exec(text)?.index ?? -1;
      expect(index, `${file} must declare ${name}`).toBeGreaterThan(previous);
      previous = index;
    }
    expect(text).toContain('@binding(13) var transmissionSampler');
    expect(text).toContain('@binding(16) var thicknessTexture');
    expect(text).toContain('@binding(17) var irradianceMap');
    expect(text).toMatch(
      /#ifdef SPECULAR_COLOR_TEXTURE_AVAILABLE\s+@group\(1\) @binding\(44\) var specularColorTextureSampler/u,
    );
    expect(text).toMatch(
      /#ifdef SPECULAR_COLOR_TEXTURE_AVAILABLE[\s\S]*?@group\(1\) @binding\(45\) var specularColorTexture/u,
    );
    expect(text).not.toMatch(/@binding\((?:7|8)\) var specularColorTexture/u);
  });
});

describe('built-in and custom material derived layout matrix', () => {
  it('models emissive and occlusion as real standard material texture parameters', () => {
    const names = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.map((entry) => entry.name);
    expect(names).toContain('emissiveTexture');
    expect(names).toContain('occlusionTexture');
    expect(names).toContain('transmissionTexture');
    expect(names).toContain('thicknessTexture');
    expect(names).toContain('displacementTexture');
    expect(
      DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter((entry) => entry.type === 'texture2d'),
    ).toHaveLength(24);
    expect(names).toEqual(
      expect.arrayContaining([
        'clearcoatTexture',
        'clearcoatRoughnessTexture',
        'clearcoatNormalTexture',
        'anisotropyTexture',
        'sheenColorTexture',
        'sheenRoughnessTexture',
        'iridescenceTexture',
        'iridescenceThicknessTexture',
        'specularTexture',
      ]),
    );
  });

  it('derives a coordinate record for every texture parameter in an interleaved custom schema', () => {
    const derived = derive([
      { name: 'before', type: 'vec4' },
      { name: 'albedo', type: 'texture2d' },
      { name: 'roughness', type: 'f32' },
      { name: 'normal', type: 'texture2d' },
    ]);
    expect(derived.coordinateRecords.map((record) => record.parameter)).toEqual([
      'albedo',
      'normal',
    ]);
    expect(derived.coordinateRecords.every((record) => record.size === 48)).toBe(true);
    expect(derived.coordinateRecords[0]?.offset).not.toBe(derived.coordinateRecords[1]?.offset);
  });

  it('keeps the built-in source matrix on the derived coordinate contract', () => {
    for (const file of builtinSources) {
      const text = source(file);
      expect(text, `${file} must expose derived coordinate members`).toContain(
        'CoordinatesTransform',
      );
      expect(text, `${file} must not carry a fixed coordinate tail`).not.toContain(
        'textureScalePadding',
      );
    }
  });
});
