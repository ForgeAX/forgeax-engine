import type { Result } from '@forgeax/engine-types';
import { loft } from '../../src/brep/loft';
import type { Frame, Shape } from '../../src/brep/types';
import type { P2, P3 } from '../../src/brep/vec';
import { cos, sin } from '../../src/dmath';
import type { ModelingError } from '../../src/errors';

const TAU = 2 * Math.PI;

function must<T>(result: Result<T, ModelingError>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function ellipse(rx: number, ry: number, count: number): P2[] {
  return Array.from({ length: count }, (_, i) => [
    rx * cos((TAU * i) / count),
    ry * sin((TAU * i) / count),
  ]);
}

/** Rounded rectangle with `arc` points per corner, counter-clockwise from the +x side. */
function roundedRect(w: number, h: number, r: number, arc: number): P2[] {
  const pts: P2[] = [];
  const corners: [number, number, number][] = [
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, 1],
    [-w / 2 + r, -h / 2 + r, 2],
    [w / 2 - r, -h / 2 + r, 3],
  ];
  for (const [cx, cy, quarter] of corners) {
    for (let k = 0; k <= arc; k++) {
      const a = (Math.PI / 2) * (quarter + k / arc);
      pts.push([cx + r * cos(a), cy + r * sin(a)]);
    }
  }
  return pts;
}

function along(origin: P3, x: P3, y: P3, z: P3): Frame {
  return { o: origin, x, y, z };
}

/**
 * Three lofts on one plate: a hollow circle-to-rounded-rectangle transition duct, an aircraft-like fuselage
 * (nose cone, circular cabin, elliptical belly, tail cone) and a hollow square-to-round shaft whose square
 * and round holes have different vertex counts.
 */
export function buildLoftShowcase(): readonly Shape[] {
  const upAt = (x: number, z: number): Frame => along([x, 0, z], [1, 0, 0], [0, 1, 0], [0, 0, 1]);
  const duct = must(
    loft({
      samples: 64,
      label: 'showcase.duct',
      role: 'duct',
      sections: [
        { profile: ellipse(1.0, 1.0, 48), holes: [ellipse(0.82, 0.82, 48)], frame: upAt(-4, 0) },
        {
          profile: roundedRect(2.2, 1.9, 0.8, 8),
          holes: [roundedRect(1.82, 1.52, 0.62, 8)],
          frame: upAt(-4, 1.6),
        },
        {
          profile: roundedRect(2.8, 1.6, 0.3, 8),
          holes: [roundedRect(2.44, 1.24, 0.12, 8)],
          frame: upAt(-4, 3.2),
        },
      ],
    }),
  );
  const nose = (x: number): Frame => along([x, -5, 1], [0, 1, 0], [0, 0, 1], [1, 0, 0]);
  const fuselage = must(
    loft({
      samples: 48,
      label: 'showcase.fuselage',
      role: 'fuselage',
      sections: [
        { profile: ellipse(0.18, 0.18, 24), frame: nose(-3.4) },
        { profile: ellipse(0.62, 0.55, 40), frame: nose(-2.5) },
        { profile: ellipse(0.9, 0.85, 48), frame: nose(-0.8) },
        { profile: ellipse(0.9, 0.95, 48), frame: nose(1.2) },
        { profile: ellipse(0.5, 0.45, 40), frame: nose(2.8) },
        { profile: ellipse(0.12, 0.2, 24), frame: nose(3.5) },
      ],
    }),
  );
  const shaft = must(
    loft({
      samples: 48,
      label: 'showcase.shaft',
      role: 'shaft',
      sections: [
        {
          profile: [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ],
          holes: [ellipse(0.45, 0.45, 24)],
          frame: upAt(4, 0),
        },
        {
          profile: ellipse(0.95, 0.95, 32),
          holes: [ellipse(0.5, 0.5, 24)],
          frame: upAt(4, 1.4),
        },
        {
          profile: ellipse(0.7, 0.7, 48),
          holes: [ellipse(0.3, 0.3, 16)],
          frame: upAt(4, 3.0),
        },
      ],
    }),
  );
  return [duct, fuselage, shaft];
}
