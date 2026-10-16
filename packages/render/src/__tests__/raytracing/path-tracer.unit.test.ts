import { fileURLToPath } from 'node:url';
import type { AssetGuid, MaterialAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  admitRayMaterial,
  admitRayMaterialValues,
  rayMaterialContract,
} from '../../../../shader/src/material/ray-program';
import {
  buildMaterialSourceCatalog,
  collectMaterialSources,
  cookRayMaterial,
} from '../../../../shader-compiler/src/index';
import { Materials } from '../../materials';
import { buildRaySurfaceScene } from '../../raytracing/attributes';
import { plane } from './path-tracer.fixture';

describe('ray Surface admission and source ownership', () => {
  it('refuses active screen diffusion in every ray context and in runtime value edits', () => {
    const active = Materials.standard({
      staticSwitches: { subsurfaceDiffusion: true },
      baseColor: [1, 1, 1, 1],
      subsurfaceRadius: [9, 6, 3],
      subsurfaceWeight: 1,
    });
    for (const context of ['ray-hit', 'raster-probe', 'card-capture'] as const) {
      expect(admitRayMaterial(active, 'wax', context)).toMatchObject({
        ok: false,
        error: {
          code: 'ray-material-unsupported',
          detail: { requirement: 'screen-space subsurface diffusion' },
        },
      });
      expect(
        admitRayMaterial(
          { ...active, values: { ...active.values, subsurfaceWeight: 0 } },
          'wax',
          context,
        ).ok,
      ).toBe(true);
      expect(
        admitRayMaterial(
          { ...active, values: { ...active.values, subsurfaceRadius: [0, 0, 0] } },
          'wax',
          context,
        ).ok,
      ).toBe(true);
    }
    if (active.parent !== undefined) throw new Error('expected a root material');
    const inherited: MaterialAsset = {
      ...active,
      parameters: (active.parameters ?? []).map((parameter) =>
        parameter.name === 'subsurfaceRadius'
          ? { ...parameter, default: [9, 6, 3] }
          : parameter.name === 'subsurfaceWeight'
            ? { ...parameter, default: 1 }
            : parameter,
      ),
      values: { baseColor: [1, 1, 1, 1] },
    };
    expect(admitRayMaterial(inherited, 'default-profile').ok).toBe(false);
    expect(
      admitRayMaterialValues(
        { subsurfaceRadius: [9, 6, 3], subsurfaceWeight: 0 },
        'wax',
        'accepted-program',
      ).ok,
    ).toBe(true);
    expect(
      admitRayMaterialValues(
        { subsurfaceRadius: [9, 6, 3], subsurfaceWeight: 1 },
        'wax',
        'accepted-program',
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'ray-material-unsupported' },
    });
  });
  it('keeps custom ray eligibility independent of canonical Card qualification', () => {
    const canonical = Materials.standard({ baseColor: [1, 1, 1, 1] });
    if (canonical.parent !== undefined) throw new Error('expected a root material');
    expect(admitRayMaterial(canonical, 'canonical', 'card-capture').ok).toBe(true);
    const forward = canonical.passes?.find((pass) => pass.name.toLowerCase() === 'forward');
    if (forward === undefined) throw new Error('expected a Forward pass');
    const custom: MaterialAsset = {
      ...canonical,
      passes: [
        {
          ...forward,
          program: { ...forward.program, moduleSlots: { surface: 'game::view_surface' } },
        },
      ],
    };
    expect(admitRayMaterial(custom, 'custom', 'ray-hit').ok).toBe(true);
    expect(admitRayMaterial(custom, 'custom', 'raster-probe').ok).toBe(true);
    expect(admitRayMaterial(custom, 'custom', 'card-capture')).toMatchObject({
      ok: false,
      error: { code: 'ray-material-unsupported', detail: { source: 'game::view_surface' } },
    });
  });

  it('reconstructs indexed source attributes after BVH ordering without borrowing arrays', () => {
    const p = plane();
    const colors = [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1];
    const scene = buildRaySurfaceScene([
      {
        ...p,
        indices: [2, 3, 0, 1, 2, 0],
        colors,
        transform: [-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1],
      },
    ]).unwrap();
    const view = new DataView(scene.attributes.buffer),
      tri = new DataView(scene.triangles.buffer);
    for (let t = 0; t < 2; t++) {
      const primitive = tri.getUint32(t * 80 + 56, true);
      const indices = primitive === 0 ? [2, 3, 0] : [1, 2, 0];
      indices.forEach((vertex, corner) => {
        const offset = t * 384 + corner * 128;
        expect(view.getFloat32(offset, true)).toBe(p.positions[vertex * 3]);
        expect(view.getFloat32(offset + 16, true)).toBe(colors[vertex * 4]);
        expect(view.getFloat32(offset + 40, true)).toBe(p.uvSets?.[1]?.[vertex * 2]);
      });
    }
    colors.fill(0);
    expect(new Float32Array(scene.attributes.buffer).some((v) => v === 1)).toBe(true);
    expect(buildRaySurfaceScene([{ ...p, uvSets: [[NaN, 0]] }]).ok).toBe(false);
    expect(buildRaySurfaceScene([{ ...p, colors: [1, 1, 1, 2] }]).ok).toBe(false);
  });
  it('rejects unsupported material coverage, bump derivatives and layers', () => {
    for (const asset of [
      Materials.unlit([1, 1, 1, 1]),
      Materials.standard({ baseColor: [1, 1, 1, 0.5] }),
      Materials.standard({ baseColor: [1, 1, 1, 1], bumpTexture: 'bump' }),
      Materials.standard({
        baseColor: [1, 1, 1, 1],
        transmission: 1,
      }),
      Materials.standard({
        staticSwitches: { clearcoat: true },
        baseColor: [1, 1, 1, 1],
        clearcoat: 1,
      }),
      Materials.standard({ baseColor: [1, 1, 1, 1], alphaHash: true }),
    ])
      expect(admitRayMaterial(asset, 'test').ok).toBe(false);
  });
  it('rejects raster-specialized projection instead of tracing it by UV', () => {
    const projected = [
      Materials.standard({ baseColor: [1, 1, 1, 1], triplanar: { space: 'world' } }),
      Materials.standard({ baseColor: [1, 1, 1, 1], triplanar: { space: 'object' } }),
      Materials.standard({ baseColor: [1, 1, 1, 1], normalTexture: 'n', normalMapSpace: 'object' }),
    ];
    for (const asset of projected)
      expect(admitRayMaterial(asset, 'test')).toMatchObject({
        ok: false,
        error: { code: 'ray-material-unsupported' },
      });
    expect(admitRayMaterial(Materials.standard({ baseColor: [1, 1, 1, 1] }), 'test').ok).toBe(true);
    expect(admitRayMaterial(Materials.lambert({ baseColor: [1, 1, 1, 1] }), 'test').ok).toBe(true);
  });
  it('rejects diffuse transmission until the shared ray and cache BSDF supports it', () => {
    for (const options of [
      { diffuseTransmission: 0.5 },
      { diffuseTransmissionColor: [0.2, 0.6, 0.3] as const },
      { diffuseTransmissionTexture: 'leaf-thickness' },
      { diffuseTransmissionColorTexture: 'leaf-color' },
    ]) {
      const result = admitRayMaterial(
        Materials.standard({ baseColor: [1, 1, 1, 1], ...options }),
        'foliage',
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('ray-material-unsupported');
        expect(result.error.detail.requirement).toContain('diffuseTransmission');
      }
    }
  });

  it('keeps unsupported diffuse transmission out of every cooked ray and cache context', async () => {
    const directory = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
    const sources = buildMaterialSourceCatalog(
      await collectMaterialSources([directory], [directory]),
    ).unwrap();
    const material = Materials.standard({
      staticSwitches: { diffuseTransmission: true },
      baseColor: [1, 1, 1, 1],
      diffuseTransmission: 0.5,
    });
    for (const context of ['ray-hit', 'raster-probe', 'card-capture'] as const) {
      const result = await cookRayMaterial({
        material: 'foliage',
        table: { foliage: material },
        sources,
        context,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('ray-material-unsupported');
    }
  });

  it('admits shared MASK coverage without enabling blend or stochastic alpha', () => {
    expect(
      admitRayMaterial(
        Materials.standard({
          baseColor: [1, 1, 1, 0.5],
          alphaCutoff: 0.5,
        }),
        'cutout',
      ).ok,
    ).toBe(true);
  });
  it('admits normal textures through the shared Standard Surface', () => {
    expect(
      admitRayMaterial(
        Materials.standard({ baseColor: [1, 1, 1, 1], normalTexture: 'normal' }),
        'normal',
      ).ok,
    ).toBe(true);
  });
  it('derives inherited values and both contexts from one material source closure', async () => {
    const directory = fileURLToPath(new URL('../../../../shader/src/', import.meta.url));
    const inputs = await collectMaterialSources([directory], [directory]);
    const sources = buildMaterialSourceCatalog(inputs).unwrap();
    const root = Materials.standard({ baseColor: [0.8, 0.4, 0.2, 1] });
    const table = {
      root,
      child: {
        kind: 'material' as const,
        parent: 'root' as unknown as AssetGuid,
        values: { roughness: 0.4 },
      },
    };
    const ray = (await cookRayMaterial({ material: 'child', table, sources })).unwrap();
    const raster = (
      await cookRayMaterial({ material: 'child', table, sources, context: 'raster-probe' })
    ).unwrap();
    expect(ray.asset.values?.roughness).toBe(0.4);
    expect(ray.program.contract).toBe(raster.program.contract);
    expect(ray.program.wgsl).toContain('cs_surface');
    expect(raster.program.wgsl).toContain('fs_probe');
    const value = (
      await cookRayMaterial({
        material: 'child',
        table: { ...table, child: { ...table.child, values: { roughness: 0.8 } } },
        sources,
      })
    ).unwrap();
    expect(value.program.sourceClosureDigest).toBe(ray.program.sourceClosureDigest);
    expect(value.program.contract).toBe(rayMaterialContract(ray.asset));
    expect(value.asset.values).not.toEqual(ray.asset.values);
    const changed = buildMaterialSourceCatalog({
      ...inputs,
      engine: inputs.engine.map((s) => ({
        ...s,
        source: s.source.replace(
          'let baseColor = materialValue.baseColor.rgb',
          'let baseColor = vec3f(0.5) * materialValue.baseColor.rgb',
        ),
      })),
    }).unwrap();
    const edit = (await cookRayMaterial({ material: 'child', table, sources: changed })).unwrap();
    expect(edit.program.sourceClosureDigest).not.toBe(ray.program.sourceClosureDigest);
    expect(edit.program.wgsl).not.toBe(ray.program.wgsl);
  });
});
