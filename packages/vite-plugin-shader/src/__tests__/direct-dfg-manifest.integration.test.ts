import {
  findVariantByDefines,
  LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER,
  LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import { MATERIAL_WGSL_PROFILE } from '@forgeax/engine-shader-compiler';
import { prepareShaderProgramCompiler } from '@forgeax/engine-shader-compiler/program';
import { expect, it } from 'vitest';
import { buildEngineShaderTemplateManifest } from '../index.js';
import { SHADER_MANIFEST_TEST_TIMEOUT_MS } from './shader-manifest.fixture.js';

it(
  'publishes Cluster ABI, resampling and distinct DFG variants through Engine source templates',
  async () => {
    const wire = await buildEngineShaderTemplateManifest();
    const registry = new ShaderRegistry({
      manifestUrl: 'memory://engine-shaders/manifest.json',
      readText: async () => JSON.stringify(wire),
      prepareProgramCompiler: prepareShaderProgramCompiler,
    });
    (await registry.loadManifest()).unwrap();
    const materials = [...registry.materialShaderManifestEntries()];
    const entries = [...registry.entries()];
    const clusterMaterial = materials.find(
      (candidate) => candidate.identifier === 'forgeax::default-standard-pbr',
    );
    const clusterVariant =
      clusterMaterial &&
      findVariantByDefines(clusterMaterial, {
        CLUSTER_FORWARD_AVAILABLE: true,
        STORAGE_BUFFER_AVAILABLE: true,
      });
    expect(
      clusterVariant,
      'publishes the storage-backed Standard Cluster material variant',
    ).toBeDefined();
    const clusterGlobals = clusterVariant?.reflection?.boundGlobals ?? [];
    const lightData = clusterGlobals.find((global) => global.group === 0 && global.binding === 30);
    expect(lightData).toMatchObject({
      resourceKind: 'storage-buffer',
      addressSpace: 'storage',
      elementStride: 96,
      span: 96,
    });
    expect(lightData?.members?.map(({ name, offset, type }) => ({ name, offset, type }))).toEqual([
      { name: 'position', offset: 0, type: 'vec4<f32>' },
      { name: 'colorTimesIntensity', offset: 16, type: 'vec4<f32>' },
      { name: 'direction', offset: 32, type: 'vec4<f32>' },
      { name: 'auxiliary', offset: 48, type: 'vec4<f32>' },
      { name: 'metadata', offset: 64, type: 'vec4<u32>' },
      { name: 'channels', offset: 80, type: 'vec4<u32>' },
    ]);
    const clusterUniform = clusterGlobals.find(
      (global) => global.group === 0 && global.binding === 33,
    );
    expect(clusterUniform?.group).toBe(0);
    expect(clusterUniform?.binding).toBe(33);
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
    expect(clusterVariant?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
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
      const entry = entries.find((candidate) => candidate.identifier === identifier);
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
      expect(entry.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
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
    expect(
      entries.filter(
        ({ identifier }) =>
          identifier === LIGHT_TEXTURE_RESAMPLE_COMPUTE_IDENTIFIER ||
          identifier === LIGHT_TEXTURE_RESAMPLE_FRAGMENT_IDENTIFIER,
      ),
    ).toHaveLength(2);
    for (const identifier of [
      'forgeax::engine-ray-path-tracer',
      'forgeax::engine-standard-deferred-lighting',
    ]) {
      const entry = materials.find((entry) => entry.identifier === identifier);
      expect(entry, identifier).toBeDefined();
      const fit =
        entry?.variants.filter((variant) => variant.defines.DIRECT_DFG_LUT_AVAILABLE === false) ??
        [];
      const lut =
        entry?.variants.filter((variant) => variant.defines.DIRECT_DFG_LUT_AVAILABLE === true) ??
        [];
      expect(fit.length).toBeGreaterThan(0);
      expect(lut.length).toBe(fit.length);
      expect(fit.some((variant) => variant.composedWgsl === entry?.composedWgsl)).toBe(true);
      expect(entries.find((row) => row.identifier === identifier)?.wgsl).toBe(entry?.composedWgsl);
      for (const variant of fit) {
        expect(/var directDfgLut(?:_\d+)?\b/.test(variant.composedWgsl), `${identifier} fit`).toBe(
          false,
        );
      }
      for (const variant of lut) {
        expect(
          /var directDfgLut(?:_\d+)?\b/.test(variant.composedWgsl),
          `${identifier} LUT: ${variant.composedWgsl.match(/var\s+\w*Dfg\w*/g)?.join(', ')}`,
        ).toBe(true);
      }
    }
  },
  SHADER_MANIFEST_TEST_TIMEOUT_MS,
);
