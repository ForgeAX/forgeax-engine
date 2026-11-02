import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
} from '@forgeax/engine-shader';
import { MATERIAL_WGSL_PROFILE } from '@forgeax/engine-shader-compiler';
import { describe, expect, it } from 'vitest';
import {
  extractDefineImportPath,
  loadEngineShaderEntries,
} from '../engine-inputs/load-engine-shader-entries.js';
import * as publicSurface from '../index.js';
import { buildEngineShaderManifest, VIEW_ABI } from '../index.js';
import { publishShaderManifest } from '../manifest-publication.js';

const reflection = {
  schemaVersion: 'shader-reflection/3' as const,
  uvSetCount: 0,
  boundGlobals: [],
};

const resamplingPrograms = [
  {
    identifier: LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
    entryPoints: [
      { name: 'light_texture_resample', stage: 'compute', bindings: [] },
      { name: 'light_texture_reduce', stage: 'compute', bindings: [] },
    ],
    programContract: { schemaVersion: 'shader-program-contract/1', colorTargets: [] },
  },
  {
    identifier: LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
    entryPoints: [
      { name: 'light_texture_fullscreen', stage: 'vertex', bindings: [] },
      { name: 'light_texture_resample_fragment', stage: 'fragment', bindings: [] },
    ],
    programContract: {
      schemaVersion: 'shader-program-contract/1',
      colorTargets: [
        { location: 0, format: 'rgba32float', numericType: 'float' },
        { location: 1, format: 'rgba8unorm', numericType: 'float' },
      ],
    },
  },
] as const;

const engineMaterialIdentifiers = [
  'forgeax::default-standard-pbr',
  'forgeax::pbr-skin',
  'forgeax::default-shadow-caster',
  'forgeax::default-unlit',
  ...resamplingPrograms.map(({ identifier }) => identifier),
];

const materialShaders = engineMaterialIdentifiers.map((identifier, index) => {
  const program = resamplingPrograms.find((candidate) => candidate.identifier === identifier);
  return {
    identifier,
    sourcePath: `${identifier}.wgsl`,
    hash: (index + 1).toString(16).padStart(8, '0'),
    compilerProfile: MATERIAL_WGSL_PROFILE,
    reflection,
    entryPoints: program?.entryPoints ?? [],
    composedWgsl: `// ${identifier}`,
    paramSchema: '[]',
    variants: [],
  };
});

const sharedEntry = {
  hash: 'a11ce001',
  wgsl: 'shared',
  bindings: '[]',
  compilerProfile: MATERIAL_WGSL_PROFILE,
  reflection,
};

const resamplingEntries = resamplingPrograms.map((program) => {
  const material = materialShaders.find((row) => row.identifier === program.identifier);
  if (material === undefined)
    throw new Error(`Missing synthetic material row: ${program.identifier}`);
  return {
    hash: material.hash,
    identifier: program.identifier,
    wgsl: material.composedWgsl,
    bindings: '[]',
    compilerProfile: material.compilerProfile,
    reflection: material.reflection,
    entryPoints: program.entryPoints,
    programContract: program.programContract,
  };
});

const sharedEntries = [sharedEntry, ...resamplingEntries];

describe('vite-plugin-shader public engine input surface', () => {
  it('keeps the plugin front door without a version mirror', () => {
    expect(typeof publicSurface.forgeaxShader).toBe('function');
    expect('VITE_PLUGIN_SHADER_PACKAGE_VERSION' in publicSurface).toBe(false);
  });

  it('publishes one typed View ABI without live GPU objects', () => {
    expect(VIEW_ABI.moduleId).toBe('forgeax_view::common');
    expect(VIEW_ABI.group).toBe(0);
    expect(VIEW_ABI.binding).toBe(0);
    expect(VIEW_ABI.byteLength).toBe(1280);
    expect(VIEW_ABI.fields.map((field) => field.name)).toEqual([
      'worldViewProj',
      'inverseViewProj',
      'spotLightViewProj',
      'temporalCurrentViewProj',
      'temporalPreviousViewProj',
      'temporalProjection',
      'temporalPreviousCameraPos',
      'ssrParams',
      'cloudShadowProjection',
      'clippingPlanes',
      'clippingControl',
      'fogColorDensity',
      'fogHeightOpacity',
      'atmosphere',
      'atmosphereControl',
    ]);
    expect(VIEW_ABI.fields.at(-1)).toEqual({
      name: 'atmosphereControl',
      offsetBytes: 1264,
      sizeBytes: 16,
    });
    expect(JSON.stringify(VIEW_ABI)).not.toMatch(/device|buffer|texture/i);
  });

  it('keeps engine entries and import-path extraction behind engine-inputs', async () => {
    expect(extractDefineImportPath('#define_import_path forgeax_view::common')).toBe(
      'forgeax_view::common',
    );
    const entries = await loadEngineShaderEntries();
    expect(entries.imports['forgeax_view::common']).toContain('struct View');
    expect(entries.imports['forgeax_pbr::lighting_probe']).toContain('evaluateProbeDiffuse');
    expect(entries.imports['forgeax_pbr::lighting_spot_projector']).toContain(
      'fn sampleStandardSpotProjector',
    );
    expect(entries.bloomHorizontal.source).toContain('bloom');
    expect(entries.bloomVertical.source).toContain('bloom');
    expect(entries.depthPyramidSeed.source).toContain(
      '#define_import_path forgeax_depth_pyramid::seed',
    );
    expect(entries.depthPyramidReduce.source).toContain(
      '#define_import_path forgeax_depth_pyramid::reduce',
    );
    expect(entries.ssrTrace.source).toContain('#define_import_path forgeax_ssr::trace');
    expect(entries.ssrTemporal.source).toContain('#define_import_path forgeax_ssr::temporal');
    expect(entries.ssrCompose.source).toContain('fn fs_ssr_compose(');
  });

  it('publishes the production GTAO compute adapter with its shared visibility function', async () => {
    const entries = await loadEngineShaderEntries();
    expect(entries.hdrpGtaoCompute.source).toContain('fn cs_gtao_calc(');
    expect(entries.imports['forgeax_hdrp::ssao']).toContain('fn gtaoRawVisibility(');

    const manifest = await buildEngineShaderManifest();
    const computeEntries = manifest.entries.filter((entry) =>
      entry.wgsl.includes('fn cs_gtao_calc('),
    );
    expect(computeEntries, 'runtime must receive the compiled GTAO compute module').toHaveLength(1);
    expect(
      manifest.materialShaders.some((shader) => shader.identifier.includes('gtao-compute')),
      'the compute adapter is a renderer utility, not a material shader',
    ).toBe(false);
  }, 300_000);

  it('publishes and compiles the scene-temporal import closure', async () => {
    const entries = await loadEngineShaderEntries();
    expect(entries.imports.forgeax_scene_temporal).toContain(
      '#define_import_path forgeax_scene_temporal',
    );
    const manifest = await buildEngineShaderManifest();
    const shadow = manifest.materialShaders.find(
      (entry) => entry.identifier === 'forgeax::default-shadow-caster',
    );
    expect(shadow, 'shadow Surface must compile with its texture-use helpers').toBeDefined();
    expect(shadow?.composedWgsl).toContain('fs_shadow');
    // Canonical shadow and color passes share the texture mask and normal/bump
    // binding pair; cooked material roots keep their exact sparse schema.
    expect(shadow?.composedWgsl).toContain('@id(64000)');
    expect(shadow?.composedWgsl).toMatch(/var\s+normalTexture(?:_\d+)?\s*:/);
    expect(shadow?.composedWgsl).not.toMatch(/var\s+bumpTexture(?:_\d+)?\s*:/);
    for (const identifier of [
      'forgeax::default-standard-pbr',
      'forgeax::pbr-skin',
      'forgeax::default-unlit',
    ]) {
      const shader = manifest.materialShaders.find((entry) => entry.identifier === identifier);
      expect(shader, `${identifier} must compile through the engine manifest`).toBeDefined();
      expect(shader?.composedWgsl).toContain('packSceneTemporalV1');
      if (identifier !== 'forgeax::default-unlit') {
        for (const variant of shader?.variants ?? []) {
          expect(variant.composedWgsl).toContain('@id(64000)');
          // Only the rigid Standard root owns the surface discard gates.
          expect(variant.composedWgsl.match(/@id\(64001\)/g)?.length ?? 0).toBe(
            identifier === 'forgeax::default-standard-pbr' ? 1 : 0,
          );
          for (const field of [
            'baseColor',
            'metallicRoughness',
            'normal',
            'emissive',
            'occlusion',
          ]) {
            expect(
              variant.composedWgsl,
              `${identifier} must retain declared ${field} sampling`,
            ).toMatch(new RegExp(`textureSample\\(\\s*${field}Texture(?:_\\d+)?\\s*,`));
          }
        }
      }
    }
    expect(
      manifest.entries.some((entry) => entry.wgsl.includes('SceneTemporalV1')),
      'the temporal utility closure must survive manifest compilation',
    ).toBe(true);
    for (const marker of [
      'depth_pyramid_seed',
      'depth_pyramid_reduce',
      'ssr_trace',
      'ssr_temporal',
    ]) {
      expect(
        manifest.entries.filter((entry) => entry.wgsl.includes(marker)),
        `${marker} must be published in the engine manifest`,
      ).toHaveLength(1);
    }
  }, 300_000);

  it.each([
    false,
    true,
  ])('retains SSAO in the standalone manifest: point=%s', async (pointShadows) => {
    const previousShared = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    const previousSource = process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
    delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
    delete process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
    try {
      const manifest = await buildEngineShaderManifest({ pointShadows });
      expect(
        manifest.entries.filter(
          (entry) => entry.wgsl.includes('fs_ssao_calc') && entry.wgsl.includes('fs_ssao_blur'),
        ),
        'default standalone manifests must support the runtime Standard SSAO switch',
      ).toHaveLength(1);
    } finally {
      if (previousShared === undefined) delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
      else process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = previousShared;
      if (previousSource === undefined) delete process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD;
      else process.env.FORGEAX_ENGINE_SHADER_SOURCE_BUILD = previousSource;
    }
  }, 300_000);

  it('routes point-shadow defines through the standalone manifest builder', async () => {
    // Inspect real admitted WGSL through the public route. The complete source
    // build belongs to core/shared producers; single-worker and packaged-builder
    // regressions retain real compilation and source fallback.
    const manifest = await buildEngineShaderManifest({ pointShadows: true });
    const skin = manifest.materialShaders.find((entry) => entry.identifier === 'forgeax::pbr-skin');
    expect(skin, 'the point-shadow manifest must compile the skinned Standard entry').toBeDefined();
    expect(
      skin?.variants.some((variant) => variant.composedWgsl.includes('evalPointShadowed')),
    ).toBe(true);
  }, 600_000);

  it('reuses a validated shared shader projection for the base manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-shared-shader-builder-'));
    const sharedRoot = join(root, 'shared-app-inputs');
    const manifestPath = join(sharedRoot, 'manifest.json');
    try {
      mkdirSync(join(sharedRoot, 'shaders'), { recursive: true });
      writeFileSync(
        manifestPath,
        JSON.stringify({
          schemaVersion: 2,
          producer: 'repo-build-inputs',
          inputFingerprint: 'test-fingerprint',
          inventory: ['shared-app-inputs/shaders/manifest.json'],
          payload: { engineShaderManifest: 'shared-app-inputs/shaders/manifest.json' },
        }),
      );
      writeFileSync(
        join(sharedRoot, 'shaders', 'manifest.json'),
        JSON.stringify(publishShaderManifest(sharedEntries, materialShaders)),
      );
      const previous = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
      process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = manifestPath;
      try {
        const manifest = await buildEngineShaderManifest();
        expect(manifest.schemaVersion).toBe('1.0.0');
        expect(manifest.entries).toEqual([
          {
            ...sharedEntry,
            glsl: '',
            sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
          ...resamplingEntries.map((entry) => ({
            ...entry,
            glsl: '',
            sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          })),
        ]);
        expect(manifest.materialShaders.map((entry) => entry.identifier)).toEqual([
          'forgeax::default-standard-pbr',
          'forgeax::pbr-skin',
          'forgeax::default-shadow-caster',
          'forgeax::default-unlit',
          LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
          LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
        ]);
        for (const entry of manifest.materialShaders) {
          expect(entry.hash).toMatch(/^[a-f0-9]{8}$/);
          expect(entry.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
          expect(entry.compilerProfile).toEqual(MATERIAL_WGSL_PROFILE);
          expect(entry.reflection).toEqual(reflection);
          for (const variant of entry.variants) {
            expect(variant.hash).toMatch(/^[a-f0-9]{8}$/);
            expect(variant.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
            expect(variant.compilerProfile).toEqual(MATERIAL_WGSL_PROFILE);
            expect(variant.reflection).toEqual(reflection);
          }
        }
        for (const program of resamplingPrograms) {
          const direct = manifest.entries.find((entry) => entry.identifier === program.identifier);
          const material = manifest.materialShaders.find(
            (entry) => entry.identifier === program.identifier,
          );
          expect(direct?.entryPoints).toEqual(program.entryPoints);
          expect(direct?.programContract).toEqual(program.programContract);
          expect(material?.entryPoints).toEqual(program.entryPoints);
        }
        const authored = await buildEngineShaderManifest({
          materialPackages: [
            resolve(import.meta.dirname, '../../../../apps/hello/ssr/src/ssr-reflection.pack.json'),
          ],
        });
        expect(authored.entries[0]).toEqual(manifest.entries[0]);
        expect(authored.entries).toHaveLength(manifest.entries.length + 1);
        const custom = authored.materialShaders.find(
          (entry) => entry.identifier === 'hello_ssr::reflection',
        );
        expect(custom?.composedWgsl).toContain('textureSample');
        expect(custom?.variants.length).toBeGreaterThan(0);
        expect(manifest.materialShaders).toHaveLength(6);
        await expect(
          buildEngineShaderManifest({
            materialPackages: [join(root, 'missing.pack.json')],
          }),
        ).rejects.toThrow('missing.pack.json');
      } finally {
        if (previous === undefined) delete process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
        else process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = previous;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
