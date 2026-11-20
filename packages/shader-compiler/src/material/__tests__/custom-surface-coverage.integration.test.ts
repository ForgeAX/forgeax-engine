import { fileURLToPath } from 'node:url';
import {
  type MaterialAsset,
  type MaterialPass,
  standardSurfaceParameters,
} from '@forgeax/engine-types';
import { afterAll, describe, expect, it } from 'vitest';
import { cookMaterialAsset } from '../cook';
import { createNodeMaterialProgramCompiler } from '../node-program-compiler';
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
const compiler = createNodeMaterialProgramCompiler();
afterAll(compiler.close);

function body(source: string, name: string): string {
  const declaration = new RegExp(`fn ${name}\\w*\\([^]*?\\n}`).exec(source)?.[0];
  expect(declaration, `missing compiled ${name}`).toBeDefined();
  return declaration ?? '';
}

const opaquePasses = ['forward', 'deferred', 'shadow-caster'] as const;

async function cook(
  alphaClip: boolean,
  blend = false,
  options: {
    readonly context?: Partial<MaterialVariantContext>;
    readonly hash?: boolean;
    readonly stockCutoff?: boolean;
    readonly onlyPass?: (typeof opaquePasses)[number];
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
  const passes: NonNullable<MaterialAsset['passes']> = [
    pass('forward'),
    ...(!blend ? [pass('deferred')] : []),
    pass('shadow-caster'),
  ];
  const asset: MaterialAsset = {
    kind: 'material',
    staticSwitches: { alphaClipping: alphaClip, alphaHash: options.hash ?? false },
    parameters: standardSurfaceParameters([
      { name: 'coverage', type: 'f32' },
      { name: 'threshold', type: 'f32' },
    ]).filter((parameter) => options.stockCutoff !== false || parameter.name !== 'alphaCutoff'),
    values: { coverage: 0.4, threshold: 0.5 },
    passes,
  };
  const request = {
    material: 'coverage',
    table: { coverage: asset },
    sources,
    context: { ...DEFAULT_MATERIAL_VARIANT_CONTEXT, ...options.context },
  };
  // Each pass uses the complete material contract and the same bounded native
  // pool. The independently checked passes can occupy it together.
  const names =
    options.onlyPass === undefined ? passes.map(({ name }) => name) : [options.onlyPass];
  const cooked = await Promise.all(
    names.map((name) => cookMaterialAsset(request, compiler.compile, [name])),
  );
  return cooked.flatMap((result) => {
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    return result.unwrap().passes;
  });
}

describe('authored custom Surface coverage', () => {
  const alphaCases = opaquePasses.flatMap((onlyPass) =>
    [false, true].map((alphaClip) => ({ alphaClip, onlyPass })),
  );
  it.each(alphaCases)('compiles alphaClip=$alphaClip in $onlyPass', async ({
    alphaClip,
    onlyPass,
  }) => {
    const passes = await cook(alphaClip, false, {
      context: { capability: 'storage-buffer-minimum' },
      onlyPass,
    });
    expect(passes.map((pass) => pass.pass)).toEqual([onlyPass]);
    for (const pass of passes) {
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
    const passes = await cook(false, true);
    expect(passes.map((pass) => pass.pass)).toEqual(['forward', 'shadow-caster']);
    for (const pass of passes) {
      expect(
        body(
          pass.compile.wgsl,
          pass.pass === 'shadow-caster' ? 'alphaTestShadowSurface' : 'alphaTestSurface',
        ),
      ).not.toContain('discard;');
    }
  });

  it.each(
    opaquePasses,
  )('honors a custom threshold without stock cutoff in %s', async (onlyPass) => {
    const passes = await cook(true, false, {
      context: { capability: 'storage-buffer-minimum' },
      stockCutoff: false,
      onlyPass,
    });
    expect(passes.map((pass) => pass.pass)).toEqual([onlyPass]);
    for (const pass of passes) {
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
    const passes = await cook(false, false, { hash: true });
    for (const pass of passes) {
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
    const passes = await cook(false, false, {
      context: profile === 'skinned' ? { geometry: 'skinned' } : { capability: 'uniform-fallback' },
    });
    for (const pass of passes) {
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
  const geometryVariants = (['mesh', 'skinned'] as const).flatMap((geometry) =>
    [false, true].map((viewClipping) => ({ geometry, viewClipping })),
  );
  it.each(
    geometryVariants,
  )('publishes view clipping $viewClipping on $geometry without LOD coverage', ({
    geometry,
    viewClipping,
  }) => checkNativeCoverage({ geometry, viewClipping, lodCoverage: false }));
});

async function checkNativeCoverage({
  geometry,
  viewClipping,
  lodCoverage,
}: {
  geometry: 'mesh' | 'skinned';
  viewClipping: boolean;
  lodCoverage: boolean;
}) {
  const passes = await cook(false, false, {
    context: {
      geometry,
      ...(lodCoverage ? { lodCoverage: true as const } : {}),
      ...(viewClipping ? { viewClipping: true as const } : {}),
    },
  });
  for (const pass of passes) {
    const name = pass.pass === 'shadow-caster' ? 'fs_shadow' : 'fs_opaque';
    for (const [address, compiled] of [
      ['direct', pass.compile],
      ['scene-index', pass.sceneCompile],
    ] as const) {
      if (compiled === undefined) throw Error('Missing address program');
      const entry = compiled.reflection.entryPoints?.find(
        (entry) => entry.stage === 'fragment' && entry.name === name,
      );
      expect(
        entry?.effects?.mayDiscard,
        `${pass.pass}/${address}/${lodCoverage}/${viewClipping}`,
      ).toBe(viewClipping || (address === 'scene-index' && lodCoverage));
      if (!lodCoverage) expect(compiled.wgsl).not.toContain('applyLodCoverage');
      else if (address === 'scene-index') expect(compiled.wgsl).toContain('applyLodCoverage');
      expect(compiled.wgsl.includes('clippedByPlanes')).toBe(viewClipping);
    }
  }
}

it.each([false, true])('publishes mesh LOD coverage with view clipping %s', (viewClipping) => {
  return checkNativeCoverage({ geometry: 'mesh', viewClipping, lodCoverage: true });
});
