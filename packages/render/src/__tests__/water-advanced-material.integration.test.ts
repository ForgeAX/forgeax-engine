import { definePackageId } from '@forgeax/engine-pack/source';
import type { MaterialAsset, MaterialStaticSwitches } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { cookMaterialAsset } from '../../../shader-compiler/src/material/cook';
import {
  collectMaterialSources,
  materialShaderSourceRoots,
} from '../../../shader-compiler/src/material/pack-cooker';
import {
  buildMaterialSourceCatalog,
  type MaterialSourceCatalog,
} from '../../../shader-compiler/src/material/source-catalog';
import { buildWaterMaterialFamily } from '../../../water/src/material-family';
import { EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES } from '../prepare/extended-lighting/resources';
import { MATERIAL_UNIFORM_BYTES } from '../record/render-context';

let sources: MaterialSourceCatalog;
beforeAll(async () => {
  const roots = materialShaderSourceRoots();
  const collected = await collectMaterialSources(roots, roots);
  sources = buildMaterialSourceCatalog({
    roots,
    engine: collected.engine,
    project: collected.project,
  }).unwrap();
});

describe('stock Water advanced producer material contracts', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const)('cooks shallow=%s Ocean=%s with one bounded atlas per source field', async (shallow, ocean) => {
    const family = buildWaterMaterialFamily(
      definePackageId('019ffa97-7000-7000-8000-000000000099'),
    );
    const root = family.outputs['material/water/root'];
    if (root === undefined || !('parameters' in root)) throw new Error('missing Water root');
    const switches: MaterialStaticSwitches = {
      ...root.staticSwitches,
      waterShallowSimulation: shallow,
      waterOceanPatch: ocean,
      waterOceanDisplacement: ocean,
      waterFoam: false,
      waterOceanFoam: false,
    };
    const asset: MaterialAsset = { ...root, staticSwitches: switches };
    const cooked = (
      await cookMaterialAsset({ material: 'advanced', table: { advanced: asset }, sources })
    ).unwrap();
    const pass = cooked.passes.find((row) => row.pass === 'forward');
    if (pass === undefined || pass.sceneCompile === undefined)
      throw new Error('missing direct or scene-index Water artifact');
    expect(pass.abi.materialRow.byteLength).toBeLessThanOrEqual(MATERIAL_UNIFORM_BYTES);
    const textureParameters = pass.parameters
      .filter((parameter) => parameter.type === 'texture')
      .map((parameter) => parameter.name);
    for (const name of [
      'waterShallowGridTexture',
      'waterShallowNormalTexture',
      'waterShallowFoamTexture',
      'waterShallowMappingTexture',
    ])
      expect(textureParameters.includes(name)).toBe(shallow);
    expect(textureParameters.includes('waterOceanPatchTexture')).toBe(ocean);
    expect(textureParameters).not.toContain('waterVolumeNoiseTexture');
    expect(textureParameters.some((name) => /previous/i.test(name))).toBe(false);
    for (const compiled of [pass.compile, pass.sceneCompile]) {
      const globals = compiled.reflection.boundGlobals;
      expect(new Set(globals.map((row) => `${row.group}:${row.binding}`)).size).toBe(
        globals.length,
      );
      for (const point of compiled.reflection.entryPoints ?? []) {
        const reads = new Set(point.bindings.map((row) => `${row.group}:${row.binding}`));
        const textures = globals.filter(
          (row) =>
            row.resourceKind === 'texture' &&
            row.textureClass === 'sampled' &&
            reads.has(`${row.group}:${row.binding}`),
        );
        expect(
          textures.length,
          `${point.stage} ${point.name} sampled textures`,
        ).toBeLessThanOrEqual(EXTENDED_LIGHTING_REQUIRED_SAMPLED_TEXTURES);
      }
    }
  });

  it('compiles the visual-normal source only for the opted-in fragment surface', async () => {
    const family = buildWaterMaterialFamily(
      definePackageId('019ffa97-7000-7000-8000-000000000099'),
    );
    const sourceRoot = family.outputs['material/water/root'];
    if (sourceRoot === undefined || !('parameters' in sourceRoot))
      throw new Error('missing Water root');
    const root: MaterialAsset = {
      ...sourceRoot,
      staticSwitches: {
        ...sourceRoot.staticSwitches,
        waterVisualNormalDetail: true,
        waterShallowSimulation: true,
        waterFoam: false,
        waterOceanFoam: false,
        waterNormalTexture: false,
        waterFlowmap: false,
      },
    };
    const cooked = (
      await cookMaterialAsset({
        material: 'visual-detail',
        table: { 'visual-detail': root },
        sources,
      })
    ).unwrap();
    const forward = cooked.passes.find((row) => row.pass === 'forward');
    const shadow = cooked.passes.find((row) => row.pass === 'shadow');
    if (forward === undefined || shadow === undefined)
      throw new Error('missing Water forward/shadow compile');
    expect(forward.parameters.map(({ name }) => name)).toContain('NormalDetailTex');
    // Native local foam uses the shallow output independently of legacy Ocean/static foam maps.
    expect(forward.parameters.map(({ name }) => name)).toContain('waterShallowFoamTexture');
    expect(forward.parameters.map(({ name }) => name)).toContain('foamScatteringPerM');
    const texture = forward.compile.reflection.boundGlobals.find(
      ({ name }) => name?.startsWith('NormalDetailTexX_') === true,
    );
    if (texture === undefined) throw new Error('missing visual-normal texture binding');
    const entryReads = (pass: typeof forward) =>
      pass.compile.reflection.entryPoints?.map((entry) => ({
        stage: entry.stage,
        reads: entry.bindings.some(
          ({ group, binding }) => group === texture.group && binding === texture.binding,
        ),
      })) ?? [];
    expect(entryReads(forward)).toContainEqual({ stage: 'fragment', reads: true });
    expect(entryReads(forward)).not.toContainEqual({ stage: 'vertex', reads: true });
    expect(entryReads(shadow).some(({ reads }) => reads)).toBe(false);
  });
});
