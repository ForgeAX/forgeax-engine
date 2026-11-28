import { describe, expect, it } from 'vitest';
import type { ModelingError } from '../../errors';
import { ShapeAssembler } from '../assembler';
import { cone, cylinder, revolve, sphere, torus } from '../build';
import { measure } from '../measure';
import { measureTrimmedFace } from '../measure-trimmed';
import type { Frame, Shape } from '../types';
import type { P3 } from '../vec';

type Maybe<T> = { ok: true; value: T } | { ok: false; error: ModelingError };
const TAU = 2 * Math.PI;
const ID: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

function must<T>(r: Maybe<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function sphereCap(radius: number, z: number): Shape {
  const asm = must(ShapeAssembler.create(2 * radius));
  const sphere = asm.surface({ kind: 'sphere', frame: ID, radius });
  const v0 = Math.asin(z / radius);
  const r = Math.sqrt(radius * radius - z * z);
  const circle = asm.edge(
    asm.curve({ kind: 'circle', frame: { ...ID, o: [0, 0, z] }, radius: r }),
    0,
    TAU,
  );
  const seamFrame: Frame = { o: ID.o, x: ID.x, y: ID.z, z: [0, -1, 0] };
  const seam = asm.edge(asm.curve({ kind: 'circle', frame: seamFrame, radius }), v0, Math.PI / 2);
  const pole = asm.degenerateEdge(asm.vertex([0, 0, radius]));
  const curvedLoop = must(
    asm.loop(
      sphere,
      [{ edge: circle }, { edge: seam }, { edge: pole, span: [-TAU, 0] }, { edge: seam }],
      true,
    ),
  );
  const curved = asm.face(sphere, [curvedLoop], false, 'cap');
  const plane = asm.surface({ kind: 'plane', frame: { ...ID, o: [0, 0, z] } });
  const diskLoop = must(asm.loop(plane, [{ edge: circle }], true));
  const disk = asm.face(plane, [diskLoop], true, 'base');
  asm.shell([curved, disk]);
  return must(asm.finish());
}

function boxWithBore(radius: number): Shape {
  const asm = must(ShapeAssembler.create(4));
  const faces: number[] = [];
  const edgeMap = new Map<string, number>();
  const edge = (a: P3, b: P3) => {
    const ka = a.join(',');
    const kb = b.join(',');
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    let found = edgeMap.get(key);
    if (found === undefined) {
      const delta: P3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      found = asm.edge(asm.curve({ kind: 'line', o: a, d: delta }), 0, 1);
      edgeMap.set(key, found);
    }
    return found;
  };
  const rect = (surface: number, points: readonly P3[]) =>
    must(
      asm.loop(
        surface,
        points.map((p, i) => ({ edge: edge(p, points[(i + 1) % points.length] as P3) })),
        true,
      ),
    );
  const planes: readonly { o: P3; x: P3; y: P3; z: P3 }[] = [
    { o: [0, 0, -1], x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] },
    { o: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
    { o: [1, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
    { o: [-1, 0, 0], x: [0, 1, 0], y: [0, 0, -1], z: [-1, 0, 0] },
    { o: [0, 1, 0], x: [0, 0, 1], y: [1, 0, 0], z: [0, 1, 0] },
    { o: [0, -1, 0], x: [0, 0, 1], y: [-1, 0, 0], z: [0, -1, 0] },
  ];
  const circleAt = (z: number) =>
    asm.edge(asm.curve({ kind: 'circle', frame: { ...ID, o: [0, 0, z] }, radius }), 0, TAU);
  const top = circleAt(1);
  const bottom = circleAt(-1);
  const hole = (surface: number, circle: number) =>
    must(asm.loop(surface, [{ edge: circle }], false));
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i] as (typeof planes)[number];
    const surface = asm.surface({ kind: 'plane', frame: p });
    const points = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(
      ([u, v]) =>
        [
          p.o[0] + p.x[0] * (u as number) + p.y[0] * (v as number),
          p.o[1] + p.x[1] * (u as number) + p.y[1] * (v as number),
          p.o[2] + p.x[2] * (u as number) + p.y[2] * (v as number),
        ] as P3,
    );
    const outer = rect(surface, points);
    const loops = i < 2 ? [outer, hole(surface, i === 0 ? bottom : top)] : [outer];
    faces.push(asm.face(surface, loops, false, `box${i}`));
  }
  const cylinder = asm.surface({ kind: 'cylinder', frame: ID, radius });
  const seam = asm.edge(asm.curve({ kind: 'line', o: [radius, 0, -1], d: [0, 0, 2] }), 0, 1);
  const side = must(
    asm.loop(cylinder, [{ edge: bottom }, { edge: seam }, { edge: top }, { edge: seam }], true),
  );
  faces.push(asm.face(cylinder, [side], true, 'bore'));
  asm.shell(faces);
  return must(asm.finish());
}

function torusSegment(major: number, minor: number, sweep: number): Shape {
  const asm = must(ShapeAssembler.create(2 * (major + minor)));
  const torusSurface = asm.surface({ kind: 'torus', frame: ID, major, minor });
  const outer = asm.edge(asm.curve({ kind: 'circle', frame: ID, radius: major + minor }), 0, sweep);
  const frameAt = (u: number): Frame => {
    const c = Math.cos(u);
    const s = Math.sin(u);
    return { o: [major * c, major * s, 0], x: [c, s, 0], y: [0, 0, 1], z: [s, -c, 0] };
  };
  const end0 = asm.edge(asm.curve({ kind: 'circle', frame: frameAt(0), radius: minor }), 0, TAU);
  const end1 = asm.edge(
    asm.curve({ kind: 'circle', frame: frameAt(sweep), radius: minor }),
    0,
    TAU,
  );
  const loop = must(
    asm.loop(
      torusSurface,
      [
        { edge: outer, pcurve: { kind: 'line', o: [0, 0], d: [1, 0] } },
        { edge: end1, pcurve: { kind: 'line', o: [sweep, 0], d: [0, 1] } },
        { edge: outer, pcurve: { kind: 'line', o: [0, TAU], d: [1, 0] } },
        { edge: end0, pcurve: { kind: 'line', o: [0, 0], d: [0, 1] } },
      ],
      true,
    ),
  );
  const face = asm.face(torusSurface, [loop], false, 'segment');
  const planes: number[] = [];
  for (const [index, u] of [0, sweep].entries()) {
    const c = Math.cos(u);
    const s = Math.sin(u);
    const normal: P3 = index === 0 ? [s, -c, 0] : [-s, c, 0];
    const x: P3 = [c, s, 0];
    const y: P3 = [
      normal[1] * x[2] - normal[2] * x[1],
      normal[2] * x[0] - normal[0] * x[2],
      normal[0] * x[1] - normal[1] * x[0],
    ];
    const surface = asm.surface({
      kind: 'plane',
      frame: { o: [major * c, major * s, 0], x, y, z: normal },
    });
    const edge = index === 0 ? end0 : end1;
    const disk = must(asm.loop(surface, [{ edge }], true));
    planes.push(asm.face(surface, [disk], false, `end${index}`));
  }
  asm.shell([face, ...planes]);
  return must(asm.finish());
}

describe('trimmed-face exact measurements', () => {
  it('measures a box with a circular through-hole, including plane loops', () => {
    const radius = 0.35;
    const result = must(measure(boxWithBore(radius)));
    expect(Math.abs(result.volume - (8 - 2 * Math.PI * radius * radius))).toBeLessThan(1e-9);
    expect(
      Math.abs(result.area - (24 - 2 * Math.PI * radius * radius + 4 * Math.PI * radius)),
    ).toBeLessThan(1e-9);
    expect(Math.abs(result.centroid?.[0] ?? Infinity)).toBeLessThan(1e-9);
    expect(Math.abs(result.centroid?.[1] ?? Infinity)).toBeLessThan(1e-9);
    expect(Math.abs(result.centroid?.[2] ?? Infinity)).toBeLessThan(1e-9);
  });

  it('preserves signed loop contributions for reversed faces and dropped holes', () => {
    const shape = boxWithBore(0.35);
    const baseline = must(measure(shape));
    const boreIndex = shape.faces.findIndex((face) => face.label === 'bore');
    const topIndex = shape.faces.findIndex((face) => face.label === 'box1');
    const reverseBore = {
      ...shape,
      faces: shape.faces.map((face, i) =>
        i === boreIndex ? { ...face, reversed: !face.reversed } : face,
      ),
    } as Shape;
    const reversed = must(measure(reverseBore));
    expect(Math.abs(reversed.volume - baseline.volume)).toBeGreaterThan(1);
    expect(
      Math.abs(
        measureTrimmedFace(reverseBore, boreIndex).volume +
          measureTrimmedFace(shape, boreIndex).volume,
      ),
    ).toBeLessThan(1e-9);
    const topFace = shape.faces[topIndex];
    if (topFace === undefined) throw new Error('missing top face');
    const droppedHole = {
      ...shape,
      faces: shape.faces.map((face, i) =>
        i === topIndex ? { ...face, loops: [face.loops[0] as number] } : face,
      ),
    } as Shape;
    const omitted = measure(droppedHole);
    expect(omitted.ok).toBe(false);
  });

  it('measures a spherical cap with planar closure', () => {
    const radius = 2;
    const z = 0.75;
    const result = must(measure(sphereCap(radius, z)));
    const h = radius - z;
    expect(
      Math.abs(result.area - (2 * Math.PI * radius * h + Math.PI * (radius * radius - z * z))),
    ).toBeLessThan(1e-9);
    expect(Math.abs(result.volume - Math.PI * h * h * (radius - h / 3))).toBeLessThan(1e-9);
    expect(
      Math.abs(
        (result.centroid?.[2] ?? Infinity) - (z + (h * (4 * radius - h)) / (4 * (3 * radius - h))),
      ),
    ).toBeLessThan(1e-9);
  });

  it('measures a cylinder trimmed by two offset planes', () => {
    const radius = 1.25;
    const bottom = -0.2;
    const top = 1.1;
    const height = top - bottom;
    const result = must(
      measure(
        must(
          cylinder({
            radius,
            height,
            frame: { ...ID, o: [0, 0, (bottom + top) / 2] },
          }),
        ),
      ),
    );
    expect(Math.abs(result.area - 2 * Math.PI * radius * (radius + height))).toBeLessThan(1e-9);
    expect(Math.abs(result.volume - Math.PI * radius * radius * height)).toBeLessThan(1e-9);
    expect(Math.abs(result.centroid?.[0] ?? Infinity)).toBeLessThan(1e-9);
    expect(Math.abs(result.centroid?.[1] ?? Infinity)).toBeLessThan(1e-9);
    expect(Math.abs((result.centroid?.[2] ?? Infinity) - (bottom + top) / 2)).toBeLessThan(1e-9);
  });

  it('measures sphere, cone and torus primitive closed forms', () => {
    const c = must(measure(must(cylinder({ radius: 2, height: 3 }))));
    expect(Math.abs(c.area - 20 * Math.PI)).toBeLessThan(1e-9);
    expect(Math.abs(c.volume - 12 * Math.PI)).toBeLessThan(1e-9);
    const s = must(measure(must(sphere({ radius: 2 }))));
    expect(Math.abs(s.area - 16 * Math.PI)).toBeLessThan(1e-9);
    expect(Math.abs(s.volume - (32 * Math.PI) / 3)).toBeLessThan(1e-9);
    const t = must(measure(must(torus({ major: 3, minor: 0.5 }))));
    expect(Math.abs(t.volume - 2 * Math.PI * Math.PI * 3 * 0.25)).toBeLessThan(1e-9);
    const k = must(measure(must(cone({ radius: 1.1, height: 2.2 }))));
    expect(Math.abs(k.volume - (Math.PI * 1.1 * 1.1 * 2.2) / 3)).toBeLessThan(1e-9);
  });

  it('measures a planar annular plate with a circular hole', () => {
    const outer = 1.2;
    const inner = 0.45;
    const height = 0.3;
    const shape = must(
      revolve({
        profile: [
          [inner, -height / 2],
          [outer, -height / 2],
          [outer, height / 2],
          [inner, height / 2],
          [inner, -height / 2],
        ],
      }),
    );
    const result = must(measure(shape));
    expect(
      Math.abs(
        result.area -
          (2 * Math.PI * (outer * outer - inner * inner) + 2 * Math.PI * height * (outer + inner)),
      ),
    ).toBeLessThan(1e-9);
    expect(
      Math.abs(result.volume - Math.PI * height * (outer * outer - inner * inner)),
    ).toBeLessThan(1e-9);
    expect(result.centroid).not.toBeNull();
    for (const value of result.centroid ?? []) expect(Math.abs(value)).toBeLessThan(1e-9);
  });

  it('measures a torus segment', () => {
    const major = 2;
    const minor = 0.4;
    const sweep = Math.PI / 3;
    const result = must(measure(torusSegment(major, minor, sweep)));
    expect(Math.abs(result.area - 2 * Math.PI * minor * (major * sweep + minor))).toBeLessThan(
      1e-9,
    );
    expect(Math.abs(result.volume - Math.PI * minor * minor * major * sweep)).toBeLessThan(1e-9);
    const centroidRadius = major + (minor * minor) / (4 * major);
    expect(
      Math.abs((result.centroid?.[0] ?? Infinity) - (centroidRadius * Math.sin(sweep)) / sweep),
    ).toBeLessThan(1e-9);
    expect(
      Math.abs(
        (result.centroid?.[1] ?? Infinity) - (centroidRadius * (1 - Math.cos(sweep))) / sweep,
      ),
    ).toBeLessThan(1e-9);
  });
});
