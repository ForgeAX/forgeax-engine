import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import { type MaterialAsset, standardSurfaceParameters } from '@forgeax/engine-types';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as compiler from '../../compile.js';
import { collectMaterialSources, createMaterialPackCooker } from '../pack-cooker.js';
import { cookRayMaterial } from '../ray-material.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

// Compiler spies observe their own realm; the Worker route has its own native contracts.
vi.hoisted(() => vi.stubEnv('FORGEAX_SHADER_COMPILE_WORKERS', '1'));
afterAll(() => vi.unstubAllEnvs());

const material: MaterialAsset = {
  kind: 'material',
  parameters: standardSurfaceParameters([{ name: 'baseColor', type: 'color' }]),
  passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
  surface: { model: 'standard', module: 'game::surface' },
};
const surface = `#define_import_path game::surface
#import forgeax_material::surface_v1::{SurfaceData, SurfaceInput}
#import game::filter::{filterWidth}
fn evaluate_surface(input : SurfaceInput) -> SurfaceData {
  let width = filterWidth(input.uv0, input.uvFootprint0);
  return SurfaceData(vec3<f32>(0.5), normalize(input.vertexNormalWS), 0.0,
    clamp(width, 0.1, 0.9), vec3<f32>(0.0), 1.0, 1.0, 0.0);
}
`;
const filter = `#define_import_path game::filter
#import game::footprint::{footprintWidth}
fn filterWidth(p : vec2<f32>, footprint : vec4<f32>) -> f32 {
  return footprintWidth(p, footprint);
}
`;
const guarded = `#ifdef RAY_SURFACE_CONTEXT
  return max(length(footprint.xy), length(footprint.zw));
#else
  return length(fwidth(p));
#endif`;

async function fixture<T>(body: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'ray-surface-derivatives-'));
  try {
    await writeFile(join(root, 'surface.wgsl'), surface);
    await writeFile(join(root, 'filter.wgsl'), filter);
    await writeFile(
      join(root, 'footprint.wgsl'),
      `#define_import_path game::footprint
fn footprintWidth(p : vec2<f32>, footprint : vec4<f32>) -> f32 {
  ${body}
}
`,
    );
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function cookRay(root: string, context: 'ray-hit' | 'raster-probe' = 'ray-hit') {
  const engine = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
  const inputs = await collectMaterialSources([root, engine], [engine]);
  const sources = buildMaterialSourceCatalog(inputs).unwrap();
  return cookRayMaterial({ material: 'game', table: { game: material }, sources, context });
}

async function cookPack(root: string) {
  const product = await createMaterialPackCooker([root]).cook({ guid: 'game', source: material });
  return validateCookedMaterialRecord((product.payload as { cooked: unknown }).cooked).unwrap();
}

afterEach(() => vi.restoreAllMocks());

describe('ray qualification of project Surface closures', { timeout: 30_000 }, () => {
  it('rejects reachable screen derivatives two imports below the selected Surface', async () => {
    await fixture('return length(fwidth(p));', async (root) => {
      const result = await cookRay(root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ray-material-unsupported');
    });
  });

  it('preserves raster publication when the optional ray closure is unsupported', async () => {
    await fixture('return length(fwidth(p));', async (root) => {
      const record = await cookPack(root);
      const selections = record.programs.flatMap((program) => program.selections);
      expect(selections.some((selection) => selection.pass === 'Forward')).toBe(true);
      expect(selections.some((selection) => selection.context.pipeline === 'ray')).toBe(false);
      expect(record.programs.some((program) => program.artifact.bytes.byteLength > 0)).toBe(true);
    });
  });

  it('compiles an actual guarded ray path and retains its publication', async () => {
    await fixture(guarded, async (root) => {
      const result = await cookRay(root);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.program.wgsl).toContain('fn cs_surface');
      const record = await cookPack(root);
      expect(
        record.programs.some((program) =>
          program.selections.some(
            (selection) =>
              selection.context.pipeline === 'ray' && selection.context.pass === 'ray-hit',
          ),
        ),
      ).toBe(true);
    });
  });

  it('admits explicit filtering and ignores derivative names in comments', async () => {
    await fixture(
      '// fwidth(p) and dpdx(p) are not executed.\nreturn length(footprint.xy);',
      async (root) => {
        expect((await cookRay(root)).ok).toBe(true);
      },
    );
  });

  it('allows screen derivatives in the fragment-only raster probe', async () => {
    await fixture('return length(fwidth(p));', async (root) => {
      const result = await cookRay(root, 'raster-probe');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.program.wgsl).toContain('fn fs_probe');
    });
  });

  it('does not accept a claimed context marker whose compute path still uses derivatives', async () => {
    await fixture(
      `#ifdef RAY_SURFACE_CONTEXT
  let ray = 1.0;
#endif
  return length(fwidth(p));`,
      async (root) => {
        const result = await cookRay(root);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('shader-compile-failed');
      },
    );
  });

  it('keeps a mandatory raster compile error fatal', async () => {
    await fixture('return nonexistentFunction(p);', async (root) => {
      await expect(cookPack(root)).rejects.toHaveProperty('code', 'shader-compile-failed');
    });
  });

  it('keeps an admitted ray compiler error fatal rather than treating it as optional rejection', async () => {
    const original = compiler.compileShaderWithComposition;
    const failure = await compiler.compileShader('invalid WGSL', { id: 'ray-rejection-control' });
    if (failure.ok) throw new Error('invalid shader control compiled');
    vi.spyOn(compiler, 'compileShaderWithComposition').mockImplementation(
      (source, options, compose) =>
        options?.id === 'forgeax_material::ray_surface::ray-hit'
          ? Promise.resolve(failure)
          : original(source, options, compose),
    );
    await fixture('return length(footprint.xy);', async (root) => {
      await expect(cookPack(root)).rejects.toBe(failure.error);
    });
  });
});
