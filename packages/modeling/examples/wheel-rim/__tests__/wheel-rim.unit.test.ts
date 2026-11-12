import { fileURLToPath } from 'node:url';
import { definePackageId, executePackBuild } from '@forgeax/engine-pack/source';
import { type FaceSelector, type Model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { attachSourceLines, recordingSessions, sourceCalls } from '../../case/record';
import { FRONT_TIRE_DIAMETER } from '../../mech-gt/proportions';
import {
  BORE,
  buildWheelRim,
  FLANGE,
  LUG_HOLE,
  LUGS,
  PCD,
  segments,
  spokePlane,
  spokeSector,
  VALVE_HOLE,
  VALVE_Y,
  WALL,
  WELL,
  WHEEL_RIM_DEFAULTS,
  WINDOW_IN,
  type WheelRimParameters,
  windowOuter,
} from '../wheel-rim';
import pack from '../wheel-rim.pack';

const SOURCE = fileURLToPath(new URL('../wheel-rim.ts', import.meta.url));
const BOOLEANS = ['windows', 'lug-seats', 'lugs', 'bore', undefined, 'valve'];
const EPS = 1e-6;

interface Centroid {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Distance from the axle. */
  readonly r: number;
}

function centroids(m: Model, selector: FaceSelector): Centroid[] {
  const mesh = m.editMesh;
  return selector.evaluate(mesh).map((f) => {
    const ps = mesh.faceVertices(f).map((v) => mesh.position(v));
    const [x, y, z] = [0, 1, 2].map((k) => ps.reduce((s, p) => s + (p[k] as number), 0) / ps.length) as [number, number, number];
    return { x, y, z, r: Math.hypot(x, z) };
  });
}

/** Every named region of the rim with the predicate its faces must satisfy for `p`. */
function regions(p: WheelRimParameters): [string, FaceSelector, (c: Centroid) => boolean][] {
  const r = p.diameter / 2;
  const yo = p.width / 2;
  const { front, back } = spokePlane(p);
  const lugCenters = Array.from({ length: LUGS }, (_, k) => [(PCD / 2) * Math.sin((2 * Math.PI * k) / LUGS), (PCD / 2) * Math.cos((2 * Math.PI * k) / LUGS)]);
  const nearLug = (c: Centroid, radius: number) => lugCenters.some(([x, z]) => Math.abs(Math.hypot(c.x - (x as number), c.z - (z as number)) - radius) < 1e-3);
  const valveAngle = Math.PI / p.spokes;
  return [
    ["createdBy('windows','cutB')", sel.createdBy('windows', 'cutB'), (c) => c.r > WINDOW_IN - 2e-3 && c.r < windowOuter(p) + EPS && c.y > back - EPS && c.y < front + EPS],
    ["createdBy('window-chamfer','bevel')", sel.createdBy('window-chamfer', 'bevel'), (c) => Math.abs(c.y - front) < 0.003 && c.r > WINDOW_IN - 5e-3 && c.r < windowOuter(p) + 4e-3],
    ["createdBy('lip-round','bevel')", sel.createdBy('lip-round', 'bevel'), (c) => c.y > yo + FLANGE - 0.0031 && c.r > r - WALL - 1e-3],
    ["material('machined')", sel.material('machined'), (c) => c.y > yo + FLANGE - 0.0031],
    ["createdBy('lugs','cutB')", sel.createdBy('lugs', 'cutB'), (c) => nearLug(c, LUG_HOLE)],
    ["createdBy('bore','cutB')", sel.createdBy('bore', 'cutB'), (c) => Math.abs(c.r - BORE) < 1e-3],
    ["createdBy('valve','cutB')", sel.createdBy('valve', 'cutB'), (c) => Math.abs(Math.hypot(c.y - VALVE_Y, c.x * Math.cos(valveAngle) - c.z * Math.sin(valveAngle)) - VALVE_HOLE) < 1e-3 && Math.abs(c.r - (r - WELL)) < 0.01],
    ["tag('barrel')", sel.tag('barrel'), (c) => c.r > r - WELL - WALL - 1e-3],
  ];
}

/** Structural counts that follow from the parameters alone. */
function structure(m: Model, p: WheelRimParameters) {
  const step = 360 / p.spokes;
  return {
    wallsPerWindow: Array.from({ length: p.spokes }, (_, k) => m.count(spokeSector(k * step + step / 2, step).and(sel.createdBy('windows', 'cutB')))),
    // Rim edges also split where facet edges crossed them: at least one strip per window wall.
    chamferStrips: m.count(sel.createdBy('window-chamfer', 'bevel')) >= 28 * p.spokes,
    firstWindow: m.count(sel.tag('window-array:0')),
    lipStrips: m.count(sel.createdBy('lip-round', 'bevel')),
    lugWalls: m.count(sel.createdBy('lugs', 'cutB')),
    boreWalls: m.count(sel.createdBy('bore', 'cutB')),
    valveWalls: m.count(sel.createdBy('valve', 'cutB')),
    defaultFaces: m.count(sel.material('Default')),
  };
}

function variants(): WheelRimParameters[] {
  const out: WheelRimParameters[] = [];
  for (const q of pack.parameters as readonly { name: keyof WheelRimParameters; minimum: number; maximum: number }[]) {
    for (const value of [q.minimum, q.maximum]) out.push({ ...WHEEL_RIM_DEFAULTS, [q.name]: value });
  }
  out.push({ diameter: 0.5334, width: 0.3175, spokes: 7, offset: 0.05 });
  return out;
}

describe('C-101 wheel rim (revolve, boolean spoke windows, bevels)', () => {
  it('fits the C-100 front wheel envelope and the Pack defaults', { timeout: 60000 }, () => {
    expect(WHEEL_RIM_DEFAULTS.diameter).toBeCloseTo(0.508, 9);
    for (const q of pack.parameters as readonly { name: keyof WheelRimParameters; default: number }[]) {
      expect([q.name, q.default]).toEqual([q.name, WHEEL_RIM_DEFAULTS[q.name]]);
    }
    const bounds = buildWheelRim().bounds(sel.all());
    if (!bounds.ok) throw bounds.error;
    const outer = bounds.value.max[0] as number;
    expect(outer * 2).toBeLessThan(FRONT_TIRE_DIAMETER);
    expect(outer).toBeCloseTo(WHEEL_RIM_DEFAULTS.diameter / 2 + 0.0175, 3);
  });

  it('builds without failure; its history maps onto the source, loops included', { timeout: 60000 }, () => {
    const recording = recordingSessions();
    const rim = buildWheelRim(WHEEL_RIM_DEFAULTS, recording.session);
    expect(rim.poisoned).toBeUndefined();
    const steps = attachSourceLines(recording.steps, SOURCE);
    expect(steps.length).toBeGreaterThan(sourceCalls(SOURCE).length);
    expect(steps.every((s) => s.entry.status === 'ok')).toBe(true);
    const booleans = steps.filter((s) => ['union', 'difference'].includes(s.entry.op));
    expect(booleans.map((s) => s.entry.label)).toEqual(BOOLEANS);
    for (const step of booleans) {
      const info = step.entry.diagnostics?.find((d) => d.severity === 'info');
      expect(info?.detail).toMatchObject({ backend: 'ts', quality: 'baseline', status: 'ok' });
      const metrics = (info?.detail as { metrics: Record<string, number> }).metrics;
      expect(metrics.provenanceMapped).toBe(metrics.provenanceFaces);
    }
    const bevels = steps.filter((s) => s.entry.op === 'bevel');
    expect(bevels.map((s) => [s.session, s.entry.label])).toEqual([
      ['windows', 'window-corner'],
      ['face', 'window-chamfer'],
      ['rim', 'lip-round'],
    ]);
    for (const step of bevels) expect(step.entry.diagnostics?.filter((d) => d.severity === 'warn') ?? []).toEqual([]);
  });

  it('is a closed solid without errors or confirmed issues and exports', { timeout: 60000 }, () => {
    const rim = buildWheelRim();
    const report = rim.validate();
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(rim.inspect().materials).toEqual(expect.arrayContaining(['barrel', 'painted', 'machined', 'bore']));
    const exported = rim.toMesh({ normals: { mode: 'weighted' } });
    expect(exported.ok).toBe(true);
  });

  it('keeps every named selector on the same semantic region across parameter sets', { timeout: 600000 }, () => {
    for (const p of [WHEEL_RIM_DEFAULTS, ...variants()]) {
      const rim = buildWheelRim(p);
      expect([p, rim.poisoned?.code]).toEqual([p, undefined]);
      expect(rim.validate().closed).toBe(true);
      for (const [name, selector, inside] of regions(p)) {
        const faces = centroids(rim, selector);
        expect([name, faces.length > 0]).toEqual([name, true]);
        expect([name, p, faces.filter((c) => !inside(c)).map((c) => [c.r, c.y])]).toEqual([name, p, []]);
      }
      const n = segments(p.spokes);
      expect(structure(rim, p)).toEqual({
        wallsPerWindow: Array(p.spokes).fill(28),
        chamferStrips: true,
        firstWindow: 28,
        lipStrips: 2 * 3 * n,
        lugWalls: LUGS * 24,
        boreWalls: 48,
        valveWalls: 16,
        defaultFaces: 0,
      });
    }
  });

  it('is an ordinary Pack build with a mesh/wheel-rim output', { timeout: 60000 }, async () => {
    const result = await executePackBuild(pack, {
      packageId: definePackageId('01900000-0000-7000-8000-0000000c0101'),
      readByGuid: async () => {
        throw new Error('the wheel rim reads no other asset');
      },
      values: { ...WHEEL_RIM_DEFAULTS },
    });
    expect(result.ok && Object.keys(result.value)).toEqual(['mesh/wheel-rim']);
  });
});
