import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  createBuiltinMaterialAsset,
  DEFAULT_SPRITE_PARAM_SCHEMA,
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
  ShaderRegistry,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { resolveMaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { Materials } from '../materials.js';
import {
  materialColorParameterSchema,
  materialParametersToParamSchema,
  materialParamSchemaForMaterial,
} from '../render-system-extract.js';

describe('vertex color does not change the material contract', () => {
  it('uses optional schema lookup without constructing missing shader diagnostics', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const assets = new AssetRegistry(registry);
    const authored = [{ name: 'color', type: 'vec4' as const, default: [1, 0, 0, 1] }];
    const strict = vi.spyOn(registry, 'findMaterialArtifact').mockImplementation(() => {
      throw Error('optional extraction must not use strict diagnostics');
    });
    try {
      expect(materialColorParameterSchema(authored, 'project::late', assets)).toBe(authored);
      expect(materialParamSchemaForMaterial(authored, 'project::late', [], assets)).toEqual(
        materialParametersToParamSchema(authored),
      );
      registry.installMaterialArtifact('project::late', {
        source: '',
        paramSchema: [{ name: 'inherited', type: 'vec4', default: [0, 1, 0, 1] }],
      });
      expect(materialColorParameterSchema(authored, 'project::late', assets)).toEqual([
        { name: 'inherited', type: 'vec4', default: [0, 1, 0, 1] },
        ...authored,
      ]);
      expect(materialParamSchemaForMaterial(authored, 'project::late', [], assets)).toBe(
        registry.materialArtifact('project::late')?.paramSchema,
      );
      expect(strict).not.toHaveBeenCalled();
    } finally {
      strict.mockRestore();
    }
  });
  it('keeps colored and plain materials on the same schema and resource identity', () => {
    const plain = createBuiltinMaterialAsset('standard');
    const colored = createBuiltinMaterialAsset('standard');
    expect(colored.parameters).toEqual(plain.parameters);
    expect(colored.passes).toEqual(plain.passes);
    expect(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.map((entry) => entry.name)).toContain('baseColor');
    expect(DEFAULT_UNLIT_PARAM_SCHEMA.some((entry) => entry.name === 'color')).toBe(false);
    expect(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.some((entry) => entry.name === 'color')).toBe(false);
  });

  it('keeps vertex color out of the authored material flags and bindings', () => {
    const material = createBuiltinMaterialAsset('unlit');
    expect(JSON.stringify(material)).not.toMatch(/hasColor|VERTEX_COLOR_AVAILABLE|colorBinding/i);
    expect(material.passes?.[0]?.program).not.toHaveProperty('color');
  });

  it.each([
    ['unlit', Materials.unlit([0.5, 0.5, 0.5, 1])],
    ['standard', Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] })],
  ] as const)('keeps the %s factory fallback aligned with its color schema', (_name, material) => {
    const resolved = resolveMaterialAsset('factory-fallback', {
      'factory-fallback': material,
    });
    expect(resolved).toMatchObject({ ok: true });
  });

  it('keeps the standard authoring parameters derived from the shared schema', () => {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1] });
    expect(
      material.parameters
        ?.filter((parameter) => parameter.type !== 'texture')
        .map((parameter) => parameter.name),
    ).toEqual([
      'alphaChannel',
      'baseColor',
      'metallic',
      'roughness',
      'subsurfaceRadius',
      'subsurfaceWeight',
      'metallicChannel',
      'roughnessChannel',
      'aoChannel',
      'extraChannel',
      'emissive',
      'emissiveIntensity',
      'occlusionStrength',
      'alphaCutoff',
      'specular',
      'alphaHash',
      'specularColor',
      'normalScale',
      'bumpScale',
      'ior',
      'displacementScale',
      'displacementBias',
      'triplanarSpace',
      'triplanarScale',
      'triplanarSharpness',
      'normalMapSpace',
    ]);
    expect(material.values).not.toHaveProperty('transmission');
    expect(material.values).toHaveProperty('ior', 1.5);
  });

  it('routes canonical Standard roots through the complete runtime UBO schema', () => {
    const material = Materials.standard({ baseColor: [1, 1, 1, 1] });
    const authoredSchema = materialParametersToParamSchema(material.parameters ?? []);
    const canonicalSchema = materialParametersToParamSchema(
      material.parameters ?? [],
      'forgeax::default-standard-pbr',
    );

    expect(authoredSchema.map((entry) => entry.name)).toEqual(
      material.parameters?.map((parameter) => parameter.name),
    );
    expect(canonicalSchema).toBe(STANDARD_PIPELINE_PARAM_SCHEMA);
    expect(authoredSchema).not.toBe(STANDARD_PIPELINE_PARAM_SCHEMA);
  });

  it('uses a registered custom shader ABI when generated material parameters are omitted', () => {
    const registered = [
      { name: 'colorTint', type: 'vec4', default: [1, 1, 1, 1] },
      { name: 'region', type: 'vec4', default: [0, 0, 1, 1] },
      { name: 'pivotAndSize', type: 'vec4', default: [0.5, 0.5, 1, 1] },
    ] as const;
    let requestedShader: string | undefined;
    const assets = {
      shaderRegistry: {
        materialArtifact(shaderId: string) {
          requestedShader = shaderId;
          return { paramSchema: registered };
        },
      },
    } as unknown as NonNullable<Parameters<typeof materialParamSchemaForMaterial>[3]>;

    expect(materialParamSchemaForMaterial([], 'project::generated', [], assets)).toBe(registered);
    expect(requestedShader).toBe('project::generated');
  });

  it('keeps the built-in Sprite UBO ABI when no shader artifact is installed', () => {
    expect(materialParametersToParamSchema([], 'forgeax::sprite')).toBe(
      DEFAULT_SPRITE_PARAM_SCHEMA,
    );
    expect(materialParametersToParamSchema([], 'forgeax::sprite', [])).toBe(
      DEFAULT_SPRITE_PARAM_SCHEMA,
    );
  });

  it.each([
    'forgeax::sprite',
    'forgeax::sprite-lit',
    'project::authored',
  ])('retains authored parameters when %s has no published parameter layout', (shaderId) => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    registry.installMaterialArtifact(shaderId, { source: '', paramSchema: [] });
    const parameters = [
      { name: 'colorTint', type: 'vec4' as const },
      { name: 'region', type: 'vec4' as const, optional: true },
      { name: 'pivotAndSize', type: 'vec4' as const },
      { name: 'slicesAndMode', type: 'vec4' as const, optional: true },
      { name: 'baseColorTexture', type: 'texture' as const },
    ];
    expect(
      materialParamSchemaForMaterial(parameters, shaderId, [], new AssetRegistry(registry)),
    ).toEqual(materialParametersToParamSchema(parameters));
  });

  it('retains the accepted custom Surface ABI even when the material redeclares parameters', () => {
    const registry = new ShaderRegistry({ manifestUrl: undefined });
    const material = Materials.standard({
      surfaceModule: 'game::paint',
      parameters: [{ name: 'paintStrength', type: 'f32', default: 0.75 }],
      values: { paintStrength: 0.75 },
    });
    const schema = materialParametersToParamSchema(material.parameters ?? []);
    registry.installMaterialArtifact('program/paint', { source: '', paramSchema: schema });
    const accepted = registry.findMaterialArtifact('program/paint').unwrap();
    const assets = new AssetRegistry(registry);
    expect(
      materialParamSchemaForMaterial(
        material.parameters ?? [],
        'program/paint',
        material.passes ?? [],
        assets,
      ),
    ).toBe(accepted.paramSchema);
    // An uncompiled Standard root is not the ABI for its custom Surface.
    registry.installMaterialArtifact('forgeax::default-standard-pbr', {
      source: '',
      paramSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
    });
    const uncompiled = materialParamSchemaForMaterial(
      material.parameters ?? [],
      'forgeax::default-standard-pbr',
      material.passes ?? [],
      assets,
    );
    expect(uncompiled).toEqual(schema);
    expect(uncompiled).not.toBe(STANDARD_PIPELINE_PARAM_SCHEMA);
  });

  it('publishes the complete Standard contract when authoring a custom Surface', () => {
    const custom = Materials.standard({
      surfaceModule: 'project::paint',
      parameters: [{ name: 'paintStrength', type: 'f32', default: 0.75 }],
      values: { paintStrength: 0.5 },
    });
    const names = custom.parameters?.map((parameter) => parameter.name) ?? [];
    expect(names).toEqual(
      expect.arrayContaining([
        'baseColor',
        'metallic',
        'roughness',
        'normalScale',
        'bumpScale',
        'paintStrength',
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(custom.parameters?.find((parameter) => parameter.name === 'paintStrength')).toEqual({
      name: 'paintStrength',
      type: 'f32',
      default: 0.75,
    });
    expect(custom.values).toEqual({ paintStrength: 0.5 });
    expect(names).not.toContain('clearcoat');
  });

  it('routes active transmission to Forward and ShadowCaster only', () => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      transmission: 0.5,
    });
    expect(material.passes?.map((pass) => pass.name)).toEqual(['forward', 'shadow-caster']);
    expect(material.passes?.[0]?.renderState).toMatchObject({ depthWriteEnabled: false });
  });

  it('projects the standard material raster orientation into its ShadowCaster pass', () => {
    const material = Materials.standard({
      baseColor: [1, 1, 1, 1],
      renderState: { cullMode: 'none', frontFace: 'cw' },
    });
    const shadowCaster = material.passes?.find((entry) => entry.name === 'shadow-caster');
    expect(shadowCaster?.renderState).toMatchObject({ cullMode: 'none', frontFace: 'cw' });
  });

  it.each([
    ['transmission', { transmission: -0.1 }],
    ['ior', { ior: 0 }],
    ['thickness', { thickness: -0.1 }],
    ['attenuationDistance', { attenuationDistance: 0 }],
  ])('rejects invalid %s before material publication', (_name, options) => {
    expect(() => Materials.standard({ baseColor: [1, 1, 1, 1], ...options })).toThrow();
  });

  it('rejects BLEND and depth writes for an active transmission material', () => {
    expect(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        transmission: 0.5,
        renderState: {
          blend: {
            color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        transmission: 0.5,
        renderState: { depthWriteEnabled: true },
      }),
    ).toThrow();
  });
});
