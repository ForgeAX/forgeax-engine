import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { filletedBox, pipeElbowShape } from '../../../examples/brep-continuity/cases.ts';
import { buildBracket } from '../../../examples/brep-edit/bracket.ts';
import { must } from '../../../examples/brep-heal/damage.ts';
import { buildHousing, buildPlate } from '../../../examples/brep-heal/parts.ts';
import {
  obliqueCylinder,
  sphereCapWithHole,
  wavyPatch,
} from '../../../examples/trimmed-faces/models.ts';
import { cone, sphere, torus } from '../build.ts';
import { measure } from '../measure.ts';
import { BREP_JSON_VERSION, deserializeShape, serializeShape } from '../serialize.ts';
import type { Shape } from '../types.ts';
import { validate } from '../validate.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const FIXTURES: Record<string, () => Shape> = {
  bracket: () => buildPlate(),
  'bracket-simplified': () => buildBracket().simplified,
  housing: () => buildHousing(),
  'filleted-box': () => filletedBox(),
  'pipe-elbow': () => pipeElbowShape(),
  'wavy-patch': () => wavyPatch(),
  'oblique-cylinder': () => obliqueCylinder(3, 0.4, 1),
  'sphere-cap-hole': () => sphereCapWithHole(2, 0.4).shape,
  sphere: () => must(sphere({ radius: 2 })),
  cone: () => must(cone({ radius: 2, height: 3 })),
  torus: () => must(torus({ major: 3, minor: 1 })),
};

const roundTrip = (s: Shape) => must(deserializeShape(must(serializeShape(s))));
const text = (s: Shape) => must(serializeShape(s));

/** Parsed JSON document: nested objects are edited by path, so the tests type it loosely. */
// biome-ignore lint/suspicious/noExplicitAny: path edits on parsed JSON
type Doc = any;

/** A copy of `s` with `edit` applied to the parsed document, as text. */
function mutated(s: Shape, edit: (doc: Doc) => void): string {
  const doc = JSON.parse(text(s));
  edit(doc);
  return JSON.stringify(doc);
}

describe('serializeShape / deserializeShape: round trip', () => {
  for (const [name, make] of Object.entries(FIXTURES)) {
    it(`${name}: equal structure, faces, volume, area and text digest`, () => {
      const shape = make();
      const back = roundTrip(shape);
      expect(back).toEqual(shape);
      expect(back.faces.length).toBe(shape.faces.length);
      expect(text(back)).toBe(text(shape));
      expect(sha(text(back))).toBe(sha(text(shape)));
      const a = measure(shape);
      const b = measure(back);
      expect(b.ok).toBe(a.ok);
      if (a.ok && b.ok) {
        expect(b.value.volume).toBe(a.value.volume);
        expect(b.value.area).toBe(a.value.area);
        expect(a.value.volume).not.toBe(0);
      }
      expect(validate(back).ok).toBe(validate(shape).ok);
    });
  }

  it('the fixtures between them carry every surface, curve and pcurve kind and a reversed face', () => {
    const shapes = Object.values(FIXTURES).map((f) => f());
    const surfaces = new Set(shapes.flatMap((s) => s.surfaces.map((x) => x.kind)));
    const curves = new Set(shapes.flatMap((s) => s.curves.map((x) => x.kind)));
    const pcurves = new Set(shapes.flatMap((s) => s.coedges.map((c) => c.pcurve.kind)));
    expect([...surfaces].sort()).toEqual(['cone', 'cylinder', 'nurbs', 'plane', 'sphere', 'torus']);
    expect([...curves].sort()).toEqual(['circle', 'ellipse', 'line', 'nurbs']);
    expect([...pcurves].sort()).toEqual(['circle', 'line', 'nurbs']);
    expect(shapes.some((s) => s.faces.some((f) => f.reversed))).toBe(true);
    expect(shapes.some((s) => s.edges.some((e) => e.curve === -1))).toBe(true);
    expect(shapes.some((s) => s.loops.some((l) => !l.outer))).toBe(true);
  });

  it('keeps weights, negative zero, tolerances and every bit of a double', () => {
    const patch = wavyPatch();
    const nurbs = patch.surfaces.map((s, i) => [s, i] as const).find(([s]) => s.kind === 'nurbs');
    if (nurbs === undefined || nurbs[0].kind !== 'nurbs') throw new Error('nurbs surface');
    const net = nurbs[0].surface;
    const weights = net.points.map((row, i) => row.map((_, j) => 1 + 0.1 * ((i * 7 + j) % 5)));
    const weighted: Shape = {
      ...patch,
      tol: patch.tol / 3,
      surfaces: patch.surfaces.map((s, i) =>
        i === nurbs[1] ? { kind: 'nurbs', surface: { ...net, weights } } : s,
      ),
      vertices: patch.vertices.map((v, i) =>
        i === 0 ? { ...v, p: [-0, 1 / 3, Number.MIN_VALUE] } : v,
      ),
    };
    const back = roundTrip(weighted);
    expect(back).toEqual(weighted);
    expect(Object.is(back.vertices[0]?.p[0], -0)).toBe(true);
    expect(back.vertices[0]?.p[2]).toBe(Number.MIN_VALUE);
    expect(back.tol).toBe(patch.tol / 3);
    const s = back.surfaces[nurbs[1]];
    expect(s?.kind === 'nurbs' ? s.surface.weights : undefined).toEqual(weights);
  });

  it('keeps the weights of NURBS edge curves and NURBS pcurves', () => {
    const patch = wavyPatch();
    const w = (n: number) => Array.from({ length: n }, (_, i) => 0.5 + 0.25 * (i % 4));
    const weighted: Shape = {
      ...patch,
      curves: patch.curves.map((c) =>
        c.kind === 'nurbs'
          ? { kind: 'nurbs', curve: { ...c.curve, weights: w(c.curve.points.length) } }
          : c,
      ),
      coedges: patch.coedges.map((c) =>
        c.pcurve.kind === 'nurbs'
          ? {
              ...c,
              pcurve: {
                kind: 'nurbs',
                curve: { ...c.pcurve.curve, weights: w(c.pcurve.curve.points.length) },
              },
            }
          : c,
      ),
    };
    expect(weighted.curves.some((c) => c.kind === 'nurbs')).toBe(true);
    expect(weighted.coedges.some((c) => c.pcurve.kind === 'nurbs')).toBe(true);
    expect(roundTrip(weighted)).toEqual(weighted);
  });

  it('is deterministic and independent of input key order', () => {
    const shape = FIXTURES['filleted-box']?.() as Shape;
    expect(text(shape)).toBe(text(FIXTURES['filleted-box']?.() as Shape));
    const shuffled = JSON.parse(text(shape));
    shuffled.shape = Object.fromEntries(Object.entries(shuffled.shape).reverse());
    expect(text(must(deserializeShape(JSON.stringify(shuffled))))).toBe(text(shape));
  });

  it('returns a frozen Shape', () => {
    const back = roundTrip(FIXTURES.housing?.() as Shape);
    expect(Object.isFrozen(back)).toBe(true);
    expect(Object.isFrozen(back.faces[0])).toBe(true);
  });

  it('serialization depends on the orientation flag: flipping one face changes text and volume', () => {
    const shape = FIXTURES['filleted-box']?.() as Shape;
    const flipped: Shape = {
      ...shape,
      faces: shape.faces.map((f, i) => (i === 0 ? { ...f, reversed: !f.reversed } : f)),
    };
    expect(sha(text(flipped))).not.toBe(sha(text(shape)));
    expect(must(measure(roundTrip(flipped))).volume).toBe(must(measure(flipped)).volume);
    expect(roundTrip(flipped).faces[0]?.reversed).toBe(!shape.faces[0]?.reversed);
  });
});

describe('deserializeShape: strict schema errors', () => {
  const shape = FIXTURES.bracket?.() as Shape;
  const reason = (r: ReturnType<typeof deserializeShape>) => {
    if (r.ok) throw new Error('expected an error');
    expect(r.error.code).toBe('model-invalid-argument');
    expect(r.error.detail?.brep).toBe('brep-bad-argument');
    return r.error.detail as { reason: string; path: string; kind?: string; known?: string[] };
  };

  it('unknown surface kind names the kind, its path and the known kinds', () => {
    const d = reason(
      deserializeShape(
        mutated(shape, (doc) => {
          doc.shape.surfaces[1].kind = 'nurbs-blob';
        }),
      ),
    );
    expect(d.reason).toBe('unknown-surface-kind');
    expect(d.path).toBe('$.shape.surfaces[1].kind');
    expect(d.kind).toBe('nurbs-blob');
    expect(d.known).toEqual(['plane', 'cylinder', 'sphere', 'cone', 'torus', 'nurbs']);
  });

  it('unknown curve and pcurve kinds are refused the same way', () => {
    const c = reason(
      deserializeShape(
        mutated(shape, (doc) => {
          doc.shape.curves[0].kind = 'helix';
        }),
      ),
    );
    expect([c.reason, c.path]).toEqual(['unknown-curve-kind', '$.shape.curves[0].kind']);
    const p = reason(
      deserializeShape(
        mutated(shape, (doc) => {
          doc.shape.coedges[2].pcurve.kind = 'spline';
        }),
      ),
    );
    expect([p.reason, p.path]).toEqual(['unknown-pcurve-kind', '$.shape.coedges[2].pcurve.kind']);
  });

  it('inherited names are not kinds', () => {
    const d = reason(
      deserializeShape(
        mutated(shape, (doc) => {
          doc.shape.surfaces[0].kind = 'constructor';
        }),
      ),
    );
    expect(d.reason).toBe('unknown-surface-kind');
  });

  it('unknown or wrong version and format are refused before the body is read', () => {
    expect(
      reason(
        deserializeShape(
          mutated(shape, (d) => {
            d.version = BREP_JSON_VERSION + 1;
          }),
        ),
      ).reason,
    ).toBe('unsupported-version');
    expect(
      reason(
        deserializeShape(
          mutated(shape, (d) => {
            d.format = 'other';
          }),
        ),
      ).reason,
    ).toBe('unknown-format');
    expect(
      reason(
        deserializeShape(
          mutated(shape, (d) => {
            delete d.version;
          }),
        ),
      ).reason,
    ).toBe('unsupported-version');
    expect(reason(deserializeShape('[]')).reason).toBe('not-an-object');
    expect(reason(deserializeShape('{nope')).reason).toBe('invalid-json');
  });

  it('unknown, missing and mistyped fields name their path', () => {
    const circled = FIXTURES['pipe-elbow']?.() as Shape;
    const cases: [string, (doc: Doc) => void, string, string][] = [
      [
        'extra field',
        (d) => {
          d.shape.faces[0].colour = 'red';
        },
        'unknown-field',
        '$.shape.faces[0].colour',
      ],
      [
        'extra top-level',
        (d) => {
          d.extra = 1;
        },
        'unknown-field',
        '$.extra',
      ],
      [
        'missing field',
        (d) => {
          delete d.shape.maxTol;
        },
        'missing-field',
        '$.shape.maxTol',
      ],
      [
        'string for number',
        (d) => {
          d.shape.tol = '1e-6';
        },
        'not-a-number',
        '$.shape.tol',
      ],
      [
        'short vector',
        (d) => {
          d.shape.vertices[0].p = [1, 2];
        },
        'bad-tuple-length',
        '$.shape.vertices[0].p',
      ],
      [
        'fractional index',
        (d) => {
          d.shape.faces[0].surface = 1.5;
        },
        'not-an-index',
        '$.shape.faces[0].surface',
      ],
      [
        'bad dir',
        (d) => {
          const c = d.shape.coedges.find(
            (x: { pcurve: { kind: string } }) => x.pcurve.kind === 'circle',
          );
          c.pcurve.dir = 0;
        },
        'bad-literal',
        '',
      ],
      [
        'non-boolean',
        (d) => {
          d.shape.faces[0].reversed = 1;
        },
        'not-a-boolean',
        '$.shape.faces[0].reversed',
      ],
    ];
    for (const [name, edit, why, path] of cases) {
      const d = reason(deserializeShape(mutated(name === 'bad dir' ? circled : shape, edit)));
      expect([name, d.reason]).toEqual([name, why]);
      if (path !== '') expect([name, d.path]).toEqual([name, path]);
    }
  });

  it('an indexable-looking but structurally broken Shape reports the structure, not a schema slip', () => {
    const d = reason(
      deserializeShape(
        mutated(shape, (doc) => {
          doc.shape.faces[0].surface = 9999;
        }),
      ),
    );
    expect(d.reason).toBe('invalid-structure');
  });

  it('serializeShape refuses a Shape that carries an unknown kind or a non-finite number', () => {
    const alien = {
      ...shape,
      surfaces: [{ kind: 'bezier' }, ...shape.surfaces.slice(1)],
    } as unknown as Shape;
    const r = serializeShape(alien);
    expect(r.ok).toBe(false);
    expect(!r.ok && (r.error.detail as { reason: string }).reason).toBe('unknown-surface-kind');
    const nan = { ...shape, tol: Number.NaN };
    const n = serializeShape(nan);
    expect(!n.ok && (n.error.detail as { reason: string }).reason).toBe('non-finite-number');
  });
});
