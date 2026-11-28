import { ShapeAssembler } from '../../src/brep/assembler.ts';
import { cylinder, revolve } from '../../src/brep/build.ts';
import type { Frame, Shape } from '../../src/brep/types.ts';
import type { P3 } from '../../src/brep/vec.ts';
import type { ModelingError } from '../../src/errors.ts';

export interface MeasureCase {
  readonly name: string;
  readonly shape: Shape;
  readonly area: number;
  readonly volume: number;
  readonly centroid: readonly [number, number, number];
}

function must<T>(
  name: string,
  result: { ok: true; value: T } | { ok: false; error: ModelingError },
): T {
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  return result.value;
}

const WORLD: Frame = {
  o: [0, 0, 0],
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

function boxWithBore(radius: number): Shape {
  const asm = must('box assembler', ShapeAssembler.create(4));
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
      'box boundary',
      asm.loop(
        surface,
        points.map((point, i) => ({ edge: edge(point, points[(i + 1) % points.length] as P3) })),
        true,
      ),
    );
  const planes: readonly Frame[] = [
    { o: [0, 0, -1], x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] },
    { o: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
    { o: [1, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
    { o: [-1, 0, 0], x: [0, 1, 0], y: [0, 0, -1], z: [-1, 0, 0] },
    { o: [0, 1, 0], x: [0, 0, 1], y: [1, 0, 0], z: [0, 1, 0] },
    { o: [0, -1, 0], x: [0, 0, 1], y: [-1, 0, 0], z: [0, -1, 0] },
  ];
  const circleAt = (z: number) =>
    asm.edge(
      asm.curve({ kind: 'circle', frame: { ...WORLD, o: [0, 0, z] }, radius }),
      0,
      2 * Math.PI,
    );
  const top = circleAt(1);
  const bottom = circleAt(-1);
  for (let i = 0; i < planes.length; i++) {
    const frame = planes[i] as Frame;
    const surface = asm.surface({ kind: 'plane', frame });
    const points: P3[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([u, v]) => [
      frame.o[0] + frame.x[0] * (u as number) + frame.y[0] * (v as number),
      frame.o[1] + frame.x[1] * (u as number) + frame.y[1] * (v as number),
      frame.o[2] + frame.x[2] * (u as number) + frame.y[2] * (v as number),
    ]);
    const outer = rect(surface, points);
    const loops =
      i < 2
        ? [
            outer,
            must('bore opening', asm.loop(surface, [{ edge: i === 0 ? bottom : top }], false)),
          ]
        : [outer];
    faces.push(asm.face(surface, loops, false, `box${i}`));
  }
  const cylinder = asm.surface({ kind: 'cylinder', frame: WORLD, radius });
  const seam = asm.edge(asm.curve({ kind: 'line', o: [radius, 0, -1], d: [0, 0, 1] }), 0, 2);
  const side = must(
    'bore surface boundary',
    asm.loop(cylinder, [{ edge: bottom }, { edge: seam }, { edge: top }, { edge: seam }], true),
  );
  faces.push(asm.face(cylinder, [side], true, 'bore'));
  asm.shell(faces);
  return must('box with cylindrical through-hole', asm.finish());
}

function sphereCap(radius: number, z: number): Shape {
  const asm = must('sphere-cap assembler', ShapeAssembler.create(2 * radius));
  const surface = asm.surface({ kind: 'sphere', frame: WORLD, radius });
  const v0 = Math.asin(z / radius);
  const circleRadius = Math.sqrt(radius * radius - z * z);
  const circle = asm.edge(
    asm.curve({ kind: 'circle', frame: { ...WORLD, o: [0, 0, z] }, radius: circleRadius }),
    0,
    2 * Math.PI,
  );
  const seamFrame: Frame = { o: WORLD.o, x: WORLD.x, y: WORLD.z, z: [0, -1, 0] };
  const seam = asm.edge(asm.curve({ kind: 'circle', frame: seamFrame, radius }), v0, Math.PI / 2);
  const pole = asm.degenerateEdge(asm.vertex([0, 0, radius]));
  const curvedLoop = must(
    'spherical cap boundary',
    asm.loop(
      surface,
      [{ edge: circle }, { edge: seam }, { edge: pole, span: [-2 * Math.PI, 0] }, { edge: seam }],
      true,
    ),
  );
  const curved = asm.face(surface, [curvedLoop], false, 'spherical-cap');
  const plane = asm.surface({ kind: 'plane', frame: { ...WORLD, o: [0, 0, z] } });
  const diskLoop = must('spherical cap closure', asm.loop(plane, [{ edge: circle }], true));
  const disk = asm.face(plane, [diskLoop], true, 'spherical-cap-base');
  asm.shell([curved, disk]);
  return must('spherical cap', asm.finish());
}

function torusSegment(major: number, minor: number, sweep: number): Shape {
  const asm = must('torus assembler', ShapeAssembler.create(2 * (major + minor)));
  const torusSurface = asm.surface({ kind: 'torus', frame: WORLD, major, minor });
  const outer = asm.edge(
    asm.curve({ kind: 'circle', frame: WORLD, radius: major + minor }),
    0,
    sweep,
  );
  const frameAt = (u: number): Frame => {
    const c = Math.cos(u);
    const s = Math.sin(u);
    return { o: [major * c, major * s, 0], x: [c, s, 0], y: [0, 0, 1], z: [s, -c, 0] };
  };
  const end0 = asm.edge(
    asm.curve({ kind: 'circle', frame: frameAt(0), radius: minor }),
    0,
    2 * Math.PI,
  );
  const end1 = asm.edge(
    asm.curve({ kind: 'circle', frame: frameAt(sweep), radius: minor }),
    0,
    2 * Math.PI,
  );
  const loop = must(
    'torus segment boundary',
    asm.loop(
      torusSurface,
      [
        { edge: outer, pcurve: { kind: 'line', o: [0, 0], d: [1, 0] } },
        { edge: end1, pcurve: { kind: 'line', o: [sweep, 0], d: [0, 1] } },
        { edge: outer, pcurve: { kind: 'line', o: [0, 2 * Math.PI], d: [1, 0] } },
        { edge: end0, pcurve: { kind: 'line', o: [0, 0], d: [0, 1] } },
      ],
      true,
    ),
  );
  const curved = asm.face(torusSurface, [loop], false, 'curved-segment');
  const ends: number[] = [];
  for (const [index, u] of [0, sweep].entries()) {
    const c = Math.cos(u);
    const s = Math.sin(u);
    const z: P3 = index === 0 ? [s, -c, 0] : [-s, c, 0];
    const x: P3 = [c, s, 0];
    const y: P3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    const plane = asm.surface({ kind: 'plane', frame: { o: [major * c, major * s, 0], x, y, z } });
    const edge = index === 0 ? end0 : end1;
    const disk = must('torus segment cap', asm.loop(plane, [{ edge }], true));
    ends.push(asm.face(plane, [disk], false, `cap-${index}`));
  }
  asm.shell([curved, ...ends]);
  return must('torus segment', asm.finish());
}

export function buildMeasureCases(): MeasureCase[] {
  const radius = 0.35;
  const plateOuter = 1.2;
  const plateInner = 0.45;
  const plateHeight = 0.3;
  const cylinderRadius = 1.4;
  const cylinderHeight = 1.3;
  const torusMinor = 0.4;
  const torusMajor = 2;
  const torusSweep = Math.PI / 3;
  return [
    {
      name: 'box with cylindrical through-hole',
      shape: boxWithBore(radius),
      area: 24 - 2 * Math.PI * radius * radius + 2 * Math.PI * radius * 2,
      volume: 8 - 2 * Math.PI * radius * radius,
      centroid: [0, 0, 0],
    },
    {
      name: 'offset cylinder cut by two planes',
      shape: must(
        'offset cylinder',
        cylinder({
          radius: cylinderRadius,
          height: cylinderHeight,
          frame: { ...WORLD, o: [0, 0, 0.45] },
        }),
      ),
      area: 2 * Math.PI * cylinderRadius * (cylinderRadius + cylinderHeight),
      volume: Math.PI * cylinderRadius * cylinderRadius * cylinderHeight,
      centroid: [0, 0, 0.45],
    },
    {
      name: 'spherical cap',
      shape: sphereCap(2, 0.75),
      area: 2 * Math.PI * 2 * (2 - 0.75) + Math.PI * (4 - 0.75 * 0.75),
      volume: Math.PI * (2 - 0.75) * (2 - 0.75) * (2 - (2 - 0.75) / 3),
      centroid: [0, 0, 0.75 + ((2 - 0.75) * (8 - (2 - 0.75))) / (4 * (6 - (2 - 0.75)))],
    },
    {
      name: 'annular plate with circular hole',
      shape: must(
        'annular plate',
        revolve({
          profile: [
            [plateInner, -plateHeight / 2],
            [plateOuter, -plateHeight / 2],
            [plateOuter, plateHeight / 2],
            [plateInner, plateHeight / 2],
            [plateInner, -plateHeight / 2],
          ],
        }),
      ),
      area:
        2 * Math.PI * (plateOuter * plateOuter - plateInner * plateInner) +
        2 * Math.PI * plateHeight * (plateOuter + plateInner),
      volume: Math.PI * plateHeight * (plateOuter * plateOuter - plateInner * plateInner),
      centroid: [0, 0, 0],
    },
    {
      name: 'trimmed torus segment',
      shape: torusSegment(torusMajor, torusMinor, torusSweep),
      area: 2 * Math.PI * torusMinor * (torusMajor * torusSweep + torusMinor),
      volume: Math.PI * torusMinor * torusMinor * torusMajor * torusSweep,
      centroid: [
        ((torusMajor + (torusMinor * torusMinor) / (4 * torusMajor)) * Math.sin(torusSweep)) /
          torusSweep,
        ((torusMajor + (torusMinor * torusMinor) / (4 * torusMajor)) * (1 - Math.cos(torusSweep))) /
          torusSweep,
        0,
      ],
    },
  ];
}
