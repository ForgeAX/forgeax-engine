import { describe, expect, it } from 'vitest';
import { type JuzhePurlin, juzhePurlins } from '../recipes/juzhe-roof';
import {
  clipHalfPlane,
  type FoldMitre,
  facetFrames,
  foldMitre,
  polygonArea,
  sawtoothRow,
  type TileRowsOptions,
  tileRows,
} from '../recipes/tile-rows';

const roofPurlins = juzhePurlins(0.3, 0.9, 3);
const T = 0.02;

/** Distance from (u, y) to the infinite line through two cross-section purlins. */
function lineDistance(u: number, y: number, a: JuzhePurlin, b: JuzhePurlin): number {
  const dx = b.run - a.run;
  const dy = b.height - a.height;
  return Math.abs(dy * (u - a.run) - dx * (y - a.height)) / Math.hypot(dx, dy);
}

/** Smallest distance from a model vertex to any purlin facet line of the roof. */
function surfaceDistance(
  v: readonly [number, number, number],
  purlins: readonly JuzhePurlin[],
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < purlins.length; i++) {
    const a = purlins[i] as JuzhePurlin;
    const b = purlins[i + 1] as JuzhePurlin;
    best = Math.min(best, lineDistance(Math.abs(v[0]), v[1], a, b));
  }
  return best;
}

function vertexDistances(
  r: {
    model: { editMesh: { vertices(): number[]; position(v: number): [number, number, number] } };
  },
  purlins: readonly JuzhePurlin[],
): number[] {
  return r.model.editMesh
    .vertices()
    .map((v) => surfaceDistance(r.model.editMesh.position(v), purlins));
}

/** Hand example: two facets, drops 0.1 and 0.2 (slope lengths sqrt(0.13) and sqrt(0.10)). */
const handPurlins: JuzhePurlin[] = [
  { run: 0, height: 0.3 },
  { run: 0.3, height: 0.2 },
  { run: 0.6, height: 0 },
];
const handOptions: TileRowsOptions = {
  purlins: handPurlins,
  length: 0.6,
  tileWidth: 0.3,
  exposure: 0.2,
  lap: 0.05,
};

describe('tileRows', () => {
  it('defaults build a closed, passing model on the 3-span roof', () => {
    const r = tileRows({ purlins: roofPurlins });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const report = r.value.model.validate({ contacts: r.value.contacts ?? [] });
    expect(report.closed).toBe(true);
    expect(report.pass).toBe(true);
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    // 2 sides x 3 facets x 2 rows x 4 columns = 48 pans; 12 rows x 3 covers = 36 covers.
    expect(r.value.dimensions.pans).toBe(48);
    expect(r.value.dimensions.covers).toBe(36);
    // 692 triangles for the default roof (2 x 3 facets, 4 columns, 36 covers).
    expect(report.faces).toBe(692);
  });

  it('tile length is the largest pitch plus the lap, and rows divide each facet evenly', () => {
    const r = tileRows(handOptions);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Facet 0 has slope sqrt(0.10) = 0.31623, less the 0.08 ridge cap: 2 rows of 0.11811.
    // Facet 1 has slope sqrt(0.13) = 0.36056 and no cap: 2 rows of 0.18028. The longer pitch
    // sets the tile length.
    expect(r.value.dimensions.pitchMax).toBeCloseTo(Math.sqrt(0.13) / 2, 12);
    expect(r.value.dimensions.pitchMin).toBeCloseTo((Math.sqrt(0.1) - 0.08) / 2, 12);
    expect(r.value.dimensions.tileLength).toBeCloseTo(Math.sqrt(0.13) / 2 + 0.05, 12);
    expect(r.value.dimensions.rows).toBe(8);
    expect(r.value.dimensions.columns).toBe(2);
    expect(r.value.dimensions.pans).toBe(16);
    expect(r.value.dimensions.covers).toBe(8);
  });

  it('hand-computed contacts: pan-cover seats, row neighbours, fold neighbours and the ridge', () => {
    const r = tileRows(handOptions);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Per side with 2 facets x 2 rows and 2 columns (1 cover per row):
    //   within a row: 1 cover x 2 pan seats = 2 per row, 4 rows -> 8
    //   row to row inside a facet: 2 pan + 1 cover = 3, one pair per facet -> 6
    //   fold: last row of facet 0 to first row of facet 1 -> 3
    //   ridge cap to the first row of facet 0 -> 3
    // Two sides: 2 * (8 + 6 + 3 + 3) = 40.
    expect(r.value.contacts?.length).toBe(40);
  });

  it('surface band: every vertex lies within the cover profile of a roof facet', () => {
    const r = tileRows({ purlins: roofPurlins, thickness: T });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Pans rise to 2t at the butt; covers rise to 2.5t plus their radius at the butt.
    const coverRadius = (0.3 * 0.3) / 2;
    const band = 2.5 * T + coverRadius;
    const distances = vertexDistances(r.value, roofPurlins);
    for (const d of distances) expect(d).toBeLessThanOrEqual(band + 1e-9);
    // Bedding vertices sit exactly on the facet plane.
    expect(distances.filter((d) => d <= 1e-9).length).toBeGreaterThan(0);
  });

  it('is deterministic: the same options give the same mesh bytes', () => {
    const options: TileRowsOptions = { purlins: roofPurlins, lap: 0.1 };
    const a = tileRows(options);
    const b = tileRows(options);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(
      Buffer.from(a.value.model.snapshot()).equals(Buffer.from(b.value.model.snapshot())),
    ).toBe(true);
  });

  it('sawtooth: a butt stands one thickness above the head of the row below it', () => {
    const f = facetFrames(handPurlins)[0];
    if (f === undefined) throw new Error('facet');
    const lower = sawtoothRow(f, 0, 0.1, T);
    const upper = sawtoothRow(f, 0.1, 0.2, T);
    // Butt of the lower row (index 2) minus head of the upper row (index 3), along the normal.
    const butt = lower[2] as [number, number];
    const head = upper[3] as [number, number];
    const step = (butt[0] - head[0]) * f.n[0] + (butt[1] - head[1]) * f.n[1];
    expect(step).toBeCloseTo(T, 12);
  });

  it('mitre clip: each fold facet keeps its own side of the bisector', () => {
    const facets = facetFrames(handPurlins);
    const mitre: FoldMitre = foldMitre(facets, 1);
    const upper = facets[0];
    const lower = facets[1];
    if (upper === undefined || lower === undefined) throw new Error('facets');
    // Both facets' rows lie on their own side near the fold, so the clip removes nothing from
    // an ordinary fold: the rows meet along the mitre line.
    const upperRow = sawtoothRow(upper, 0.05, upper.length, T);
    const lowerRow = sawtoothRow(lower, 0, 0.1, T);
    const keptUpper = clipHalfPlane(upperRow, mitre.origin, mitre.dir);
    const keptLower = clipHalfPlane(lowerRow, mitre.origin, [-mitre.dir[0], -mitre.dir[1]]);
    expect(polygonArea(keptUpper)).toBeCloseTo(polygonArea(upperRow), 12);
    expect(polygonArea(keptLower)).toBeCloseTo(polygonArea(lowerRow), 12);
    // Opposite sides: the upper row cannot be kept by the lower half-plane.
    const crossUpper = keptUpper.map(
      ([x, y]) => mitre.dir[0] * (y - mitre.origin[1]) - mitre.dir[1] * (x - mitre.origin[0]),
    );
    expect(Math.min(...crossUpper)).toBeGreaterThanOrEqual(-1e-12);
  });

  it('clipHalfPlane keeps the half of a unit square on the requested side', () => {
    const square = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as const;
    // cross((0,1), p - (0.5, 0)) >= 0 keeps p.x <= 0.5.
    const half = clipHalfPlane(square, [0.5, 0], [0, 1]);
    expect(polygonArea(half)).toBeCloseTo(0.5, 12);
    expect(half.every(([x]) => x <= 0.5 + 1e-12)).toBe(true);
  });

  it.each([
    ['tile width too small', { tileWidth: 0.001 }],
    ['lap too large', { lap: 0.6 }],
    ['exposure too large', { exposure: 2 }],
    ['thickness too large', { thickness: 0.2 }],
    ['cover not narrower than the joint', { coverWidth: 0.3, tileWidth: 0.3 }],
    ['purlins with one point', { purlins: [{ run: 0, height: 0.3 }] }],
    [
      'ridge not at run zero',
      {
        purlins: [
          { run: 0.1, height: 0.3 },
          { run: 0.6, height: 0 },
        ],
      },
    ],
    [
      'heights rise outward',
      {
        purlins: [
          { run: 0, height: 0.3 },
          { run: 0.3, height: 0.4 },
        ],
      },
    ],
    [
      'ridge cap longer than the first facet',
      {
        purlins: [
          { run: 0, height: 0.3 },
          { run: 0.001, height: 0.2999 },
          { run: 0.6, height: 0 },
        ],
      },
    ],
  ])('refuses %s with a structured argument error', (_, extra) => {
    const r = tileRows({ purlins: roofPurlins, ...extra } as TileRowsOptions);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('model-invalid-argument');
  });

  it('falsifier: tiles laid on a straight bedding leave the built roof facets', () => {
    // The same tiles on a straight line from ridge to eave: the bedding sits off the 3-span roof
    // by more than the designed cover band at the first purlin.
    const straight: JuzhePurlin[] = [0, 1, 2, 3].map((p) => ({
      run: 0.3 * p,
      height: 0.3 * (1 - p / 3),
    }));
    const r = tileRows({ purlins: straight });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const worst = Math.max(...vertexDistances(r.value, roofPurlins));
    expect(worst).toBeGreaterThan(2.5 * T + (0.3 * 0.3) / 2 + 1e-6);
  });
});
