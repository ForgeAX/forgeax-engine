import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { massProperties } from '../mass';
import { model } from '../model';
import { region2d, toRegion } from '../region2d';
import { type SheetMetalSpec, sheet } from '../sheet';

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const T = 0.002;
const R = 0.003;
const W = 0.04;

function allowance(angle: number, radius: number, k: number): number {
  return (angle * Math.PI * (radius + k * T)) / 180;
}

/** An L bracket: two flanges of `leg` meters joined by one bend of `angle` degrees. */
function lBracket(angle: number, k = 0.44, leg = 0.03): SheetMetalSpec {
  const ba = allowance(Math.abs(angle), R, k);
  return {
    thickness: T,
    kFactor: k,
    outline: rect(-leg - ba / 2, 0, leg + ba / 2, W),
    bends: [
      {
        line: [
          [0, 0],
          [0, W],
        ],
        angle,
        radius: R,
      },
    ],
  };
}

function volumeOf(spec: SheetMetalSpec): number {
  const m = model();
  const r = m.sheet(spec);
  if (r.error) throw r.error;
  const p = massProperties(m, { density: 1 });
  if (!p.ok) throw p.error;
  return p.value.volume;
}

/** Closed form of the faceted fold: flat flanges plus radial wedges of the arc. */
function facetedVolume(spec: SheetMetalSpec, facets: number): number {
  const bend = spec.bends[0];
  if (!bend) throw new Error('no bend');
  const theta = (Math.abs(bend.angle) * Math.PI) / 180;
  const k = spec.kFactor ?? 0.44;
  const ba = theta * (bend.radius + k * T);
  const flat = region2d.area(toRegion(spec.outline));
  const wedges =
    (facets * Math.sin(theta / facets) * ((bend.radius + T) ** 2 - bend.radius ** 2)) / 2;
  return (flat - ba * W) * T + wedges * W;
}

describe('sheet bend allowance', () => {
  it.each([
    [90, 0.003, 0.002, 0.44],
    [45, 0.001, 0.0015, 0.33],
    [30, 0.0005, 0.003, 0.5],
    [135, 0.01, 0.001, 0],
    [179, 0.002, 0.002, 1],
  ])('BA = angle * (r + k t) for %s deg, r %s, t %s, k %s', (angle, r, t, k) => {
    expect(sheet.bendAllowance(angle, r, t, k)).toBeCloseTo(
      (angle * Math.PI * (r + k * t)) / 180,
      15,
    );
  });

  it('defaults k to 0.44 and ignores the fold direction', () => {
    expect(sheet.bendAllowance(90, 0.003, 0.002)).toBe(sheet.bendAllowance(90, 0.003, 0.002, 0.44));
    expect(sheet.bendAllowance(-90, 0.003, 0.002)).toBe(sheet.bendAllowance(90, 0.003, 0.002));
  });
});

describe('sheet folded body', () => {
  it('folds an L bracket into a closed solid with the faceted closed-form volume', () => {
    const spec = lBracket(90);
    expect(volumeOf(spec)).toBeCloseTo(facetedVolume(spec, 18), 12);
  });

  it.each([
    30, 60, 90, 120, -90,
  ])('mass matches flat area x t at k = 0.5 within the facet bound (%s deg)', (angle) => {
    const spec = lBracket(angle, 0.5);
    const flat = region2d.area(toRegion(spec.outline)) * T;
    const rel = Math.abs(volumeOf(spec) - flat) / flat;
    expect(rel).toBeLessThan(2e-3);
  });

  it('deviates from flat area x t as the textbook volume rule predicts for k != 0.5', () => {
    const spec = lBracket(90, 0.3);
    const flat = region2d.area(toRegion(spec.outline)) * T;
    const theta = Math.PI / 2;
    const predicted = theta * T * T * (0.5 - 0.3) * W;
    expect(Math.abs(volumeOf(spec) - flat - -predicted * -1)).toBeLessThan(
      0.02 * predicted + 2e-3 * flat,
    );
  });

  it('places the far flange perpendicular to the base', () => {
    const m = model();
    const r = m.sheet(lBracket(90));
    if (r.error) throw r.error;
    const mesh = m.editMesh;
    const zs = mesh
      .faces()
      .flatMap((f) => mesh.faceVertices(f).map((v) => mesh.position(v)[2] as number));
    expect(Math.max(...zs)).toBeGreaterThan(0.03);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-1e-9);
  });

  it('counts roles', () => {
    const m = model();
    const r = m.sheet({ ...lBracket(90), label: 'bracket' });
    expect(r.error).toBeUndefined();
    expect(r.roles.bend).toBeGreaterThan(0);
    expect(r.roles.sheet).toBeGreaterThan(0);
    expect(r.roles['sheet-edge']).toBeGreaterThan(0);
    const total = Object.values(r.roles).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(r.faces);
  });

  it('folds a tray with four bends and corner reliefs', () => {
    const t = 0.0015;
    const rad = 0.002;
    const ba = (rad + 0.44 * t) * (Math.PI / 2);
    const bodyHalf = 0.03;
    const flange = 0.015;
    const c = bodyHalf + ba / 2;
    const reach = bodyHalf + ba + flange;
    const cross = region2d.union(
      rect(-bodyHalf, -reach, bodyHalf, reach),
      rect(-reach, -bodyHalf, reach, bodyHalf),
    );
    if (!cross.ok) throw cross.error;
    const spec: SheetMetalSpec = {
      thickness: t,
      outline: cross.value.region,
      bends: [
        {
          line: [
            [-c, -reach],
            [-c, reach],
          ],
          angle: 90,
          radius: rad,
        },
        {
          line: [
            [c, reach],
            [c, -reach],
          ],
          angle: 90,
          radius: rad,
        },
        {
          line: [
            [-reach, c],
            [reach, c],
          ],
          angle: 90,
          radius: rad,
        },
        {
          line: [
            [reach, -c],
            [-reach, -c],
          ],
          angle: 90,
          radius: rad,
        },
      ],
    };
    const m = model();
    const r = m.sheet(spec);
    if (r.error) throw r.error;
    const p = massProperties(m, { density: 1 });
    if (!p.ok) throw p.error;
    const flat = region2d.area(cross.value.region) * t;
    expect(Math.abs(p.value.volume - flat) / flat).toBeLessThan(0.03);
  });
});

describe('sheet flat pattern', () => {
  it('returns the checked outline', () => {
    const flat = sheet.flat(lBracket(90));
    if (!flat.ok) throw flat.error;
    expect(region2d.area(flat.value)).toBeCloseTo((0.06 + allowance(90, R, 0.44)) * W, 12);
  });

  it('draws bend lines on GUIDE and the outline on VISIBLE in millimeters', () => {
    const dxf = sheet.dxf(lBracket(90));
    if (!dxf.ok) throw dxf.error;
    expect(dxf.value).toContain('VISIBLE');
    expect(dxf.value).toContain('GUIDE');
    const again = sheet.dxf(lBracket(90));
    if (!again.ok) throw again.error;
    expect(again.value).toBe(dxf.value);
  });

  it('keeps the DXF bytes (golden)', () => {
    const spec: SheetMetalSpec = {
      thickness: 0.002,
      kFactor: 0.44,
      outline: {
        outer: rect(-0.0345, 0, 0.0345, 0.04),
        holes: [
          [
            [-0.02, 0.01],
            [-0.02, 0.03],
            [-0.01, 0.03],
            [-0.01, 0.01],
          ],
        ],
      },
      bends: [
        {
          line: [
            [0, 0],
            [0, 0.04],
          ],
          angle: 90,
          radius: 0.003,
        },
      ],
    };
    const dxf = sheet.dxf(spec);
    if (!dxf.ok) throw dxf.error;
    const hash = createHash('sha256').update(dxf.value).digest('hex');
    expect(hash).toBe('6308aeaf0f5132a860bf84fe4b176c2d8f7b981ba3699f7ed7d155137380d5d1');
  });
});

describe('sheet errors', () => {
  const code = (spec: SheetMetalSpec) => {
    const m = model();
    return m.sheet(spec).error;
  };

  it('rejects a bend without material on a side as not-sheet', () => {
    const spec = {
      ...lBracket(90),
      bends: [
        {
          line: [
            [0.2, 0],
            [0.2, W],
          ],
          angle: 90,
          radius: R,
        },
      ],
    } as SheetMetalSpec;
    const e = code(spec);
    expect(e?.code).toBe('model-precondition');
    expect(e?.detail).toMatchObject({ reason: 'not-sheet', cause: 'bend-no-material' });
  });

  it('rejects a bend line shorter than the material', () => {
    const spec = {
      ...lBracket(90),
      bends: [
        {
          line: [
            [0, 0.01],
            [0, 0.03],
          ],
          angle: 90,
          radius: R,
        },
      ],
    } as SheetMetalSpec;
    expect(code(spec)?.detail).toMatchObject({ reason: 'not-sheet', cause: 'bend-line-short' });
  });

  it('rejects an oblique outline edge crossing the zone', () => {
    const ba = allowance(90, R, 0.44);
    const spec: SheetMetalSpec = {
      thickness: T,
      outline: [
        [-0.03, 0],
        [0.03, 0],
        [0.03, W],
        [-0.03, 0.02],
      ],
      bends: [
        {
          line: [
            [0, -1],
            [0, 1],
          ],
          angle: 90,
          radius: R,
        },
      ],
    };
    void ba;
    expect(code(spec)?.detail).toMatchObject({ reason: 'not-sheet', cause: 'bend-edge-oblique' });
  });

  it('rejects overlapping bend zones', () => {
    const spec: SheetMetalSpec = {
      ...lBracket(90),
      bends: [
        {
          line: [
            [0, 0],
            [0, W],
          ],
          angle: 90,
          radius: R,
        },
        {
          line: [
            [0.001, 0],
            [0.001, W],
          ],
          angle: 90,
          radius: R,
        },
      ],
    };
    expect(code(spec)?.detail).toMatchObject({ reason: 'not-sheet', cause: 'bend-zones-overlap' });
  });

  it.each([
    ['thickness', { thickness: 0 }],
    ['kFactor', { kFactor: 1.5 }],
    [
      'angle 0',
      {
        bends: [
          {
            line: [
              [0, 0],
              [0, W],
            ],
            angle: 0,
            radius: R,
          },
        ],
      },
    ],
    [
      'angle 180',
      {
        bends: [
          {
            line: [
              [0, 0],
              [0, W],
            ],
            angle: 180,
            radius: R,
          },
        ],
      },
    ],
    [
      'radius',
      {
        bends: [
          {
            line: [
              [0, 0],
              [0, W],
            ],
            angle: 90,
            radius: 0,
          },
        ],
      },
    ],
    ['two shapes', { outline: [rect(0, 0, 1, 1), rect(2, 2, 3, 3)] }],
  ])('rejects a bad %s as an invalid argument', (_name, patch) => {
    const e = code({ ...lBracket(90), ...patch } as SheetMetalSpec);
    expect(e?.code).toBe('model-invalid-argument');
  });
});

describe('sheet determinism', () => {
  it('folds to identical bytes twice', () => {
    const bytes = () => {
      const m = model();
      const r = m.sheet(lBracket(75));
      if (r.error) throw r.error;
      const mesh = m.editMesh;
      return mesh
        .faces()
        .map((f) =>
          mesh
            .faceVertices(f)
            .map((v) => mesh.position(v).join(','))
            .join('|'),
        )
        .join(';');
    };
    expect(bytes()).toBe(bytes());
  });
});
