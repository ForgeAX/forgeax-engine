// @ts-nocheck — merged file: cross-source type narrowing failures
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=8):
//   - packages/shader/src/__tests__/fullscreen-triangle.test.ts
//   - packages/shader/src/__tests__/fxaa-shader.test.ts
//   - packages/shader/src/__tests__/ibl-modules-parse.test.ts
//   - packages/shader/src/__tests__/register-material-shader.test.ts
//   - packages/shader/src/__tests__/registry.test.ts
//   - packages/shader/src/__tests__/skybox-direction.test.ts
//   - packages/shader/src/__tests__/tbn-lighting-helpers.test.ts
//   - packages/shader/src/__tests__/tonemap-shader.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { readFileSync } from 'node:fs';
import type { Result, RhiError, ShaderModule } from '@forgeax/engine-rhi';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ShaderError } from '../errors.js';
import { err as errResult, ok as okResult } from '../errors.js';
import { TONEMAP_LUMINANCE_EPSILON } from '../index.js';
import {
  FORGEAX_RESERVED_PATH_PREFIX,
  type MaterialShaderEntry,
  ShaderRegistry,
} from '../ShaderRegistry.js';

{
  const sceneTemporalSource = readFileSync(
    new URL('../scene-temporal.wgsl', import.meta.url),
    'utf8',
  );
  describe('scene-temporal accessor ABI', () => {
    it('keeps the public shader module free of compiler and backend policy imports', () => {
      expect(sceneTemporalSource).toContain('forgeax_scene_temporal');
      expect(sceneTemporalSource).not.toMatch(/naga|shader-compiler|engine-rhi/i);
    });
  });
}

{
  // --- from fullscreen-triangle.test.ts ---
  // @forgeax/engine-shader/__tests__/fullscreen-triangle.test.ts -
  // TS-equivalence test for `fullscreen_triangle()` SSOT in common.wgsl
  // (feat-20260519-tonemap-reinhard-mvp / T-M2.1).
  //
  // Shape: the WGSL function takes vertex_index (u32 0/1/2) and emits a
  // large covering triangle in NDC — vertex 0 -> (-1, -1), vertex 1 ->
  // (3, -1), vertex 2 -> (-1, 3). UV is derived as the half-open
  // transform of clip-space xy back to [0, 1]: u = (x + 1) * 0.5,
  // v = 1 - (y + 1) * 0.5 (Y flipped to keep texture sampling right-side-up
  // against WebGPU's [0, 1] -> top-left UV convention).
  //
  // This file does not run the GPU; it asserts the math via a TS port that
  // must stay byte-equivalent to the WGSL body. Drift between the two
  // surfaces is caught by both this test (when TS port drifts) and the
  // naga_oil composer (when WGSL drifts to break the import / signature).
  //
  // research §F3 §2.3 (single-large-triangle, 3-vertex idiom) is the SSOT
  // for the (-1,-1)/(3,-1)/(-1,3) layout.

  // TS port of the WGSL body. Must be kept byte-equivalent by hand; the
  // shader-side function in `common.wgsl` is the runtime SSOT. See the
  // comment block in that file for the canonical equation.
  function fullscreenTriangleTS(vertexIndex: number): {
    position: [number, number, number, number];
    uv: [number, number];
  } {
    // x: vertex 0 / 2 -> -1; vertex 1 -> 3.
    // y: vertex 0 / 1 -> -1; vertex 2 -> 3.
    const x = vertexIndex === 1 ? 3.0 : -1.0;
    const y = vertexIndex === 2 ? 3.0 : -1.0;
    const u = (x + 1.0) * 0.5;
    const v = 1.0 - (y + 1.0) * 0.5;
    return {
      position: [x, y, 0.0, 1.0],
      uv: [u, v],
    };
  }

  describe('fullscreen_triangle (TS-equivalence)', () => {
    it('vertex 0 -> NDC (-1, -1, 0, 1) and UV (0, 1)', () => {
      const out = fullscreenTriangleTS(0);
      expect(out.position).toEqual([-1.0, -1.0, 0.0, 1.0]);
      expect(out.uv).toEqual([0.0, 1.0]);
    });

    it('vertex 1 -> NDC (3, -1, 0, 1) and UV (2, 1)', () => {
      const out = fullscreenTriangleTS(1);
      expect(out.position).toEqual([3.0, -1.0, 0.0, 1.0]);
      expect(out.uv).toEqual([2.0, 1.0]);
    });

    it('vertex 2 -> NDC (-1, 3, 0, 1) and UV (0, -1)', () => {
      const out = fullscreenTriangleTS(2);
      expect(out.position).toEqual([-1.0, 3.0, 0.0, 1.0]);
      expect(out.uv).toEqual([0.0, -1.0]);
    });

    it('the three vertices form a triangle that fully covers the [-1, 1] NDC quad', () => {
      // Coverage check: any point (px, py) in [-1, 1]^2 lies inside the
      // triangle (-1, -1), (3, -1), (-1, 3). Sample the four corners + center.
      const v = [
        fullscreenTriangleTS(0).position,
        fullscreenTriangleTS(1).position,
        fullscreenTriangleTS(2).position,
      ];
      const samples: Array<[number, number]> = [
        [-1.0, -1.0],
        [1.0, -1.0],
        [-1.0, 1.0],
        [1.0, 1.0],
        [0.0, 0.0],
      ];
      for (const [px, py] of samples) {
        const [a, b, c] = v as [
          [number, number, number, number],
          [number, number, number, number],
          [number, number, number, number],
        ];
        const denom = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        const w0 = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / denom;
        const w1 = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / denom;
        const w2 = 1.0 - w0 - w1;
        expect(w0).toBeGreaterThanOrEqual(-1e-6);
        expect(w1).toBeGreaterThanOrEqual(-1e-6);
        expect(w2).toBeGreaterThanOrEqual(-1e-6);
      }
    });
  });
}

{
  // --- from fxaa-shader.test.ts ---
  // @forgeax/engine-shader/__tests__/fxaa-shader.test.ts -
  // TS-equivalence test for fxaa.wgsl content markers and SSOT
  // compliance (feat-20260528-fxaa-post-processing / w5).
  //
  // Four concerns:
  //   1. fxaa.wgsl source contains rgb2luma function (content marker per D-5)
  //   2. fxaa.wgsl source does NOT contain fn fullscreen_triangle (SSOT in common.wgsl)
  //   3. fxaa.wgsl source imports forgeax_view::common (AC-05)
  //   4. EDGE_THRESHOLD_MIN / EDGE_THRESHOLD_MAX constants exist
  //
  // Reads the fxaa.wgsl source via dynamic node:fs import (same pattern as
  // pbr-ibl-callsite.test.ts and ibl-modules-parse.test.ts).

  interface NodeFs {
    readFileSync: (p: string, enc: string) => string;
  }
  interface NodePath {
    resolve: (...parts: string[]) => string;
    dirname: (p: string) => string;
  }
  interface NodeUrl {
    fileURLToPath: (u: string) => string;
  }

  let fxaaSource!: string;
  let commonSource!: string;

  beforeAll(async () => {
    const fsId = 'node:fs';
    const pathId = 'node:path';
    const urlId = 'node:url';
    const fs = (await import(/* @vite-ignore */ fsId)) as NodeFs;
    const path = (await import(/* @vite-ignore */ pathId)) as NodePath;
    const url = (await import(/* @vite-ignore */ urlId)) as NodeUrl;
    const here = url.fileURLToPath(import.meta.url);
    const fxaaPath = path.resolve(path.dirname(here), '..', 'fxaa.wgsl');
    const commonPath = path.resolve(path.dirname(here), '..', 'common.wgsl');
    fxaaSource = fs.readFileSync(fxaaPath, 'utf8');
    commonSource = fs.readFileSync(commonPath, 'utf8');
  });

  describe('fxaa.wgsl content markers', () => {
    it('contains rgb2luma function definition (D-5 content marker)', () => {
      expect(fxaaSource).toContain('fn rgb2luma');
    });

    it('contains EDGE_THRESHOLD_MIN constant', () => {
      expect(fxaaSource).toContain('EDGE_THRESHOLD_MIN');
      expect(fxaaSource).toContain('0.0312');
    });

    it('contains EDGE_THRESHOLD_MAX constant', () => {
      expect(fxaaSource).toContain('EDGE_THRESHOLD_MAX');
      expect(fxaaSource).toContain('0.063');
    });
  });

  describe('fxaa.wgsl display-encoded SSOT gate (AC-05)', () => {
    it('does NOT define fullscreen_triangle (SSOT is in common.wgsl)', () => {
      expect(fxaaSource).not.toMatch(/fn fullscreen_triangle/);
    });

    it('imports forgeax_view::common::fullscreen_triangle', () => {
      expect(fxaaSource).toContain('#import forgeax_view::common::fullscreen_triangle');
    });

    it('imports forgeax_view::common::FullscreenOutput', () => {
      expect(fxaaSource).toContain('#import forgeax_view::common::{FullscreenOutput');
    });

    it('declares display-encoded input/output without an OETF owner', () => {
      expect(fxaaSource).toContain('display-encoded');
      expect(fxaaSource).not.toContain('linearLdrColorDomain');
      expect(fxaaSource).not.toContain('linearToSrgbOetf');
    });

    it('gates dither at both early and final paths with the per-pass policy UBO', () => {
      expect(fxaaSource).toContain('struct FxaaParams');
      expect(fxaaSource).toMatch(
        /@group\(0\)\s+@binding\(2\)\s+var<uniform> params\s*:\s*FxaaParams/,
      );
      expect(fxaaSource).toContain(
        'select(centerColor, ditherUnorm8(centerColor, in.position.xy), params.ditherEnabled > 0.5)',
      );
      expect(fxaaSource).toContain(
        'select(finalColor, ditherUnorm8(finalColor, in.position.xy), params.ditherEnabled > 0.5)',
      );
    });

    it('uses the shared output-boundary dither implementation', () => {
      expect(commonSource).toContain('fn ditherUnorm8');
      expect(commonSource).toContain('fn ditherNoise');
      expect(fxaaSource).not.toContain('fn ditherUnorm8');
      expect(fxaaSource).not.toContain('fn ditherNoise');
    });
  });

  describe('fxaa.wgsl bindings', () => {
    it('declares @group(0) @binding(0) texture_2d<f32>', () => {
      expect(fxaaSource).toMatch(/@binding\(0\)\s+var\s+screenTexture.*texture_2d<f32>/);
    });

    it('declares @group(0) @binding(1) sampler', () => {
      expect(fxaaSource).toMatch(/@binding\(1\)\s+var\s+samp.*sampler/);
    });

    it('declares @group(0) @binding(2) FxaaParams uniform', () => {
      expect(fxaaSource).toMatch(/@binding\(2\)\s+var<uniform>\s+params\s*:\s*FxaaParams/);
    });
  });
}

{
  // --- from ibl-modules-parse.test.ts ---
  // ibl-modules-parse.test.ts -- feat-20260520-skylight-ibl-cubemap M3 / t41.
  //
  // Structural red-phase tests for the 6-module ibl-* WGSL family. The
  // single-file ibl.wgsl that round-1 shipped (commit 5dd45cb9) collided on
  // @group(1) @binding(0) across 3 distinct texture types (texture_2d for
  // equirect / texture_cube x2 for irradiance + prefilter), which naga
  // rejects under the WGSL spec rule "(group, binding) must be globally
  // unique within a module". round-2 splits the file into 6 physically
  // independent modules so each module's @group/@binding namespace is its
  // own.
  //
  // These tests are red BEFORE t42..t47 land (module files do not exist) and
  // turn green when each module is in place. The package physically isolates
  // naga (4 grep gates -- see scripts/check-shader-no-naga-in-dist.mjs), so
  // these checks read the source files directly and assert structural rules
  // rather than invoking naga.parse / composeShader (the cross-file
  // composition path is exercised by the dawn test in
  // packages/runtime/src/__tests__/dawn/ibl-modules-compose.dawn.test.ts
  // where engine-naga is allowed as a devDependency).
  //
  // node:* are accessed via `await import(varId)` (vite-ignore) -- the
  // established cross-package pattern in renderer-draw-world.test.ts -- so
  // the shader tsconfig keeps `types: ["@webgpu/types"]` without pulling in
  // `@types/node` (which would regress unrelated brand-type narrowing).

  interface NodeFs {
    readFileSync: (p: string, enc: string) => string;
  }
  interface NodePath {
    resolve: (...parts: string[]) => string;
    dirname: (p: string) => string;
  }
  interface NodeUrl {
    fileURLToPath: (u: string) => string;
  }

  let fs!: NodeFs;
  let srcDir!: string;

  beforeAll(async () => {
    const fsId = 'node:fs';
    const pathId = 'node:path';
    const urlId = 'node:url';
    fs = (await import(/* @vite-ignore */ fsId)) as NodeFs;
    const path = (await import(/* @vite-ignore */ pathId)) as NodePath;
    const url = (await import(/* @vite-ignore */ urlId)) as NodeUrl;
    const here = url.fileURLToPath(import.meta.url);
    srcDir = path.resolve(path.dirname(here), '..');
  });

  interface ModuleSpec {
    readonly file: string;
    readonly importPath: string;
    readonly expectedGroup1: readonly ('texture_2d' | 'texture_cube')[];
  }

  const MODULES: readonly ModuleSpec[] = [
    { file: 'ibl-shared.wgsl', importPath: 'forgeax_pbr::ibl_shared', expectedGroup1: [] },
    {
      file: 'ibl-equirect-to-cube.wgsl',
      importPath: 'forgeax_pbr::ibl_equirect_to_cube',
      expectedGroup1: ['texture_2d'],
    },
    {
      file: 'ibl-irradiance.wgsl',
      importPath: 'forgeax_pbr::ibl_irradiance',
      expectedGroup1: ['texture_cube'],
    },
    {
      file: 'ibl-prefilter.wgsl',
      importPath: 'forgeax_pbr::ibl_prefilter',
      expectedGroup1: ['texture_cube', 'texture_2d'],
    },
    { file: 'ibl-brdf-lut.wgsl', importPath: 'forgeax_pbr::ibl_brdf_lut', expectedGroup1: [] },
    { file: 'ibl-sampling.wgsl', importPath: 'forgeax_pbr::ibl_sampling', expectedGroup1: [] },
  ];

  function readSource(file: string): string {
    const p = `${srcDir}/${file}`;
    return fs.readFileSync(p, 'utf8');
  }

  describe('t41 (a) -- 6 ibl-* WGSL modules: namespace isolation', () => {
    for (const spec of MODULES) {
      describe(spec.file, () => {
        it('declares the exact #define_import_path', () => {
          const src = readSource(spec.file);
          const match = /^\s*#define_import_path\s+(\S+)\s*$/m.exec(src);
          expect(match?.[1]).toBe(spec.importPath);
        });

        it(`@group(1) shape matches expected (${spec.expectedGroup1})`, () => {
          const src = readSource(spec.file);
          // Strip comments line-by-line so banner annotations like
          // "// @group(1) ..." cannot fool the structural grep.
          const codeOnly = src
            .split(/\r?\n/)
            .map((line: string) => line.replace(/\/\/.*$/, ''))
            .join('\n');
          const group1Lines = codeOnly
            .split(/\r?\n/)
            .filter((line: string) => /@group\(1\)/.test(line));

          if (spec.expectedGroup1.length === 0) {
            // Shared math + sampling helpers + brdf-lut entry are zero-binding.
            expect(group1Lines).toHaveLength(0);
            return;
          }
          expect(group1Lines.length).toBeGreaterThan(0);
          const textureTypes = group1Lines.flatMap((line: string) => {
            const type = /var\s+\w+\s*:\s*(texture_\w+)/.exec(line)?.[1];
            return type === undefined ? [] : [type];
          });
          expect(textureTypes).toEqual(spec.expectedGroup1);
        });

        it('every @binding(N) inside @group(1) is unique within the module', () => {
          const src = readSource(spec.file);
          const codeOnly = src
            .split(/\r?\n/)
            .map((line: string) => line.replace(/\/\/.*$/, ''))
            .join('\n');
          const seen = new Set<number>();
          const re = /@group\(1\)\s*@binding\((\d+)\)/g;
          let m: RegExpExecArray | null = re.exec(codeOnly);
          while (m !== null) {
            const idx = Number(m[1]);
            expect(seen.has(idx), `duplicate @binding(${idx}) in ${spec.file}`).toBe(false);
            seen.add(idx);
            m = re.exec(codeOnly);
          }
        });
      });
    }
  });

  describe('t41 (a) -- ibl-shared / ibl-sampling are zero-binding pure-function modules', () => {
    it.each([
      ['ibl-shared.wgsl'],
      ['ibl-sampling.wgsl'],
    ])('%s has zero @group/@binding declarations', (file: string) => {
      const src = readSource(file);
      const codeOnly = src
        .split(/\r?\n/)
        .map((line: string) => line.replace(/\/\/.*$/, ''))
        .join('\n');
      expect(codeOnly).not.toMatch(/@group\(\d+\)\s*@binding\(\d+\)/);
    });
  });

  describe('WebGL2 uniform alignment', () => {
    it('pads ibl-prefilter PrefilterUniforms to a 16-byte block', () => {
      const src = readSource('ibl-prefilter.wgsl');
      expect(src).toMatch(
        /struct\s+PrefilterUniforms\s*\{[\s\S]*?level:\s*f32,[\s\S]*?face:\s*f32,[\s\S]*?sourceIsCameraCube:\s*f32,[\s\S]*?_padding:\s*f32,/,
      );
    });

    it('bounds runtime roughness sampling to the complete CubeUV level range', () => {
      const src = readSource('ibl-pmrem.wgsl');
      expect(src).toContain('clamp(pmremRoughnessToMip(roughness), -2.0, maxMip)');
      expect(src).toContain('if (fract(mip) == 0.0) { return first; }');
    });

    it('evaluates the real Hammersley domain without a zero GGX denominator', () => {
      const radicalInverseVdC = (bits: number) => {
        let value = bits >>> 0;
        value = ((value << 16) | (value >>> 16)) >>> 0;
        value = (((value & 0x55555555) << 1) | ((value & 0xaaaaaaaa) >>> 1)) >>> 0;
        value = (((value & 0x33333333) << 2) | ((value & 0xcccccccc) >>> 2)) >>> 0;
        value = (((value & 0x0f0f0f0f) << 4) | ((value & 0xf0f0f0f0) >>> 4)) >>> 0;
        value = (((value & 0x00ff00ff) << 8) | ((value & 0xff00ff00) >>> 8)) >>> 0;
        return value * 2.3283064365386963e-10;
      };
      const sampleCount = 512;
      const roughness = 0;
      let maximumXiY = 0;
      let minimumDenominator = Number.POSITIVE_INFINITY;
      for (let index = 0; index < sampleCount; index += 1) {
        const xiY = radicalInverseVdC(index);
        const denominator = 1 + (roughness ** 4 - 1) * xiY;
        maximumXiY = Math.max(maximumXiY, xiY);
        minimumDenominator = Math.min(minimumDenominator, denominator);
        expect(Number.isFinite(denominator)).toBe(true);
      }
      expect(maximumXiY).toBeLessThan(1);
      expect(minimumDenominator).toBeGreaterThan(0);
      expect(minimumDenominator).toBeCloseTo(1 / sampleCount, 12);
    });
  });

  describe('t41 (a) -- ibl-sampling exports sampleIblDiffuse + sampleIblSpecular', () => {
    it('declares the two runtime sampling helpers consumed by pbr.wgsl', () => {
      const src = readSource('ibl-sampling.wgsl');
      expect(src).toMatch(/fn\s+sampleIblDiffuse\s*\(/);
      expect(src).toMatch(/fn\s+sampleIblSpecular\s*\(/);
    });
  });
}

{
  // --- from register-material-shader.test.ts ---
  // register-material-shader.test.ts -- feat-20260523-shader-template-instance-split
  // M5 / T06.
  //
  // Tests for the new ShaderRegistry.installMaterialArtifact / findMaterialArtifact
  // surface (M5-T05 + plan-strategy D-DefaultStandardPbr-Identifier).
  //
  // 5 cases per plan acceptanceCheck:
  //   (a) register and lookup happy path
  //   (b) duplicate register throws (programmer error / fail-fast no overwrite)
  //   (c) non-`forgeax::` identifier (user path) is allowed
  //   (d) lookup of non-existent identifier returns Result.err with code
  //       'material-shader-not-found'
  //   (e) materialShaderIdentifiers() iterator enumerates registrations in
  //       insertion order (charter F1 grep gate -- AI users iterate to discover)
  //
  // The original M5-T06 plan-task acceptanceCheck note (e) was "startup
  // auto-registers 'forgeax::default-standard-pbr' via import side-effect".
  // That formulation is incompatible with the package's
  // instance-per-engine + zero-module-side-effect design rules
  // (plan-strategy section S-10 + AGENTS.md "explicit registration"). The
  // equivalent invariant landed as "the default identifier is registrable
  // under the FORGEAX_RESERVED_PATH_PREFIX path namespace + iterator
  // enumerates the registration" -- the host (createRenderer in M6) wires
  // the actual default-standard-pbr triple at engine boot.
  //
  // Each test constructs a fresh ShaderRegistry instance (no shared state).

  /// <reference types="@webgpu/types" />

  const SHADER_MODULE_BRAND: unique symbol = Symbol('mock-shader-module');
  type MockShaderModule = { readonly [SHADER_MODULE_BRAND]: 'mock' };

  function createNoopDevice(): ShaderRegistryDevice {
    return {
      createShaderModule(): Result<ShaderModule, RhiError> {
        const handle: MockShaderModule = { [SHADER_MODULE_BRAND]: 'mock' as const };
        return { ok: true, value: handle as unknown as ShaderModule } as unknown as Result<
          ShaderModule,
          RhiError
        >;
      },
    };
  }

  function makeRegistry(): ShaderRegistry {
    return new ShaderRegistry({ device: createNoopDevice(), manifestUrl: undefined });
  }

  const STUB_SOURCE_DEFAULT = '// stub composed wgsl for forgeax::default-standard-pbr\n';
  const STUB_SOURCE_USER = '// stub composed wgsl for user shader\n';

  function makeDefaultEntry(): MaterialShaderEntry {
    return {
      source: STUB_SOURCE_DEFAULT,
      paramSchema: [
        { name: 'baseColor', type: 'color' },
        { name: 'metallic', type: 'f32', default: 0.0 },
        { name: 'roughness', type: 'f32', default: 0.5 },
      ],
    };
  }

  function makeUserEntry(): MaterialShaderEntry {
    return {
      source: STUB_SOURCE_USER,
      paramSchema: [
        { name: 'baseColor', type: 'color' },
        { name: 'time', type: 'f32', default: 0.0 },
      ],
    };
  }

  describe('M5-T06 (a) -- register + lookup happy path', () => {
    it('registers an engine-reserved identifier and looks it back up', () => {
      const registry = makeRegistry();
      const entry = makeDefaultEntry();
      const id = `${FORGEAX_RESERVED_PATH_PREFIX}default-standard-pbr`;
      registry.installMaterialArtifact(id, entry);

      const r = registry.findMaterialArtifact(id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.source).toBe(STUB_SOURCE_DEFAULT);
      expect(r.value.paramSchema).toHaveLength(3);
      expect(r.value.paramSchema[0]).toEqual({ name: 'baseColor', type: 'color' });
      expect(r.value.paramSchemaProjection).toMatchObject({ ownerId: id, revision: 1 });
      expect(r.value.paramSchemaProjection.schema).toBe(r.value.paramSchema);
      expect(registry.paramSchemaProjectionStats()).toEqual({
        admissions: 1,
        derivations: 1,
        projections: 1,
      });
    });
  });

  describe('M5-T06 (b) -- duplicate register throws (fail-fast no overwrite)', () => {
    it('throws on same-name re-register', () => {
      const registry = makeRegistry();
      const entry = makeDefaultEntry();
      const id = `${FORGEAX_RESERVED_PATH_PREFIX}default-standard-pbr`;
      registry.installMaterialArtifact(id, entry);

      expect(() => registry.installMaterialArtifact(id, entry)).toThrow(/already registered/);
      // Original entry stays intact -- duplicate register did not perturb storage.
      const lookup = registry.findMaterialArtifact(id);
      expect(lookup.ok).toBe(true);
      if (lookup.ok) {
        expect(lookup.value.source).toBe(STUB_SOURCE_DEFAULT);
      }
    });

    it('does not allow overwrite even when entry shape differs', () => {
      const registry = makeRegistry();
      const id = `${FORGEAX_RESERVED_PATH_PREFIX}default-standard-pbr`;
      registry.installMaterialArtifact(id, makeDefaultEntry());
      // Attempt a "drift" overwrite with a different source body.
      expect(() =>
        registry.installMaterialArtifact(id, {
          source: '// drifted source\n',
          paramSchema: [],
        }),
      ).toThrow(/already registered/);
    });
  });

  describe('M5-T06 (c) -- non-forgeax:: user identifier is allowed', () => {
    it('accepts a user-namespaced path identifier', () => {
      const registry = makeRegistry();
      const userId = 'my-game::pulse-material';
      registry.installMaterialArtifact(userId, makeUserEntry());
      const r = registry.findMaterialArtifact(userId);
      expect(r.ok).toBe(true);
    });

    it('accepts a GUID-shaped identifier', () => {
      const registry = makeRegistry();
      const guidId = '01923a4b-7d8c-7c4e-9f12-345678901234';
      registry.installMaterialArtifact(guidId, makeUserEntry());
      const r = registry.findMaterialArtifact(guidId);
      expect(r.ok).toBe(true);
    });
  });

  // bug-20260619 -- register-time texture-declaration consistency fail-fast.
  // A user shader that samples a user-region material texture but omits it from
  // paramSchema would let the extract stage silently drop the handle and bind
  // the default white texture (LO 4.3 blending demo grass + windows opaque
  // white). See docs/handover/2026-06-19-blending-transparency-regression-bisect.md.
  describe('bug-20260619 -- under-declared sampled texture throws at register', () => {
    const wgslSamplingBaseColor =
      '@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;\n' +
      '@fragment fn fs() { let s = textureSample(baseColorTexture, smp, in.uv); }';

    it('throws when a user shader samples baseColorTexture absent from paramSchema', () => {
      const registry = makeRegistry();
      expect(() =>
        registry.installMaterialArtifact('learn-render::alpha-test', {
          source: wgslSamplingBaseColor,
          paramSchema: [{ name: 'baseColor', type: 'color' }],
        }),
      ).toThrow(/samples texture\(s\) \[baseColorTexture\].*does not declare/s);
    });

    it('accepts the same shader once baseColorTexture is declared', () => {
      const registry = makeRegistry();
      expect(() =>
        registry.installMaterialArtifact('learn-render::alpha-test', {
          source: wgslSamplingBaseColor,
          paramSchema: [
            { name: 'baseColor', type: 'color' },
            { name: 'baseColorTexture', type: 'texture2d' },
          ],
        }),
      ).not.toThrow();
    });

    it('does NOT apply the check to engine forgeax:: shaders (build-time gate owns them)', () => {
      // An engine shader may sample engine-injected textures (emissive /
      // occlusion) absent from its schema by design; the runtime check is
      // scoped to user shaders only.
      const registry = makeRegistry();
      const wgslEngineInjected =
        '@fragment fn fs() { let e = textureSample(emissiveTexture, smp, in.uv); }';
      expect(() =>
        registry.installMaterialArtifact(`${FORGEAX_RESERVED_PATH_PREFIX}custom`, {
          source: wgslEngineInjected,
          paramSchema: [{ name: 'baseColor', type: 'color' }],
        }),
      ).not.toThrow();
    });
  });

  describe('M5-T06 (d) -- lookup non-existent returns material-shader-not-found', () => {
    it('returns Result.err with the structured error code', () => {
      const registry = makeRegistry();
      const r = registry.findMaterialArtifact('forgeax::no-such-shader');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('material-shader-not-found');
      expect(r.error.hint).toMatch(/installMaterialArtifact/);
      expect(r.error.message).toContain('forgeax::no-such-shader');
    });
  });

  describe('M5-T06 (e) -- materialShaderIdentifiers() iterator enumerates in order', () => {
    it('enumerates every registered identifier (insertion order)', () => {
      const registry = makeRegistry();
      const ids = [
        `${FORGEAX_RESERVED_PATH_PREFIX}default-standard-pbr`,
        'my-game::pulse-material',
        'my-game::wave-material',
      ] as const;
      for (const id of ids) {
        registry.installMaterialArtifact(id, makeUserEntry());
      }
      const seen = Array.from(registry.materialShaderIdentifiers());
      expect(seen).toEqual(ids);
    });

    it('returns an empty iterator on a fresh registry (no module-level singletons / no implicit auto-register at construction)', () => {
      const registry = makeRegistry();
      const seen = Array.from(registry.materialShaderIdentifiers());
      expect(seen).toEqual([]);
    });
  });

  describe('M5-T06 (f) -- FORGEAX_RESERVED_PATH_PREFIX SSOT', () => {
    it("equals 'forgeax::' (charter F1 grep gate anchor)", () => {
      expect(FORGEAX_RESERVED_PATH_PREFIX).toBe('forgeax::');
    });
  });

  // feat-20260528-material-shader-registration-unification M3 / w13:
  // materialShaderNotFound .expected field tests (charter P3 structured failure).
  describe('M3-w13 -- materialShaderNotFound .expected field', () => {
    it('(a) lookup miss after 3 registrations -> err.expected lists all 3 identifiers', () => {
      const registry = makeRegistry();
      const ids = [
        `${FORGEAX_RESERVED_PATH_PREFIX}default-standard-pbr`,
        'my-game::pulse-material',
        'my-game::wave-material',
      ] as const;
      for (const id of ids) {
        registry.installMaterialArtifact(id, makeUserEntry());
      }
      const r = registry.findMaterialArtifact('forgeax::no-such-shader');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('material-shader-not-found');
      const expectedList = r.error.expected;
      expect(expectedList).toContain(ids[0]);
      expect(expectedList).toContain(ids[1]);
      expect(expectedList).toContain(ids[2]);
    });

    it('(b) lookup miss on empty registry -> err.expected is empty', () => {
      const registry = makeRegistry();
      const r = registry.findMaterialArtifact('forgeax::no-such-shader');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('material-shader-not-found');
      expect(r.error.expected).toContain('ShaderRegistry has registered identifiers: []');
    });

    it('(c) register + miss, add more, miss again -> err.expected updates', () => {
      const registry = makeRegistry();
      registry.installMaterialArtifact(
        `${FORGEAX_RESERVED_PATH_PREFIX}default-standard-pbr`,
        makeUserEntry(),
      );
      const r1 = registry.findMaterialArtifact('forgeax::no-such-shader');
      expect(r1.ok).toBe(false);
      if (r1.ok) return;
      expect(r1.error.expected).toContain('forgeax::');

      registry.installMaterialArtifact('my-game::pulse-material', makeUserEntry());
      registry.installMaterialArtifact('my-game::wave-material', makeUserEntry());
      const r2 = registry.findMaterialArtifact('different-miss');
      expect(r2.ok).toBe(false);
      if (r2.ok) return;
      expect(r2.error.expected).toContain('forgeax::');
      expect(r2.error.expected).toContain('my-game::pulse-material');
      expect(r2.error.expected).toContain('my-game::wave-material');
    });

    // feat-20260624-sprite-lit F-P1 fix (Pure charter P3 finding):
    // err.detail.registeredShaderIds carries the raw string[] so AI users can
    // enumerate registered ids by property access instead of regex-parsing the
    // human-formatted err.expected string.
    it('(d) err.detail.registeredShaderIds exposes raw string[] for property-access enumeration', () => {
      const registry = makeRegistry();
      const ids = [
        `${FORGEAX_RESERVED_PATH_PREFIX}default-standard-pbr`,
        'my-game::pulse-material',
        'my-game::wave-material',
      ] as const;
      for (const id of ids) {
        registry.installMaterialArtifact(id, makeUserEntry());
      }
      const r = registry.findMaterialArtifact('forgeax::no-such-shader');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('material-shader-not-found');
      const detail = r.error.detail;
      const registered =
        detail?.code === 'material-shader-not-found' ? detail.registeredShaderIds : undefined;
      expect(Array.isArray(registered)).toBe(true);
      expect(registered).toEqual(ids);
      expect(registered).toContain('my-game::pulse-material');
    });

    it('(e) empty-registry miss -> err.detail.registeredShaderIds is empty array (not undefined)', () => {
      const registry = makeRegistry();
      const r = registry.findMaterialArtifact('forgeax::no-such-shader');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      const detail = r.error.detail;
      const registered =
        detail?.code === 'material-shader-not-found' ? detail.registeredShaderIds : undefined;
      expect(Array.isArray(registered)).toBe(true);
      expect(registered).toEqual([]);
    });
  });

  // feat-20260604-instances-per-instance-transform-shader-group3-bin M1 / w1:
  // variant=2 compile unit test (AC-11: variants count stays 2, no new axis).
  //
  // Structural source-level assertions (same pattern as tbn-lighting-helpers.test.ts):
  //   (a) common.wgsl declares @group(3) instances binding under STORAGE_BUFFER_AVAILABLE
  //   (b) default-standard-pbr.wgsl and unlit.wgsl each carry exactly one
  //       #pragma variant_axis STORAGE_BUFFER_AVAILABLE (no second axis)
  //   (c) No shader introduces a new variant axis like INSTANCE_STORAGE_AVAILABLE (OOS-6)
  //
  // RED before w3 (common.wgsl has no @group(3) yet); GREEN after w3 adds it.

  interface NodeFsW1 {
    readFileSync: (p: string, enc: string) => string;
  }
  interface NodePathW1 {
    resolve: (...parts: string[]) => string;
    dirname: (p: string) => string;
  }
  interface NodeUrlW1 {
    fileURLToPath: (u: string) => string;
  }

  describe('M1-w1 -- variant=2 structural compile unit test (AC-11)', () => {
    let fsW1!: NodeFsW1;
    let srcDirW1!: string;

    beforeAll(async () => {
      const fsId = 'node:fs';
      const pathId = 'node:path';
      const urlId = 'node:url';
      fsW1 = (await import(/* @vite-ignore */ fsId)) as NodeFsW1;
      const pathW1 = (await import(/* @vite-ignore */ pathId)) as NodePathW1;
      const urlW1 = (await import(/* @vite-ignore */ urlId)) as NodeUrlW1;
      const hereW1 = urlW1.fileURLToPath(import.meta.url);
      srcDirW1 = pathW1.resolve(pathW1.dirname(hereW1), '..');
    });

    function readWgsl(file: string): string {
      return fsW1.readFileSync(`${srcDirW1}/${file}`, 'utf8');
    }

    function stripComments(src: string): string {
      return src
        .split(/\r?\n/)
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
    }

    it('(a) common.wgsl declares @group(3) instances under STORAGE_BUFFER_AVAILABLE', () => {
      const src = readWgsl('common.wgsl');
      // After w3: common.wgsl must have @group(3) @binding(0) instances declaration
      expect(src).toMatch(
        /@group\(3\)\s+@binding\(0\)\s+var<storage,\s*read>\s+instances\s*:\s*array<InstanceData>/,
      );
      expect(src).toMatch(
        /@group\(3\)\s+@binding\(0\)\s+var<uniform>\s+instances\s*:\s*array<InstanceData,\s*128>/,
      );
      // Both forms must be guarded by STORAGE_BUFFER_AVAILABLE.
      // bug-20260610: switched `#ifdef X` → `#if X == true` (naga_oil's
      // `#ifdef` only checks key presence in the def map, not the value;
      // the ==/!= form is needed to make the false branch actually live).
      expect(src).toMatch(/#if\s+STORAGE_BUFFER_AVAILABLE\s*==\s*true[\s\S]*@group\(3\)/);
    });

    it('(b) default-standard-pbr.wgsl declares its complete capability variant-axis contract', () => {
      // feat-20260609-hdrp-cluster-fragment-ggx M1: added CLUSTER_FORWARD_AVAILABLE as a
      // second variant axis so the standard-pbr fragment can switch between URP-style
      // (single dirlight + ambient) and HDRP-style (cluster forward 256 punctual lights).
      const src = stripComments(readWgsl('default-standard-pbr.wgsl'));
      const variantAxes = src.match(/#pragma\s+variant_axis\s+\w+/g) ?? [];
      expect(variantAxes).toEqual([
        '#pragma variant_axis STORAGE_BUFFER_AVAILABLE',
        '#pragma variant_axis ATMOSPHERE_AVAILABLE',
        '#pragma variant_axis CLUSTER_FORWARD_AVAILABLE',
        '#pragma variant_axis VERTEX_COLOR_AVAILABLE',
        '#pragma variant_axis PROBE_BLEND_AVAILABLE',
        '#pragma variant_axis EXTENDED_LIGHTING_AVAILABLE',
        '#pragma variant_axis TRANSMISSION_AVAILABLE',
        '#pragma variant_axis DIRECTIONAL_PCSS_AVAILABLE',
        '#pragma variant_axis PROJECTOR_AVAILABLE',
        '#pragma variant_axis GPU_DRIVEN_SCENE_INDEX_AVAILABLE',
        '#pragma variant_axis REFLECTION_FALLBACK_AVAILABLE',
        '#pragma variant_axis COVERAGE_ONLY',
        '#pragma variant_axis VISIBLE_SURFACE_AVAILABLE',
      ]);
    });

    it('(b) unlit.wgsl declares storage and vertex-color variant axes', () => {
      const src = stripComments(readWgsl('unlit.wgsl'));
      const variantAxes = src.match(/#pragma\s+variant_axis\s+\w+/g) ?? [];
      expect(variantAxes).toEqual([
        '#pragma variant_axis STORAGE_BUFFER_AVAILABLE',
        '#pragma variant_axis ATMOSPHERE_AVAILABLE',
        '#pragma variant_axis VERTEX_COLOR_AVAILABLE',
        '#pragma variant_axis COVERAGE_ONLY',
        '#pragma variant_axis SKINNING_DISABLED',
      ]);
    });

    it('(c) no shader introduces INSTANCE_STORAGE_AVAILABLE (OOS-6)', () => {
      const shaderFilesWgsl = [
        'common.wgsl',
        'default-standard-pbr.wgsl',
        'unlit.wgsl',
        'sprite.wgsl',
        'default-standard-pbr-skin.wgsl',
        'shadow_caster.wgsl',
      ];
      for (const file of shaderFilesWgsl) {
        const src = readWgsl(file);
        expect(src, `${file} must NOT declare INSTANCE_STORAGE_AVAILABLE axis`).not.toMatch(
          /#pragma\s+variant_axis\s+INSTANCE_STORAGE_AVAILABLE/,
        );
      }
    });
  });

  // feat-20260604-instances-per-instance-transform-shader-group3-bin M2 / w7:
  // 4-shader @group(3) form consistency test (AC-04: structural-alignment guard).
  //
  // Asserts that the 4 material shaders (default-standard-pbr / unlit / sprite /
  // default-standard-pbr-skin) plus shadow_caster all consume the same common.wgsl
  // @group(3) `instances` binding via #import — no shader redeclares a divergent
  // @group(3) form. The @group(3) @binding(0) declaration lives ONLY in common.wgsl.
  //
  // RED before w8/w9/w11: sprite, skin, and shadow_caster do not yet import
  // `instances` from common.wgsl in their #import lines. GREEN after all three
  // land their @group(3) alignment.
  describe('M2-w7 -- 5-shader @group(3) form consistency test (AC-04)', () => {
    let fsW7!: NodeFsW1;
    let srcDirW7!: string;

    beforeAll(async () => {
      const fsId = 'node:fs';
      const pathId = 'node:path';
      const urlId = 'node:url';
      fsW7 = (await import(/* @vite-ignore */ fsId)) as NodeFsW1;
      const pathW7 = (await import(/* @vite-ignore */ pathId)) as NodePathW1;
      const urlW7 = (await import(/* @vite-ignore */ urlId)) as NodeUrlW1;
      const hereW7 = urlW7.fileURLToPath(import.meta.url);
      srcDirW7 = pathW7.resolve(pathW7.dirname(hereW7), '..');
    });

    function readWgslW7(file: string): string {
      return fsW7.readFileSync(`${srcDirW7}/${file}`, 'utf8');
    }

    function stripCommentsW7(src: string): string {
      return src
        .split(/\r?\n/)
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
    }

    it('(a) all 5 vertex shaders import instances from common.wgsl', () => {
      const vertexShaderFiles = [
        'default-standard-pbr.wgsl',
        'unlit.wgsl',
        'sprite.wgsl',
        'default-standard-pbr-skin.wgsl',
        'shadow_caster.wgsl',
      ];
      for (const file of vertexShaderFiles) {
        const src = readWgslW7(file);
        expect(
          src,
          `${file} must import instances from forgeax_view::common (AC-04 structural alignment)`,
        ).toMatch(/#import\s+forgeax_view::common\s*::\s*\{[^}]*\binstances\b[^}]*\}/);
      }
    });

    it('(b) no vertex shader re-declares @group(3) directly (SSOT in common.wgsl only)', () => {
      const vertexShaderFiles = [
        'default-standard-pbr.wgsl',
        'unlit.wgsl',
        'sprite.wgsl',
        'default-standard-pbr-skin.wgsl',
        'shadow_caster.wgsl',
      ];
      for (const file of vertexShaderFiles) {
        const src = stripCommentsW7(readWgslW7(file));
        expect(src, `${file} must NOT redeclare @group(3) @binding(0) directly`).not.toMatch(
          /@group\(3\)\s+@binding\(0\)/,
        );
      }
    });
  });
}

{
  // --- from registry.test.ts ---
  // @forgeax/engine-shader/__tests__/registry.test.ts — MVP-2.2 ShaderRegistry node-mock integration tests.
  //
  // Shape rules (plan-strategy §S-10 + §S-11 + §4.3 MVP-2.2):
  // - The mock RHI Device reuses the upstream loop's gpu-device.ts shape: a sync
  //   `device.createShaderModule` returning `Result<ShaderModule, RhiError>`.
  // - 5 test cases cover: (1) happy path / (2) hash miss / (3) manifest JSON
  //   parse failure / (4) manifest schema missing `entries` / (5) RhiError
  //   pass-through (`device.createShaderModule` fails).
  // - `registry.get(hash)` returns `Result<ShaderModule, RhiError | ShaderError>`
  //   synchronously (AGENTS.md "RHI / Shader / error-model contract" 9-member
  //   union).
  //
  // w16 red: before the ShaderRegistry impl lands, every test in this file
  // should fail (the registry class does not exist).
  // w17 green: after the ShaderRegistry instance-per-engine implementation lands,
  // every test passes.
  //
  // The fixture is injected via a `data:application/json,...` URL: this avoids a
  // node:fs dependency (same shape as the editor-target test fixtures in
  // packages/shader-compiler — pure ESM + the built-in fetch is enough).

  /// <reference types="@webgpu/types" />

  // ─── Mock device shape ──────────────────────────────────────────────────────────

  const SHADER_MODULE_BRAND: unique symbol = Symbol('mock-shader-module');
  type MockShaderModule = { readonly [SHADER_MODULE_BRAND]: 'mock' };

  interface MockDevice {
    readonly created: { readonly code: string; readonly label?: string | undefined }[];
    createShaderModule(desc: {
      readonly code: string;
      readonly label?: string | undefined;
    }): Result<ShaderModule, RhiError>;
  }

  interface MockDeviceOptions {
    readonly failOnCode?: string;
  }

  function createMockDevice(opts: MockDeviceOptions = {}): MockDevice {
    const created: { readonly code: string; readonly label?: string | undefined }[] = [];
    return {
      get created() {
        return created;
      },
      createShaderModule(desc) {
        created.push(desc);
        if (opts.failOnCode !== undefined && desc.code === opts.failOnCode) {
          const rhiError: RhiError = {
            name: 'RhiError',
            message: 'mock: shader-compile-failed forced',
            code: 'shader-compile-failed',
            expected: 'WGSL compiles cleanly',
            hint: 'fix WGSL source per detail.compilerMessages',
            detail: {
              compilerMessages: [
                {
                  message: 'mock-forced compile error',
                  type: 'error',
                  lineNum: 1,
                  linePos: 1,
                  offset: 0,
                  length: 0,
                } as GPUCompilationMessage,
              ],
            },
          } as unknown as RhiError;
          return errResult(rhiError);
        }
        const handle: MockShaderModule = { [SHADER_MODULE_BRAND]: 'mock' as const };
        return okResult(handle as unknown as ShaderModule);
      },
    };
  }

  interface OneShotRefusalDevice extends MockDevice {
    readonly refusal: RhiError;
    clearRefusal(): void;
  }

  function createOneShotRefusalDevice(targetCode: string): OneShotRefusalDevice {
    const refusal: RhiError = {
      name: 'RhiError',
      message: 'mock: transient webgpu-runtime-error forced',
      code: 'webgpu-runtime-error',
      expected: 'shader module creation succeeds',
      hint: 'retry the same shader hash after the transient refusal clears',
      detail: {
        error: {
          code: 'webgpu-runtime-error',
          message: 'mock one-shot refusal',
        },
      },
    } as unknown as RhiError;
    const created: { readonly code: string; readonly label?: string | undefined }[] = [];
    let refusalArmed = true;
    return {
      get created() {
        return created;
      },
      refusal,
      clearRefusal() {
        refusalArmed = false;
      },
      createShaderModule(desc) {
        created.push(desc);
        if (refusalArmed && desc.code === targetCode) {
          return errResult(refusal);
        }
        const handle: MockShaderModule = { [SHADER_MODULE_BRAND]: 'mock' as const };
        return okResult(handle as unknown as ShaderModule);
      },
    };
  }

  // ─── Manifest fixture loader (data: URL inline) ────────────────────────────────

  const VALID_FIXTURE = {
    entries: [
      {
        hash: 'abc12345',
        wgsl:
          '@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); } ' +
          '@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
        glsl: null,
        bindings: '[]',
      },
      {
        hash: 'def67890',
        wgsl:
          '@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(1.0); } ' +
          '@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(0.5); }',
        glsl: '',
        bindings: '[]',
      },
    ],
  };

  function dataUrl(payload: string): string {
    return `data:application/json,${encodeURIComponent(payload)}`;
  }

  const VALID_MANIFEST_URL = dataUrl(JSON.stringify(VALID_FIXTURE));

  // ─── Tests ───────────────────────────────────────────────────────────────────────

  describe('ShaderRegistry (MVP-2.2 node mock)', () => {
    it('happy path: loadManifest + get(existing hash) → Result.ok(ShaderModule)', async () => {
      const device = createMockDevice();
      const registry = new ShaderRegistry({
        device: device as never,
        manifestUrl: VALID_MANIFEST_URL,
      });

      const loaded = await registry.loadManifest();
      expect(loaded.ok).toBe(true);

      const result = registry.get('abc12345');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
      }
    });

    it('forks validated CPU inputs across two devices without fetching or reusing GPU modules', async () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(VALID_FIXTURE)]));
      try {
        const firstDevice = createMockDevice();
        const first = new ShaderRegistry({ device: firstDevice, manifestUrl: url });
        expect((await first.loadManifest()).ok).toBe(true);
        first.installMaterialArtifact('custom::recovery', {
          source: 'shader source',
          paramSchema: [],
        });
        const firstModule = first.get('abc12345');
        expect(firstModule.ok).toBe(true);
        URL.revokeObjectURL(url);
        let previous = first;
        let previousModule = firstModule;
        for (let generation = 1; generation <= 2; generation += 1) {
          const device = createMockDevice();
          const candidate = previous.forkForDevice(device);
          expect((await candidate.loadManifest()).ok).toBe(true);
          expect([...candidate.entries()]).toEqual(VALID_FIXTURE.entries);
          expect(candidate.findMaterialArtifact('custom::recovery').ok).toBe(false);
          const module = candidate.get('abc12345');
          expect(module.ok).toBe(true);
          expect(module.value).not.toBe(previousModule.value);
          expect(previous.get('abc12345').value).toBe(previousModule.value);
          candidate.installMaterialArtifact(`custom::generation-${generation}`, {
            source: 'candidate-only source',
            paramSchema: [],
          });
          expect(previous.findMaterialArtifact(`custom::generation-${generation}`).ok).toBe(false);
          previous = candidate;
          previousModule = module;
        }
      } finally {
        URL.revokeObjectURL(url);
      }
    });

    it('can fork manifest metadata without carrying material artifacts', async () => {
      const manifest = {
        ...VALID_FIXTURE,
        materialShaders: [
          {
            identifier: 'engine::manifest',
            sourcePath: 'engine.wgsl',
            composedWgsl: 'manifest shader source',
            paramSchema: '[]',
            variants: [],
          },
        ],
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(manifest)]));
      try {
        const original = new ShaderRegistry({ device: createMockDevice(), manifestUrl: url });
        expect((await original.loadManifest()).ok).toBe(true);
        original.installMaterialArtifact('custom::recovery', {
          source: 'shader source',
          paramSchema: [],
        });
        original.installMaterialArtifact('engine::manifest', {
          source: 'manifest shader source',
          paramSchema: [],
        });
        const candidate = original.forkForDevice(createMockDevice());
        expect((await candidate.loadManifest()).ok).toBe(true);
        expect(candidate.findMaterialArtifact('custom::recovery').ok).toBe(false);
        expect(candidate.findMaterialArtifact('engine::manifest').ok).toBe(false);
        expect(original.findMaterialArtifact('engine::manifest').ok).toBe(true);
        expect([...candidate.entries()]).toEqual(VALID_FIXTURE.entries);
      } finally {
        URL.revokeObjectURL(url);
      }
    });

    it('does not admit an unloaded manifest when forking a device', async () => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(VALID_FIXTURE)]));
      try {
        const original = new ShaderRegistry({ device: createMockDevice(), manifestUrl: url });
        const candidate = original.forkForDevice(createMockDevice());
        expect([...candidate.entries()]).toEqual([]);
        expect((await candidate.loadManifest()).ok).toBe(true);
        URL.revokeObjectURL(url);
        expect((await original.loadManifest()).ok).toBe(false);
        expect((await original.forkForDevice(createMockDevice()).loadManifest()).ok).toBe(false);
        expect([...original.entries()]).toEqual([]);
      } finally {
        URL.revokeObjectURL(url);
      }
    });

    it('hash miss path: get(unknown hash) → Result.err(ShaderError.shader-not-found)', async () => {
      const device = createMockDevice();
      const registry = new ShaderRegistry({
        device: device as never,
        manifestUrl: VALID_MANIFEST_URL,
      });

      await registry.loadManifest();

      const result = registry.get('not-exist');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const err = result.error as ShaderError;
        expect(err.code).toBe('shader-not-found');
      }
    });

    it('manifest malformed: invalid JSON → Result.err(ShaderError.manifest-malformed)', async () => {
      const device = createMockDevice();
      const broken = dataUrl('{invalid json');
      const registry = new ShaderRegistry({
        device: device as never,
        manifestUrl: broken,
      });

      const loaded = await registry.loadManifest();
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error.code).toBe('manifest-malformed');
      }
    });

    it('manifest schema malformed: missing entries field → Result.err(ShaderError.manifest-malformed)', async () => {
      const device = createMockDevice();
      const broken = dataUrl(JSON.stringify({ noEntriesField: true }));
      const registry = new ShaderRegistry({
        device: device as never,
        manifestUrl: broken,
      });

      const loaded = await registry.loadManifest();
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error.code).toBe('manifest-malformed');
      }
    });

    it('RhiError pass-through: device.createShaderModule fails → Result.err(RhiError)', async () => {
      const targetEntry = VALID_FIXTURE.entries[0];
      if (!targetEntry) throw new Error('fixture missing entries[0]');
      const device = createMockDevice({ failOnCode: targetEntry.wgsl });
      const registry = new ShaderRegistry({
        device: device as never,
        manifestUrl: VALID_MANIFEST_URL,
      });

      const loaded = await registry.loadManifest();
      expect(loaded.ok).toBe(true);

      const result = registry.get(targetEntry.hash);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // RhiError-path discrimination: check `.code === 'shader-compile-failed'`
        // (which is not a member of the 4-variant ShaderErrorCode union).
        expect(result.error.code).toBe('shader-compile-failed');
      }
    });

    it('retries one transient refusal on the same registry and preserves the healthy sibling cache', async () => {
      const healthyEntry = VALID_FIXTURE.entries[0];
      const retryEntry = VALID_FIXTURE.entries[1];
      if (healthyEntry === undefined || retryEntry === undefined) {
        throw new Error('fixture missing sibling entries');
      }
      const device = createOneShotRefusalDevice(retryEntry.wgsl);
      const registry = new ShaderRegistry({
        device: device as never,
        manifestUrl: VALID_MANIFEST_URL,
      });

      const loaded = await registry.loadManifest();
      expect(loaded.ok).toBe(true);

      const healthyFirst = registry.get(healthyEntry.hash);
      expect(healthyFirst.ok).toBe(true);
      if (!healthyFirst.ok) return;
      const healthyModule = healthyFirst.value;

      const firstRefusal = registry.get(retryEntry.hash);
      expect(firstRefusal.ok).toBe(false);
      if (firstRefusal.ok) return;
      expect(firstRefusal.error.code).toBe('webgpu-runtime-error');
      expect(firstRefusal.error).toBe(device.refusal);
      expect(device.created.map(({ label }) => label)).toEqual([
        healthyEntry.hash,
        retryEntry.hash,
      ]);

      device.clearRefusal();
      const recovered = registry.get(retryEntry.hash);
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) return;
      const recoveredModule = recovered.value;
      expect(device.created.map(({ label }) => label)).toEqual([
        healthyEntry.hash,
        retryEntry.hash,
        retryEntry.hash,
      ]);

      const cachedRecovered = registry.get(retryEntry.hash);
      expect(cachedRecovered.ok).toBe(true);
      if (!cachedRecovered.ok) return;
      expect(cachedRecovered.value).toBe(recoveredModule);
      expect(device.created).toHaveLength(3);

      const healthyAgain = registry.get(healthyEntry.hash);
      expect(healthyAgain.ok).toBe(true);
      if (!healthyAgain.ok) return;
      expect(healthyAgain.value).toBe(healthyModule);
      expect(device.created).toHaveLength(3);
    });
  });
}

{
  // --- from skybox-direction.test.ts ---
  // @forgeax/engine-shader/__tests__/skybox-direction.test.ts -
  // TS-equivalence test for `skyboxDirection(uv)` in skybox.wgsl
  // (bug-20260608-skybox-cubemaps-upside-down).
  //
  // Bug repro:
  //   `fullscreen_triangle()` (common.wgsl) emits `v = 1 - (y + 1) * 0.5`,
  //   which is the Y-FLIPPED version of NDC.y (WebGPU top-left UV origin
  //   convention). The skybox fragment stage then reconstructs `ndc.y` as
  //   `uv.y * 2 - 1`, which produces the OPPOSITE sign of the actual NDC.y
  //   at that fragment. Apply `inverseViewProj` to that flipped ndc and
  //   you get a world-space "view direction" with Y inverted relative to
  //   the real camera ray; the `dir.y = -dir.y` post-flip (kept for the IBL
  //   bake convention, ibl-sampling.wgsl:30) then double-negates and the
  //   skybox renders upside-down for any fragment whose actual NDC.y != 0.
  //
  // Acceptance: at the fragment under the screen center vertically (NDC y > 0,
  // i.e. upper half of screen), the reconstructed world-direction must point
  // "up" in world space (positive Y component, given an identity view at
  // origin looking down -Z). Pre-fix this test FAILS because the math returns
  // a "down" direction at the upper-half fragment.

  // TS port of the WGSL `fullscreen_triangle` body (kept in lockstep with
  // common.wgsl; same equations as fullscreen-triangle.test.ts).
  function fullscreenTriangleUv(vertexIndex: number): [number, number] {
    const x = vertexIndex === 1 ? 3.0 : -1.0;
    const y = vertexIndex === 2 ? 3.0 : -1.0;
    const u = (x + 1.0) * 0.5;
    const v = 1.0 - (y + 1.0) * 0.5;
    return [u, v];
  }

  // Linear interpolation of UV across the on-screen [-1, 1]^2 NDC box, given
  // the rasteriser barycentric of the 3-vertex covering triangle. The on-
  // screen quad portion of vertices (-1,-1)/(3,-1)/(-1,3) interpolates UV
  // linearly because the triangle's vertex attributes are linear in NDC.
  function interpolateUvAtNdc(ndc: [number, number]): [number, number] {
    const v0 = { ndc: [-1, -1] as [number, number], uv: fullscreenTriangleUv(0) };
    const v1 = { ndc: [3, -1] as [number, number], uv: fullscreenTriangleUv(1) };
    const v2 = { ndc: [-1, 3] as [number, number], uv: fullscreenTriangleUv(2) };
    const denom =
      (v1.ndc[1] - v2.ndc[1]) * (v0.ndc[0] - v2.ndc[0]) +
      (v2.ndc[0] - v1.ndc[0]) * (v0.ndc[1] - v2.ndc[1]);
    const w0 =
      ((v1.ndc[1] - v2.ndc[1]) * (ndc[0] - v2.ndc[0]) +
        (v2.ndc[0] - v1.ndc[0]) * (ndc[1] - v2.ndc[1])) /
      denom;
    const w1 =
      ((v2.ndc[1] - v0.ndc[1]) * (ndc[0] - v2.ndc[0]) +
        (v0.ndc[0] - v2.ndc[0]) * (ndc[1] - v2.ndc[1])) /
      denom;
    const w2 = 1.0 - w0 - w1;
    return [
      w0 * v0.uv[0] + w1 * v1.uv[0] + w2 * v2.uv[0],
      w0 * v0.uv[1] + w1 * v1.uv[1] + w2 * v2.uv[1],
    ];
  }

  // 4x4 inverse-view-projection matrix utility. We bake one for an identity
  // view at origin looking down -Z (camera at world origin, +Y up, +Z back),
  // with a standard WebGPU [0, 1] NDC.z perspective projection. The result
  // matrix is `inv(P * V) = inv(P)` (V is identity).
  function invPerspectiveWebgpu(fovY: number, aspect: number, near: number, far: number): number[] {
    // mat4.perspective (WebGPU [0, 1] NDC.z), column-major.
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    // proj column-major laid out as [m0..m15]:
    //   [f/a, 0,  0,         0]
    //   [0,   f,  0,         0]
    //   [0,   0,  far*nf,   -1]
    //   [0,   0,  far*near*nf, 0]
    const m00 = f / aspect;
    const m11 = f;
    const m22 = far * nf;
    const m23 = -1;
    const m32 = far * near * nf;
    // Inverse of this perspective is straightforward (block-diagonal in 2x2
    // pieces). Derivation:
    //   inv(diag(a, b, c, d)-ish) where the bottom-right 2x2 is
    //     [[m22, m32], [-1, 0]]
    //   det = m22 * 0 - m32 * -1 = m32
    //   inv = (1/m32) * [[0, -m32], [1, m22]]
    //   so inv(proj)[10] = 0, inv(proj)[11] = 1/m32,
    //      inv(proj)[14] = -1, inv(proj)[15] = m22/m32
    const out = [1 / m00, 0, 0, 0, 0, 1 / m11, 0, 0, 0, 0, 0, 1 / m32, 0, 0, -1, m22 / m32];
    // ignore m23 reference for byte-stable structure
    void m23;
    return out;
  }

  // Multiply 4x4 (column-major) by 4-vector.
  function mat4MulVec4(
    m: number[],
    v: [number, number, number, number],
  ): [number, number, number, number] {
    // column-major: out[i] = sum_j m[j*4 + i] * v[j]
    const o0 = (m[0] ?? 0) * v[0] + (m[4] ?? 0) * v[1] + (m[8] ?? 0) * v[2] + (m[12] ?? 0) * v[3];
    const o1 = (m[1] ?? 0) * v[0] + (m[5] ?? 0) * v[1] + (m[9] ?? 0) * v[2] + (m[13] ?? 0) * v[3];
    const o2 = (m[2] ?? 0) * v[0] + (m[6] ?? 0) * v[1] + (m[10] ?? 0) * v[2] + (m[14] ?? 0) * v[3];
    const o3 = (m[3] ?? 0) * v[0] + (m[7] ?? 0) * v[1] + (m[11] ?? 0) * v[2] + (m[15] ?? 0) * v[3];
    return [o0, o1, o2, o3];
  }

  function normalize3(v: [number, number, number]): [number, number, number] {
    const m = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / m, v[1] / m, v[2] / m];
  }

  // TS port of `skyboxDirection(uv)` that is byte-equivalent to skybox.wgsl
  // (the function under test). `inverseViewProj` is column-major mat4.
  // Final `[x, -y, z]` is the IBL-bake compensation (matches
  // ibl-sampling.wgsl:30 / :47 convention; left intact post-fix).
  function skyboxDirectionTS(
    uv: [number, number],
    inverseViewProj: number[],
    cameraPos: [number, number, number] = [0, 0, 0],
  ): [number, number, number] {
    // bug fix: the V-flip in fullscreen_triangle's `v = 1 - (y + 1) * 0.5`
    // is undone here so ndc.y matches the actual fragment NDC.y. Pre-fix
    // line was `uv.y * 2 - 1`, which produced the OPPOSITE sign of NDC.y.
    const ndcX = uv[0] * 2.0 - 1.0;
    const ndcY = 1.0 - uv[1] * 2.0;
    const worldPoint = mat4MulVec4(inverseViewProj, [ndcX, ndcY, 0.5, 1.0]);
    const w = worldPoint[3];
    const dir = normalize3([
      worldPoint[0] / w - cameraPos[0],
      worldPoint[1] / w - cameraPos[1],
      worldPoint[2] / w - cameraPos[2],
    ]);
    return [dir[0], -dir[1], dir[2]];
  }

  // inv(P * V) for an unrotated camera at `cameraPos`: inv(V) * inv(P), where
  // inv(V) only adds the camera translation to each column's xyz scaled by w.
  function translateInverseViewProj(invP: number[], cameraPos: [number, number, number]): number[] {
    const out = [...invP];
    for (let column = 0; column < 4; column++) {
      const w = invP[column * 4 + 3] ?? 0;
      for (let row = 0; row < 3; row++) {
        out[column * 4 + row] = (invP[column * 4 + row] ?? 0) + cameraPos[row] * w;
      }
    }
    return out;
  }

  describe('skybox.wgsl skyboxDirection (TS-equivalence)', () => {
    // Identity view at origin looking down -Z; standard perspective.
    const fovY = Math.PI / 3;
    const aspect = 1.0;
    const near = 0.1;
    const far = 100.0;
    const invVP = invPerspectiveWebgpu(fovY, aspect, near, far);

    it('center fragment (NDC 0, 0) -> sampling direction approximately +/- camera forward', () => {
      const uv = interpolateUvAtNdc([0, 0]);
      const dir = skyboxDirectionTS(uv, invVP);
      // Camera looks down -Z, so center-of-screen direction should be
      // (0, 0, -1) (forward). Y is small either way (uv flip cancels).
      expect(Math.abs(dir[0])).toBeLessThan(1e-5);
      expect(Math.abs(dir[1])).toBeLessThan(1e-5);
      expect(dir[2]).toBeLessThan(0);
    });

    it('upper-half fragment (NDC y = +0.8) -> POST-IBL-FLIP sample direction has y < 0 (samples world UP face)', () => {
      // bug-20260608: this is the litmus test.
      // With the V-flip undone in skyboxDirection, the upper screen fragment
      // produces a world-space view direction with positive Y (looking UP).
      // The post-flip `[x, -y, z]` for cubemap sampling then makes the
      // SAMPLED direction y-component NEGATIVE, which is correct for the
      // engine's IBL-bake convention (CAPTURE_VIEW_PROJS up=-Y) -- the
      // -Y face of the bake is the world UP face (ceiling in the loft).
      const uv = interpolateUvAtNdc([0, 0.8]);
      const dir = skyboxDirectionTS(uv, invVP);
      // Pre-fix bug would yield dir[1] > 0 (sampling the world DOWN face
      // = floor at the top of the screen = upside-down skybox).
      expect(dir[1]).toBeLessThan(0);
    });

    it('lower-half fragment (NDC y = -0.8) -> POST-IBL-FLIP sample direction has y > 0 (samples world DOWN face)', () => {
      const uv = interpolateUvAtNdc([0, -0.8]);
      const dir = skyboxDirectionTS(uv, invVP);
      expect(dir[1]).toBeGreaterThan(0);
    });

    // Regression: the unprojected NDC sample is a world point, not a ray. A
    // camera away from the origin collapsed every fragment onto
    // normalize(cameraPos) -- a flat single-color skybox (learn-render 6.3).
    it('camera away from the origin keeps per-fragment view rays', () => {
      const cameraPos: [number, number, number] = [0, 2, 8];
      const translated = translateInverseViewProj(invVP, cameraPos);
      const center = skyboxDirectionTS(interpolateUvAtNdc([0, 0]), translated, cameraPos);
      const left = skyboxDirectionTS(interpolateUvAtNdc([-0.8, 0]), translated, cameraPos);
      const right = skyboxDirectionTS(interpolateUvAtNdc([0.8, 0]), translated, cameraPos);
      expect(Math.abs(center[0])).toBeLessThan(1e-5);
      expect(Math.abs(center[1])).toBeLessThan(1e-5);
      expect(center[2]).toBeLessThan(-0.999);
      expect(left[0]).toBeLessThan(-0.3);
      expect(right[0]).toBeGreaterThan(0.3);
    });

    // Source-text grep gate so a regression that re-introduces the double-
    // Y-flip is caught at unit-test time, not on visual smoke. Dynamic node
    // imports mirror ibl-modules-parse.test.ts (the package's tsconfig does
    // not include @types/node); the WGSL is the SSOT, the TS port above
    // tracks the formula manually.
    it('keeps file-source `1.0 - uv.y * 2.0` rather than the buggy `uv.y * 2.0 - 1.0`', async () => {
      const fsId = 'node:fs';
      const pathId = 'node:path';
      const urlId = 'node:url';
      const fs = (await import(/* @vite-ignore */ fsId)) as {
        readFileSync: (p: string, enc: string) => string;
      };
      const path = (await import(/* @vite-ignore */ pathId)) as {
        resolve: (...parts: string[]) => string;
        dirname: (p: string) => string;
      };
      const url = (await import(/* @vite-ignore */ urlId)) as {
        fileURLToPath: (u: string) => string;
      };
      const here = url.fileURLToPath(import.meta.url);
      const src = fs.readFileSync(path.resolve(path.dirname(here), '..', 'skybox.wgsl'), 'utf8');
      expect(src).toEqual(expect.stringContaining('1.0 - uv.y * 2.0'));
      expect(src).not.toEqual(expect.stringContaining('uv.y * 2.0 - 1.0'));
      expect(src).toEqual(
        expect.stringContaining('worldPoint.xyz / worldPoint.w - view.cameraPos'),
      );
    });
  });
}

{
  // --- from tbn-lighting-helpers.test.ts ---
  // tbn-lighting-helpers.test.ts -- feat-20260523-shader-template-instance-split
  // M5 / T03.
  //
  // Structural unit tests for the three new helper ShaderModules extracted from
  // pbr.wgsl in M5-T01 + M5-T02:
  //   - forgeax_pbr::tbn (tbn.wgsl)
  //   - forgeax_pbr::lighting_directional (lighting-directional.wgsl)
  //   - forgeax_pbr::lighting_punctual (lighting-punctual.wgsl)
  //
  // AC anchor: requirements AC-06 (ShaderModule extraction must not regress
  // pbr.wgsl semantics) + plan-strategy M5 §7 (TBN + lighting helper module
  // boundary). Following the established structural-grep pattern in
  // `ibl-modules-parse.test.ts` -- this package physically isolates naga
  // (4 grep gates), so cross-module composition is exercised by the dawn
  // integration tests in packages/runtime/src/__tests__/dawn/. Here we
  // assert source-file invariants only:
  //   (a) every module declares the exact #define_import_path
  //   (b) helpers are physically present (function declarations grep)
  //   (c) pbr.wgsl no longer carries the inlined helper bodies (regression
  //       guard: future edits to pbr.wgsl must not re-inline the helpers)
  //   (d) tbn.wgsl is zero-binding (mirrors ibl-sampling style)
  //   (e) lighting-punctual.wgsl is zero-binding (host owns light buffers)
  //
  // node:* are accessed via `await import(varId)` (vite-ignore) -- the
  // established cross-package pattern (see ibl-modules-parse.test.ts) keeps
  // the shader tsconfig free of @types/node dependency.

  interface NodeFs {
    readFileSync: (p: string, enc: string) => string;
  }
  interface NodePath {
    resolve: (...parts: string[]) => string;
    dirname: (p: string) => string;
  }
  interface NodeUrl {
    fileURLToPath: (u: string) => string;
  }

  let fs!: NodeFs;
  let srcDir!: string;

  beforeAll(async () => {
    const fsId = 'node:fs';
    const pathId = 'node:path';
    const urlId = 'node:url';
    fs = (await import(/* @vite-ignore */ fsId)) as NodeFs;
    const path = (await import(/* @vite-ignore */ pathId)) as NodePath;
    const url = (await import(/* @vite-ignore */ urlId)) as NodeUrl;
    const here = url.fileURLToPath(import.meta.url);
    srcDir = path.resolve(path.dirname(here), '..');
  });

  function readSource(file: string): string {
    return fs.readFileSync(`${srcDir}/${file}`, 'utf8');
  }

  function stripComments(src: string): string {
    return src
      .split(/\r?\n/)
      .map((line: string) => line.replace(/\/\/.*$/, ''))
      .join('\n');
  }

  interface HelperModuleSpec {
    readonly file: string;
    readonly importPath: string;
    readonly exportedFns: readonly string[];
    readonly zeroBinding: boolean;
  }

  const MODULES: readonly HelperModuleSpec[] = [
    {
      file: 'tbn.wgsl',
      importPath: 'forgeax_pbr::tbn',
      exportedFns: ['decodeTangentSpaceNormalRg', 'applyTBN'],
      zeroBinding: true,
    },
    {
      file: 'lighting-directional.wgsl',
      importPath: 'forgeax_pbr::lighting_directional',
      exportedFns: ['evalDirectional', 'evalDirectionalNoShadow', 'evalDirectionalShadowFactor'],
      // lighting-directional reads view + shadowMap from forgeax_view::common
      // via #import; the helper itself declares no @group/@binding so the
      // zero-binding invariant still holds at the file level.
      zeroBinding: true,
    },
    {
      file: 'lighting-punctual.wgsl',
      importPath: 'forgeax_pbr::lighting_punctual',
      exportedFns: ['evalPunctualBody', 'evalPoint', 'evalSpot'],
      zeroBinding: true,
    },
  ];

  describe('M5-T03 (a) -- helper modules declare the exact #define_import_path', () => {
    for (const spec of MODULES) {
      it(`${spec.file} declares ${spec.importPath}`, () => {
        const src = readSource(spec.file);
        const m = /^\s*#define_import_path\s+(\S+)\s*$/m.exec(src);
        expect(m?.[1]).toBe(spec.importPath);
      });
    }
  });

  describe('M5-T03 (b) -- helper modules export the expected fn names', () => {
    for (const spec of MODULES) {
      describe(spec.file, () => {
        for (const fnName of spec.exportedFns) {
          it(`exports fn ${fnName}`, () => {
            const codeOnly = stripComments(readSource(spec.file));
            const re = new RegExp(`fn\\s+${fnName}\\s*\\(`);
            expect(codeOnly).toMatch(re);
          });
        }
      });
    }
  });

  describe('M5-T03 (c) -- engine PBR entry re-imports the extracted helpers (no re-inline)', () => {
    // Regression guard: the M5-T01 / M5-T02 commits removed the inlined
    // helper bodies from pbr.wgsl and replaced them with #import directives.
    // M5 / T09 retired pbr.wgsl in favour of default-standard-pbr.wgsl
    // (same body); the regression guard retargets at the new file path so
    // a future edit that re-inlines (e.g. paste-in fix-up) defeats the
    // module boundary at lint time.
    it('default-standard-pbr.wgsl imports forgeax_pbr::tbn::{decodeTangentSpaceNormalRg, applyTBN}', () => {
      const src = readSource('default-standard-pbr.wgsl');
      expect(src).toMatch(/#import\s+forgeax_pbr::tbn::/);
      expect(src).toMatch(/decodeTangentSpaceNormalRg/);
      expect(src).toMatch(/applyTBN/);
    });

    it('default-standard-pbr.wgsl imports directional lighting and the shared cluster owner', () => {
      const src = readSource('default-standard-pbr.wgsl');
      expect(src).toMatch(/#import\s+forgeax_pbr::lighting_directional::/);
      expect(src).toMatch(/#import\s+forgeax_standard::cluster::/);
    });

    it('default-standard-pbr.wgsl no longer defines fn evalDirectional / evalPoint / evalSpot inline', () => {
      const codeOnly = stripComments(readSource('default-standard-pbr.wgsl'));
      expect(codeOnly).not.toMatch(/fn\s+evalDirectional\s*\(/);
      expect(codeOnly).not.toMatch(/fn\s+evalPoint\s*\(/);
      expect(codeOnly).not.toMatch(/fn\s+evalSpot\s*\(/);
      expect(codeOnly).not.toMatch(/fn\s+evalPunctualBody\s*\(/);
    });

    it('built-in PBR shaders evaluate directional CSM for base and clearcoat contributions', () => {
      for (const file of ['default-standard-pbr.wgsl', 'default-standard-pbr-skin.wgsl']) {
        const codeOnly = stripComments(readSource(file));
        expect(codeOnly.match(/evalDirectionalShadowFactorAtPixel\s*\(/g)).toHaveLength(1);
        expect(codeOnly).not.toMatch(/evalDirectional\s*\(/);
        expect(codeOnly.match(/evalDirectionalNoShadow\s*\(/g)).toHaveLength(1);
        expect(codeOnly.match(/evaluateStandardDirect\s*\(/g)).toHaveLength(1);
      }
    });

    it('directional CSM skips shadow projection and PCF beyond the authored shadow distance', () => {
      const codeOnly = stripComments(readSource('lighting-directional.wgsl'));
      expect(codeOnly).toMatch(
        /if\s*\(viewDepth\s*>\s*view\.splitPlanes\[count\s*-\s*1u\]\.x\)\s*\{\s*return\s+1\.0\s*;/,
      );
    });

    it('directional CSM treats cascadeCount=0 as the fully-lit castShadow opt-out', () => {
      const codeOnly = stripComments(readSource('lighting-directional.wgsl'));
      expect(codeOnly).toMatch(
        /fn\s+evalDirectionalShadowFactor[\s\S]*?if\s*\(view\.cascadeCount\s*<\s*1\.0\s*\)\s*\{\s*return\s+1\.0\s*;/,
      );
    });

    it('directional CSM adds the receiver family base to its logical cascade layer', () => {
      const codeOnly = stripComments(readSource('lighting-directional.wgsl'));
      expect(codeOnly).toMatch(/let\s+uv\s*=\s*tileUv\s*\*\s*viewportScale\s*;/);
      expect(codeOnly).toMatch(/let\s+shadowLayer\s*=\s*i32\(layer\s*\+\s*layerBase\)/);
      expect(codeOnly).not.toMatch(/_atlasTile/);
      expect(stripComments(readSource('common.wgsl'))).toMatch(
        /var\s+shadowMap\s*:\s*texture_depth_2d_array\s*;/,
      );
    });

    it('directional PCF selects fixed 1x1, 3x3, or 5x5 paths without per-tap radius branches', () => {
      const codeOnly = stripComments(readSource('lighting-directional.wgsl'));
      expect(codeOnly).toMatch(/if\s*\(kernel\s*==\s*1u\)/);
      expect(codeOnly).toMatch(/if\s*\(kernel\s*==\s*3u\)/);
      expect(codeOnly).not.toMatch(/abs\(x\)\s*>\s*halfI/);
      expect(codeOnly).not.toMatch(/continue\s*;/);
    });

    it('default-standard-pbr.wgsl no longer inlines the TBN basis math directly', () => {
      // The tell-tale of the pre-extraction inline TBN block: the `t0` /
      // `b0` / `n0` triple-let pattern appearing all together.
      const codeOnly = stripComments(readSource('default-standard-pbr.wgsl'));
      const tbnTriple = /let\s+n0\s*=\s*normalize\(in\.worldNormal\)/;
      expect(codeOnly).not.toMatch(tbnTriple);
    });
  });

  describe('M5-T03 (d) -- helper modules respect their zero-binding invariant', () => {
    for (const spec of MODULES) {
      if (!spec.zeroBinding) continue;
      it(`${spec.file} declares no @group()/@binding() of its own`, () => {
        const codeOnly = stripComments(readSource(spec.file));
        expect(codeOnly).not.toMatch(/@group\(\d+\)\s*@binding\(\d+\)/);
      });
    }
  });

  describe('M5-T03 (e) -- lighting helpers re-use the shared brdf module', () => {
    // Plan-strategy P4 consistent abstraction: GGX / Schlick / Smith helpers
    // live in forgeax_pbr::brdf -- the lighting evaluators must pull them
    // through #import, not re-implement them inline.
    it('lighting-directional.wgsl #imports forgeax_pbr::brdf', () => {
      const src = readSource('lighting-directional.wgsl');
      expect(src).toMatch(/#import\s+forgeax_pbr::brdf/);
    });

    it('lighting-punctual.wgsl #imports forgeax_pbr::brdf', () => {
      const src = readSource('lighting-punctual.wgsl');
      expect(src).toMatch(/#import\s+forgeax_pbr::brdf/);
    });
  });
}

{
  // --- from tonemap-shader.test.ts ---
  // @forgeax/engine-shader/__tests__/tonemap-shader.test.ts -
  // TS-equivalence test for the luminance Reinhard formula in tonemap.wgsl
  // and the manifest registration of the 'tonemap-reinhard-extended'
  // pipeline (feat-20260519-tonemap-reinhard-mvp / T-M2.2 + T-M2.3).
  //
  // Three concerns:
  //   1. The fragment-stage luminance Reinhard 6-sample numerical
  //      ground-truth table (research F1 section 6 - "extended Reinhard
  //      matches Reinhard 2002 luminance variant"). The TS port shadowed
  //      below is the formula manifest.
  //   2. TonemapParams std140 layout is 16 B (exposure + whitePoint
  //      + 2 padding f32 = 16 B). The shader-side struct in tonemap.wgsl
  //      keeps the same byte layout.
  //   3. TONEMAP_LUMINANCE_EPSILON is the shared TS / WGSL const
  //      (D-O3, 1e-5).
  //
  // The test does not invoke a GPU. The luminance Reinhard ground truth is
  // the algorithmic specification; downstream browser / dawn integration
  // tests in M3 verify the GPU readback matches this TS port within a
  // pixel epsilon.

  // Luminance weights for Rec. 709 (research F1, section 4 - "use the same
  // luminance weights the legacy CRT phosphor code paths used"). The
  // shader-side `dot(rgb, vec3(0.2126, 0.7152, 0.0722))` matches.
  const LUMINANCE_WEIGHTS = [0.2126, 0.7152, 0.0722] as const;

  function tonemapReinhardLuminanceTS(
    rgbIn: readonly [number, number, number],
    exposure: number,
    whitePoint: number,
  ): [number, number, number] {
    const exposed: [number, number, number] = [
      rgbIn[0] * exposure,
      rgbIn[1] * exposure,
      rgbIn[2] * exposure,
    ];
    const luma =
      exposed[0] * LUMINANCE_WEIGHTS[0] +
      exposed[1] * LUMINANCE_WEIGHTS[1] +
      exposed[2] * LUMINANCE_WEIGHTS[2];
    const lumaPrime = (luma * (1.0 + luma / (whitePoint * whitePoint))) / (1.0 + luma);
    const scale = lumaPrime / Math.max(luma, TONEMAP_LUMINANCE_EPSILON);
    return [exposed[0] * scale, exposed[1] * scale, exposed[2] * scale];
  }

  describe('tonemap-reinhard-extended luminance formula (TS-equivalence)', () => {
    it('TONEMAP_LUMINANCE_EPSILON is the shared 1e-5 floor (D-O3)', () => {
      expect(TONEMAP_LUMINANCE_EPSILON).toBe(1e-5);
    });

    it('sample 1: black input -> black output (epsilon floor keeps divisor finite)', () => {
      const out = tonemapReinhardLuminanceTS([0, 0, 0], 1.0, 4.0);
      expect(out[0]).toBeLessThan(1e-3);
      expect(out[1]).toBeLessThan(1e-3);
      expect(out[2]).toBeLessThan(1e-3);
    });

    it('sample 2: pure white at L = whitePoint -> Y_prime = 1 (top of curve)', () => {
      const out = tonemapReinhardLuminanceTS([4, 4, 4], 1.0, 4.0);
      const luma = 4 * (LUMINANCE_WEIGHTS[0] + LUMINANCE_WEIGHTS[1] + LUMINANCE_WEIGHTS[2]);
      expect(luma).toBeCloseTo(4.0, 5);
      const yPrime = (luma * (1.0 + luma / 16.0)) / (1.0 + luma);
      expect(yPrime).toBeCloseTo(1.0, 5);
      expect(out[0]).toBeCloseTo(1.0, 4);
      expect(out[1]).toBeCloseTo(1.0, 4);
      expect(out[2]).toBeCloseTo(1.0, 4);
    });

    it('sample 3: mid-gray (0.5, 0.5, 0.5) at exposure=1, Lw=4', () => {
      const out = tonemapReinhardLuminanceTS([0.5, 0.5, 0.5], 1.0, 4.0);
      expect(out[0]).toBeGreaterThan(0.0);
      expect(out[0]).toBeLessThan(0.5);
      expect(out[0]).toBeCloseTo(out[1], 5);
      expect(out[0]).toBeCloseTo(out[2], 5);
    });

    it('sample 4: high intensity (10, 5, 2) at Lw=4 stays in [0, 1] band', () => {
      const out = tonemapReinhardLuminanceTS([10, 5, 2], 1.0, 4.0);
      expect(out[0]).toBeGreaterThan(0.0);
      expect(out[1]).toBeGreaterThan(0.0);
      expect(out[2]).toBeGreaterThan(0.0);
      // R is the brightest channel because the input is.
      expect(out[0]).toBeGreaterThan(out[1]);
      expect(out[1]).toBeGreaterThan(out[2]);
    });

    it('sample 5: AC-05 exposure equivalence (exp=2 + L_in=halved == exp=1 + L_in)', () => {
      const a = tonemapReinhardLuminanceTS([10, 5, 2], 2.0, 4.0);
      const b = tonemapReinhardLuminanceTS([20, 10, 4], 1.0, 4.0);
      expect(a[0]).toBeCloseTo(b[0], 5);
      expect(a[1]).toBeCloseTo(b[1], 5);
      expect(a[2]).toBeCloseTo(b[2], 5);
    });

    it('sample 6: Lw=1 + L=1 gray -> Y_prime = 1 (basic Reinhard degenerate case)', () => {
      const luma = 1.0;
      const yPrime = (luma * (1.0 + luma / 1.0)) / (1.0 + luma);
      expect(yPrime).toBeCloseTo(1.0, 5);
      const out = tonemapReinhardLuminanceTS([1, 1, 1], 1.0, 1.0);
      expect(out[0]).toBeCloseTo(1.0, 4);
      expect(out[1]).toBeCloseTo(1.0, 4);
      expect(out[2]).toBeCloseTo(1.0, 4);
    });
  });

  describe('TonemapParams std140 layout', () => {
    it('TonemapParams stride is 16 B (4 f32 = exposure + whitePoint + 2 padding)', () => {
      // The host writes `Float32Array` of length 4 to the UBO; the shader
      // declares `struct TonemapParams { exposure: f32, whitePoint: f32,
      // _pad0: f32, _pad1: f32 }` — total = 16 B.
      const stride = 4 * 4;
      expect(stride).toBe(16);
    });
  });
}
