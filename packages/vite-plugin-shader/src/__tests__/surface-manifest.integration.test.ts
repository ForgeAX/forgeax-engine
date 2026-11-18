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

  // The complete cold source/Cluster/DFG contract is owned by direct-dfg-manifest.integration.test.ts.

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
