// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
// @ts-nocheck — merged file: indexed-access checks cascade across noUncheckedIndexedAccess for blocks originally outside src/ rootDir
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
//
// Source files (N=44):
//   - packages/runtime/__tests__/antialias-from-f32.test.ts
//   - packages/runtime/src/__tests__/bloom-gating.test.ts
//   - packages/runtime/src/__tests__/camera-antialias.test.ts
//   - packages/runtime/src/__tests__/camera-bloom.test.ts
//   - packages/runtime/src/__tests__/camera-clear-schema.test.ts
//   - packages/runtime/src/__tests__/camera-ortho.test.ts
//   - packages/runtime/src/__tests__/fxaa-intermediate-texture.test.ts
//   - packages/runtime/src/__tests__/fxaa-pipeline.test.ts
//   - packages/runtime/src/__tests__/ibl-pipeline-cache.test.ts
//   - packages/runtime/src/__tests__/ibl-runtime-probe.test.ts
//   - packages/runtime/src/__tests__/render-system-record-warn-once.test.ts
//   - packages/runtime/src/__tests__/shadow-skip-non-triangle.test.ts
//   - packages/runtime/src/__tests__/skin-errors-kebab-case.test.ts
//   - packages/runtime/src/__tests__/skybox-error.test.ts
//   - packages/runtime/src/__tests__/skybox-shader-compile.test.ts
//   - packages/runtime/src/__tests__/skylight-bind-group.test.ts
//   - packages/runtime/src/__tests__/skylight-component.test.ts
//   - packages/runtime/src/__tests__/skylight-fallback-path.test.ts
//   - packages/runtime/src/__tests__/skylight-pipeline-layout.test.ts
//   - packages/runtime/src/__tests__/tonemap-hdr-target.test.ts
//   - packages/runtime/src/__tests__/tonemap-pipeline-split.test.ts
//   - packages/runtime/src/__tests__/zero-camera-clear-fallback.test.ts
//   - packages/runtime/src/components/__tests__/skin.test.ts
//   - packages/runtime/src/systems/__tests__/advance-animation-player.test.ts
//   - packages/runtime/src/systems/__tests__/graph-skybox.test.ts
//   - packages/runtime/src/systems/__tests__/propagate-transforms.test.ts
//   - packages/runtime/src/systems/__tests__/skin-cap-gate.test.ts
//   - packages/runtime/src/systems/__tests__/skin-instances-coexist.test.ts
//   - packages/runtime/src/systems/__tests__/skin-palette-extract.test.ts
//   - packages/runtime/src/systems/__tests__/skin-pipeline-routing.test.ts
//   - packages/runtime/src/systems/__tests__/skybox-extract.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-boundary.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-clamp.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-frame-duration-negative.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-frame-duration-zero.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-loop.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-override-probe.test.ts
//   - packages/runtime/src/systems/__tests__/sprite-animation-tick-regions-mismatch.test.ts
//   - packages/runtime/src/systems/__tests__/tonemap.test.ts
//   - packages/runtime/src/systems/__tests__/transparent-sort-config-get.test.ts
//   - packages/runtime/src/systems/__tests__/transparent-sort-config-set.test.ts
//   - packages/runtime/src/systems/__tests__/transparent-sort.test.ts
//   - packages/runtime/src/__tests__/render-system-multi-material.test.ts
//   - packages/runtime/src/__tests__/render-system-record-submesh.test.ts
//
// Paradigm: each block-scope wraps a source file. ancestorTitles[0] is the
// source-preserved inner describe (NOT the source filename for these 3 files
// — recovery path: vitest report ancestorTitles -> grep this file -> upstream
// `// ─── from <name>.test.ts ───` block separator -> source filename).
// Top-level imports merged + deduped.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());
{
  // --- from skybox-shader-compile.test.ts ---

  // __dirname equivalent in ESM
  const __dirname = fileURLToPath(new URL('.', import.meta.url));

  const shaderSrcDir = resolve(__dirname, '..', '..', '..', 'shader', 'src');

  function readSkyboxWgsl(): string {
    return readFileSync(resolve(shaderSrcDir, 'skybox.wgsl'), 'utf8');
  }

  describe('skybox.wgsl source-level import + structure (AC-03)', () => {
    let source: string;

    beforeAll(() => {
      source = readSkyboxWgsl();
    });

    it('exists and is non-empty', () => {
      expect(source.length).toBeGreaterThan(0);
    });

    it('defines import path forgeax_view::skybox', () => {
      expect(source).toEqual(expect.stringContaining('#define_import_path forgeax_view::skybox'));
    });

    it('imports FullscreenOutput from forgeax_view::common', () => {
      expect(source).toEqual(
        expect.stringContaining('#import forgeax_view::common::FullscreenOutput'),
      );
    });

    it('imports View from forgeax_view::common', () => {
      expect(source).toEqual(expect.stringContaining('#import forgeax_view::common::View'));
    });

    it('imports fullscreen_triangle from forgeax_view::common', () => {
      expect(source).toEqual(
        expect.stringContaining('#import forgeax_view::common::fullscreen_triangle'),
      );
    });

    it('declares fragment entry point skybox_fs', () => {
      // `fn skybox_fs` uniquely identifies the fragment entry point;
      // this is the content marker used by createRenderer to identify
      // the skybox manifest entry (plan-strategy D-7).
      expect(source).toEqual(expect.stringContaining('fn skybox_fs'));
    });

    it('declares vertex entry point vs_main', () => {
      expect(source).toEqual(expect.stringContaining('fn vs_main'));
    });

    it('references inverseViewProj for world-space reconstruction', () => {
      expect(source).toEqual(expect.stringContaining('inverseViewProj'));
    });

    it('negates Y to match IBL cubemap convention (ibl-sampling.wgsl:30,47)', () => {
      // The fragment stage negates Y on the reconstructed world-space
      // direction before cubemap sampling. This matches the IBL path
      // convention in ibl-sampling.wgsl (sampleIblDiffuse:30,
      // sampleIblSpecular:47) where dir = vec3(x, -y, z).
      expect(source).toEqual(expect.stringContaining('-dir.y'));
    });

    it('uses textureSample for cubemap lookup', () => {
      expect(source).toEqual(expect.stringContaining('textureSample'));
    });

    it('declares cubemap as texture_cube<f32>', () => {
      expect(source).toEqual(expect.stringContaining('texture_cube<f32>'));
    });

    it('binds cubemap at @group(0) @binding(0)', () => {
      // WGSL binding declaration: @group(0) @binding(0) var cubemap
      expect(source).toMatch(/@group\(0\)\s*@binding\(0\)\s*var\s+cubemap\s*:/);
    });

    it('binds sampler at @group(0) @binding(1)', () => {
      expect(source).toMatch(/@group\(0\)\s*@binding\(1\)\s*var\s+/);
    });

    it('binds View UBO at @group(0) @binding(2)', () => {
      expect(source).toMatch(/@group\(0\)\s*@binding\(2\)\s*var<uniform>\s*view\s*:/);
    });
  });
}
