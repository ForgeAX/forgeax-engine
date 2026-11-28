// Flanged housing built only from integration/v2 primitives: extrude (plates with holes),
// revolve (stepped bore sleeve), cylinder (side port, bolt bosses) and box (ribs).
// The parts are an assembly: no boolean fuses them, so each keeps its own exact B-rep.

import { box, cylinder, extrude, revolve } from '../../src/brep/build.ts';
import type { Frame, Shape } from '../../src/brep/types.ts';
import { validate } from '../../src/brep/validate.ts';

type P2 = readonly [number, number];

export interface HousingPart {
  readonly name: string;
  readonly shape: Shape;
}

function must<T>(name: string, r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value;
}

function ring(cx: number, cy: number, r: number, n: number, phase = 0): P2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / n;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  });
}

function boltCircle(radius: number, holeRadius: number, count: number, phase: number): P2[][] {
  return Array.from({ length: count }, (_, i) => {
    const a = phase + (2 * Math.PI * i) / count;
    return ring(radius * Math.cos(a), radius * Math.sin(a), holeRadius, 16);
  });
}

function frameAt(origin: readonly [number, number, number], azimuth: number): Frame {
  const c = Math.cos(azimuth);
  const s = Math.sin(azimuth);
  return { o: origin, x: [c, s, 0], y: [-s, c, 0], z: [0, 0, 1] };
}

export function buildHousing(): HousingPart[] {
  const parts: HousingPart[] = [];
  const add = (name: string, shape: Shape): void => {
    parts.push({ name, shape });
  };

  add(
    'base flange',
    must(
      'base flange',
      extrude({
        profile: ring(0, 0, 46, 48),
        holes: [ring(0, 0, 18, 48), ...boltCircle(37, 4, 6, 0.2)],
        depth: 10,
        label: 'base',
      }),
    ),
  );

  add(
    'sleeve',
    must(
      'sleeve',
      revolve({
        profile: [
          [18, 10],
          [28, 10],
          [28, 50],
          [24, 50],
          [24, 56],
          [18, 56],
          [18, 10],
        ],
        label: 'sleeve',
      }),
    ),
  );

  add(
    'top plate',
    must(
      'top plate',
      extrude({
        profile: ring(0, 0, 32, 36),
        holes: [ring(0, 0, 18, 36), ...boltCircle(27, 2.5, 6, 0)],
        depth: 5,
        frame: { o: [0, 0, 56], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
        label: 'top',
      }),
    ),
  );

  add(
    'side port',
    must(
      'side port',
      cylinder({
        radius: 9,
        height: 26,
        frame: { o: [36, 0, 30], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
        label: 'port',
      }),
    ),
  );

  add(
    'port flange',
    must(
      'port flange',
      cylinder({
        radius: 13,
        height: 4,
        frame: { o: [50, 0, 30], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] },
        label: 'port-flange',
      }),
    ),
  );

  for (let i = 0; i < 4; i++) {
    const az = Math.PI / 4 + (Math.PI * i) / 2;
    add(
      `rib ${i + 1}`,
      must(
        `rib ${i + 1}`,
        box({
          size: [10, 3, 14],
          frame: frameAt([33 * Math.cos(az), 33 * Math.sin(az), 17], az),
          label: `rib${i + 1}`,
        }),
      ),
    );
  }

  for (let i = 0; i < 3; i++) {
    const az = Math.PI / 2 + (2 * Math.PI * i) / 3 + 0.6;
    add(
      `boss ${i + 1}`,
      must(
        `boss ${i + 1}`,
        cylinder({
          radius: 4,
          height: 8,
          frame: {
            o: [37 * Math.cos(az), 37 * Math.sin(az), 14],
            x: [1, 0, 0],
            y: [0, 1, 0],
            z: [0, 0, 1],
          },
          label: `boss${i + 1}`,
        }),
      ),
    );
  }
  return parts;
}

export function housingIssues(parts: readonly HousingPart[]): string[] {
  return parts.flatMap((p) => {
    const report = validate(p.shape);
    return report.ok ? [] : [`${p.name}: ${report.issues.map((x) => x.code).join(', ')}`];
  });
}
