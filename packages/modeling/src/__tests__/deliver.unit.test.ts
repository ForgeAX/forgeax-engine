import { err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { ASSET_OUTPUT_PROFILES, textureBytes } from '../asset-budget.ts';
import * as exact from '../brep/index.ts';
import { type DeliverySource, deliverAsset } from '../deliver.ts';
import { ModelingError } from '../errors.ts';
import type { ExactStage } from '../model.ts';
import { surfaceOf } from './bake-gates.ts';
import { buildBlaster } from './fixtures/hero-blaster.ts';

function twoPrimitives(): DeliverySource {
  const body = exact.box({ size: [0.6, 0.3, 0.4] });
  const barrel = exact.cylinder({ radius: 0.12, height: 0.5 });
  if (!body.ok || !barrel.ok) throw new Error('primitive build failed');
  return {
    parts: [
      { name: 'body', shape: body.value, material: 'BodyMetal' },
      { name: 'barrel', shape: barrel.value, material: 'DarkHardware' },
    ],
  };
}

const UNREACHABLE = {
  maxTriangles: 1,
  maxVertices: 1,
  maxMaterials: 1,
  uniqueUv: true,
  minUvCoverage: 0,
  maxUvOverlap: 1,
  maxUvOutOfRange: 1,
  maxTexelSpread: 1e9,
  maxDegenerate: 1e9,
};

describe('deliverAsset on two primitive parts', () => {
  it('delivers a budget-passing asset with the kernel quads, islands and step trail', () => {
    const result = deliverAsset(twoPrimitives(), 'mobile-prop', { exact, sizes: [0.1] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { report, mesh } = result.value;
    expect(report.profile).toBe('mobile-prop');
    expect(report.size).toBe(0.1);
    expect(report.budget.ok).toBe(true);
    expect(report.stats.triangles).toBeGreaterThan(0);
    expect(report.stats.materials).toBe(2);
    expect(report.uv.islands).toBeGreaterThan(1);
    expect(report.uv.coverage).toBeGreaterThan(0);
    expect(report.uv.exactOverlapPairs).toBe(0);
    expect(mesh.kind).toBe('mesh');
    expect(report.steps.map((s) => s.step)).toEqual([
      'quad',
      'assign',
      'seams',
      'unwrap',
      'pack',
      'budget',
    ]);
  });

  it('is deterministic: two runs produce identical mesh arrays and report', () => {
    const a = deliverAsset(twoPrimitives(), 'mobile-prop', { exact, sizes: [0.1] });
    const b = deliverAsset(twoPrimitives(), 'mobile-prop', { exact, sizes: [0.1] });
    if (!a.ok || !b.ok) throw new Error('delivery failed');
    expect(a.value.mesh.vertices).toEqual(b.value.mesh.vertices);
    expect(a.value.mesh.indices).toEqual(b.value.mesh.indices);
    expect(a.value.report).toEqual(b.value.report);
  });

  it('falsifier: no size fitting the profile is delivery-no-size-fits with every attempt listed', () => {
    const result = deliverAsset(twoPrimitives(), UNREACHABLE, { exact, sizes: [0.1, 0.2] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('delivery-no-size-fits');
    const attempts = result.error.detail.attempts as { size: number; issues: string[] }[];
    expect(attempts.map((a) => a.size)).toEqual([0.1, 0.2]);
    expect(attempts[0]?.issues).toContain('budget-triangles');
  });

  it('falsifier: empty source, duplicate part names and a non-positive size are delivery-invalid-argument', () => {
    const base = twoPrimitives();
    const empty = deliverAsset({ parts: [] }, 'mobile-prop', { exact, sizes: [0.1] });
    expect(empty.ok ? '' : empty.error.code).toBe('delivery-invalid-argument');
    const first = base.parts[0];
    if (first === undefined) throw new Error('no part');
    const dup = deliverAsset({ parts: [first, first] }, 'mobile-prop', { exact, sizes: [0.1] });
    expect(dup.ok ? '' : dup.error.code).toBe('delivery-invalid-argument');
    const zero = deliverAsset(base, 'mobile-prop', { exact, sizes: [0] });
    expect(zero.ok ? '' : zero.error.code).toBe('delivery-invalid-argument');
  });

  it('falsifier: a part every mesher route refuses is delivery-part-refused with each route tried', () => {
    const refuse = () =>
      err(new ModelingError({ code: 'model-invalid-argument', expected: 'a meshable shape' }));
    const refusing = { ...exact, quadrangulate: refuse } as unknown as ExactStage;
    const result = deliverAsset(twoPrimitives(), 'mobile-prop', { exact: refusing, sizes: [0.1] });
    expect(result.ok ? '' : result.error.code).toBe('delivery-part-refused');
    const tried = result.ok ? [] : (result.error.detail.tried as unknown[]);
    expect(tried).toHaveLength(4);
  });
});

/** Texels of a baked rgba8 map (level 0) that differ from the flat tangent-space or white occlusion value. */
function nonFlatTexels(
  data: Uint8Array,
  resolution: number,
  flat: readonly [number, number, number],
): number {
  let n = 0;
  for (let i = 0; i < resolution * resolution * 4; i += 4) {
    if (
      Math.abs((data[i] as number) - (flat[0] as number)) > 2 ||
      Math.abs((data[i + 1] as number) - (flat[1] as number)) > 2 ||
      Math.abs((data[i + 2] as number) - (flat[2] as number)) > 2
    )
      n++;
  }
  return n;
}

/** A filleted body: its rounded edges are detail the coarse base cannot represent, unlike the planar box. */
function filletedParts(): DeliverySource {
  const body = exact.filletBox({ size: [0.6, 0.3, 0.4], radius: 0.06 });
  const barrel = exact.cylinder({ radius: 0.12, height: 0.5 });
  if (!body.ok || !barrel.ok) throw new Error('primitive build failed');
  return {
    parts: [
      { name: 'body', shape: body.value, material: 'BodyMetal' },
      { name: 'barrel', shape: barrel.value, material: 'DarkHardware' },
    ],
  };
}

describe('deliverAsset LOD chain (step 5)', () => {
  it('builds LOD1..n as coarser quads with the same parts, each with fewer triangles', () => {
    const result = deliverAsset(twoPrimitives(), 'mobile-prop', {
      exact,
      sizes: [0.1],
      lods: [0.13, 0.16],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tris = result.value.lods.map((m) => m.indices?.length ?? 0);
    expect(result.value.lods).toHaveLength(2);
    expect(tris[0]).toBeGreaterThan(0);
    expect(tris[1]).toBeLessThan(tris[0] as number);
    const lod = result.value.report.steps.find((s) => s.step === 'lod');
    expect((lod?.detail.lods as { size: number; freeChains: number }[]).map((r) => r.size)).toEqual(
      [0.13, 0.16],
    );
    for (const row of lod?.detail.lods as {
      freeChains: number;
      boundarySetEqualsLod0: boolean;
    }[]) {
      expect(row.freeChains).toBe(0);
      expect(row.boundarySetEqualsLod0).toBe(true);
    }
  });

  it('without lods the result has no LOD mesh and no lod step', () => {
    const result = deliverAsset(twoPrimitives(), 'mobile-prop', { exact, sizes: [0.1] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lods).toEqual([]);
    expect(result.value.report.steps.some((s) => s.step === 'lod')).toBe(false);
  });

  it('falsifier: a LOD not coarser than the delivered size is delivery-invalid-argument', () => {
    const result = deliverAsset(twoPrimitives(), 'mobile-prop', {
      exact,
      sizes: [0.1],
      lods: [0.1],
    });
    expect(result.ok ? '' : result.error.code).toBe('delivery-invalid-argument');
  });

  it('falsifier: a LOD that opens a seam chain is refused with the boundary numbers', () => {
    const real = exact;
    const damaged = {
      ...real,
      quadrangulate: (
        shape: Parameters<typeof real.quadrangulate>[0],
        opts: Parameters<typeof real.quadrangulate>[1],
      ) => {
        const r = real.quadrangulate(shape, opts);
        if (!r.ok || opts.size !== 0.16) return r;
        const mesh = r.value.mesh.clone();
        mesh.removeFace(mesh.faces()[0] as number);
        return { ...r, value: { ...r.value, mesh } };
      },
    } as unknown as ExactStage;
    const result = deliverAsset(twoPrimitives(), 'mobile-prop', {
      exact: damaged,
      sizes: [0.1],
      lods: [0.16],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('delivery-kernel-failed');
    const cause = result.error.detail.cause as { freeChains: number };
    expect(cause.freeChains).toBeGreaterThan(0);
  });
});

describe('deliverAsset UV overlap repair (step 6)', () => {
  // The blaster is the only reproducer found: primitives and their pairs lay out with zero exact overlap.
  it('the mobile-hero blaster delivery has no exact UV overlap pairs', { timeout: 120000 }, () => {
    const parts = buildBlaster().parts.map((p) => ({
      name: p.name,
      shape: p.shape,
      material: p.material,
    }));
    const merge = { BodyMetal: 'Atlas', DarkHardware: 'Atlas', Glass: 'Atlas', Accent: 'Atlas' };
    const result = deliverAsset({ parts }, 'mobile-hero', { exact, sizes: [0.9], merge });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.uv.exactOverlapPairs).toBe(0);
    expect(result.value.report.attempts[0]?.triangles).toBe(11170);
    expect(result.value.report.steps.find((s) => s.step === 'pack')?.detail.resolveOverlaps).toBe(
      2,
    );
  });
});

describe('deliverAsset texture byte budget (step 4)', () => {
  it('the verdict estimate equals the bytes the bake really produces', () => {
    const result = deliverAsset(filletedParts(), 'mobile-prop', {
      exact,
      sizes: [0.1],
      detailSize: 0.04,
      bake: { resolution: 128, maps: ['normal'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bake = result.value.report.bake;
    expect(bake?.pass).toBe(true);
    expect(bake?.bytes).toBe(textureBytes(128, 128, false) * 1);
    expect(bake?.bytes).toBe(result.value.textures.normal?.data.byteLength);
  });

  it('falsifier: a bake over the profile texture limit is delivery-no-size-fits with budget-texture-bytes', () => {
    const tight = { ...ASSET_OUTPUT_PROFILES['mobile-prop'], maxTextureBytes: 1024 };
    const result = deliverAsset(filletedParts(), tight, {
      exact,
      sizes: [0.1],
      detailSize: 0.04,
      bake: { resolution: 128, maps: ['normal'] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('delivery-no-size-fits');
    const attempts = result.error.detail.attempts as { issues: string[] }[];
    expect(attempts[0]?.issues).toContain('budget-texture-bytes');
  });

  it('without a bake the texture limit is not checked', () => {
    const tight = { ...ASSET_OUTPUT_PROFILES['mobile-prop'], maxTextureBytes: 1 };
    const result = deliverAsset(twoPrimitives(), tight, { exact, sizes: [0.1] });
    expect(result.ok).toBe(true);
  });

  it('textureBytes counts the RGBA8 mip chain the texture writer builds', () => {
    expect(textureBytes(4, 4, false)).toBe(64);
    expect(textureBytes(4, 4, true)).toBe((16 + 4 + 1) * 4);
    expect(textureBytes(1, 1, true)).toBe(4);
  });
});

describe('deliverAsset default slot merge (step 3)', () => {
  function threeMaterials(): DeliverySource {
    const body = exact.box({ size: [0.6, 0.3, 0.4] });
    const barrel = exact.cylinder({ radius: 0.12, height: 0.5 });
    const cap = exact.box({ size: [0.1, 0.1, 0.1] });
    if (!body.ok || !barrel.ok || !cap.ok) throw new Error('primitive build failed');
    return {
      parts: [
        { name: 'body', shape: body.value, material: 'BodyMetal' },
        { name: 'barrel', shape: barrel.value, material: 'DarkHardware' },
        { name: 'cap', shape: cap.value, material: 'Glass' },
      ],
    };
  }
  const TWO_SLOTS = { ...ASSET_OUTPUT_PROFILES['mobile-prop'], maxMaterials: 2 };

  it('folds slots down to the profile limit when no merge is given, and records the merge applied', () => {
    const result = deliverAsset(threeMaterials(), TWO_SLOTS, { exact, sizes: [0.1] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.stats.materials).toBe(2);
    const assign = result.value.report.steps.find((s) => s.step === 'assign');
    const merge = assign?.detail.merge as Record<string, string>;
    expect(Object.keys(merge)).toHaveLength(1);
    const [from, to] = Object.entries(merge)[0] ?? [];
    expect(from).toBeDefined();
    expect(to).toBeDefined();
    expect(from).not.toBe(to);
    expect((assign?.detail.slots as string[]).sort()).toEqual(
      ['BodyMetal', 'DarkHardware', 'Glass'].filter((m) => m !== from).sort(),
    );
  });

  it('falsifier: with the default disabled by an explicit empty merge the same source is delivery-no-size-fits', () => {
    const result = deliverAsset(threeMaterials(), TWO_SLOTS, {
      exact,
      sizes: [0.1],
      merge: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('delivery-no-size-fits');
    const attempts = result.error.detail.attempts as { issues: string[] }[];
    expect(attempts[0]?.issues).toContain('budget-materials');
  });

  it('an explicit merge overrides the default', () => {
    const result = deliverAsset(threeMaterials(), TWO_SLOTS, {
      exact,
      sizes: [0.1],
      merge: { Glass: 'BodyMetal' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const assign = result.value.report.steps.find((s) => s.step === 'assign');
    expect(assign?.detail.merge).toEqual({ Glass: 'BodyMetal' });
  });
});

describe('deliverAsset bake', () => {
  it('bakes normal and AO of the delivered base, one group per part, and the normal map carries detail', () => {
    const result = deliverAsset(filletedParts(), 'mobile-prop', {
      exact,
      sizes: [0.1],
      bake: { resolution: 128, maps: ['normal', 'ao'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bake = result.value.report.bake;
    expect(bake?.pass).toBe(true);
    expect(bake?.detailSize).toBeCloseTo(0.04, 10);
    expect(bake?.groups.map((g) => g.id).sort()).toEqual(['barrel', 'body']);
    expect(result.value.report.steps.map((s) => s.step)).toContain('bake');
    const normal = result.value.textures.normal;
    const ao = result.value.textures.ao;
    expect(normal).toBeDefined();
    expect(ao).toBeDefined();
    if (normal === undefined) return;
    // Falsifier: a bake that produced a flat map (no detail reached the base) would have zero non-flat texels.
    expect(nonFlatTexels(normal.data, 128, [128, 128, 255])).toBeGreaterThan(0);
  });

  it('the exported normals are the base frame the bake used (same normal set, split at the crease angle)', () => {
    const result = deliverAsset(filletedParts(), 'mobile-prop', {
      exact,
      sizes: [0.1],
      bake: { resolution: 128, maps: ['normal'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { mesh, model, report } = result.value;
    const bake = report.bake;
    if (bake === undefined) throw new Error('bake report missing');
    expect(bake.baseNormals).toEqual({ mode: 'autoSmooth', angle: 30 });
    // The bake's base frame is `bakeSurface(model, baseNormals)`; the export must hold exactly that normal set.
    const frame = surfaceOf(model, bake.baseNormals);
    const normalSet = (positions: ArrayLike<number>, normals: ArrayLike<number>) =>
      Array.from({ length: positions.length / 3 }, (_, i) =>
        [0, 1, 2]
          .map((k) => (positions[i * 3 + k] as number).toFixed(4))
          .concat([0, 1, 2].map((k) => (normals[i * 3 + k] as number).toFixed(3)))
          .join(','),
      ).sort();
    const exported = normalSet(
      mesh.attributes.position as Float32Array,
      mesh.attributes.normal as Float32Array,
    );
    expect(exported).toEqual(normalSet(frame.position, frame.normal));
    // Falsifier: the check discriminates; a smooth export of the same model has another normal set.
    const smooth = surfaceOf(model, { mode: 'smooth' });
    expect(normalSet(smooth.position, smooth.normal)).not.toEqual(
      normalSet(frame.position, frame.normal),
    );
  });

  it('falsifier: a kernel refusal is reported as data, pass false with no textures, and the flat asset still ships', () => {
    const result = deliverAsset(twoPrimitives(), 'mobile-prop', {
      exact,
      sizes: [0.1],
      bake: { resolution: 0, maps: ['normal'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mesh.kind).toBe('mesh');
    expect(result.value.report.bake?.pass).toBe(false);
    expect(result.value.report.bake?.refusal?.code).toBe('model-invalid-argument');
    expect(result.value.textures).toEqual({});
    const bakeStep = result.value.report.steps.find((s) => s.step === 'bake');
    expect(bakeStep?.status).toBe('failed');
  });

  it('falsifier: a bake with no maps is delivery-invalid-argument', () => {
    const result = deliverAsset(twoPrimitives(), 'mobile-prop', {
      exact,
      sizes: [0.1],
      bake: { resolution: 128, maps: [] },
    });
    expect(result.ok ? '' : result.error.code).toBe('delivery-invalid-argument');
  });

  it('without a bake request the report has no bake and the asset has no textures', () => {
    const result = deliverAsset(twoPrimitives(), 'mobile-prop', { exact, sizes: [0.1] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.bake).toBeUndefined();
    expect(result.value.textures).toEqual({});
  });
});

describe('deliverAsset material atlas (step 7)', () => {
  // Two parts with different source slots, merged into one output slot: the merge erases the
  // slot in the mesh, so only the atlas can say which source colour each texel should carry.
  const LINEAR = {
    BodyMetal: [0.66, 0.68, 0.72],
    DarkHardware: [0.24, 0.25, 0.28],
  } as const;

  it('the atlas holds each source slot colour over its own texels', { timeout: 120000 }, () => {
    const result = deliverAsset({ parts: twoPrimitives().parts }, 'desktop-hero', {
      exact,
      sizes: [0.6],
      merge: { BodyMetal: 'Atlas', DarkHardware: 'Atlas' },
      albedo: { size: 64, colors: LINEAR },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const atlas = result.value.textures.albedo;
    expect(atlas?.shape.extent).toEqual({ width: 64, height: 64 });
    const seen = new Set<string>();
    const data = atlas?.data as Uint8Array;
    for (let k = 0; k < 64 * 64; k++) {
      const a = data[k * 4 + 3];
      if (a === 0) continue;
      seen.add(`${data[k * 4]},${data[k * 4 + 1]},${data[k * 4 + 2]}`);
    }
    // Both source colours appear, and nothing else: no averaging, no default fill.
    expect(seen.size).toBe(2);
    expect(result.value.report.steps.find((s) => s.step === 'atlas')?.detail.slots).toEqual([
      'BodyMetal',
      'DarkHardware',
    ]);
  });

  it('refuses an atlas colour missing for a used source slot', () => {
    const result = deliverAsset({ parts: twoPrimitives().parts }, 'desktop-hero', {
      exact,
      sizes: [0.6],
      albedo: { size: 64, colors: { BodyMetal: [0.5, 0.5, 0.5] } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('delivery-invalid-argument');
  });
});

describe('deliverAsset session on the result (step 8)', () => {
  it('the delivered model holds the final tags of every face and is detached from mesh', {
    timeout: 120000,
  }, () => {
    const result = deliverAsset({ parts: twoPrimitives().parts }, 'desktop-hero', {
      exact,
      sizes: [0.6],
      merge: { BodyMetal: 'Atlas', DarkHardware: 'Atlas' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { mesh, model } = result.value;
    const session = model.editMesh;
    // Each face keeps its part tag, and the faces are the delivered base faces.
    const part = session.tagNames.indexOf('body');
    expect(part).toBeGreaterThanOrEqual(0);
    const faces = session.faces();
    expect(faces.length).toBeGreaterThan(0);
    const tagged = faces.filter((f) => session.hasTag(f, part));
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.length).toBeLessThan(faces.length);

    const vertexCopy = Float32Array.from(mesh.vertices);
    const indexCopy = mesh.indices === undefined ? undefined : mesh.indices.slice();
    const triangleBefore = indexCopy?.length;
    // Editing the session after delivery must not reach the delivered base mesh.
    session.removeFace(faces[0] as number);
    expect(session.faces().length).toBe(faces.length - 1);
    expect(Array.from(mesh.vertices)).toEqual(Array.from(vertexCopy));
    expect(mesh.indices?.length).toBe(triangleBefore);
    expect(Array.from(mesh.indices ?? [])).toEqual(Array.from(indexCopy ?? []));
  });
});
