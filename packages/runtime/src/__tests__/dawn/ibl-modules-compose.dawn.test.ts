// ibl-modules-compose.dawn.test.ts -- feat-20260520-skylight-ibl-cubemap M3 / t41.
//
// Cross-file composition test for the 6-module ibl-* family. Each module
// declares a unique #define_import_path; this test verifies that naga_oil
// Composer can:
//   (1) Register every module independently (no @group/@binding collision).
//   (2) Compose ibl_shared + ibl_irradiance into a fragment entry that
//       references ibl_irradiance helpers, exercising the texture_cube
//       @group(1) binding path.
//   (3) Compose ibl_shared + ibl_prefilter into a fragment entry, mirroring
//       (2) but with the prefilter module's additional prefilterUniforms
//       buffer to confirm dual-uniform @group(0) ordering.
//   (4) Compose ibl_shared + ibl_sampling into a pbr-style entry that
//       provides texture/sampler as function arguments (zero-binding
//       runtime helper module).
//
// Red-phase: before t42..t47 land, the source files do not exist and every
// it(...) below fails (readFileSync throws ENOENT). Green after the 6
// modules exist + their imports compose cleanly.
//
// node:* are accessed via the established `await import(varId)` pattern
// (renderer-draw-world.test.ts) so the runtime tsconfig does not need an
// explicit `@types/node` types entry (which would regress brand-type
// narrowing in createRenderer.ts).

import { composeShader, parse } from '@forgeax/engine-naga';
import { beforeAll, describe, expect, it } from 'vitest';

interface NodeFs {
  readFileSync: (p: string, enc: string) => string;
}
interface NodePath {
  resolve: (...parts: string[]) => string;
  dirname: (p: string) => string;
}
interface NodeModule {
  createRequire: (filename: string | URL) => { resolve: (id: string) => string };
}

const dawnReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

let srcDir!: string;
let readSourceSync!: (file: string) => string;

beforeAll(async () => {
  const fsId = 'node:fs';
  const pathId = 'node:path';
  const moduleId = 'node:module';
  const fs = (await import(/* @vite-ignore */ fsId)) as NodeFs;
  const path = (await import(/* @vite-ignore */ pathId)) as NodePath;
  const mod = (await import(/* @vite-ignore */ moduleId)) as NodeModule;
  const req = mod.createRequire(import.meta.url);
  const pkg = req.resolve('@forgeax/engine-shader/package.json');
  srcDir = path.resolve(path.dirname(pkg), 'src');
  readSourceSync = (file: string) => fs.readFileSync(path.resolve(srcDir, file), 'utf8');
});

describe('t41 (b) -- 6-module ibl-* family naga_oil composition', () => {
  it.skipIf(!dawnReady)(
    '(b1) ibl_shared composes alone (zero binding pure-math module)',
    async () => {
      const shared = readSourceSync('ibl-shared.wgsl');
      const entry = [
        '#import forgeax_pbr::ibl_shared::{hammersley}',
        '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
        '@fragment fn fs() -> @location(0) vec4<f32> {',
        '  let h = hammersley(3u, 16u);',
        '  return vec4<f32>(h, 0.0, 1.0);',
        '}',
      ].join('\n');
      const composed = await composeShader(
        entry,
        { 'forgeax_pbr::ibl_shared': shared, 'forgeax_pbr::brdf': readSourceSync('brdf.wgsl') },
        {},
      );
      expect(composed).toContain('hammersley');
      const parsed = await parse(composed);
      expect(parsed).not.toBeNull();
    },
  );

  it.skipIf(!dawnReady)(
    '(b2) ibl_shared + ibl_irradiance compose (texture_cube @group(1))',
    async () => {
      const shared = readSourceSync('ibl-shared.wgsl');
      const irradiance = readSourceSync('ibl-irradiance.wgsl');
      // The irradiance module declares its own @group(0) faceUniforms +
      // @group(1) envCube + sampler. Compose by importing irradianceConvolve_fs
      // as the entry directly -- naga_oil inlines the module sources, the
      // composed output exposes the entry. We call it via a thin re-entry.
      const entry = [
        '#import forgeax_pbr::ibl_shared::{radicalInverseVdC}',
        '#import forgeax_pbr::ibl_irradiance',
        '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
        '@fragment fn fs() -> @location(0) vec4<f32> {',
        '  _ = radicalInverseVdC(11u);',
        '  return vec4<f32>(1.0);',
        '}',
      ].join('\n');
      const composed = await composeShader(
        entry,
        {
          'forgeax_pbr::ibl_shared': shared,
          'forgeax_pbr::brdf': readSourceSync('brdf.wgsl'),
          'forgeax_pbr::ibl_irradiance': irradiance,
        },
        {},
      );
      expect(composed.length).toBeGreaterThan(0);
      const parsed = await parse(composed);
      expect(parsed).not.toBeNull();
    },
  );

  it.skipIf(!dawnReady)(
    '(b3) ibl_shared + ibl_prefilter compose (dual-uniform @group(0))',
    async () => {
      const shared = readSourceSync('ibl-shared.wgsl');
      const prefilter = readSourceSync('ibl-prefilter.wgsl');
      const entry = [
        '#import forgeax_pbr::ibl_shared::{hammersley}',
        '#import forgeax_pbr::ibl_prefilter',
        '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
        '@fragment fn fs() -> @location(0) vec4<f32> {',
        '  _ = hammersley(0u, 1024u);',
        '  return vec4<f32>(1.0);',
        '}',
      ].join('\n');
      const composed = await composeShader(
        entry,
        {
          'forgeax_pbr::ibl_shared': shared,
          'forgeax_pbr::brdf': readSourceSync('brdf.wgsl'),
          'forgeax_pbr::ibl_prefilter': prefilter,
        },
        {},
      );
      const parsed = await parse(composed);
      expect(parsed).not.toBeNull();
    },
  );

  it.skipIf(!dawnReady)(
    '(b4) ibl_shared + ibl_sampling compose (zero-binding runtime helper)',
    async () => {
      const shared = readSourceSync('ibl-shared.wgsl');
      const sampling = readSourceSync('ibl-sampling.wgsl');
      // ibl_sampling exports sampleIblDiffuse/sampleIblSpecular which take
      // texture/sampler as function arguments. The entry provides them via
      // its own @group(1) bindings, mirroring how pbr.wgsl consumes the
      // helper through its skylight @group(4).
      const entry = [
        '#import forgeax_pbr::ibl_sampling::{sampleIblDiffuse}',
        '@group(1) @binding(0) var irradianceMap: texture_cube<f32>;',
        '@group(1) @binding(1) var irradianceSampler: sampler;',
        '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
        '@fragment fn fs() -> @location(0) vec4<f32> {',
        '  let c = sampleIblDiffuse(vec3<f32>(0.0, 1.0, 0.0), vec4<f32>(0.0, 0.0, 0.0, 1.0), irradianceMap, irradianceSampler);',
        '  return vec4<f32>(c, 1.0);',
        '}',
      ].join('\n');
      const composed = await composeShader(
        entry,
        {
          'forgeax_pbr::ibl_shared': shared,
          'forgeax_pbr::brdf': readSourceSync('brdf.wgsl'),
          'forgeax_pbr::ibl_sampling': sampling,
        },
        {},
      );
      expect(composed).toContain('sampleIblDiffuse');
      const parsed = await parse(composed);
      expect(parsed).not.toBeNull();
    },
  );

  it.skipIf(!dawnReady)(
    '(b5) ibl_brdf_lut composes alone (no @group(1) external texture)',
    async () => {
      const shared = readSourceSync('ibl-shared.wgsl');
      const brdfLut = readSourceSync('ibl-brdf-lut.wgsl');
      const entry = [
        '#import forgeax_pbr::ibl_shared::{hammersley}',
        '#import forgeax_pbr::ibl_brdf_lut',
        '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
        '@fragment fn fs() -> @location(0) vec4<f32> {',
        '  _ = hammersley(1u, 16u);',
        '  return vec4<f32>(1.0);',
        '}',
      ].join('\n');
      const composed = await composeShader(
        entry,
        {
          'forgeax_pbr::ibl_shared': shared,
          'forgeax_pbr::brdf': readSourceSync('brdf.wgsl'),
          'forgeax_pbr::ibl_brdf_lut': brdfLut,
        },
        {},
      );
      const parsed = await parse(composed);
      expect(parsed).not.toBeNull();
    },
  );

  it.skipIf(!dawnReady)(
    '(b6) ibl_shared + ibl_equirect_to_cube compose (texture_2d @group(1))',
    async () => {
      const shared = readSourceSync('ibl-shared.wgsl');
      const equirect = readSourceSync('ibl-equirect-to-cube.wgsl');
      const entry = [
        '#import forgeax_pbr::ibl_shared::{radicalInverseVdC}',
        '#import forgeax_pbr::ibl_equirect_to_cube',
        '@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
        '@fragment fn fs() -> @location(0) vec4<f32> {',
        '  _ = radicalInverseVdC(5u);',
        '  return vec4<f32>(1.0);',
        '}',
      ].join('\n');
      const composed = await composeShader(
        entry,
        {
          'forgeax_pbr::ibl_shared': shared,
          'forgeax_pbr::brdf': readSourceSync('brdf.wgsl'),
          'forgeax_pbr::ibl_equirect_to_cube': equirect,
        },
        {},
      );
      const parsed = await parse(composed);
      expect(parsed).not.toBeNull();
    },
  );
});
