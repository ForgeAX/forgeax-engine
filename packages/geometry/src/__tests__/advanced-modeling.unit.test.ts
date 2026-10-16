import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createExtrusionGeometry,
  createProfileSweepGeometry,
  type Vec2Point,
  type Vec3Point,
} from '../index';

const rectangle = (x: number, y: number, w: number, h: number): Vec2Point[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const outer = rectangle(-2, -2, 4, 4),
  hole = rectangle(-1, -1, 2, 2);
function metrics(mesh: MeshAsset) {
  const positions = mesh.attributes.position as Float32Array,
    normals = mesh.attributes.normal as Float32Array;
  const indices = mesh.indices as Uint32Array;
  const edges = new Map<string, { count: number; balance: number }>();
  const point = (i: number): Vec3Point => [
    positions[i * 3] as number,
    positions[i * 3 + 1] as number,
    positions[i * 3 + 2] as number,
  ];
  let volume = 0,
    area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] as number,
      ib = indices[i + 1] as number,
      ic = indices[i + 2] as number;
    const a = point(ia),
      b = point(ib),
      c = point(ic);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [
      (u[1] as number) * (v[2] as number) - (u[2] as number) * (v[1] as number),
      (u[2] as number) * (v[0] as number) - (u[0] as number) * (v[2] as number),
      (u[0] as number) * (v[1] as number) - (u[1] as number) * (v[0] as number),
    ];
    const size = Math.hypot(...n);
    expect(size).toBeGreaterThan(1e-10);
    expect(
      (n[0] as number) * (normals[ia * 3] as number) +
        (n[1] as number) * (normals[ia * 3 + 1] as number) +
        (n[2] as number) * (normals[ia * 3 + 2] as number),
    ).toBeGreaterThan(0);
    area += size / 2;
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) +
        a[1] * (b[2] * c[0] - b[0] * c[2]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const keyP = (p as Vec3Point).join(','),
        keyQ = (q as Vec3Point).join(',');
      const positive = keyP < keyQ,
        key = positive ? `${keyP}|${keyQ}` : `${keyQ}|${keyP}`;
      const edge = edges.get(key) ?? { count: 0, balance: 0 };
      edge.count++;
      edge.balance += positive ? 1 : -1;
      edges.set(key, edge);
    }
  }
  for (const edge of edges.values()) expect(edge).toEqual({ count: 2, balance: 0 });
  for (const values of Object.values(mesh.attributes))
    if (values instanceof Float32Array)
      expect(Array.from(values).every(Number.isFinite)).toBe(true);
  return { area, volume };
}
describe('advanced polygon modeling', () => {
  it('keeps holes empty, watertight and outward with independent volume and area', () => {
    for (const reversed of [false, true]) {
      const mesh = createExtrusionGeometry(reversed ? [...outer].reverse() : outer, 2, {
        holes: [reversed ? [...hole].reverse() : hole],
      }).unwrap();
      const result = metrics(mesh);
      expect(result.volume).toBeCloseTo(24, 5);
      expect(result.area).toBeCloseTo(72, 5);
      expect(Array.from(mesh.aabb ?? [])).toEqual([-2, -2, -1, 2, 2, 1]);
    }
  });
  it('triangulates multiple holes in a concave material domain without mutating inputs', () => {
    const contour = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 6 },
      { x: 4, y: 6 },
      { x: 4, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 6 },
      { x: 0, y: 6 },
    ];
    const holes = [rectangle(0.5, 0.5, 1, 1), rectangle(4.5, 3, 1, 1)];
    const before = JSON.stringify({ contour, holes });
    expect(metrics(createExtrusionGeometry(contour, 3, { holes }).unwrap()).volume).toBeCloseTo(
      78,
      5,
    );
    expect(JSON.stringify({ contour, holes })).toBe(before);
  });
  it('builds bounded rim chamfers and rounded bevel layers, including hole walls', () => {
    // Square prism 4x4x2 with 0.25 inset: each end removes
    // integral_0^b (16-(4-2t)^2) dt = 8*b^2-4*b^3/3.
    const bevel = 0.25;
    const mesh = createExtrusionGeometry(outer, 2, { bevelSize: bevel }).unwrap();
    expect(metrics(mesh).volume).toBeCloseTo(32 - 2 * (8 * bevel ** 2 - (4 * bevel ** 3) / 3), 5);
    expect(Array.from(mesh.aabb ?? [])).toEqual([-2, -2, -1, 2, 2, 1]);
    for (const bevelSegments of [1, 3, 8]) {
      const rounded = createExtrusionGeometry(outer, 2, {
        holes: [hole],
        bevelSize: bevel,
        bevelSegments,
      }).unwrap();
      const volume = metrics(rounded).volume;
      expect(volume).toBeGreaterThan(20);
      expect(volume).toBeLessThan(24);
    }
  });
  it('sweeps an arbitrary concave profile with a hole and both caps', () => {
    const shape = { contour: outer, holes: [hole] };
    const straight = createProfileSweepGeometry(
      shape,
      [
        [0, 0, 0],
        [0, 0, 3],
      ],
      { up: [1, 0, 0] },
    ).unwrap();
    expect(metrics(straight).volume).toBeCloseTo(36, 5);
    const profile = [
      { x: -0.2, y: -0.2 },
      { x: 0.2, y: -0.2 },
      { x: 0.2, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0.2 },
      { x: -0.2, y: 0.2 },
    ];
    const path = Array.from(
      { length: 33 },
      (_, i): Vec3Point => [
        Math.sin((i / 32) * Math.PI) * 2,
        i / 32,
        Math.cos((i / 32) * Math.PI) * 2,
      ],
    );
    expect(
      metrics(createProfileSweepGeometry({ contour: profile }, path).unwrap()).volume,
    ).toBeGreaterThan(0.5);
  });
  it('transports frames through the old reference-axis threshold and closes a 3D loop', () => {
    const profile = rectangle(-0.05, -0.1, 0.1, 0.2);
    const path = Array.from(
      { length: 65 },
      (_, i): Vec3Point => [
        2 * Math.cos((i / 64) * 2 * Math.PI),
        2 * Math.sin((i / 64) * 2 * Math.PI),
        0.3 * Math.sin((i / 64) * 4 * Math.PI),
      ],
    );
    path[path.length - 1] = path[0] as Vec3Point;
    expect(
      metrics(createProfileSweepGeometry({ contour: profile }, path, { closed: true }).unwrap())
        .volume,
    ).toBeGreaterThan(0.2);
  });
  it('rejects malformed domains, collapsing bevels, reversals and excessive work', () => {
    for (const holes of [
      [rectangle(3, 3, 1, 1)],
      [rectangle(1, -1, 2, 2)],
      [hole, rectangle(-0.5, -0.5, 1, 1)],
      [hole, hole],
    ])
      expect(createExtrusionGeometry(outer, 2, { holes }).ok).toBe(false);
    for (const bevelSize of [-1, NaN, 1, 10])
      expect(createExtrusionGeometry(outer, 2, { bevelSize }).ok).toBe(false);
    expect(createExtrusionGeometry(rectangle(-0.1, -2, 0.2, 4), 2, { bevelSize: 0.2 }).ok).toBe(
      false,
    );
    expect(createExtrusionGeometry(outer, 2, { holes: [hole], bevelSize: 0.75 }).ok).toBe(false);
    for (const path of [
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
      [
        [0, 0, 0],
        [0, 0, 1],
        [0, 0, 0],
      ],
    ] as const)
      expect(createProfileSweepGeometry({ contour: outer }, path).ok).toBe(false);
    expect(
      createProfileSweepGeometry(
        { contour: outer },
        [
          [0, 0, 0],
          [0, 0, 1],
        ],
        { up: [0, 0, 1] },
      ).ok,
    ).toBe(false);
    expect(createExtrusionGeometry(outer, 2, { bevelSegments: Infinity }).ok).toBe(false);
    expect(
      createExtrusionGeometry(
        Array.from({ length: 4097 }, () => ({ x: 0, y: 0 })),
        2,
      ).ok,
    ).toBe(false);
  });
  it('rejects precision loss, invalid closures and invalid initial frame directions', () => {
    expect(createExtrusionGeometry(rectangle(1e10, 1e10, 1, 1), 1).ok).toBe(false);
    expect(createExtrusionGeometry(rectangle(-1e40, -1e40, 2e40, 2e40), 1).ok).toBe(false);
    expect(createProfileSweepGeometry({ contour: outer }, []).ok).toBe(false);
    expect(
      createProfileSweepGeometry({ contour: outer }, [
        [0, 0, 0],
        [0, NaN, 1],
      ]).ok,
    ).toBe(false);
    expect(
      createProfileSweepGeometry(
        { contour: outer },
        [
          [0, 0, 0],
          [0, 0, 1],
        ],
        { closed: true },
      ).ok,
    ).toBe(false);
    expect(
      createProfileSweepGeometry(
        { contour: outer },
        [
          [0, 0, 0],
          [0, 0, 1],
        ],
        { up: [NaN, 0, 0] },
      ).ok,
    ).toBe(false);
    expect(
      createProfileSweepGeometry({ contour: [] }, [
        [0, 0, 0],
        [0, 0, 1],
      ]).ok,
    ).toBe(false);
    const open = createProfileSweepGeometry(
      { contour: outer },
      [
        [0, 0, 0],
        [0, 0, 1],
      ],
      { capped: false },
    ).unwrap();
    expect(open.indices?.length).toBe(24);
    const closedContour = [...outer, outer[0] as Vec2Point];
    expect(metrics(createExtrusionGeometry(closedContour, 1).unwrap()).volume).toBeCloseTo(16, 5);
    expect(createExtrusionGeometry([...outer, outer[3] as Vec2Point], 1).ok).toBe(false);
  });
  it('shares simplified collinear cap/wall boundaries and rejects backtracking', () => {
    const subdivided = [
      { x: -2, y: -2 },
      { x: 0, y: -2 },
      { x: 2, y: -2 },
      { x: 2, y: 2 },
      { x: -2, y: 2 },
    ];
    expect(
      metrics(createExtrusionGeometry(subdivided, 1, { holes: [hole] }).unwrap()).volume,
    ).toBeCloseTo(12, 5);
    expect(
      createExtrusionGeometry(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0.5, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        1,
      ).ok,
    ).toBe(false);
  });
});
