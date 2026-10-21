import { DEFAULT_STANDARD_SURFACE_MODULE } from '@forgeax/engine-shader';
import type { MaterialAsset, MaterialParameter, MaterialPass } from '@forgeax/engine-types';
import {
  deriveStandardLayerPlan,
  STANDARD_MATERIAL_PARAM_SCHEMA,
  standardMaterialParameters,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker.js';
import { projectMaterial } from '../project.js';

const parameters: readonly MaterialParameter[] = standardSurfaceParameters([
  { name: 'baseColor', type: 'color' },
  { name: 'metallic', type: 'f32' },
  { name: 'roughness', type: 'f32' },
  { name: 'clearcoat', type: 'f32' },
  { name: 'clearcoatRoughness', type: 'f32' },
]);

const passes: [MaterialPass, ...MaterialPass[]] = [
  { name: 'forward', program: { module: 'forgeax_material::standard' } },
  {
    name: 'shadow-caster',
    program: {
      module: 'forgeax::default-shadow-caster',
      moduleSlots: { surface: DEFAULT_STANDARD_SURFACE_MODULE },
    },
  },
];

// Cold publication validates both color ABIs, both addresses and each View ABI.
describe('standard material cook integration', { timeout: 30_000 }, () => {
  it.each([true, false])('cooks a declared or omitted alphaHash parameter: %s', async (enabled) => {
    const names = new Set(
      STANDARD_MATERIAL_PARAM_SCHEMA.filter(
        (entry) => entry.type !== 'texture2d' && (enabled || entry.name !== 'alphaHash'),
      ).map((entry) => entry.name),
    );
    const cooked = await createMaterialPackCooker().cook({
      guid: `alpha-hash-${enabled}`,
      source: {
        kind: 'material',
        staticSwitches: {
          clearcoat: true,
          anisotropy: true,
          sheen: true,
          iridescence: true,
          diffuseTransmission: true,
          transmission: true,
          subsurfaceDiffusion: true,
        },
        parameters: standardMaterialParameters(names),
        passes,
        values: enabled ? { alphaHash: 1 } : {},
      },
    });
    const sources = Object.values(cooked.artifacts).map((artifact) =>
      new TextDecoder().decode(artifact.bytes),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      expect(/\.alphaHash\b/.test(source)).toBe(enabled);
    }
  }, 30_000);

  it('removes every undeclared Standard texture from the cooked program', async () => {
    const scalarNames = new Set(
      STANDARD_MATERIAL_PARAM_SCHEMA.filter((parameter) => parameter.type !== 'texture2d').map(
        (parameter) => parameter.name,
      ),
    );
    const cooked = await createMaterialPackCooker().cook({
      guid: 'standard-no-textures',
      source: {
        kind: 'material',
        staticSwitches: {
          clearcoat: true,
          anisotropy: true,
          sheen: true,
          iridescence: true,
          diffuseTransmission: true,
          transmission: true,
          subsurfaceDiffusion: true,
        },
        parameters: standardMaterialParameters(scalarNames),
        passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
      },
    });
    const artifacts = Object.values(cooked.artifacts);
    expect(artifacts.length).toBeGreaterThan(0);
    const source = artifacts.map((artifact) => new TextDecoder().decode(artifact.bytes)).join('\n');
    expect(source).not.toMatch(
      /\b(?:materialUvLinear|surfaceUv|surfacePlaneSample|surfaceTriplanarSamples|surfaceSample|displaceVertex)\s*\(/,
    );
    for (const parameter of STANDARD_MATERIAL_PARAM_SCHEMA.filter(
      (parameter) => parameter.type === 'texture2d',
    )) {
      expect(source).not.toMatch(new RegExp(`\\b${parameter.name}\\b`));
      expect(source).not.toContain(`${parameter.name}Coordinates`);
    }
  }, 30_000);
  // Dedicated anisotropy, specular-color and foliage cases below cover these
  // maps; the physical-root case also checks the exact clearcoat bindings.
  // Keep the other 19 independent declarations and all-textures-absent control.
  it.each(
    STANDARD_MATERIAL_PARAM_SCHEMA.filter(
      (parameter) =>
        parameter.type === 'texture2d' &&
        ![
          'anisotropyTexture',
          'specularColorTexture',
          'diffuseTransmissionTexture',
          'clearcoatTexture',
          'clearcoatNormalTexture',
        ].includes(parameter.name),
    ),
  )('retains only the declared $name sampling path', async ({ name }) => {
    const names = new Set(
      STANDARD_MATERIAL_PARAM_SCHEMA.filter((parameter) => parameter.type !== 'texture2d').map(
        (parameter) => parameter.name,
      ),
    );
    names.add(name);
    const guid = `standard-only-${name.toLowerCase()}`;
    const cooked = await createMaterialPackCooker().cook({
      guid,
      source: {
        kind: 'material',
        staticSwitches: {
          clearcoat: true,
          anisotropy: true,
          sheen: true,
          iridescence: true,
          diffuseTransmission: true,
          transmission: true,
          subsurfaceDiffusion: true,
        },
        parameters: standardMaterialParameters(names),
        passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
      },
    });
    const artifacts = Object.values(cooked.artifacts);
    expect(artifacts.length).toBeGreaterThan(0);
    const source = artifacts.map((artifact) => new TextDecoder().decode(artifact.bytes)).join('\n');
    for (const parameter of STANDARD_MATERIAL_PARAM_SCHEMA.filter(
      (parameter) => parameter.type === 'texture2d',
    )) {
      const pattern = new RegExp(`\\b${parameter.name}\\b`);
      if (parameter.name === name) expect(source).toMatch(pattern);
      else expect(source).not.toMatch(pattern);
    }
  }, 30_000);
  it('uses one layer identity across compiler and renderer projections', () => {
    const compilerPlan = deriveStandardLayerPlan(parameters, passes);
    const material: MaterialAsset = {
      kind: 'material',
      staticSwitches: {
        clearcoat: true,
        anisotropy: true,
        sheen: true,
        iridescence: true,
        diffuseTransmission: true,
        transmission: true,
        subsurfaceDiffusion: true,
      },
      parameters,
      passes,
    };
    const projection = projectMaterial(material, { material: 'standard', mode: 'development' });
    expect(projection.ok).toBe(true);
    if (!projection.ok) return;
    expect(projection.value.layerPlan).toEqual(compilerPlan);
    expect(projection.value.layerPlan.identity).toContain('standard-layer-plan-v1:physical');
  });

  it('rejects a physical deferred pass before publication', () => {
    try {
      deriveStandardLayerPlan(parameters, [
        ...passes,
        {
          name: 'deferred',
          program: { module: 'forgeax_material::standard' },
          renderState: { tags: { LightMode: 'Deferred' } },
        },
      ]);
      throw new Error('expected physical Deferred admission to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'material-physical-contract-invalid' });
    }
  });

  it('cooks anisotropy with an identity direction fallback and an RG/B texture path', {
    timeout: 30_000,
  }, async () => {
    const baseParameters: readonly MaterialParameter[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
      { name: 'metallicChannel', type: 'f32' },
      { name: 'roughnessChannel', type: 'f32' },
      { name: 'aoChannel', type: 'f32' },
      { name: 'extraChannel', type: 'f32' },
      { name: 'emissive', type: 'vec3' },
      { name: 'emissiveIntensity', type: 'f32' },
      { name: 'occlusionStrength', type: 'f32' },
      { name: 'alphaCutoff', type: 'f32' },
      { name: 'normalScale', type: 'vec2' },
      { name: 'specular', type: 'f32' },
      { name: 'specularColor', type: 'vec3' },
      { name: 'ior', type: 'f32' },
      { name: 'baseColorTexture', type: 'texture' },
      { name: 'metallicRoughnessTexture', type: 'texture' },
      { name: 'normalTexture', type: 'texture' },
      { name: 'emissiveTexture', type: 'texture' },
      { name: 'occlusionTexture', type: 'texture' },
      { name: 'anisotropyStrength', type: 'f32' },
      { name: 'anisotropyRotation', type: 'f32' },
    ];
    const cooker = createMaterialPackCooker();
    const cook = async (parameters: readonly MaterialParameter[]) =>
      cooker.cook({
        guid: `anisotropy-${parameters.some((parameter) => parameter.name === 'anisotropyTexture') ? 'map' : 'scalar'}`,
        source: {
          kind: 'material',
          staticSwitches: {
            clearcoat: true,
            anisotropy: true,
            sheen: true,
            iridescence: true,
            diffuseTransmission: true,
            transmission: true,
            subsurfaceDiffusion: true,
          },
          parameters,
          passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
        },
      });

    const scalar = await cook(baseParameters);
    const mapped = await cook([...baseParameters, { name: 'anisotropyTexture', type: 'texture' }]);
    const scalarArtifact = Object.values(scalar.artifacts)[0];
    const mappedArtifact = Object.values(mapped.artifacts)[0];
    expect(scalarArtifact).toBeDefined();
    expect(mappedArtifact).toBeDefined();
    if (scalarArtifact === undefined || mappedArtifact === undefined) return;
    const scalarWgsl = new TextDecoder().decode(scalarArtifact.bytes);
    const mappedWgsl = new TextDecoder().decode(mappedArtifact.bytes);
    const scalarPayload = scalar.payload as {
      readonly cooked?: {
        readonly receipt?: { readonly derivedInterface?: { readonly layerPlanIdentity?: string } };
      };
    };
    const mappedPayload = mapped.payload as {
      readonly cooked?: {
        readonly receipt?: { readonly derivedInterface?: { readonly layerPlanIdentity?: string } };
      };
    };
    expect(scalarPayload.cooked?.receipt?.derivedInterface?.layerPlanIdentity).toContain(
      'physical:anisotropy',
    );
    expect(mappedPayload.cooked?.receipt?.derivedInterface?.layerPlanIdentity).toBe(
      scalarPayload.cooked?.receipt?.derivedInterface?.layerPlanIdentity,
    );
    expect(scalarWgsl).not.toContain('anisotropyTexture');
    expect(mappedWgsl).toContain('encodedAnisotropyDirection');
    expect(mappedWgsl).toContain('tangent.w');
  });

  it('keeps a base-only root free of second-stage texture declarations and samples', async () => {
    const baseOnly: readonly MaterialParameter[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
      { name: 'metallicChannel', type: 'f32' },
      { name: 'roughnessChannel', type: 'f32' },
      { name: 'aoChannel', type: 'f32' },
      { name: 'extraChannel', type: 'f32' },
      { name: 'emissive', type: 'vec3' },
      { name: 'emissiveIntensity', type: 'f32' },
      { name: 'occlusionStrength', type: 'f32' },
      { name: 'alphaCutoff', type: 'f32' },
      { name: 'normalScale', type: 'vec2' },
      { name: 'specular', type: 'f32' },
      { name: 'specularColor', type: 'vec3' },
      { name: 'ior', type: 'f32' },
      { name: 'baseColorTexture', type: 'texture' },
      { name: 'metallicRoughnessTexture', type: 'texture' },
      { name: 'normalTexture', type: 'texture' },
      { name: 'emissiveTexture', type: 'texture' },
      { name: 'occlusionTexture', type: 'texture' },
    ];
    const cooked = await createMaterialPackCooker().cook({
      guid: 'base-only',
      source: {
        kind: 'material',
        staticSwitches: {
          clearcoat: true,
          anisotropy: true,
          sheen: true,
          iridescence: true,
          diffuseTransmission: true,
          transmission: true,
          subsurfaceDiffusion: true,
        },
        parameters: baseOnly,
        passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
      },
    });
    const artifact = Object.values(cooked.artifacts)[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    const wgsl = new TextDecoder().decode(artifact.bytes);
    const payload = cooked.payload as {
      readonly cooked?: {
        readonly receipt?: { readonly derivedInterface?: { readonly layerPlanIdentity?: string } };
      };
    };
    expect(payload.cooked?.receipt?.derivedInterface?.layerPlanIdentity).toContain('base-only');
    for (const field of [
      'clearcoatTexture',
      'clearcoatRoughnessTexture',
      'clearcoatNormalTexture',
      'anisotropyTexture',
      'sheenColorTexture',
      'sheenRoughnessTexture',
      'iridescenceTexture',
      'iridescenceThicknessTexture',
      'specularTexture',
      'specularColorTexture',
    ]) {
      expect(wgsl).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it('treats a specular color map as a physical Forward-only declaration', async () => {
    const baseOnly: readonly MaterialParameter[] = [
      { name: 'baseColor', type: 'color' },
      { name: 'metallic', type: 'f32' },
      { name: 'roughness', type: 'f32' },
      { name: 'metallicChannel', type: 'f32' },
      { name: 'roughnessChannel', type: 'f32' },
      { name: 'aoChannel', type: 'f32' },
      { name: 'extraChannel', type: 'f32' },
      { name: 'emissive', type: 'vec3' },
      { name: 'emissiveIntensity', type: 'f32' },
      { name: 'occlusionStrength', type: 'f32' },
      { name: 'alphaCutoff', type: 'f32' },
      { name: 'normalScale', type: 'vec2' },
      { name: 'specular', type: 'f32' },
      { name: 'specularColor', type: 'vec3' },
      { name: 'ior', type: 'f32' },
      { name: 'baseColorTexture', type: 'texture' },
      { name: 'metallicRoughnessTexture', type: 'texture' },
      { name: 'normalTexture', type: 'texture' },
      { name: 'emissiveTexture', type: 'texture' },
      { name: 'occlusionTexture', type: 'texture' },
    ];
    const cooked = await createMaterialPackCooker().cook({
      guid: 'specular-color-map',
      source: {
        kind: 'material',
        staticSwitches: {
          clearcoat: true,
          anisotropy: true,
          sheen: true,
          iridescence: true,
          diffuseTransmission: true,
          transmission: true,
          subsurfaceDiffusion: true,
        },
        parameters: [...baseOnly, { name: 'specularColorTexture', type: 'texture' }],
        passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
      },
    });
    const artifact = Object.values(cooked.artifacts)[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    const wgsl = new TextDecoder().decode(artifact.bytes);
    const payload = cooked.payload as {
      readonly cooked?: {
        readonly receipt?: { readonly derivedInterface?: { readonly layerPlanIdentity?: string } };
      };
    };
    expect(payload.cooked?.receipt?.derivedInterface?.layerPlanIdentity).toContain('physical');
    expect(wgsl).toContain('specularColorTexture');
  });

  it('cooks the complete physical root with compact injected bindings', async () => {
    const parameters = standardMaterialParameters(
      new Set(STANDARD_MATERIAL_PARAM_SCHEMA.map((entry) => entry.name)),
    );
    const cooked = await createMaterialPackCooker().cook({
      guid: 'physical-all-layers',
      source: {
        kind: 'material',
        staticSwitches: {
          clearcoat: true,
          anisotropy: true,
          sheen: true,
          iridescence: true,
          diffuseTransmission: true,
          transmission: true,
          subsurfaceDiffusion: true,
        },
        parameters,
        passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
      },
    });
    const artifact = Object.values(cooked.artifacts)[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    const wgsl = new TextDecoder().decode(artifact.bytes);
    for (const field of [
      'clearcoatTexture',
      'clearcoatRoughnessTexture',
      'clearcoatNormalTexture',
      'anisotropyTexture',
      'sheenColorTexture',
      'sheenRoughnessTexture',
      'iridescenceTexture',
      'iridescenceThicknessTexture',
      'specularTexture',
      'specularColorTexture',
      'diffuseTransmissionTexture',
      'diffuseTransmissionColorTexture',
    ]) {
      expect(wgsl).toContain(field);
    }
    expect(wgsl).toMatch(/@binding\(25\)\s+var irradianceMap/);
    expect(wgsl).toMatch(/@binding\(48\)\s+var clearcoatSampler/);
    expect(wgsl).toMatch(/@binding\(52\)\s+var clearcoatNormalSampler/);
    expect(wgsl).toMatch(/@binding\(53\)\s+var clearcoatNormalTexture/);
    expect(wgsl).toMatch(/@binding\(67\)\s+var specularColorTexture/);
    expect(wgsl).toMatch(/@binding\(68\)\s+var diffuseTransmissionSampler/);
    expect(wgsl).toMatch(/@binding\(69\)\s+var diffuseTransmissionTexture/);
    expect(wgsl).toMatch(/@binding\(70\)\s+var diffuseTransmissionColorSampler/);
    expect(wgsl).toMatch(/@binding\(71\)\s+var diffuseTransmissionColorTexture/);
  });

  it('cooks a thin-foliage root with a back-face diffuse transmission lobe', async () => {
    const foliage = standardSurfaceParameters(
      standardMaterialParameters(
        new Set([
          'baseColor',
          'metallic',
          'roughness',
          'baseColorTexture',
          'diffuseTransmission',
          'diffuseTransmissionColor',
          'diffuseTransmissionTexture',
        ]),
      ),
    );
    expect(deriveStandardLayerPlan(foliage).layers.map((layer) => layer.name)).toEqual([
      'diffuseTransmission',
    ]);
    const cooked = await createMaterialPackCooker().cook({
      guid: 'thin-foliage',
      source: {
        kind: 'material',
        staticSwitches: {
          clearcoat: true,
          anisotropy: true,
          sheen: true,
          iridescence: true,
          diffuseTransmission: true,
          transmission: true,
          subsurfaceDiffusion: true,
        },
        parameters: foliage,
        passes,
        values: { diffuseTransmission: 0.6, diffuseTransmissionColor: [0.6, 0.9, 0.3] },
      },
    });
    const artifact = Object.values(cooked.artifacts)[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    const wgsl = new TextDecoder().decode(artifact.bytes);
    expect(wgsl).toContain('material.diffuseTransmissionColor');
    expect(wgsl).toMatch(/@binding\(\d+\)\s+var diffuseTransmissionTexture/);
    expect(wgsl).not.toContain('diffuseTransmissionColorTexture');
  });

  it('publishes a default Alpha Mask ShadowCaster with a reflected scene-index ABI', async () => {
    const cooked = await createMaterialPackCooker().cook({
      guid: 'default-surface-shadow-abi',
      source: {
        kind: 'material',
        staticSwitches: {
          clearcoat: true,
          anisotropy: true,
          sheen: true,
          iridescence: true,
          diffuseTransmission: true,
          transmission: true,
          subsurfaceDiffusion: true,
        },
        parameters: standardSurfaceParameters([
          { name: 'baseColor', type: 'color' },
          { name: 'alphaCutoff', type: 'f32' },
        ]),
        values: { alphaCutoff: 0.5 },
        passes: [
          { name: 'Forward', program: { module: 'forgeax_material::standard' } },
          { name: 'ShadowCaster', program: { module: 'forgeax::default-shadow-caster' } },
        ],
      },
    });
    const payload = cooked.payload as {
      cooked: {
        programs: {
          selections: {
            pass: string;
            address?: string;
            abi?: { materialRow: { byteLength: number }; sceneIndexEntry: string };
          }[];
        }[];
      };
    };
    const shadow = payload.cooked.programs
      .flatMap((program) => program.selections)
      .find(
        (selection) => selection.pass === 'ShadowCaster' && selection.address === 'scene-index',
      );
    expect(shadow?.abi).toMatchObject({
      materialRow: { byteLength: 128 },
      sceneIndexEntry: 'vs_scene_index',
    });
    expect(
      Object.values(cooked.artifacts).some((artifact) => {
        const wgsl = new TextDecoder().decode(artifact.bytes);
        return (
          wgsl.includes('fs_shadow') && wgsl.includes('alphaCutoff') && wgsl.includes('discard')
        );
      }),
    ).toBe(true);
  });

  it('publishes complete Standard and shadow programs for a multi-pass root', async () => {
    const cooked = await createMaterialPackCooker().cook({
      guid: 'multi-pass-standard',
      source: {
        kind: 'material',
        staticSwitches: {
          clearcoat: true,
          anisotropy: true,
          sheen: true,
          iridescence: true,
          diffuseTransmission: true,
          transmission: true,
          subsurfaceDiffusion: true,
        },
        parameters,
        passes,
      },
    });
    const artifact = Object.values(cooked.artifacts)[0];
    expect(artifact).toBeDefined();
    if (artifact === undefined) return;
    const wgsl = new TextDecoder().decode(artifact.bytes);
    expect(wgsl.match(/\bstruct\s+SurfaceInput\b/g)).toHaveLength(1);
    expect(wgsl.match(/\bfn\s+fs_main\s*\(/g)).toHaveLength(1);
    expect(wgsl.match(/\bfn\s+fs_gbuffer\s*\(/g)).toHaveLength(1);
    const sources = Object.values(cooked.artifacts).map((value) =>
      new TextDecoder().decode(value.bytes),
    );
    expect(sources.some((value) => /\bfn\s+fs_shadow\s*\(/.test(value))).toBe(true);
  });
});
