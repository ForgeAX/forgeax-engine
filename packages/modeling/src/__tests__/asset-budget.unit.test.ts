import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  ASSET_OUTPUT_PROFILES,
  type AssetOutputProfileId,
  type AssetPart,
  assetStats,
  checkAssetBudget,
} from '../asset-budget';
import { model } from '../model';

type Tri = readonly [readonly [number, number, number][], readonly [number, number][]];

/** Non-indexed mesh of whole triangles: positions per corner, uv0 per corner. */
function meshOf(tris: readonly Tri[]): MeshAsset {
  const corners = tris.length * 3;
  const position = new Float32Array(corners * 3);
  const uv = new Float32Array(corners * 2);
  tris.forEach(([ps, us], t) => {
    ps.forEach((p, c) => {
      position.set(p, (t * 3 + c) * 3);
    });
    us.forEach((q, c) => {
      uv.set(q, (t * 3 + c) * 2);
    });
  });
  return {
    kind: 'mesh',
    vertices: new Float32Array(corners * 8),
    attributes: { position, uv },
    submeshes: [
      {
        indexOffset: 0,
        indexCount: 0,
        vertexCount: corners,
        topology: 'triangle-list',
        materialSlot: 0,
      },
    ],
    materialSlots: [{ slotName: 'surface' }],
  };
}

/** The whole unit square, lower-left half: x + y < 1 (texel centres on the diagonal belong to the other half). */
const UNIT_TRI: Tri = [
  [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [0, 0],
    [1, 0],
    [0, 1],
  ],
];
/** Upper-right half of the unit square, sharing UNIT_TRI's diagonal. UV area 0.25 vs world area 0.5. */
const HALF_UV_TRI: Tri = [
  [
    [2, 0, 0],
    [3, 0, 0],
    [2, 1, 0],
  ],
  [
    [0.5, 0.5],
    [1, 0.5],
    [0.5, 1],
  ],
];
/** Same UV footprint as the upper-right half but a 100x smaller world triangle: density ratio 10. */
const DENSE_TRI: Tri = [
  [
    [0, 0, 0],
    [0.05, 0, 0],
    [0, 0.05, 0],
  ],
  [
    [0.5, 0.5],
    [1, 0.5],
    [0.5, 1],
  ],
];

/**
 * Texel-centre counts of a 512 x 512 grid (exact rational reference):
 * UNIT_TRI 131328 texels, HALF_UV_TRI 32896, overlap 0, both together 164224 (coverage 0.62646484375).
 */
const TEXEL_UNION_512 = 164224;

function part(id: string, tris: readonly Tri[]): AssetPart {
  return { id, mesh: meshOf(tris) };
}

function statsOf(parts: AssetPart[], options?: { uvGridSize: number }) {
  const r = assetStats(parts, options);
  if (!r.ok) throw new Error(`assetStats failed: ${r.error.message}`);
  return r.value;
}

/** Stats of the tiny two-triangle asset above; the budget tests vary one field at a time. */
const BASE = {
  parts: 1,
  triangles: 2,
  vertices: 6,
  materials: 1,
  uvCoverage: TEXEL_UNION_512 / (512 * 512),
  uvOverlap: 0,
  uvOutOfRange: 0,
  perMaterial: [
    {
      material: 'tiny/surface',
      triangles: 2,
      uvCoverage: TEXEL_UNION_512 / (512 * 512),
      uvOverlap: 0,
    },
  ],
  texelSpread: 2,
  degenerateTriangles: 0,
  rawBytes: 192,
  quantizedBytes: 132,
};

describe('assetStats', () => {
  it('measures a hand-built two-triangle asset exactly', () => {
    const stats = statsOf([part('tiny', [UNIT_TRI, HALF_UV_TRI])]);
    expect(stats).toEqual({
      ...BASE,
      // 6 vertices x 20 bytes + 2 triangles x 3 indices x 2 bytes (uint16 at <= 65535 vertices)
      quantizedBytes: 132,
    });
  });

  it('covers the full square with a quad split along its diagonal and no overlap', () => {
    const quadA: Tri = UNIT_TRI;
    const quadB: Tri = [
      [
        [1, 1, 0],
        [0, 1, 0],
        [1, 0, 0],
      ],
      [
        [1, 1],
        [0, 1],
        [1, 0],
      ],
    ];
    const stats = statsOf([part('quad', [quadA, quadB])]);
    expect(stats.uvCoverage).toBe(1);
    expect(stats.uvOverlap).toBe(0);
    expect(stats.uvOutOfRange).toBe(0);
  });

  it('reports overlap 1 when the same quad is stacked twice', () => {
    const quadB: Tri = [
      [
        [1, 1, 0],
        [0, 1, 0],
        [1, 0, 0],
      ],
      [
        [1, 1],
        [0, 1],
        [1, 0],
      ],
    ];
    const stats = statsOf([part('stack', [UNIT_TRI, quadB, UNIT_TRI, quadB])]);
    expect(stats.uvCoverage).toBe(1);
    expect(stats.uvOverlap).toBe(1);
  });

  it('counts a triple-stacked triangle as full overlap over its own texels', () => {
    const stats = statsOf([part('stack3', [UNIT_TRI, UNIT_TRI, UNIT_TRI])]);
    expect(stats.uvCoverage).toBeCloseTo(131328 / (512 * 512), 12);
    expect(stats.uvOverlap).toBe(1);
  });

  it('does not count a shared diagonal edge as overlap', () => {
    const stats = statsOf([part('shared', [UNIT_TRI, HALF_UV_TRI])]);
    expect(stats.uvOverlap).toBe(0);
  });

  it('reports a UV triangle outside the unit square as zero coverage and full out-of-range', () => {
    const offsetUv: Tri = [
      UNIT_TRI[0],
      [
        [5, 5],
        [6, 5],
        [5, 6],
      ],
    ];
    const stats = statsOf([part('off', [offsetUv])]);
    expect(stats.uvCoverage).toBe(0);
    expect(stats.uvOutOfRange).toBe(1);
  });

  it('measures the outside fraction of a triangle that straddles the unit square', () => {
    // (0,0),(2,0),(0,2) has area 2 and its part inside [0,1]^2 is the whole square (area 1).
    const straddle: Tri = [
      UNIT_TRI[0],
      [
        [0, 0],
        [2, 0],
        [0, 2],
      ],
    ];
    const stats = statsOf([part('straddle', [straddle])]);
    expect(stats.uvOutOfRange).toBeCloseTo(0.5, 12);
    expect(stats.uvCoverage).toBe(1);
  });

  it('honours a custom uvGridSize', () => {
    const stats = statsOf([part('coarse', [UNIT_TRI])], { uvGridSize: 8 });
    // Texel centres with x + y < 1 on an 8 x 8 grid: 36 of 64.
    expect(stats.uvCoverage).toBe(36 / 64);
  });

  it('reports per-material numbers, namespaced by part, and keeps whole-asset overlap across parts', () => {
    const stats = statsOf([part('a', [UNIT_TRI]), part('b', [UNIT_TRI])]);
    expect(stats.perMaterial.map((m) => m.material)).toEqual(['a/surface', 'b/surface']);
    expect(stats.perMaterial.every((m) => m.uvOverlap === 0)).toBe(true);
    // The mesh cannot tell whether the two parts share one atlas, so the whole-asset numbers count
    // both triangles together and report the stacked texels.
    expect(stats.uvOverlap).toBe(1);
  });

  it('reports per-material overlap for a slot that overlaps itself', () => {
    const stats = statsOf([part('stack', [UNIT_TRI, UNIT_TRI]), part('clean', [HALF_UV_TRI])]);
    const byMaterial = Object.fromEntries(stats.perMaterial.map((m) => [m.material, m]));
    expect(byMaterial['stack/surface']?.uvOverlap).toBe(1);
    expect(byMaterial['clean/surface']?.uvOverlap).toBe(0);
    expect(byMaterial['clean/surface']?.triangles).toBe(1);
  });

  it('rejects an invalid uvGridSize', () => {
    const r = assetStats([part('x', [UNIT_TRI])], { uvGridSize: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.detail?.reason).toBe('uv-grid-size');
  });

  it('counts a zero-area world triangle as degenerate and excludes it from texel spread', () => {
    const collinear: Tri = [
      [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
    ];
    const stats = statsOf([part('line', [UNIT_TRI, collinear])]);
    expect(stats.degenerateTriangles).toBe(1);
    expect(stats.texelSpread).toBe(1);
  });

  it('fails closed on a missing uv0 stream', () => {
    const mesh = meshOf([UNIT_TRI]);
    const position = mesh.attributes.position as Float32Array;
    const noUv: MeshAsset = { ...mesh, attributes: { position } };
    const r = assetStats([{ id: 'nouv', mesh: noUv }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('model-invalid-argument');
      expect(r.error.detail?.reason).toBe('uv0-stream');
    }
  });

  it('fails closed on a non-finite uv0 value', () => {
    const mesh = meshOf([UNIT_TRI]);
    const uv = mesh.attributes.uv as Float32Array;
    uv[0] = Number.NaN;
    const r = assetStats([{ id: 'nan', mesh }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.detail?.reason).toBe('uv0-stream');
  });

  it('fails closed on an empty part list', () => {
    const r = assetStats([]);
    expect(r.ok).toBe(false);
  });

  it('measures a real kernel box and passes the mobile-prop profile', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    m.uv.auto({ resolution: 64, padding: 2 });
    const built = m.toMesh({ normals: { mode: 'smooth' } });
    if (!built.ok) throw new Error(built.error.message);
    const stats = statsOf([{ id: 'box', mesh: built.value.mesh }]);
    expect(stats.triangles).toBe(12);
    expect(stats.vertices).toBe(24);
    expect(stats.degenerateTriangles).toBe(0);
    expect(stats.uvOutOfRange).toBeLessThanOrEqual(0.01);
    expect(checkAssetBudget(stats, 'mobile-prop').ok).toBe(true);
  });
});

describe('checkAssetBudget', () => {
  it('passes a small asset under mobile-prop', () => {
    const stats = statsOf([part('tiny', [UNIT_TRI, HALF_UV_TRI])]);
    expect(checkAssetBudget(stats, 'mobile-prop')).toEqual({ ok: true, issues: [] });
    expect(stats).toEqual(BASE);
  });

  it('fails budget-triangles on an oversized real mesh', () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [40, 40, 40] });
    m.uv.auto({ resolution: 256, padding: 2 });
    const built = m.toMesh({ normals: { mode: 'smooth' } });
    if (!built.ok) throw new Error(built.error.message);
    const stats = statsOf([{ id: 'dense', mesh: built.value.mesh }]);
    const result = checkAssetBudget(stats, 'mobile-prop');
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('budget-triangles');
  });

  const base = BASE;
  it.each([
    ['budget-triangles', { ...base, triangles: 9000 }],
    ['budget-vertices', { ...base, vertices: 7000 }],
    ['budget-materials', { ...base, materials: 4 }],
    ['uv-coverage-low', { ...base, uvCoverage: 0.01 }],
    ['uv-overlap', { ...base, uvOverlap: 0.5 }],
    ['uv-out-of-range', { ...base, uvOutOfRange: 0.2 }],
    ['budget-texel-spread', { ...base, texelSpread: 9 }],
    ['budget-degenerate', { ...base, degenerateTriangles: 1 }],
  ] as const)('fails %s on a stat outside the mobile-prop limit', (code, stats) => {
    const result = checkAssetBudget(stats, 'mobile-prop');
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual([code]);
    expect(result.issues[0]?.severity).toBe('error');
  });

  it('skips the three UV limits when the profile declares uniqueUv false', () => {
    const tiled = { ...ASSET_OUTPUT_PROFILES['mobile-prop'], uniqueUv: false };
    const stats = { ...BASE, uvCoverage: 0, uvOverlap: 0.9, uvOutOfRange: 0.9 };
    expect(checkAssetBudget(stats, tiled)).toEqual({ ok: true, issues: [] });
    expect(checkAssetBudget(stats, 'mobile-prop').issues.map((i) => i.code)).toEqual([
      'uv-coverage-low',
      'uv-overlap',
      'uv-out-of-range',
    ]);
  });

  it('gives every built-in profile unique UV checks', () => {
    for (const id of Object.keys(ASSET_OUTPUT_PROFILES) as AssetOutputProfileId[]) {
      expect(ASSET_OUTPUT_PROFILES[id].uniqueUv).toBe(true);
    }
  });

  it('fails budget-materials on a real four-material asset', () => {
    const far: Tri = [
      UNIT_TRI[0],
      [
        [5, 5],
        [6, 5],
        [5, 6],
      ],
    ];
    const stats = statsOf([part('a', [far]), part('b', [far]), part('c', [far]), part('d', [far])]);
    expect(stats.materials).toBe(4);
    expect(checkAssetBudget(stats, 'mobile-prop').issues.map((i) => i.code)).toContain(
      'budget-materials',
    );
  });

  it('fails budget-texel-spread on a real asset with a 10x density jump', () => {
    const stats = statsOf([part('spread', [UNIT_TRI, DENSE_TRI])]);
    expect(stats.texelSpread).toBeCloseTo(10, 3);
    expect(checkAssetBudget(stats, 'mobile-prop').issues.map((i) => i.code)).toEqual([
      'budget-texel-spread',
    ]);
  });

  it('fails budget-degenerate on a real zero-area triangle', () => {
    const collinear: Tri = [
      [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ],
    ];
    const stats = statsOf([part('line', [UNIT_TRI, collinear])]);
    expect(checkAssetBudget(stats, 'mobile-prop').issues.map((i) => i.code)).toEqual([
      'budget-degenerate',
    ]);
  });

  it('accepts a caller-declared profile object', () => {
    const stats = statsOf([part('tiny', [UNIT_TRI, HALF_UV_TRI])]);
    const strict = { ...ASSET_OUTPUT_PROFILES['mobile-prop'], maxTriangles: 1 };
    const result = checkAssetBudget(stats, strict);
    expect(result.issues.map((i) => i.code)).toEqual(['budget-triangles']);
    expect(result.issues[0]?.detail.profile).toBe('custom');
  });

  it('passes a small mesh under desktop-hero', () => {
    const stats = statsOf([part('tiny', [UNIT_TRI, HALF_UV_TRI])]);
    expect(checkAssetBudget(stats, 'desktop-hero').ok).toBe(true);
  });

  it('points each failing output at the output, not the source model', () => {
    const stats = { ...BASE, triangles: 9000 };
    const issue = checkAssetBudget(stats, 'mobile-prop').issues[0];
    expect(String(issue?.detail.hint)).toContain('same source');
    expect(String(issue?.detail.hint)).not.toMatch(/simplify the model/i);
  });
});
