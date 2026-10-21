import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractDefineImportPath,
  loadEngineShaderEntries,
} from '../engine-inputs/load-engine-shader-entries.js';
import * as publicSurface from '../index.js';
import { buildEngineShaderManifest, VIEW_ABI } from '../index.js';
import { publishShaderManifest } from '../manifest-publication.js';

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
        JSON.stringify(
          publishShaderManifest(
            [{ hash: 'shared', wgsl: 'shared', bindings: '[]' }],
            [
              'forgeax::default-standard-pbr',
              'forgeax::pbr-skin',
              'forgeax::default-shadow-caster',
            ].map((identifier) => ({
              identifier,
              sourcePath: `${identifier}.wgsl`,
              composedWgsl: `// ${identifier}`,
              paramSchema: '[]',
              variants: [],
            })),
          ),
        ),
      );
      const previous = process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST;
      process.env.FORGEAX_SHARED_APP_INPUTS_MANIFEST = manifestPath;
      try {
        const manifest = await buildEngineShaderManifest();
        expect(manifest.schemaVersion).toBe('1.0.0');
        expect(manifest.entries).toEqual([
          { hash: 'shared', wgsl: 'shared', bindings: '[]', glsl: '' },
        ]);
        expect(manifest.materialShaders.map((entry) => entry.identifier)).toEqual([
          'forgeax::default-standard-pbr',
          'forgeax::pbr-skin',
          'forgeax::default-shadow-caster',
        ]);
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
        expect(manifest.materialShaders).toHaveLength(3);
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
