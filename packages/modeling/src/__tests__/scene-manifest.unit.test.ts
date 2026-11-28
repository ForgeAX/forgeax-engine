import type { MeshAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { DeliveredAsset } from '../deliver';
import {
  SCENE_OUTPUT_PROFILES,
  type SceneAsset,
  type SceneOutputProfile,
  type ScenePlacement,
  sceneManifest,
  sceneTrianglesAt,
} from '../scene-manifest';

type Tri = readonly [readonly [number, number, number][], readonly [number, number][]];

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
const QUAD: readonly Tri[] = [
  [
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
    ],
    [
      [0, 0],
      [1, 0],
      [1, 1],
    ],
  ],
  [
    [
      [0, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
    ],
    [
      [0, 0],
      [1, 1],
      [0, 1],
    ],
  ],
];

function texture(width: number, height: number): TextureAsset {
  return {
    kind: 'texture',
    format: 'rgba8unorm',
    colorSpace: 'linear',
    shape: { viewDimension: '2d', extent: { width, height } },
    mips: { kind: 'generate' },
    data: new Uint8Array(width * height * 4),
  };
}

function sceneAsset(
  id: string,
  tris: readonly Tri[],
  extra: {
    lods?: readonly MeshAsset[];
    lodDistances?: readonly number[];
    textures?: DeliveredAsset['textures'];
  } = {},
): SceneAsset {
  return {
    id,
    asset: { mesh: meshOf(tris), lods: extra.lods ?? [], textures: extra.textures ?? {} },
    ...(extra.lodDistances === undefined ? {} : { lodDistances: extra.lodDistances }),
  };
}

/** Two assets, five placements: TRI x3 (1 triangle each) and QUAD x2 (2 triangles each). */
const TRI = sceneAsset('tri', [UNIT_TRI]);
const QUADA = sceneAsset('quad', QUAD);
const SCENE_ASSETS = [TRI, QUADA];
const SCENE_PLACEMENTS: ScenePlacement[] = [
  { asset: 'tri', position: [0, 0, 0] },
  { asset: 'tri', position: [5, 0, 0] },
  { asset: 'tri', position: [10, 0, 0] },
  { asset: 'quad', position: [0, 10, 0] },
  { asset: 'quad', position: [0, 20, 0] },
];

const TIGHT: SceneOutputProfile = {
  maxTriangles: 7,
  maxDrawCalls: 5,
  instancing: false,
  maxTextureBytes: 84,
  maxMeshBytes: 198,
};

function manifestOf(
  assets: readonly SceneAsset[],
  placements: readonly ScenePlacement[],
  profile: SceneOutputProfile | 'mobile-scene' = TIGHT,
) {
  const r = sceneManifest(assets, placements, profile);
  if (!r.ok) throw new Error(`refused: ${r.error.code}`);
  return r.value;
}

function refusalOf(
  assets: readonly SceneAsset[],
  placements: readonly ScenePlacement[],
  profile: SceneOutputProfile | 'mobile-scene' = TIGHT,
): string {
  const r = sceneManifest(assets, placements, profile);
  if (r.ok) throw new Error('expected a refusal');
  return r.error.code;
}

describe('sceneManifest totals', () => {
  it('counts a hand-checkable 2-asset, 5-placement scene', () => {
    const m = manifestOf(SCENE_ASSETS, SCENE_PLACEMENTS);
    expect(m.totals.instances).toBe(5);
    expect(m.totals.uniqueAssets).toBe(2);
    // LOD0 per placement: 3 x 1 + 2 x 2
    expect(m.totals.trianglesLod0).toBe(7);
    expect(m.totals.trianglesLowest).toBe(7);
    // unique: 1 + 2
    expect(m.totals.trianglesUnique).toBe(3);
    // per instance: one material per placement; instanced: one per unique asset
    expect(m.totals.drawCallsPerInstance).toBe(5);
    expect(m.totals.drawCallsInstanced).toBe(2);
    expect(m.totals.textureBytes).toBe(0);
    // quantized: 3 vertices x 20 + 1 x 3 x 2 = 66; 6 vertices x 20 + 2 x 3 x 2 = 132
    expect(m.assets.map((a) => a.meshBytes)).toEqual([66, 132]);
    expect(m.totals.meshBytes).toBe(198);
    expect(m.totals.bounds).toEqual({ min: [0, 0, 0], max: [11, 21, 0] });
    expect(m.budget).toEqual({ ok: true, issues: [] });
    expect(m.warnings).toEqual([]);
  });

  it('reports an unused asset as a warning and leaves it out of totals and assets', () => {
    const spare = sceneAsset('spare', QUAD);
    const m = manifestOf([...SCENE_ASSETS, spare], SCENE_PLACEMENTS);
    expect(m.assets.map((a) => a.id)).toEqual(['tri', 'quad']);
    expect(m.totals.trianglesLod0).toBe(7);
    expect(m.warnings).toEqual([
      { code: 'scene-asset-unused', severity: 'warn', detail: { asset: 'spare', triangles: 2 } },
    ]);
  });

  it('dedupes a shared texture by identity but reports it on each asset that uses it', () => {
    const shared = texture(4, 4);
    const a = sceneAsset('a', [UNIT_TRI], { textures: { albedo: shared } });
    const b = sceneAsset('b', QUAD, { textures: { albedo: shared } });
    const m = manifestOf(
      [a, b],
      [
        { asset: 'a', position: [0, 0, 0] },
        { asset: 'b', position: [0, 10, 0] },
      ],
    );
    // 4x4 with a full mip chain: (16 + 4 + 1) texels x 4 bytes = 84
    expect(m.totals.textureBytes).toBe(84);
    expect(m.assets.map((x) => x.textures.map((t) => t.bytes))).toEqual([[84], [84]]);
  });

  it('keeps the JSON round trip deep-equal, with no undefined fields', () => {
    const named: ScenePlacement = { asset: 'tri', name: 'first', position: [0, 0, 0] };
    const m = manifestOf(SCENE_ASSETS, [named, ...SCENE_PLACEMENTS.slice(1)]);
    expect(JSON.parse(JSON.stringify(m))).toStrictEqual(m);
  });
});

describe('sceneManifest instances', () => {
  it('defaults rotation and scale and reads a name when given', () => {
    const m = manifestOf([TRI], [{ asset: 'tri', name: 'lamp', position: [1, 2, 3] }]);
    expect(m.instances[0]).toMatchObject({
      name: 'lamp',
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
      mirrored: false,
    });
  });

  it('flags a mirrored placement from an odd count of negative scale components', () => {
    const m = manifestOf(
      [TRI],
      [
        { asset: 'tri', position: [0, 0, 0], scale: [-1, 1, 1] },
        { asset: 'tri', position: [0, 0, 0], scale: [-1, -1, 1] },
        { asset: 'tri', position: [0, 0, 0], scale: -2 },
      ],
    );
    expect(m.instances.map((i) => i.mirrored)).toEqual([true, false, true]);
  });

  it('boxes the world corners under rotation plus non-uniform scale', () => {
    // Local box [0,1] x [0,1] x [0,0]. Scale (2,3,1) gives x in [0,2], y in [0,3].
    // A +90 degree turn about z maps (x,y) to (-y,x): x in [-3,0], y in [0,2].
    // Translate by (10,20,5): x in [7,10], y in [20,22], z = 5.
    const half = Math.SQRT1_2;
    const m = manifestOf(
      [TRI],
      [{ asset: 'tri', position: [10, 20, 5], rotation: [0, 0, half, half], scale: [2, 3, 1] }],
    );
    const b = m.instances[0]?.bounds;
    expect(b?.min[0]).toBeCloseTo(7, 9);
    expect(b?.max[0]).toBeCloseTo(10, 9);
    expect(b?.min[1]).toBeCloseTo(20, 9);
    expect(b?.max[1]).toBeCloseTo(22, 9);
    expect(b?.min[2]).toBeCloseTo(5, 9);
    expect(b?.max[2]).toBeCloseTo(5, 9);
  });
});

describe('sceneManifest refusals', () => {
  const PLACE = [{ asset: 'tri', position: [0, 0, 0] } as ScenePlacement];

  it('refuses an empty scene and an empty placement list', () => {
    expect(refusalOf([], PLACE)).toBe('scene-no-assets');
    expect(refusalOf([TRI], [])).toBe('scene-no-placements');
  });

  it('refuses a duplicate asset id and a duplicate placement name', () => {
    expect(refusalOf([TRI, sceneAsset('tri', QUAD)], PLACE)).toBe('scene-duplicate-asset-id');
    expect(
      refusalOf(
        [TRI],
        [
          { asset: 'tri', name: 'x', position: [0, 0, 0] },
          { asset: 'tri', name: 'x', position: [1, 0, 0] },
        ],
      ),
    ).toBe('scene-duplicate-placement-name');
  });

  it('refuses a placement naming an unknown asset', () => {
    expect(refusalOf([TRI], [{ asset: 'ghost', position: [0, 0, 0] }])).toBe('scene-unknown-asset');
  });

  it('refuses a non-finite position', () => {
    expect(refusalOf([TRI], [{ asset: 'tri', position: [Number.NaN, 0, 0] }])).toBe(
      'scene-invalid-position',
    );
  });

  it('refuses a rotation whose length is not 1 within tolerance', () => {
    expect(refusalOf([TRI], [{ asset: 'tri', position: [0, 0, 0], rotation: [0, 0, 0, 2] }])).toBe(
      'scene-invalid-rotation',
    );
    expect(
      refusalOf([TRI], [{ asset: 'tri', position: [0, 0, 0], rotation: [0, 0, 0, 1.001] }]),
    ).toBe('scene-invalid-rotation');
  });

  it('accepts a rotation whose length is 1 within 1e-6', () => {
    const r = sceneManifest(
      [TRI],
      [{ asset: 'tri', position: [0, 0, 0], rotation: [0, 0, 0, 1 + 5e-7] }],
      TIGHT,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses a zero or non-finite scale', () => {
    expect(refusalOf([TRI], [{ asset: 'tri', position: [0, 0, 0], scale: 0 }])).toBe(
      'scene-invalid-scale',
    );
    expect(
      refusalOf([TRI], [{ asset: 'tri', position: [0, 0, 0], scale: [1, Number.NaN, 1] }]),
    ).toBe('scene-invalid-scale');
  });

  it('refuses LOD distances that are missing, mismatched, or not strictly increasing', () => {
    const lod = meshOf([UNIT_TRI]);
    expect(
      refusalOf([sceneAsset('l', QUAD, { lods: [lod] })], [{ asset: 'l', position: [0, 0, 0] }]),
    ).toBe('scene-invalid-lod-distances');
    expect(
      refusalOf(
        [sceneAsset('l', QUAD, { lods: [lod, lod], lodDistances: [10] })],
        [{ asset: 'l', position: [0, 0, 0] }],
      ),
    ).toBe('scene-invalid-lod-distances');
    expect(
      refusalOf(
        [sceneAsset('l', QUAD, { lods: [lod, lod], lodDistances: [20, 10] })],
        [{ asset: 'l', position: [0, 0, 0] }],
      ),
    ).toBe('scene-invalid-lod-distances');
  });

  it('refuses an unknown profile id and a profile with a non-finite limit', () => {
    expect(refusalOf([TRI], PLACE, 'nope' as 'mobile-scene')).toBe('scene-invalid-profile');
    expect(refusalOf([TRI], PLACE, { ...TIGHT, maxTriangles: Number.NaN })).toBe(
      'scene-invalid-profile',
    );
  });

  it('refuses an asset whose mesh cannot be measured, naming the level and cause', () => {
    const bad = meshOf([UNIT_TRI]);
    (bad.attributes.position as Float32Array)[0] = Number.NaN;
    const broken: SceneAsset = { id: 'bad', asset: { mesh: bad, lods: [], textures: {} } };
    const f = sceneManifest([broken], [{ asset: 'bad', position: [0, 0, 0] }], TIGHT);
    expect(f.ok).toBe(false);
    if (!f.ok) {
      expect(f.error.code).toBe('scene-asset-unmeasurable');
      expect(f.error.detail).toMatchObject({ asset: 'bad', level: 0 });
    }
  });

  it('refuses a non-2d texture as unmeasurable', () => {
    const cube = {
      ...texture(4, 4),
      shape: { viewDimension: '2d-array' as const, extent: { width: 4, height: 4, layers: 6 } },
    } as TextureAsset;
    expect(
      refusalOf(
        [sceneAsset('c', [UNIT_TRI], { textures: { albedo: cube } })],
        [{ asset: 'c', position: [0, 0, 0] }],
      ),
    ).toBe('scene-asset-unmeasurable');
  });
});

describe('sceneManifest budget codes, each with a passing and a failing limit', () => {
  it('triangles: fails one below the LOD0 total, passes at it', () => {
    const under = manifestOf(SCENE_ASSETS, SCENE_PLACEMENTS, { ...TIGHT, maxTriangles: 6 });
    expect(under.budget.ok).toBe(false);
    expect(under.budget.issues).toEqual([
      expect.objectContaining({
        code: 'scene-too-many-triangles',
        severity: 'error',
        detail: expect.objectContaining({ measured: 7, limit: 6 }),
      }),
    ]);
    expect(
      manifestOf(SCENE_ASSETS, SCENE_PLACEMENTS, { ...TIGHT, maxTriangles: 7 }).budget.ok,
    ).toBe(true);
  });

  it('draw calls: per-instance accounting fails at 4, passes at 5', () => {
    const per = { ...TIGHT, instancing: false };
    expect(
      manifestOf(SCENE_ASSETS, SCENE_PLACEMENTS, { ...per, maxDrawCalls: 4 }).budget.issues[0]
        ?.code,
    ).toBe('scene-too-many-draw-calls');
    expect(manifestOf(SCENE_ASSETS, SCENE_PLACEMENTS, { ...per, maxDrawCalls: 5 }).budget.ok).toBe(
      true,
    );
  });

  it('draw calls: instanced accounting counts 2 and ignores the per-instance 5', () => {
    const inst = { ...TIGHT, instancing: true };
    expect(
      manifestOf(SCENE_ASSETS, SCENE_PLACEMENTS, { ...inst, maxDrawCalls: 1 }).budget.issues[0]
        ?.code,
    ).toBe('scene-too-many-draw-calls');
    expect(manifestOf(SCENE_ASSETS, SCENE_PLACEMENTS, { ...inst, maxDrawCalls: 2 }).budget.ok).toBe(
      true,
    );
  });

  it('texture bytes: fails at 83, passes at 84', () => {
    const shared = texture(4, 4);
    const a = sceneAsset('a', [UNIT_TRI], { textures: { albedo: shared } });
    const p = [{ asset: 'a', position: [0, 0, 0] } as ScenePlacement];
    expect(manifestOf([a], p, { ...TIGHT, maxTextureBytes: 83 }).budget.issues[0]?.code).toBe(
      'scene-texture-bytes-over',
    );
    expect(manifestOf([a], p, { ...TIGHT, maxTextureBytes: 84 }).budget.ok).toBe(true);
  });

  it('mesh bytes: fails at 197, passes at 198', () => {
    expect(
      manifestOf(SCENE_ASSETS, SCENE_PLACEMENTS, { ...TIGHT, maxMeshBytes: 197 }).budget.issues[0]
        ?.code,
    ).toBe('scene-mesh-bytes-over');
    expect(
      manifestOf(SCENE_ASSETS, SCENE_PLACEMENTS, { ...TIGHT, maxMeshBytes: 198 }).budget.ok,
    ).toBe(true);
  });

  it('a measured over-budget scene is still returned as data, not a refusal', () => {
    const r = sceneManifest(SCENE_ASSETS, SCENE_PLACEMENTS, { ...TIGHT, maxTriangles: 1 });
    expect(r.ok).toBe(true);
  });

  it('a built-in profile id resolves to its named profile', () => {
    const m = manifestOf(SCENE_ASSETS, SCENE_PLACEMENTS, 'mobile-scene');
    expect(m.profile).toBe('mobile-scene');
    expect(m.budget.ok).toBe(
      m.totals.trianglesLod0 <= SCENE_OUTPUT_PROFILES['mobile-scene'].maxTriangles &&
        m.totals.drawCallsPerInstance <= SCENE_OUTPUT_PROFILES['mobile-scene'].maxDrawCalls &&
        m.totals.meshBytes <= SCENE_OUTPUT_PROFILES['mobile-scene'].maxMeshBytes,
    );
  });
});

describe('sceneTrianglesAt', () => {
  // One LOD'd asset: LOD0 is QUAD (2 triangles), LOD1 from distance 10 is TRI (1 triangle).
  const L = sceneAsset('l', QUAD, { lods: [meshOf([UNIT_TRI])], lodDistances: [10] });
  const manifest = manifestOf(
    [L],
    [
      { asset: 'l', position: [0, 0, 0] },
      { asset: 'l', position: [0, 0, 30] },
      { asset: 'l', position: [0, 0, 60] },
    ],
  );

  it('picks LOD0 when near, LOD1 when mid-range and far', () => {
    // Centres at z = 0, 30, 60; xy = (0.5, 0.5).
    expect(sceneTrianglesAt(manifest, [0.5, 0.5, 0])).toBe(2 + 1 + 1); // near: 0, 30, 60 -> 2, 1, 1
    expect(sceneTrianglesAt(manifest, [0.5, 0.5, -5])).toBe(2 + 1 + 1); // mid: 5, 35, 65 -> 2, 1, 1
    expect(sceneTrianglesAt(manifest, [0.5, 0.5, -100])).toBe(1 + 1 + 1); // far: all past 10 -> 1
  });

  it('takes the higher LOD on an exact tie at the switch distance', () => {
    const single = manifestOf([L], [{ asset: 'l', position: [0, 0, 0] }]);
    // Centre (0.5, 0.5, 0); camera at distance exactly 10 along z.
    expect(sceneTrianglesAt(single, [0.5, 0.5, 10])).toBe(1);
    expect(sceneTrianglesAt(single, [0.5, 0.5, 9.999])).toBe(2);
  });

  it('gives the LOD0 total for an asset without LODs, at any distance', () => {
    expect(sceneTrianglesAt(manifestOf(SCENE_ASSETS, SCENE_PLACEMENTS), [0, 0, 1e6])).toBe(7);
  });
});
