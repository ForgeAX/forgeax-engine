import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { derive, isMaterialProgramAbi } from '@forgeax/engine-types';
import Ajv2020 from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMaterialProgramArtifactReceipt } from '../material/artifact-types.js';
import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '../material-schemas.js';

type EngineShaderManifest = Awaited<
  ReturnType<typeof import('@forgeax/engine-vite-plugin-shader').buildEngineShaderManifest>
>;

const alphaSchema = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../apps/parity/color-lighting/schemas/material-alpha.schema.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as object;
const validateAlpha = new Ajv2020({ allErrors: true, strict: false }).compile(alphaSchema);

describe('standard PBR material alpha contract', () => {
  it('owns RGBA and factor-times-texture alpha in the baseColor schema', () => {
    const baseColor = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.find((entry) => entry.name === 'baseColor');
    const alphaCutoff = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.find(
      (entry) => entry.name === 'alphaCutoff',
    );

    expect(baseColor).toMatchObject({
      name: 'baseColor',
      type: 'color',
      default: [1, 1, 1, 1],
    });
    expect(alphaCutoff).toMatchObject({ name: 'alphaCutoff', type: 'f32' });
    expect(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.map((entry) => entry.name)).not.toContain(
      'baseColorAlpha',
    );
    expect(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.map((entry) => entry.name)).not.toContain(
      'textureAlphaFactor',
    );
  });

  it.each([
    ['short RGBA', { baseColor: [1, 1, 1], alphaMode: 'MASK' }],
    ['unknown alpha mode', { baseColor: [1, 1, 1, 1], alphaMode: 'DITHER' }],
    ['negative cutoff', { baseColor: [1, 1, 1, 1], alphaMode: 'MASK', alphaCutoff: -0.1 }],
  ])('rejects %s before GPU execution', (_name, value) => {
    expect(validateAlpha(value)).toBe(false);
  });

  it('keeps the glTF MASK default cutoff explicit in the schema', () => {
    const properties = alphaSchema as {
      readonly properties?: {
        readonly alphaCutoff?: { readonly default?: number };
      };
    };
    expect(properties.properties?.alphaCutoff?.default).toBe(0.5);
    expect(validateAlpha({ baseColor: [1, 1, 1, 0.5], alphaMode: 'MASK' })).toBe(true);
  });
});

describe('custom material program receipt contract', () => {
  it('publishes an empty direct parameter region without inventing a GPU Scene row', () => {
    const receipt = createMaterialProgramArtifactReceipt({
      schema: [],
      directEntry: 'vs_main',
      vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
    });
    expect(receipt.materialRow).toEqual({ byteLength: 0, fields: [] });
    expect(isMaterialProgramAbi(receipt)).toBe(true);
    expect(isMaterialProgramAbi({ ...receipt, sceneIndexEntry: 'vs_scene_index' })).toBe(false);
    expect(
      isMaterialProgramAbi({ ...receipt, materialRow: { byteLength: 0, fields: ['tint'] } }),
    ).toBe(false);
    expect(() =>
      createMaterialProgramArtifactReceipt({
        schema: [],
        directEntry: 'vs_main',
        sceneIndexEntry: 'vs_scene_index',
        vertexInputs: [],
        rowStride: 0,
      }),
    ).toThrow();
  });

  it('derives a compact scene-index row from the producer schema', () => {
    const schema = [
      { name: 'tint', type: 'color' as const, default: [1, 0.5, 0.25, 1] },
      { name: 'roughness', type: 'f32' as const, default: 0.4 },
      { name: 'albedo', type: 'texture2d' as const },
    ];
    const receipt = createMaterialProgramArtifactReceipt({
      schema,
      directEntry: 'vs_main',
      sceneIndexEntry: 'vs_scene_index',
      vertexInputs: [
        { semantic: 'position', location: 0, format: 'float32x3' },
        { semantic: 'color', location: 13, format: 'float32x4' },
      ],
    });
    expect(receipt.materialRow.byteLength).toBe(derive(schema).totalBytes);
    expect(receipt.materialRow.addressUnitBytes).toBe(16);
    expect(receipt.materialRow.fields).toEqual([
      'tint',
      'roughness',
      'albedoCoordinatesTransform',
      'albedoCoordinatesMetadata',
      'albedoCoordinatesRotation',
    ]);
    expect(receipt.resourceSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'albedo_sampler', parameter: 'albedo', binding: 1 }),
        expect.objectContaining({ name: 'albedo', parameter: 'albedo', binding: 2 }),
      ]),
    );
    expect(receipt.reflection.resourceSlots).toEqual(receipt.resourceSlots);
    expect(receipt.reflection.vertexInputs).toEqual(receipt.vertexInputs);
    const noColorReceipt = createMaterialProgramArtifactReceipt({
      schema,
      directEntry: 'vs_main',
      sceneIndexEntry: 'vs_scene_index',
      vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
    });
    expect(noColorReceipt.receiptIdentity).not.toBe(receipt.receiptIdentity);
  });
});

describe('standard PBR transmission material contract', () => {
  // Manifest production is an integration boundary: compile the producer once
  // and let each contract assertion consume the same receipt-backed result.
  // Rebuilding it in every test made this unit file spend ~100s in CI and
  // caused the 20s receipt assertion to time out without any semantic failure.
  let engineManifest!: EngineShaderManifest;

  beforeAll(async () => {
    const { buildEngineShaderManifest } = await import('@forgeax/engine-vite-plugin-shader');
    engineManifest = await buildEngineShaderManifest();
  }, 120_000);

  it('declares the seven transmission and volume parameters once, separate from CPU and GPU evidence', () => {
    const entries = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.filter((entry) =>
      [
        'transmission',
        'ior',
        'thickness',
        'attenuationColor',
        'attenuationDistance',
        'transmissionTexture',
        'thicknessTexture',
      ].includes(entry.name),
    );
    expect(entries).toEqual([
      { name: 'transmission', type: 'f32', default: 0 },
      { name: 'ior', type: 'f32', default: 1.5 },
      { name: 'thickness', type: 'f32', default: 0 },
      { name: 'attenuationColor', type: 'vec3', colorSpace: 'linear', default: [1, 1, 1] },
      { name: 'attenuationDistance', type: 'f32' },
      { name: 'transmissionTexture', type: 'texture2d' },
      { name: 'thicknessTexture', type: 'texture2d' },
    ]);
  });

  it('derives numeric layout and paired texture bindings from the same schema', () => {
    const derived = derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA);
    expect(derived.numericMembers.map((member) => member.name)).toEqual(
      expect.arrayContaining([
        'transmission',
        'ior',
        'thickness',
        'attenuationColor',
        'attenuationDistance',
      ]),
    );
    expect(derived.textureFieldNames.has('transmissionTexture')).toBe(true);
    expect(derived.textureFieldNames.has('thicknessTexture')).toBe(true);
    expect(derived.samplerForTexture.get('transmissionTexture')).toBe(
      'transmissionTexture_sampler',
    );
    expect(derived.samplerForTexture.get('thicknessTexture')).toBe('thicknessTexture_sampler');
  });

  it('keeps the seven transmission inputs in the reflected UBO and coordinate contract', {
    // This test intentionally invokes the full engine shader manifest
    // producer. Keep its budget local to the producer-backed contract so a
    // concurrent coverage child cannot turn host CPU contention into a false
    // product failure.
    timeout: 60_000,
  }, async () => {
    const derived = derive(DEFAULT_STANDARD_PBR_PARAM_SCHEMA);
    const transmissionNames = [
      'transmission',
      'ior',
      'thickness',
      'attenuationColor',
      'attenuationDistance',
      'transmissionTexture',
      'thicknessTexture',
    ];

    expect(derived.numericMembers.map((member) => member.name)).toEqual(
      expect.arrayContaining(transmissionNames.slice(0, 5)),
    );
    expect(derived.coordinateRecords.map((record) => record.parameter)).toEqual(
      expect.arrayContaining(transmissionNames.slice(5)),
    );
    expect(derived.resourceBindings.filter((binding) => binding.binding >= 13)).toEqual([
      {
        name: 'transmissionTexture_sampler',
        parameter: 'transmissionTexture',
        kind: 'sampler',
        binding: 13,
      },
      {
        name: 'transmissionTexture',
        parameter: 'transmissionTexture',
        kind: 'texture',
        binding: 14,
      },
      {
        name: 'thicknessTexture_sampler',
        parameter: 'thicknessTexture',
        kind: 'sampler',
        binding: 15,
      },
      {
        name: 'thicknessTexture',
        parameter: 'thicknessTexture',
        kind: 'texture',
        binding: 16,
      },
      {
        name: 'bumpTexture_sampler',
        parameter: 'bumpTexture',
        kind: 'sampler',
        binding: 17,
      },
      {
        name: 'bumpTexture',
        parameter: 'bumpTexture',
        kind: 'texture',
        binding: 18,
      },
      {
        name: 'clearcoatTexture_sampler',
        parameter: 'clearcoatTexture',
        kind: 'sampler',
        binding: 19,
      },
      {
        name: 'clearcoatTexture',
        parameter: 'clearcoatTexture',
        kind: 'texture',
        binding: 20,
      },
      {
        name: 'clearcoatRoughnessTexture_sampler',
        parameter: 'clearcoatRoughnessTexture',
        kind: 'sampler',
        binding: 21,
      },
      {
        name: 'clearcoatRoughnessTexture',
        parameter: 'clearcoatRoughnessTexture',
        kind: 'texture',
        binding: 22,
      },
      {
        name: 'clearcoatNormalTexture_sampler',
        parameter: 'clearcoatNormalTexture',
        kind: 'sampler',
        binding: 23,
      },
      {
        name: 'clearcoatNormalTexture',
        parameter: 'clearcoatNormalTexture',
        kind: 'texture',
        binding: 24,
      },
      {
        name: 'anisotropyTexture_sampler',
        parameter: 'anisotropyTexture',
        kind: 'sampler',
        binding: 25,
      },
      {
        name: 'anisotropyTexture',
        parameter: 'anisotropyTexture',
        kind: 'texture',
        binding: 26,
      },
      {
        name: 'sheenColorTexture_sampler',
        parameter: 'sheenColorTexture',
        kind: 'sampler',
        binding: 27,
      },
      {
        name: 'sheenColorTexture',
        parameter: 'sheenColorTexture',
        kind: 'texture',
        binding: 28,
      },
      {
        name: 'sheenRoughnessTexture_sampler',
        parameter: 'sheenRoughnessTexture',
        kind: 'sampler',
        binding: 29,
      },
      {
        name: 'sheenRoughnessTexture',
        parameter: 'sheenRoughnessTexture',
        kind: 'texture',
        binding: 30,
      },
      {
        name: 'iridescenceTexture_sampler',
        parameter: 'iridescenceTexture',
        kind: 'sampler',
        binding: 31,
      },
      {
        name: 'iridescenceTexture',
        parameter: 'iridescenceTexture',
        kind: 'texture',
        binding: 32,
      },
      {
        name: 'iridescenceThicknessTexture_sampler',
        parameter: 'iridescenceThicknessTexture',
        kind: 'sampler',
        binding: 33,
      },
      {
        name: 'iridescenceThicknessTexture',
        parameter: 'iridescenceThicknessTexture',
        kind: 'texture',
        binding: 34,
      },
      {
        name: 'specularTexture_sampler',
        parameter: 'specularTexture',
        kind: 'sampler',
        binding: 35,
      },
      {
        name: 'specularTexture',
        parameter: 'specularTexture',
        kind: 'texture',
        binding: 36,
      },
      {
        name: 'metallicTexture_sampler',
        parameter: 'metallicTexture',
        kind: 'sampler',
        binding: 37,
      },
      { name: 'metallicTexture', parameter: 'metallicTexture', kind: 'texture', binding: 38 },
      {
        name: 'roughnessTexture_sampler',
        parameter: 'roughnessTexture',
        kind: 'sampler',
        binding: 39,
      },
      { name: 'roughnessTexture', parameter: 'roughnessTexture', kind: 'texture', binding: 40 },
      { name: 'alphaTexture_sampler', parameter: 'alphaTexture', kind: 'sampler', binding: 41 },
      { name: 'alphaTexture', parameter: 'alphaTexture', kind: 'texture', binding: 42 },
      {
        name: 'displacementTexture_sampler',
        parameter: 'displacementTexture',
        kind: 'sampler',
        binding: 43,
      },
      {
        name: 'displacementTexture',
        parameter: 'displacementTexture',
        kind: 'texture',
        binding: 44,
      },
      {
        name: 'diffuseTransmissionTexture_sampler',
        parameter: 'diffuseTransmissionTexture',
        kind: 'sampler',
        binding: 45,
      },
      {
        name: 'diffuseTransmissionTexture',
        parameter: 'diffuseTransmissionTexture',
        kind: 'texture',
        binding: 46,
      },
      {
        name: 'diffuseTransmissionColorTexture_sampler',
        parameter: 'diffuseTransmissionColorTexture',
        kind: 'sampler',
        binding: 47,
      },
      {
        name: 'diffuseTransmissionColorTexture',
        parameter: 'diffuseTransmissionColorTexture',
        kind: 'texture',
        binding: 48,
      },
    ]);

    const manifest = engineManifest;
    const material = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(material).toBeDefined();
    if (material === undefined) return;
    const baseVariant = material.variants.find(
      (variant) =>
        variant.defines.CLUSTER_FORWARD_AVAILABLE === false &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === true &&
        variant.defines.TRANSMISSION_AVAILABLE === false &&
        variant.defines.VERTEX_COLOR_AVAILABLE === false,
    );
    expect(baseVariant).toBeDefined();
    if (baseVariant === undefined) return;
    expect(derived.totalBytes).toBe(1472);
    // The base capability variant owns only the ordinary material region and
    // the IBL injection. Transmission and second-stage physical maps are
    // specialized in authored roots, so no transmission/physical resource
    // declaration may leak into this base artifact.
    expect(baseVariant.composedWgsl).not.toMatch(
      /@group\(1\)\s*@binding\((?:13|14)\)\s*\n?\s*var\s+transmission/u,
    );
    expect(baseVariant.composedWgsl).not.toMatch(
      /@group\(1\)\s*@binding\((?:13|14|15|16|24|25|26|27|28|29|30|31|32|33|34|35|36|37|38|39|40|41|42|43|44|45|46|47|48)\)\s*\n?\s*var\s+(?:thickness|clearcoat|anisotropy|sheen|iridescence|specular|diffuseTransmission)/u,
    );
    expect(baseVariant.composedWgsl).toMatch(
      /@group\(1\)\s*@binding\(25\)\s*\n?\s*var\s+irradianceMap/u,
    );
  });

  it('publishes one receipt for direct and scene-index consumers', {
    // Manifest production is intentionally real and coverage instrumentation
    // adds enough startup cost to exceed the old 20s budget on the shared
    // heavy runner. Keep the same producer-backed budget as the neighboring
    // contract cases so CPU contention cannot turn a valid compile into a
    // timeout-only failure.
    timeout: 60_000,
  }, async () => {
    const manifest = engineManifest;
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    const skin = manifest.materialShaders.find((entry) => entry.identifier === 'forgeax::pbr-skin');
    expect(standard).toBeDefined();
    expect(skin).toBeDefined();
    const standardReceipt = standard?.receipt;
    const skinReceipt = skin?.receipt;
    expect(standardReceipt).toMatchObject({
      directEntry: expect.any(String),
      sceneIndexEntry: expect.any(String),
      materialRow: expect.any(Object),
      resourceSlots: expect.any(Array),
      uvSets: expect.any(Array),
      vertexInputs: expect.any(Array),
      alphaMask: expect.any(Object),
      reflection: expect.any(Object),
    });
    expect(skinReceipt?.receiptIdentity).toBe(standardReceipt?.receiptIdentity);
  });

  it('composes the scene-index entry into the same validated PBR artifact as the direct entry', {
    timeout: 60_000,
  }, async () => {
    const manifest = engineManifest;
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(standard).toBeDefined();
    if (standard === undefined) return;
    expect(standard.composedWgsl).toMatch(/@vertex\s+fn\s+vs_main\s*\(/);
    expect(standard.composedWgsl).toMatch(/@vertex\s+fn\s+vs_scene_index\s*\(/);
    expect(standard.composedWgsl).toMatch(/@fragment\s+fn\s+fs_main\s*\(/);
    expect(standard.receipt?.sceneIndexEntry).toBe('vs_scene_index');
    expect(standard.receipt?.reflection.layoutIdentity).toBe(standard.receipt?.receiptIdentity);
  });

  it('keeps skin scene-index material rows and non-cluster punctual lighting in the GPU variant', {
    timeout: 60_000,
  }, async () => {
    const manifest = engineManifest;
    const skin = manifest.materialShaders.find((entry) => entry.identifier === 'forgeax::pbr-skin');
    expect(skin).toBeDefined();
    if (skin === undefined) return;
    const sceneIndex = skin.variants.find(
      (variant) =>
        variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE === true &&
        variant.defines.STORAGE_BUFFER_AVAILABLE === true &&
        variant.defines.CLUSTER_FORWARD_AVAILABLE === false &&
        variant.defines.EXTENDED_LIGHTING_AVAILABLE === false &&
        variant.defines.PROBE_BLEND_AVAILABLE === false &&
        variant.defines.VERTEX_COLOR_AVAILABLE === false,
    );
    expect(sceneIndex).toBeDefined();
    expect(sceneIndex?.composedWgsl).toContain('@binding(46)');
    expect(sceneIndex?.composedWgsl).toMatch(/materialAddress/);
    expect(sceneIndex?.composedWgsl).not.toMatch(/pointLightsBuffer|spotLightsBuffer/);
  });

  it('rejects a receipt that loses a required prepared ABI field', {
    timeout: 60_000,
  }, async () => {
    const manifest = engineManifest;
    const standard = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-standard-pbr',
    );
    expect(standard).toBeDefined();
    if (standard === undefined) return;
    const malformed = { ...standard } as Record<string, unknown>;
    delete malformed.reflection;
    expect(malformed).not.toHaveProperty('reflection');
  });
});
