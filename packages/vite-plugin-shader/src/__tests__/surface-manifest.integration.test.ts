import {
  type ExpandedShaderManifest,
  expandShaderManifestPublication,
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
} from '@forgeax/engine-shader';
import { compileShader, MATERIAL_WGSL_PROFILE } from '@forgeax/engine-shader-compiler';
import { describe, expect, it } from 'vitest';
import {
  extractDefineImportPath,
  loadEngineShaderEntries,
  projectSurfaceSlotSource,
  SURFACE_SLOT_MODULE,
} from '../engine-inputs/load-engine-shader-entries.js';
import { publishShaderManifest } from '../manifest-publication.js';

describe('Surface manifest engine inputs', () => {
  it('publishes Standard and Surface modules through the engine input owner', async () => {
    const entries = await loadEngineShaderEntries();
    const ids = [
      entries.defaultStandardPbr.reservedIdentifier,
      entries.defaultStandardPbrSkin.reservedIdentifier,
    ];
    expect(ids).toEqual(['forgeax::default-standard-pbr', 'forgeax::pbr-skin']);
    expect(entries.singleLayerMedium.reservedIdentifier).toBe('forgeax::single-layer-medium');
    expect(entries.singleLayerMedium.source).toContain('SingleLayerMediumSurfaceData');
    expect(extractDefineImportPath(entries.defaultStandardPbr.source)).toBe(
      'forgeax_material::standard',
    );
    expect(entries.imports['forgeax_material::surface_v1']).toContain('SurfaceInput');
    expect(entries.imports['forgeax_material::default_standard_surface']).toContain(
      'standard_surface',
    );
    expect(entries.imports['forgeax_material::surface_v1']).toContain('alphaClipThreshold');
    expect(entries.imports['forgeax_material::surface_v1']).not.toContain('clearcoat');
    const defaultSurface = entries.imports['forgeax_material::default_standard_surface'];
    expect(defaultSurface).toBeDefined();
    if (defaultSurface === undefined) return;
    expect(entries.imports[SURFACE_SLOT_MODULE]).toBe(projectSurfaceSlotSource(defaultSurface));
  });

  it('keeps one published material input per Standard template', async () => {
    const entries = await loadEngineShaderEntries();
    const materialEntries = [entries.defaultStandardPbr, entries.defaultStandardPbrSkin];
    expect(new Set(materialEntries.map((entry) => entry.reservedIdentifier)).size).toBe(
      materialEntries.length,
    );
    expect(materialEntries.every((entry) => entry.source.includes('material_slot surface'))).toBe(
      true,
    );
  });

  // A cold full engine-source manifest compiles every material permutation and can exceed Vitest's 300 s default.
  it('builds the complete source manifest with Cluster ABI and resampling publication', async () => {
    const previousSource = process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
    const previousShared = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = '1';
    delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    try {
      const { buildEngineShaderManifest } = await import('../index.js');
      const manifest = await buildEngineShaderManifest();
      const clusterMaterial = manifest.materialShaders.find(
        (candidate) => candidate.identifier === 'forgeax::default-standard-pbr',
      );
      const clusterVariant = clusterMaterial?.variants.find(
        (variant) =>
          variant.defines.CLUSTER_FORWARD_AVAILABLE === true &&
          variant.defines.STORAGE_BUFFER_AVAILABLE === true,
      );
      expect(
        clusterVariant,
        'publishes the storage-backed Standard Cluster material variant',
      ).toBeDefined();
      const clusterGlobals = clusterVariant?.reflection?.boundGlobals ?? [];
      const lightData = clusterGlobals.find((global) => global.group === 2 && global.binding === 3);
      expect(lightData).toMatchObject({
        resourceKind: 'storage-buffer',
        addressSpace: 'storage',
        elementStride: 96,
        span: 96,
      });
      expect(lightData?.members?.map(({ name, offset, type }) => ({ name, offset, type }))).toEqual(
        [
          { name: 'position', offset: 0, type: 'vec4<f32>' },
          { name: 'colorTimesIntensity', offset: 16, type: 'vec4<f32>' },
          { name: 'direction', offset: 32, type: 'vec4<f32>' },
          { name: 'auxiliary', offset: 48, type: 'vec4<f32>' },
          { name: 'metadata', offset: 64, type: 'vec4<u32>' },
          { name: 'channels', offset: 80, type: 'vec4<u32>' },
        ],
      );
      const clusterUniform = clusterGlobals.find(
        (global) => global.group === 2 && global.binding === 6,
      );
      expect(clusterUniform?.group).toBe(2);
      expect(clusterUniform?.binding).toBe(6);
      expect(clusterUniform?.span).toBe(96);
      expect(
        clusterUniform?.members?.map(({ name, offset, type }) => ({ name, offset, type })),
      ).toEqual([
        { name: 'grid', offset: 0, type: 'vec4<u32>' },
        { name: 'near_far_log', offset: 16, type: 'vec4<f32>' },
        { name: 'ao', offset: 32, type: 'vec4<u32>' },
        { name: 'direct_ao', offset: 48, type: 'vec4<f32>' },
        { name: 'texture', offset: 64, type: 'vec4<u32>' },
        { name: 'cluster_layout', offset: 80, type: 'vec4<u32>' },
      ]);
      expect(clusterVariant?.hash).toMatch(/^[a-f0-9]{8}$/);
      expect(clusterVariant?.compilerProfile).toMatchObject({
        id: 'forgeax-material-wgsl-v1',
        compilerVersion: MATERIAL_WGSL_PROFILE.compilerVersion,
        nagaVersion: MATERIAL_WGSL_PROFILE.nagaVersion,
      });
      const publication = publishShaderManifest(manifest.entries, manifest.materialShaders);
      const expanded = expandShaderManifestPublication(publication)
        .manifest as ExpandedShaderManifest;
      const publishedClusterVariant = expanded.materialShaders
        .find((candidate) => candidate.identifier === 'forgeax::default-standard-pbr')
        ?.variants.find(
          (variant) =>
            variant.hash === clusterVariant?.hash &&
            JSON.stringify(variant.defines) === JSON.stringify(clusterVariant?.defines),
        );
      expect(publishedClusterVariant?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      const expandedClusterVariant = expanded.materialShaders
        .find((candidate) => candidate.identifier === 'forgeax::default-standard-pbr')
        ?.variants.find(
          (variant) =>
            variant.hash === clusterVariant?.hash &&
            JSON.stringify(variant.defines) === JSON.stringify(clusterVariant?.defines),
        );
      expect(expandedClusterVariant).toBeDefined();
      expect(expandedClusterVariant?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(expandedClusterVariant?.hash).toMatch(/^[a-f0-9]{8}$/);
      expect(expandedClusterVariant?.hash).toBe(clusterVariant?.hash);
      expect(expandedClusterVariant?.compilerProfile).toMatchObject({
        id: 'forgeax-material-wgsl-v1',
        compilerVersion: MATERIAL_WGSL_PROFILE.compilerVersion,
        nagaVersion: MATERIAL_WGSL_PROFILE.nagaVersion,
      });
      expect(expandedClusterVariant?.reflection).toEqual(clusterVariant?.reflection);
      for (const [identifier, stage, expectedNames, expectedBindings] of [
        [
          LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
          'compute',
          ['light_texture_resample', 'light_texture_reduce'],
          [0, 1, 2, 3],
        ],
        [
          LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
          'fragment',
          ['light_texture_fullscreen', 'light_texture_resample_fragment'],
          [0, 1, 2],
        ],
      ] as const) {
        const entry = manifest.entries.find((candidate) =>
          expectedNames.every((name) =>
            candidate.entryPoints?.some((point) => point.name === name),
          ),
        );
        expect(entry, identifier).toBeDefined();
        if (entry === undefined) continue;

        const publishedPoints = entry.reflection?.entryPoints ?? entry.entryPoints ?? [];
        for (const name of expectedNames) {
          expect(
            publishedPoints.some(
              (point) =>
                point.name === name &&
                point.stage === (name === 'light_texture_fullscreen' ? 'vertex' : stage),
            ),
            `${identifier} publishes ${name}`,
          ).toBe(true);
        }
        expect(entry.hash).toMatch(/^[a-f0-9]{8}$/);
        expect(entry.compilerProfile).toMatchObject({
          id: 'forgeax-material-wgsl-v1',
          compilerVersion: MATERIAL_WGSL_PROFILE.compilerVersion,
          nagaVersion: MATERIAL_WGSL_PROFILE.nagaVersion,
        });
        expect(entry.reflection?.boundGlobals.map((binding) => binding.binding)).toEqual(
          expectedBindings,
        );
        expect(JSON.parse(entry.bindings)).toHaveLength(1);
        expect(entry.wgsl).toMatch(/fn reconstructPixel(?:X_naga_oil_mod_[A-Z0-9]+)?\(/);
        expect(entry.wgsl).toMatch(/fn reducePixel(?:FromBuffer)?(?:X_naga_oil_mod_[A-Z0-9]+)?\(/);
        expect(entry.wgsl).not.toContain('#import');
        if (stage === 'compute') {
          expect(entry.wgsl).toContain('fn light_texture_resample(');
          expect(entry.wgsl).toContain('fn light_texture_reduce(');
        } else {
          expect(entry.wgsl).toContain('fn light_texture_fullscreen(');
          expect(entry.wgsl).toContain('fn light_texture_resample_fragment(');
        }
      }
      const expandedResamplingEntries = expanded.entries.filter((candidate) =>
        candidate.entryPoints?.some((point) => point.name.startsWith('light_texture_')),
      );
      expect(expandedResamplingEntries).toHaveLength(2);
      for (const entry of expandedResamplingEntries) {
        expect(entry.hash).toMatch(/^[a-f0-9]{8}$/);
        expect(entry.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(entry.compilerProfile?.id).toBe('forgeax-material-wgsl-v1');
        expect(entry.reflection?.boundGlobals.length).toBeGreaterThan(0);
      }
    } finally {
      if (previousSource === undefined) delete process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
      else process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = previousSource;
      if (previousShared === undefined) delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
      else process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = previousShared;
    }
  }, 900_000);

  it('publishes independent reflected compute and fragment resampling entries', async () => {
    const entries = await loadEngineShaderEntries();
    const kernelId = 'forgeax_lighting::light_texture_resample_kernel';
    const kernel = entries.imports[kernelId];
    expect(kernel).toContain('struct ResampleParams');

    const compiledEntries = [];
    for (const file of [
      entries.lightTextureResampleCompute,
      entries.lightTextureResampleFragment,
    ]) {
      const compiled = await compileShader(file.source, {
        id: file.id,
        imports: { [kernelId]: kernel },
      });
      if (!compiled.ok) {
        throw new Error(
          `${file.id}: ${compiled.error.message} ${JSON.stringify(compiled.error.detail)}`,
        );
      }
      compiledEntries.push({
        ...compiled.value.manifestEntry,
        reflection: compiled.value.reflection,
        compilerProfile: MATERIAL_WGSL_PROFILE,
        identifier: file.reservedIdentifier,
        defines: {},
        programContract: file.programContract,
      });
    }

    const publication = publishShaderManifest(compiledEntries, []);
    const expanded = expandShaderManifestPublication(publication)
      .manifest as ExpandedShaderManifest;
    expect(expanded.entries).toHaveLength(2);
    for (const entry of expanded.entries) {
      expect(entry.hash).toMatch(/^[a-f0-9]{8}$/);
      expect(entry.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      expect([
        LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
        LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
      ]).toContain(entry.identifier);
      expect(entry.defines).toEqual({});
      expect(entry.compilerProfile).toMatchObject({
        id: 'forgeax-material-wgsl-v1',
        compilerVersion: MATERIAL_WGSL_PROFILE.compilerVersion,
        nagaVersion: MATERIAL_WGSL_PROFILE.nagaVersion,
      });
      expect(entry.reflection?.boundGlobals.length).toBeGreaterThan(0);
      expect(entry.programContract).toMatchObject({
        publicationFormat: 'rgba8unorm',
        numerical: {
          intermediatePrecision: 'f32',
          outputRange: [0, 1],
          reduction: 'box2x2-mean',
          mipLevelCount: 9,
          quantization: 'unorm8',
        },
      });
      expect(entry.entryPoints?.length).toBeGreaterThan(0);
      expect(entry.wgsl).not.toContain('#import');
      expect(entry.wgsl).toMatch(/fn reconstructPixel(?:X_naga_oil_mod_[A-Z0-9]+)?\(/);
      expect(entry.wgsl).toMatch(/fn reducePixel(?:FromBuffer)?(?:X_naga_oil_mod_[A-Z0-9]+)?\(/);
    }
    expect(
      expanded.entries.flatMap((entry) => entry.entryPoints?.map(({ name }) => name) ?? []),
    ).toEqual(
      expect.arrayContaining([
        'light_texture_resample',
        'light_texture_reduce',
        'light_texture_fullscreen',
        'light_texture_resample_fragment',
      ]),
    );
    const computeEntries = expanded.entries.filter(
      (entry) =>
        entry.identifier === LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER &&
        entry.entryPoints?.some(
          ({ name, stage }) => name === 'light_texture_resample' && stage === 'compute',
        ),
    );
    expect(computeEntries).toHaveLength(1);
    expect(computeEntries[0]?.programContract?.colorTargets).toEqual([]);

    const fragmentEntries = expanded.entries.filter(
      (entry) =>
        entry.identifier === LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER &&
        entry.entryPoints?.some(
          ({ name, stage }) => name === 'light_texture_resample_fragment' && stage === 'fragment',
        ),
    );
    expect(fragmentEntries).toHaveLength(1);
    expect(fragmentEntries[0]?.programContract?.colorTargets).toEqual([
      { location: 0, format: 'rgba32float', numericType: 'float' },
      { location: 1, format: 'rgba8unorm', numericType: 'float' },
    ]);
  });
});
