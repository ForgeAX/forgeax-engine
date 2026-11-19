import { fileURLToPath } from 'node:url';
import {
  type MaterialAsset,
  type MaterialPass,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { cookMaterialAsset } from '../cook';
import { collectMaterialSources } from '../pack-cooker';
import { buildMaterialSourceCatalog } from '../source-catalog';
import { DEFAULT_MATERIAL_VARIANT_CONTEXT, type MaterialVariantContext } from '../variant-context';

const shaderRoot = fileURLToPath(new URL('../../../../shader/src', import.meta.url));
const collected = await collectMaterialSources([shaderRoot], [shaderRoot]);
const surface = `
#define_import_path coverage_test::surface
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData}
#import forgeax_material::parameters::{material}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(vec3<f32>(0.3), input.vertexNormalWS, 0.0, 0.7,
    vec3<f32>(0.0), 1.0, material.coverage, material.threshold, 0.0);
}
`;
const sources = buildMaterialSourceCatalog({
  engine: collected.engine,
  project: [{ path: 'coverage-test.wgsl', source: surface }],
}).unwrap();

function body(source: string, name: string): string {
  const declaration = new RegExp(`fn ${name}\\w*\\([^]*?\\n}`).exec(source)?.[0];
  expect(declaration, `missing compiled ${name}`).toBeDefined();
  return declaration ?? '';
}

async function cook(
  alphaClip: boolean,
  blend = false,
  options: {
    readonly context?: Partial<MaterialVariantContext>;
    readonly hash?: boolean;
    readonly stockCutoff?: boolean;
  } = {},
) {
  const pass = (name: string): MaterialPass => ({
    name,
    program: {
      module:
        name === 'shadow-caster'
          ? 'forgeax::default-shadow-caster'
          : options.context?.geometry === 'skinned'
            ? 'forgeax_material::pbr-skin'
            : 'forgeax_material::standard',
      moduleSlots: { surface: 'coverage_test::surface' },
    },
    ...(name === 'forward' && blend
      ? {
          renderState: {
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        }
      : {}),
  });
  const asset: MaterialAsset = {
    kind: 'material',
    staticSwitches: { alphaClipping: alphaClip, alphaHash: options.hash ?? false },
    parameters: standardSurfaceParameters([
      { name: 'coverage', type: 'f32' },
      { name: 'threshold', type: 'f32' },
    ]).filter((parameter) => options.stockCutoff !== false || parameter.name !== 'alphaCutoff'),
    values: { coverage: 0.4, threshold: 0.5 },
    passes: [pass('forward'), ...(!blend ? [pass('deferred')] : []), pass('shadow-caster')],
  };
  const cooked = await cookMaterialAsset({
    material: 'coverage',
    table: { coverage: asset },
    sources,
    context: { ...DEFAULT_MATERIAL_VARIANT_CONTEXT, ...options.context },
  });
  expect(cooked.ok, cooked.ok ? '' : JSON.stringify(cooked.error)).toBe(true);
  return cooked.unwrap();
}

describe('authored custom Surface coverage', () => {
  it.each([
    false,
    true,
  ])('compiles alphaClip=%s consistently into color, GBuffer and shadow', async (alphaClip) => {
    const cooked = await cook(alphaClip);
    expect(cooked.passes.map((pass) => pass.pass)).toEqual([
      'forward',
      'deferred',
      'shadow-caster',
    ]);
    for (const pass of cooked.passes) {
      for (const compiled of [pass.compile, pass.sceneCompile]) {
        expect(compiled).toBeDefined();
        const gate = body(
          compiled?.wgsl ?? '',
          pass.pass === 'shadow-caster' ? 'alphaTestShadowSurface' : 'alphaTestSurface',
        );
        expect(gate.includes('discard;')).toBe(alphaClip);
      }
      // Custom thresholds are Surface outputs, not the stock baseColor.a/cutoff ABI.
      expect(pass.abi.alphaMask).toEqual({ cutoff: '', source: '' });
    }
  });

  it('does not silently add threshold clipping to a blended Surface', async () => {
    const cooked = await cook(false, true);
    expect(cooked.passes.map((pass) => pass.pass)).toEqual(['forward', 'shadow-caster']);
    for (const pass of cooked.passes) {
      expect(
        body(
          pass.compile.wgsl,
          pass.pass === 'shadow-caster' ? 'alphaTestShadowSurface' : 'alphaTestSurface',
        ),
      ).not.toContain('discard;');
    }
  });

  it('honors an explicit custom threshold without stock cutoff parameters', async () => {
    const cooked = await cook(true, false, { stockCutoff: false });
    for (const pass of cooked.passes) {
      expect(pass.abi.materialRow.fields).not.toContain('alphaCutoff');
      expect(
        body(
          pass.compile.wgsl,
          pass.pass === 'shadow-caster' ? 'alphaTestShadowSurface' : 'alphaTestSurface',
        ),
      ).toContain('discard;');
    }
  });

  it('keeps explicit custom hash coverage when threshold coverage is disabled', async () => {
    const cooked = await cook(false, false, { hash: true });
    for (const pass of cooked.passes) {
      expect(
        body(
          pass.compile.wgsl,
          pass.pass === 'shadow-caster' ? 'alphaTestShadowSurface' : 'alphaTestSurface',
        ),
      ).toContain('discard;');
    }
  });

  it.each([
    'skinned',
    'uniform-fallback',
  ] as const)('preserves opaque coverage in %s programs', async (profile) => {
    const cooked = await cook(false, false, {
      context: profile === 'skinned' ? { geometry: 'skinned' } : { capability: 'uniform-fallback' },
    });
    for (const pass of cooked.passes) {
      expect(
        body(
          pass.compile.wgsl,
          pass.pass === 'shadow-caster' ? 'alphaTestShadowSurface' : 'alphaTestSurface',
        ),
      ).not.toContain('discard;');
      if (profile === 'uniform-fallback') expect(pass.sceneCompile).toBeUndefined();
      else expect(pass.sceneCompile).toBeDefined();
    }
  });
  it.each([
    'mesh',
    'skinned',
  ] as const)('publishes native view-clipping entry effects independently of alpha coverage (%s)', async (geometry) => {
    for (const enabled of [false, true]) {
      const cooked = await cook(false, false, {
        context: { geometry, ...(enabled ? { viewClipping: true as const } : {}) },
      });
      for (const pass of cooked.passes) {
        for (const compiled of [pass.compile, pass.sceneCompile]) {
          if (compiled === undefined) throw Error('Missing address program');
          const name = pass.pass === 'shadow-caster' ? 'fs_shadow' : 'fs_opaque';
          const entry = compiled.reflection.entryPoints?.find(
            (entry) => entry.stage === 'fragment' && entry.name === name,
          );
          expect(entry?.effects, `${geometry}/${pass.pass}/${name} native facts`).toBeDefined();
          expect(
            entry?.effects?.mayDiscard,
            `${geometry}/${pass.pass}/${compiled === pass.compile ? 'direct' : 'scene-index'}/${JSON.stringify(pass.context)}`,
          ).toBe(enabled);
        }
      }
    }
  });
});

it('cooks independent LOD coverage in Forward, GBuffer and shadow with native effects', async () => {
  for (const lodCoverage of [false, true])
    for (const viewClipping of [false, true]) {
      const cooked = await cook(false, false, {
        context: {
          ...(lodCoverage ? { lodCoverage: true as const } : {}),
          ...(viewClipping ? { viewClipping: true as const } : {}),
        },
      });
      for (const pass of cooked.passes)
        for (const [address, compiled] of [
          ['direct', pass.compile],
          ['scene-index', pass.sceneCompile],
        ] as const) {
          if (compiled === undefined) throw Error('Missing address program');
          const name = pass.pass === 'shadow-caster' ? 'fs_shadow' : 'fs_opaque';
          const entry = compiled.reflection.entryPoints?.find((entry) => entry.name === name);
          expect(
            entry?.effects?.mayDiscard,
            `${pass.pass}/${address}/${lodCoverage}/${viewClipping}`,
          ).toBe(viewClipping || (address === 'scene-index' && lodCoverage));
          if (!lodCoverage) expect(compiled.wgsl).not.toContain('applyLodCoverage');
          else if (address === 'scene-index') expect(compiled.wgsl).toContain('applyLodCoverage');
          expect(compiled.wgsl.includes('clippedByPlanes')).toBe(viewClipping);
        }
    }
});
