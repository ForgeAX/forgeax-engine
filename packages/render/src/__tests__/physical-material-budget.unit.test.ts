import {
  ShaderRegistry,
  STANDARD_PIPELINE_PARAM_SCHEMA,
  standardTextureMask,
} from '@forgeax/engine-shader';
import { derive, STANDARD_MATERIAL_PARAM_SCHEMA } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { STANDARD_PHYSICAL_REQUIRED_SAMPLED_TEXTURES } from '../assembly/device-feature-admission';
import { Materials } from '../materials';
import {
  buildBindGroupLayoutDescriptor,
  buildPbrViewBglEntries,
  omittedStandardMaterialBindings,
  standardNormalInputField,
} from '../pbr-pipeline';
import type { PipelineSpec } from '../pipeline-spec';

it('fits the cooked physical carrier, extended view and clustered SSAO in the device budget', () => {
  const textureFields = new Set([
    'baseColorTexture',
    'metallicRoughnessTexture',
    'normalTexture',
    'emissiveTexture',
    'occlusionTexture',
    'clearcoatTexture',
    'clearcoatRoughnessTexture',
    'clearcoatNormalTexture',
    'transmissionTexture',
    'thicknessTexture',
  ]);
  const spec: PipelineSpec = {
    shader: { id: 'sha256:physical-carrier', passKind: 'forward', variantSet: undefined },
    attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
    geometry: { topology: 'triangle-list', vertexLayout: {} },
    renderState: undefined,
  };
  const schema = STANDARD_MATERIAL_PARAM_SCHEMA.filter(
    (field) => field.type !== 'texture2d' || textureFields.has(field.name),
  );
  const registry = new ShaderRegistry({ manifestUrl: undefined });
  registry.installMaterialArtifact(spec.shader.id, {
    // Captured cooked ABI: backdrop22 shares prefilterSampler18; sampler21 is absent.
    source:
      '@group(1) @binding(18) var shared: sampler; @group(1) @binding(22) var backdrop: texture_2d<f32>;',
    paramSchema: schema,
  });
  const caps = { storageBuffer: true, extendedLighting: true, transmissionBackdrop: true };
  const entries = [
    ...buildPbrViewBglEntries(caps),
    ...buildBindGroupLayoutDescriptor(spec, {
      kind: 'pbr-material-merged',
      registry,
      caps,
    }).entries,
    ...buildBindGroupLayoutDescriptor(spec, { kind: 'hdrp-7-slot', caps }).entries,
  ].filter((entry) => (entry.visibility & 2) !== 0);
  expect(entries.filter((entry) => entry.sampler !== undefined).length).toBeLessThanOrEqual(16);
  expect(entries.filter((entry) => entry.texture !== undefined).length).toBeLessThanOrEqual(
    STANDARD_PHYSICAL_REQUIRED_SAMPLED_TEXTURES,
  );
});

it.each([
  [16, false, false],
  [21, false, true],
  [25, true, true],
] as const)('fits independent maps and clustered SSAO in the %i-texture profile', (limit, extendedLighting, transmissionBackdrop) => {
  const caps = {
    storageBuffer: true,
    extendedLighting,
    transmissionBackdrop,
    projectorAvailable: transmissionBackdrop,
  };
  const spec: PipelineSpec = {
    shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
    attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
    geometry: { topology: 'triangle-list', vertexLayout: {} },
    renderState: undefined,
  };
  const materialEntries = buildBindGroupLayoutDescriptor(spec, {
    kind: 'pbr-material-merged',
    caps,
  }).entries;
  const entries = [
    ...buildPbrViewBglEntries(caps),
    ...materialEntries,
    ...buildBindGroupLayoutDescriptor(spec, { kind: 'hdrp-7-slot', caps }).entries,
  ].filter((entry) => (entry.visibility & 2) !== 0);
  expect(entries.filter((entry) => entry.texture !== undefined).length).toBeLessThanOrEqual(limit);
  expect(entries.filter((entry) => entry.sampler !== undefined).length).toBeLessThanOrEqual(16);
  // Removing unavailable transmission maps must never renumber the new maps or IBL.
  const fullEntries = buildBindGroupLayoutDescriptor(spec, {
    kind: 'pbr-material-merged',
    materialParamSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
  }).entries;
  const backdropTextureBinding = derive(STANDARD_PIPELINE_PARAM_SCHEMA).userRegionBindingEnd + 7;
  expect(materialEntries).toEqual(
    fullEntries.filter(
      (entry) =>
        transmissionBackdrop || ![11, 12, 13, 14, backdropTextureBinding].includes(entry.binding),
    ),
  );
});

it('fits the complete integer Cluster transport and Standard maps in WebGL2 sixteen textures', () => {
  const caps = {
    storageBuffer: false,
    extendedLighting: false,
    transmissionBackdrop: false,
    projectorAvailable: false,
  };
  const spec: PipelineSpec = {
    shader: { id: 'forgeax::default-standard-pbr', passKind: 'forward', variantSet: undefined },
    attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
    geometry: { topology: 'triangle-list', vertexLayout: {} },
    renderState: undefined,
  };
  const cluster = buildBindGroupLayoutDescriptor(spec, { kind: 'hdrp-7-slot', caps }).entries;
  expect(cluster.find((entry) => entry.binding === 3)?.texture?.sampleType).toBe('uint');
  expect(cluster.map((entry) => entry.binding)).toEqual([0, 3, 6]);
  const entries = [
    ...buildPbrViewBglEntries(caps),
    ...buildBindGroupLayoutDescriptor(spec, { kind: 'pbr-material-merged', caps }).entries,
    ...cluster,
  ];
  // GLES allocates one texture-slot namespace across both shader stages.
  expect(entries.filter((entry) => entry.texture !== undefined)).toHaveLength(16);
  expect(
    entries.filter((entry) => entry.texture !== undefined && entry.visibility === 1),
  ).toHaveLength(1);
  expect(buildPbrViewBglEntries(caps).some((entry) => [5, 6].includes(entry.binding))).toBe(false);
});

it('keeps texture bindings owned by non-Standard shaders even when their names match', () => {
  expect([
    ...omittedStandardMaterialBindings(['transmissionTexture', 'thicknessTexture'], false, false),
  ]).toEqual([]);
});

it('follows actual cooked backdrop binding declarations independently of program names', () => {
  const fields = [
    'baseColorTexture',
    'metallicRoughnessTexture',
    'normalTexture',
    'emissiveTexture',
    'occlusionTexture',
    'transmissionTexture',
    'thicknessTexture',
  ];
  expect([...omittedStandardMaterialBindings(fields, true, false, false, [18, 22])]).toEqual([21]);
  expect([...omittedStandardMaterialBindings(fields, true, false, false, [18, 21, 22])]).toEqual(
    [],
  );
});

it('fits authored independent maps with clearcoat in the physical device budget', () => {
  const material = Materials.standard({
    staticSwitches: { clearcoat: true },
    baseColor: [1, 1, 1, 1],
    metallicTexture: 1,
    roughnessTexture: 2,
    alphaTexture: 3,
    clearcoat: 1,
    clearcoatTexture: 4,
  });
  const names = new Set(material.parameters?.map((parameter) => parameter.name));
  const schema = STANDARD_MATERIAL_PARAM_SCHEMA.filter((field) => names.has(field.name));
  const spec: PipelineSpec = {
    shader: { id: 'budget::standard-physical', passKind: 'forward', variantSet: undefined },
    attachments: { colorFormats: [], depthFormat: undefined, sampleCount: 1 },
    geometry: { topology: 'triangle-list', vertexLayout: {} },
    renderState: undefined,
  };
  const caps = { storageBuffer: true, extendedLighting: true, transmissionBackdrop: true };
  const entries = [
    ...buildPbrViewBglEntries(caps),
    ...buildBindGroupLayoutDescriptor(spec, {
      kind: 'pbr-material-merged',
      materialParamSchema: schema,
      caps,
    }).entries,
    ...buildBindGroupLayoutDescriptor(spec, { kind: 'hdrp-7-slot', caps }).entries,
  ].filter((entry) => (entry.visibility & 2) !== 0);
  expect(schema.filter((field) => field.type === 'texture2d').map((field) => field.name)).toEqual(
    expect.arrayContaining([
      'metallicTexture',
      'roughnessTexture',
      'alphaTexture',
      'clearcoatTexture',
    ]),
  );
  expect(entries.filter((entry) => entry.sampler !== undefined).length).toBeLessThanOrEqual(16);
  expect(entries.filter((entry) => entry.texture !== undefined).length).toBeLessThanOrEqual(
    STANDARD_PHYSICAL_REQUIRED_SAMPLED_TEXTURES,
  );
});

it('selects the shared normal input from authored presence, with normal taking precedence', () => {
  const mask = (names: string[]) =>
    standardTextureMask(names.map((name) => ({ name, type: 'texture2d' as const })));
  expect(standardNormalInputField('normalTexture', mask(['bumpTexture']))).toBe('bumpTexture');
  expect(standardNormalInputField('normalTexture', mask(['normalTexture', 'bumpTexture']))).toBe(
    'normalTexture',
  );
  expect(standardNormalInputField('normalTexture', 0)).toBe('normalTexture');
  expect(standardNormalInputField('normalTexture', undefined)).toBe('normalTexture');
  expect(standardNormalInputField('baseColorTexture', mask(['bumpTexture']))).toBe(
    'baseColorTexture',
  );
});

it('keeps IBL intact when shared storage extends the material user region', () => {
  expect([
    ...omittedStandardMaterialBindings(
      ['height', 'weights', 'images'],
      false,
      true,
      false,
      undefined,
      8,
    ),
  ]).toEqual([14]);
});
