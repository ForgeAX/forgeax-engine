import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import { type EdgeSelector, sel } from '../selectors';
import { SPIKE_CASES } from './boolean-cases';

/**
 * Design 16 bevel spike set: parametric hard-surface parts, each with a selection
 * and bevel parameters drawn from a fixed-seed generator. Widths run up to and past
 * the clamp limit; segments run from chamfers to eight-segment rounds.
 */
export interface SpikeVariant {
  readonly family: string;
  readonly name: string;
  readonly build: () => Model;
  readonly edges: EdgeSelector;
  readonly width: number;
  readonly segments: number;
}

export interface SpikeOutcome {
  readonly family: string;
  readonly name: string;
  /** Every selected edge was replaced by bevel faces (the operation succeeded). */
  readonly effect: boolean;
  /** No validation error and no confirmed geometric defect. */
  readonly valid: boolean;
  readonly closed: boolean;
  readonly clamped: boolean;
  readonly selected: number;
  readonly faces: number;
  /** Warning codes the validation reports (non-planar faces, candidate contacts). */
  readonly warnings: readonly string[];
  readonly error?: string;
  readonly defects?: readonly string[];
}

/** Park-Miller generator: the set is the same on every run and in every realm. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

const CONFIRMED = new Set(['self-intersection', 'face-flipped', 'mesh-inverted']);

export function spikeVariants(): SpikeVariant[] {
  const random = generator(20261022);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const range = (lo: number, hi: number) => lo + (hi - lo) * random();
  const segmentsOf = () => pick([1, 1, 2, 3, 4, 5, 8]);
  const out: SpikeVariant[] = [];

  // Boxes, optionally subdivided, with whole-part, loop, single-edge and sharp selections.
  for (let i = 0; i < 50; i++) {
    const size: [number, number, number] = [range(0.3, 2), range(0.3, 2), range(0.3, 2)];
    const segments: [number, number, number] = [
      pick([1, 1, 2, 3]),
      pick([1, 1, 2]),
      pick([1, 2, 3]),
    ];
    const choice = pick(['all', 'top', 'one', 'verticals', 'sharp'] as const);
    const edges =
      choice === 'all'
        ? sel.edges.all()
        : choice === 'top'
          ? sel.extreme('+y').boundary()
          : choice === 'one'
            ? sel.extreme('+y').toEdges('touching').and(sel.extreme('+z').toEdges('touching'))
            : choice === 'verticals'
              ? sel.edges.parallel('y').and(sel.edges.dihedral('>', 30))
              : sel.edges.dihedral('>', 30);
    out.push({
      family: 'box',
      name: `box-${i} ${choice}`,
      build: () => {
        const m = model();
        m.box({ size, segments });
        return m;
      },
      edges,
      width: Math.min(...size) * range(0.03, 0.6),
      segments: segmentsOf(),
    });
  }

  // Extruded outlines: convex polygons, L, U, T and star sections.
  const outline = (kind: string): Point2[] => {
    const a = range(0.6, 1.4);
    const b = range(0.6, 1.4);
    const t = range(0.2, 0.45);
    switch (kind) {
      case 'L':
        return [
          [0, 0],
          [a, 0],
          [a, t],
          [t, t],
          [t, b],
          [0, b],
        ];
      case 'U':
        return [
          [0, 0],
          [a, 0],
          [a, b],
          [a - t, b],
          [a - t, t],
          [t, t],
          [t, b],
          [0, b],
        ];
      case 'T':
        return [
          [0, b - t],
          [a / 2 - t / 2, b - t],
          [a / 2 - t / 2, 0],
          [a / 2 + t / 2, 0],
          [a / 2 + t / 2, b - t],
          [a, b - t],
          [a, b],
          [0, b],
        ];
      case 'star': {
        const points: Point2[] = [];
        const n = pick([5, 6, 7]);
        for (let k = 0; k < 2 * n; k++) {
          const r = k % 2 === 0 ? a : a * range(0.45, 0.7);
          const angle = (Math.PI * k) / n;
          points.push([r * Math.cos(angle), r * Math.sin(angle)]);
        }
        return points;
      }
      default: {
        const points: Point2[] = [];
        const n = pick([3, 4, 5, 6, 8]);
        for (let k = 0; k < n; k++) {
          const angle = (2 * Math.PI * k) / n;
          points.push([a * Math.cos(angle), b * Math.sin(angle)]);
        }
        return points;
      }
    }
  };
  for (let i = 0; i < 50; i++) {
    const kind = pick(['convex', 'L', 'U', 'T', 'star']);
    const points = outline(kind);
    const depth = range(0.2, 1.2);
    const choice = pick(['all', 'walls', 'caps', 'concave'] as const);
    const edges =
      choice === 'all'
        ? sel.edges.dihedral('>', 10)
        : choice === 'walls'
          ? sel.edges.parallel('z').and(sel.edges.dihedral('>', 10))
          : choice === 'caps'
            ? sel.facing('+z').boundary().or(sel.facing('-z').boundary())
            : kind === 'convex'
              ? sel.facing('+z').boundary()
              : sel.edges.concave();
    out.push({
      family: 'profile',
      name: `profile-${i} ${kind} ${choice}`,
      build: () => {
        const m = model();
        m.extrudePolygon({ points, depth });
        return m;
      },
      edges,
      width: Math.min(depth, 0.2) * range(0.05, 0.8),
      segments: segmentsOf(),
    });
  }

  // Plates with inset pockets or bosses; the bevel takes every sharp edge (convex and concave).
  for (let i = 0; i < 45; i++) {
    const size: [number, number, number] = [range(1, 3), range(0.2, 0.6), range(1, 3)];
    const inset = Math.min(size[0], size[2]) * range(0.1, 0.35);
    const depth = size[1] * range(0.2, 0.7) * pick([-1, 1]);
    const perFace = random() < 0.3;
    const build = () => {
      const m = model();
      m.box({ size, segments: perFace ? [2, 1, 2] : [1, 1, 1] });
      m.inset(sel.facing('+y'), {
        thickness: inset / (perFace ? 2 : 1),
        region: perFace ? 'perFace' : 'merged',
        label: 'p',
      });
      m.extrude(sel.createdBy('p', 'inner'), { distance: depth, region: 'perFace', label: 'd' });
      return m;
    };
    out.push({
      family: 'plate',
      name: `plate-${i} ${depth < 0 ? 'pocket' : 'boss'}${perFace ? ' x4' : ''}`,
      build,
      edges:
        random() < 0.5
          ? sel.edges.dihedral('>', 30)
          : sel.createdBy('d', 'side').toEdges('touching').and(sel.edges.dihedral('>', 30)),
      width: Math.min(Math.abs(depth), inset) * range(0.05, 0.6),
      segments: segmentsOf(),
    });
  }

  // Frames: a plate with a rectangular hole bridged through, chamfered or rounded all round.
  for (let i = 0; i < 30; i++) {
    const size: [number, number, number] = [range(1, 2.5), range(0.15, 0.5), range(1, 2.5)];
    const rim = Math.min(size[0], size[2]) * range(0.12, 0.3);
    out.push({
      family: 'frame',
      name: `frame-${i}`,
      build: () => {
        const m = model();
        m.box({ size });
        m.inset(sel.facing('+y'), { thickness: rim, region: 'merged', label: 'top' });
        m.inset(sel.facing('-y'), { thickness: rim, region: 'merged', label: 'bottom' });
        m.delete(sel.createdBy('top', 'inner').or(sel.createdBy('bottom', 'inner')));
        m.bridge(sel.edges.meshBoundary(), { label: 'bore' });
        return m;
      },
      edges: random() < 0.5 ? sel.edges.dihedral('>', 30) : sel.createdBy('bore').boundary(),
      width: Math.min(size[1], rim) * range(0.05, 0.6),
      segments: segmentsOf(),
    });
  }

  // Revolved rims and hubs (wheel-like): closed loops through valence-4 vertices.
  for (let i = 0; i < 30; i++) {
    const inner = range(0.1, 0.4);
    const outer = range(0.8, 1.4);
    const step = range(inner + 0.15, outer - 0.1);
    const h = range(0.2, 0.6);
    const profile: Point2[] = [
      [inner, 0],
      [outer, 0],
      [outer, h * 0.4],
      [step, h * 0.55],
      [step, h],
      [inner, h],
      [inner, 0],
    ];
    const radial = pick([12, 16, 24, 32]);
    out.push({
      family: 'revolve',
      name: `revolve-${i} ${radial}`,
      build: () => {
        const m = model();
        m.revolve({ points: profile, segments: radial });
        return m;
      },
      edges: sel.edges.dihedral('>', 30),
      width: Math.min(h * 0.4, step - inner) * range(0.05, 0.5),
      segments: segmentsOf(),
    });
  }

  // Apex junctions: cones and pyramids (valence 3 to 8 at the apex).
  for (let i = 0; i < 20; i++) {
    const radial = pick([3, 4, 5, 6, 8]);
    out.push({
      family: 'apex',
      name: `apex-${i} ${radial}`,
      build: () => {
        const m = model();
        m.cone({ radius: range(0.5, 1.2), height: range(0.5, 1.5), radialSegments: radial });
        return m;
      },
      edges: random() < 0.5 ? sel.edges.all() : sel.edges.all().minus(sel.edges.perpendicular('y')),
      width: range(0.02, 0.15),
      segments: segmentsOf(),
    });
  }

  // Triangulated parts: sliver triangles and high-valence vertices along the sharp edges.
  for (let i = 0; i < 20; i++) {
    const size: [number, number, number] = [range(0.5, 2), range(0.5, 2), range(0.5, 2)];
    const segments: [number, number, number] = [pick([1, 2, 3]), pick([1, 2]), pick([1, 2, 3])];
    out.push({
      family: 'triangulated',
      name: `triangulated-${i}`,
      build: () => {
        const m = model();
        m.box({ size, segments });
        m.triangulate(sel.all());
        return m;
      },
      edges: sel.edges.dihedral('>', 30),
      width: Math.min(...size) * range(0.02, 0.3),
      segments: segmentsOf(),
    });
  }

  // Double bevels: chamfer the sharp edges, then bevel the chamfer rails again.
  for (let i = 0; i < 20; i++) {
    const size: [number, number, number] = [range(0.6, 2), range(0.6, 2), range(0.6, 2)];
    const first = Math.min(...size) * range(0.05, 0.2);
    out.push({
      family: 'double',
      name: `double-${i}`,
      build: () => {
        const m = model();
        m.box({ size });
        m.bevel(sel.edges.all(), { width: first, segments: 1, label: 'chamfer' });
        return m;
      },
      edges: sel.createdBy('chamfer', 'bevel').boundary().and(sel.edges.dihedral('>', 30)),
      width: first * range(0.1, 0.45),
      segments: segmentsOf(),
    });
  }

  // Holed plates: caps around through holes are convex pieces (extrudePolygon) or strips
  // (difference), so rim vertices carry flat partition edges. Widths stay below the ligament.
  for (let i = 0; i < 40; i++) {
    const a = range(0.6, 2);
    const b = range(0.4, 1.2);
    const depth = range(0.08, 0.4);
    const count = pick([1, 2, 3, 4]);
    const pitch = a / count;
    const radius = Math.min(pitch, b) * range(0.12, 0.32);
    const radial = pick([8, 12, 16, 24, 32]);
    const boolean = random() < 0.5;
    const ligament = Math.min(pitch / 2 - radius, b / 2 - radius);
    const choice = pick(['rims', 'top', 'all'] as const);
    const holes = Array.from({ length: count }, (_, k): Point2 => [(k + 0.5) * pitch, b / 2]);
    out.push({
      family: 'holed',
      name: `holed-${i} ${boolean ? 'difference' : 'extrude'} ${count}x${radial} ${choice}`,
      build: () => {
        const m = model();
        if (boolean) {
          m.box({ size: [a, depth, b], center: [a / 2, depth / 2, b / 2], label: 'plate' });
          const drills = model();
          for (const [x, z] of holes) {
            drills.cylinder({
              radiusTop: radius,
              radiusBottom: radius,
              height: depth * 3,
              radialSegments: radial,
              center: [x, depth / 2, z],
            });
          }
          m.difference(drills, { label: 'hole' });
        } else {
          m.extrudePolygon({
            points: [
              [0, 0],
              [a, 0],
              [a, b],
              [0, b],
            ],
            holes: holes.map(([x, y]) =>
              Array.from({ length: radial }, (_, k): Point2 => {
                const angle = (2 * Math.PI * k) / radial;
                return [x + radius * Math.cos(angle), y + radius * Math.sin(angle)];
              }),
            ),
            depth,
            label: 'plate',
          });
          m.rotate(sel.all(), 'x', 90);
          m.translate(sel.all(), [0, depth, 0]);
        }
        return m;
      },
      edges:
        choice === 'all'
          ? sel.edges.dihedral('>', 30)
          : choice === 'top'
            ? sel.facing('+y').boundary()
            : (boolean ? sel.createdBy('hole', 'cutB') : sel.createdBy('plate', 'hole'))
                .toEdges('touching')
                .and(sel.facing('+y').or(sel.facing('-y')).toEdges('touching')),
      width: Math.min(ligament, depth / 2) * range(0.05, 0.6),
      segments: segmentsOf(),
    });
  }
  return out;
}

export function runSpikeVariant(variant: SpikeVariant): SpikeOutcome {
  const m = variant.build();
  const base = { family: variant.family, name: variant.name };
  if (m.poisoned !== undefined) {
    return {
      ...base,
      effect: false,
      valid: false,
      closed: false,
      clamped: false,
      selected: 0,
      faces: 0,
      warnings: [],
      error: `setup ${m.poisoned.code}`,
    };
  }
  const selected = m.count(variant.edges);
  const op = m.bevel(variant.edges, { width: variant.width, segments: variant.segments });
  const report = m.validate();
  const defects = report.issues
    .filter(
      (issue) =>
        issue.severity === 'error' ||
        (CONFIRMED.has(issue.code) &&
          (issue.detail as { certainty?: string }).certainty !== 'candidate'),
    )
    .map((issue) => issue.code);
  return {
    ...base,
    effect: op.status === 'ok',
    valid: op.status === 'ok' && defects.length === 0,
    closed: report.closed,
    clamped:
      op.diagnostics?.some((d) => d.severity === 'warn' && 'clamped' in (d.detail ?? {})) === true,
    selected,
    faces: report.faces,
    warnings: [
      ...new Set(
        report.issues
          .filter((issue) => issue.severity === 'warn' && !defects.includes(issue.code))
          .map((issue) => issue.code),
      ),
    ].sort(),
    ...(op.error === undefined ? {} : { error: `${op.error.code}: ${op.error.expected}` }),
    ...(defects.length === 0 ? {} : { defects }),
  };
}

export function spikeReport(outcomes: readonly SpikeOutcome[]) {
  const rate = (items: readonly SpikeOutcome[], key: 'effect' | 'valid') =>
    items.length === 0 ? 0 : items.filter((o) => o[key]).length / items.length;
  const families = [...new Set(outcomes.map((o) => o.family))];
  return {
    schema: 'forgeax.model.bevel-spike/1',
    gate: { effectRate: 0.95 },
    variants: outcomes.length,
    effectRate: rate(outcomes, 'effect'),
    validRate: rate(outcomes, 'valid'),
    clamped: outcomes.filter((o) => o.clamped).length,
    warnings: Object.fromEntries(
      [...new Set(outcomes.flatMap((o) => o.warnings))]
        .sort()
        .map((code) => [code, outcomes.filter((o) => o.warnings.includes(code)).length]),
    ),
    selectedEdges: outcomes.reduce((sum, o) => sum + o.selected, 0),
    families: Object.fromEntries(
      families.map((family) => {
        const items = outcomes.filter((o) => o.family === family);
        return [
          family,
          {
            variants: items.length,
            effectRate: rate(items, 'effect'),
            validRate: rate(items, 'valid'),
            clamped: items.filter((o) => o.clamped).length,
          },
        ];
      }),
    ),
    failures: outcomes.filter((o) => !o.effect || !o.valid),
  };
}

/**
 * Design 16 measures bevel on "the same set" as the boolean spike: every boolean case
 * result, all creases above 30 degrees, width 15 % of the part's smallest extent and
 * one to three segments. The 95 % gate applies to this set too.
 */
export function booleanSetOutcomes(): SpikeOutcome[] {
  const out: SpikeOutcome[] = [];
  for (const [i, c] of SPIKE_CASES.entries()) {
    const part = c.build(() => {}).model;
    const bounds = part.bounds(sel.all());
    if (part.poisoned !== undefined || !bounds.ok) continue;
    const { min, max } = bounds.value;
    const width = 0.15 * Math.min(...[0, 1, 2].map((k) => (max[k] as number) - (min[k] as number)));
    out.push(
      runSpikeVariant({
        family: `boolean-${c.family}`,
        name: c.name,
        build: () => part,
        edges: sel.edges.dihedral('>', 30),
        width,
        segments: 1 + (i % 3),
      }),
    );
  }
  return out;
}
