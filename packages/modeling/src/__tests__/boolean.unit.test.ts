import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { tsBackend } from '../compute/boolean-ts';
import {
  type BackendOutput,
  type ComputeBackend,
  type ComputeJobKind,
  computeCacheKey,
  type FaceProvenance,
  runComputeJob,
} from '../compute/job';
import { sha256 } from '../compute/sha256';
import { modelingError } from '../errors';
import { decodeSnapshot } from '../fxem';
import { meshVolume, type Tuple3 } from '../geom';
import { EDGE_SHARP } from '../mesh';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';

/** Volume of an n-sided prism inscribed in a circle of radius r. */
function prism(n: number, r: number, h: number): number {
  return (n / 2) * r * r * Math.sin((2 * Math.PI) / n) * h;
}

function plate(m: Model = model()): Model {
  m.box({ size: [0.4, 0.02, 0.25], label: 'plate', tag: 'plate' });
  return m;
}

function drills(count: number, segments = 16, radius = 0.01, height = 0.05): Model {
  const d = model();
  for (let i = 0; i < count; i++) {
    d.cylinder({
      radiusTop: radius,
      radiusBottom: radius,
      height,
      radialSegments: segments,
      center: [-0.15 + i * 0.1, 0, 0.06],
      tag: 'drill-tool',
    });
  }
  return d;
}

function job(report: OpReport): Record<string, unknown> & { metrics: Record<string, number> } {
  const info = report.diagnostics?.find((d) => d.severity === 'info' && d.detail?.cacheKey);
  return info?.detail as Record<string, unknown> & { metrics: Record<string, number> };
}

/** Postconditions every boolean result satisfies, whatever the backend (design 15 job contract). */
function expectContract(m: Model, report: OpReport, volume: number): void {
  expect(report.status, report.error?.message).toBe('ok');
  const v = m.validate();
  expect(v.closed).toBe(true);
  expect(v.volume).toBeCloseTo(volume, 12);
  const crossings = v.issues.filter(
    (i) => i.code === 'self-intersection' && i.detail.certainty === 'confirmed',
  );
  expect(crossings).toEqual([]);
  const metrics = job(report).metrics;
  expect(metrics.provenanceMapped).toBe(metrics.provenanceFaces);
  expect(metrics.resultFaces).toBeLessThanOrEqual(
    (metrics.inputFaces as number) + (metrics.cutFaces as number),
  );
}

describe('boolean operators: job contract on the TS baseline', () => {
  it('difference drills through holes with cutB roles and maximal n-gons', () => {
    const m = plate();
    const r = m.difference(drills(3), { label: 'drill', tag: 'holes' });
    expectContract(m, r, 0.4 * 0.02 * 0.25 - 3 * prism(16, 0.01, 0.02));
    expect(r.roles).toEqual({ cutB: 16 * 3 });
    expect(m.count(sel.createdBy('drill', 'cutB'))).toBe(48);
    expect(m.count(sel.createdBy('drill'))).toBe(48);
    // Top and bottom each split once through the hole row; the cut faces keep their label.
    expect(m.count(sel.createdBy('plate'))).toBe(8);
    expect(m.count(sel.tag('holes'))).toBe(48);
    expect(m.count(sel.tag('plate'))).toBe(8);
    expect(m.count(sel.tag('drill-tool'))).toBe(48);
    expect(job(r)).toMatchObject({ backend: 'ts', quality: 'baseline', status: 'ok' });
    expect(m.cleanup.planar().error?.code).toBe('model-op-no-effect');
  });

  it('keeps the label and role of target faces it cuts, like loopCut and bisect', () => {
    const m = plate();
    const roles = () => m.inspect().labels.find((l) => l.label === 'plate')?.roles;
    const before = roles() as Record<string, number>;
    m.difference(drills(3), { label: 'drill' });
    // Top and bottom are cut into two n-gons each; every piece keeps its (label, role).
    const after = roles() as Record<string, number>;
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(8);
    expect(m.count(sel.createdBy('plate'))).toBe(8);
    expect(m.count(sel.createdBy('drill', 'cutB'))).toBe(48);
    expect(m.count(sel.createdBy('drill'))).toBe(48);
    // A second labelled cut through the drill walls keeps theirs as well.
    const slot = model();
    slot.box({ size: [0.3, 0.05, 0.004], center: [0, 0, 0.06] });
    m.difference(slot, { label: 'slot' });
    const all = sel.createdBy('plate').or(sel.createdBy('drill', 'cutB'));
    expect(m.count(sel.createdBy('slot', 'cutB'))).toBeGreaterThan(0);
    expect(m.count(sel.createdBy('drill', 'cutB'))).toBeGreaterThan(0);
    expect(m.count(all.or(sel.createdBy('slot', 'cutB')))).toBe(m.inspect().faces);
  });

  it('marks the cut curve sharp and keeps the target edge intent', () => {
    const m = plate();
    m.markSharp(sel.edges.dihedral('>', 45));
    m.difference(drills(1));
    const mesh = m.editMesh;
    const sharp = mesh.edges().filter((e) => ((mesh.eFlags[e] as number) & EDGE_SHARP) !== 0);
    // 12 box edges (four of them split where the cut lines through the hole on the top and
    // bottom meet them) and two 16-edge rims; the hole walls stay smooth along the cylinder.
    expect(sharp.length).toBe(12 + 4 + 32);
  });

  it('union, intersection and splitBy agree with the analytic volumes', () => {
    const block = () => {
      const b = model();
      b.box({ size: [0.1, 0.1, 0.1], center: [0.2, 0.01, 0.125], tag: 'block' });
      return b;
    };
    const overlap = 0.05 * 0.02 * 0.05;
    const union = plate();
    expectContract(union, union.union(block(), { label: 'add' }), 0.002 + 0.001 - overlap);
    const both = plate();
    expectContract(both, both.intersection(block(), { label: 'keep' }), overlap);
    const split = plate();
    const r = split.splitBy(block(), { label: 'cut' });
    expectContract(split, r, 0.002);
    expect(split.count(sel.createdBy('cut', 'piece'))).toBe(6);
    expect(split.validate().closed).toBe(true);
  });

  it('accepts the operand as closed components selected inside the session', () => {
    const m = plate();
    m.cylinder({
      radiusTop: 0.02,
      radiusBottom: 0.02,
      height: 0.1,
      radialSegments: 12,
      label: 'tool',
    });
    const r = m.difference(sel.createdBy('tool'), { label: 'bore' });
    expectContract(m, r, 0.002 - prism(12, 0.02, 0.02));
    expect(m.count(sel.createdBy('tool'))).toBe(0);
  });

  it('cuts revolved parts with a radial array of cylinders (wheel rim)', () => {
    const rim = model();
    rim.revolve({
      points: [
        [0.2, -0.03],
        [0.26, -0.03],
        [0.26, 0.03],
        [0.2, 0.03],
        [0.2, -0.03],
      ],
      segments: 48,
      label: 'rim',
    });
    const cutters = model();
    for (let i = 0; i < 6; i++) {
      cutters.cylinder({
        radiusTop: 0.012,
        radiusBottom: 0.012,
        height: 0.15,
        radialSegments: 16,
        label: `spoke-${i}`,
      });
      cutters.rotate(sel.createdBy(`spoke-${i}`), 'z', 90);
      cutters.translate(sel.createdBy(`spoke-${i}`), [0.23, 0, 0]);
      cutters.rotate(sel.createdBy(`spoke-${i}`), 'y', i * 60 + 3);
    }
    const before = rim.validate().volume;
    const r = rim.difference(cutters, { label: 'vent' });
    expect(r.status, r.error?.message).toBe('ok');
    const v = rim.validate();
    expect(v.closed).toBe(true);
    expect(v.volume).toBeLessThan(before);
    expect(rim.count(sel.createdBy('vent', 'cutB'))).toBe(6 * 16);
    expect(job(r).metrics.provenanceMapped).toBe(job(r).metrics.provenanceFaces);
  });

  it('maps target corner values by barycentric position and reports operand faces without them', () => {
    const m = plate();
    m.uv.project({ mode: 'box', scale: 0.1 });
    const r = m.difference(drills(1));
    expect(r.status).toBe('ok');
    expect(r.diagnostics?.some((d) => d.severity === 'warn' && /uv0/.test(d.message))).toBe(true);
    const mesh = m.editMesh;
    let checked = 0;
    for (const f of sel.createdBy('plate').evaluate(mesh)) {
      for (const h of mesh.faceHalves(f)) {
        const p = mesh.position(mesh.hVert[h] as number);
        const uv = mesh.corner('uv0', h) as Float32Array;
        // Box projection on the +-Y faces maps (x, z) / scale; on the sides another axis pair.
        const n = mesh.faceVertices(f).map((v) => mesh.position(v));
        if (n.every((q) => Math.abs(q[1] - p[1]) < 1e-12)) {
          expect(Math.abs(Math.abs(uv[0] as number) - Math.abs(p[0] / 0.1))).toBeLessThan(1e-5);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(8);
    m.uv.project({ mode: 'box', scale: 0.1 });
    expect(m.toMesh().ok).toBe(true);
  });

  it('applies material to operand faces and leaves origins alone without a label', () => {
    const m = plate();
    m.difference(drills(1), { material: 'bore' });
    expect(m.count(sel.material('bore'))).toBe(16);
    expect(m.count(sel.createdBy('plate'))).toBe(m.inspect().faces - 16);
  });
});

describe('boolean operators: coplanar and touching inputs', () => {
  it('a flush pocket (coplanar top) and a hole exactly as deep as the plate', () => {
    const m = plate();
    const pocket = model();
    pocket.box({ size: [0.1, 0.012, 0.08], center: [0, 0.004, 0] });
    expectContract(m, m.difference(pocket), 0.002 - 0.1 * 0.012 * 0.08);
    const exact = model();
    exact.cylinder({
      radiusTop: 0.01,
      radiusBottom: 0.01,
      height: 0.02,
      radialSegments: 8,
      center: [0.15, 0, 0.08],
    });
    expectContract(m, m.difference(exact), 0.002 - 0.1 * 0.012 * 0.08 - prism(8, 0.01, 0.02));
  });

  it('boxes sharing a face union into one closed solid; cleanup.planar merges the seams', () => {
    const m = model();
    m.box({ size: [1, 1, 1], center: [0, 0, 0] });
    const other = model();
    other.box({ size: [1, 1, 1], center: [1, 0, 0] });
    const r = m.union(other);
    expectContract(m, r, 2);
    expect(m.inspect().faces).toBe(10);
    expect(m.cleanup.planar().status).toBe('ok');
    expect(m.inspect().faces).toBe(6);
  });

  it('coplanar identical solids: union and intersection are the solid', () => {
    const a = model();
    a.box({ size: [1, 1, 1] });
    const b = model();
    b.box({ size: [1, 1, 1] });
    expectContract(a, a.union(b), 1);
    const c = model();
    c.box({ size: [1, 1, 1] });
    const d = model();
    d.box({ size: [1, 1, 1] });
    const r = c.intersection(d);
    expectContract(c, r, 1);
  });

  it('a difference or split that leaves nothing outside the operand is degenerate, not no-effect', () => {
    for (const size of [1, 2]) {
      const m = model();
      m.box({ size: [1, 1, 1] });
      const tool = model();
      tool.box({ size: [size, size, size] });
      expect(m.difference(tool).error?.code).toBe('model-degenerate');
      const s = model();
      s.box({ size: [1, 1, 1] });
      expect(s.splitBy(tool).error?.code).toBe('model-degenerate');
    }
  });

  it('a tool resting on the target face removes nothing (model-op-no-effect)', () => {
    const m = plate();
    const lid = model();
    lid.box({ size: [0.1, 0.01, 0.1], center: [0, 0.015, 0] });
    const r = m.difference(lid);
    expect(r.error?.code).toBe('model-op-no-effect');
    const apart = plate();
    const far = model();
    far.box({ size: [0.1, 0.1, 0.1], center: [5, 0, 0] });
    expect(apart.intersection(far).error?.code).toBe('model-op-no-effect');
    const split = plate();
    expect(split.splitBy(far).error?.code).toBe('model-op-no-effect');
  });

  it('boxes touching along one edge are partial (non-manifold), with a location', () => {
    const a = model();
    a.box({ size: [1, 1, 1] });
    const b = model();
    b.box({ size: [1, 1, 1], center: [1, 1, 0] });
    const r = a.union(b);
    expect(r.error?.code).toBe('model-partial');
    const locations = r.error?.detail?.locations as { reason: string; position: Tuple3 }[];
    expect(locations.length).toBeGreaterThan(0);
    expect(
      locations.some((l) => l.reason === 'non-manifold-edge' || l.reason === 'open-edge'),
    ).toBe(true);
    expect(a.inspect().faces).toBe(6);
    // 'accept' never commits an open result as ok (review B-5): the target stays as it was.
    const c = model();
    c.box({ size: [1, 1, 1] });
    const accepted = c.union(b, { onPartial: 'accept' });
    expect(accepted.status).toBe('failed');
    expect(accepted.error?.code).toBe('model-partial');
    expect(accepted.error?.expected).toMatch(/closed/);
    expect(accepted.error?.hint).toMatch(/open/);
    const kept = accepted.error?.detail?.locations as { reason: string }[];
    expect(kept.some((l) => l.reason === 'open-edge')).toBe(true);
    const d = model();
    d.box({ size: [1, 1, 1] });
    const faces = d.editMesh.faceCount;
    d.union(b, { onPartial: 'accept' });
    expect(d.editMesh.faceCount).toBe(faces);
  });

  it('cuts a source face whose hole region pinches at a vertex', () => {
    // A square tool and a diamond tool touch the slab rim region at one vertex, so the
    // outline of the removed region visits that vertex twice.
    const m = model();
    m.box({ size: [1, 0.2, 1] });
    const tool = model();
    tool.box({ size: [0.2, 0.4, 0.2], center: [-0.2, 0.1, 0] });
    tool.cylinder({
      radiusTop: 0.2,
      radiusBottom: 0.2,
      height: 0.4,
      radialSegments: 4,
      center: [0.3, 0.1, 0],
    });
    const before = meshVolume(m.editMesh);
    const r = m.difference(tool, { label: 'cut' });
    expect(r.status).toBe('ok');
    const mesh = m.editMesh;
    const top: number[] = [];
    for (const f of mesh.faces()) {
      const ps = mesh.faceVertices(f).map((v) => mesh.position(v));
      if (ps.every((p) => Math.abs(p[1] - 0.1) < 1e-9)) top.push(ps.length);
    }
    // Both holes are cut out of the top face into strips; none stays one face with a bridge.
    expect(top.sort((a, b) => a - b)).toEqual([10, 10]);
    expect(before - meshVolume(mesh)).toBeCloseTo(0.2 * 0.2 * 0.2 + 2 * 0.2 * 0.2 * 0.2, 9);
    expect(m.validate().issues).toEqual([]);
  });
});

describe('boolean operators: preconditions, policy, budget', () => {
  it('rejects open operands and leaves the target unchanged', () => {
    const m = plate();
    const sheet = model();
    sheet.plane({ width: 1, height: 1 });
    const before = m.snapshot();
    const r = m.difference(sheet);
    expect(r.error?.code).toBe('model-precondition');
    expect(r.error?.hint).toMatch(/fillHoles/);
    expect(m.editMesh.faceCount).toBe(6);
    expect(Buffer.from(model().snapshot()).length).toBeGreaterThan(0);
    void before;
    const open = model();
    open.box({ size: [1, 1, 1] });
    open.delete(sel.facing('+y'));
    const target = plate();
    expect(target.union(open).error?.code).toBe('model-precondition');
    const inverted = model();
    inverted.box({ size: [1, 1, 1] });
    inverted.flip(sel.all());
    expect(plate().union(inverted).error?.code).toBe('model-precondition');
  });

  it("compute: 'native' without a native backend is model-capability-unavailable", () => {
    const m = plate();
    const r = m.difference(drills(1), { compute: 'native' });
    expect(r.error?.code).toBe('model-capability-unavailable');
    expect(r.error?.hint).toMatch(/toolchain install modeling/);
    const session = model({ compute: 'native' });
    plate(session);
    expect(session.union(drills(1)).error?.code).toBe('model-capability-unavailable');
    const auto = plate(model({ compute: 'auto' }));
    expect(job(auto.difference(drills(1))).backend).toBe('ts');
  });

  it('an injected native backend is chosen by auto, and its broken output is caught as partial', () => {
    const broken: ComputeBackend = {
      name: 'native',
      identity: 'fake-native@0',
      supports: (kind: ComputeJobKind) => kind === 'boolean',
      quality: () => 'production',
      run(request, work) {
        const out = tsBackend.run(request, work);
        if (!out.ok) return out;
        const value = out.value as BackendOutput<'boolean'>;
        const face = new Int32Array(value.provenance[0]?.face ?? []).map(() => 0);
        return ok({
          ...value,
          provenance: [{ ...(value.provenance[0] as FaceProvenance), face }],
        } as never);
      },
    };
    const m = plate(model({ native: broken }));
    const r = m.difference(drills(1));
    expect(r.error?.code).toBe('model-partial');
    const locations = r.error?.detail?.locations as { reason: string }[];
    expect(locations.some((l) => l.reason === 'unmapped-face')).toBe(true);
    expect(r.error?.detail?.backend).toBe('native');
    const failing: ComputeBackend = {
      ...broken,
      run: () => err(modelingError('model-degenerate', 'the native tool accepts the input', {})),
    };
    const f = plate(model({ native: failing }));
    const failed = f.difference(drills(1), { compute: 'native' });
    expect(failed.error?.code).toBe('model-degenerate');
    expect(failed.error?.detail?.backendIdentity).toBe('fake-native@0');
    expect(
      job(plate(model({ native: failing })).difference(drills(1), { compute: 'ts' })).backend,
    ).toBe('ts');
  });

  it('a volume that breaks the operation bounds is partial', () => {
    const growing: ComputeBackend = {
      name: 'native',
      identity: 'fake-grow@0',
      supports: () => true,
      quality: () => 'production',
      run(request, work) {
        const swapped = { ...request, params: { ...request.params, operation: 'union' } };
        return tsBackend.run(swapped as typeof request, work);
      },
    };
    const m = plate(model({ native: growing }));
    const big = model();
    big.box({ size: [0.2, 0.2, 0.2] });
    const r = m.difference(big);
    expect(r.error?.code).toBe('model-partial');
    expect((r.error?.detail?.locations as { reason: string }[]).map((l) => l.reason)).toContain(
      'volume',
    );
  });

  it('work budget and cancellation end the job', () => {
    const m = plate(model({ budget: { work: 50 } }));
    const r = m.difference(drills(2));
    expect(r.error?.code).toBe('model-work-budget');
    expect(r.error?.hint).toMatch(/native/);
    let reads = 0;
    const signal = {
      get aborted() {
        reads++;
        return reads > 1;
      },
    };
    const c = plate(model({ signal }));
    reads = 0;
    expect(c.difference(drills(4)).error?.code).toBe('model-cancelled');
  });
});

describe('compute jobs: determinism and cache identity', () => {
  it('the same input gives identical FXEM bytes and cache keys', () => {
    const build = () => {
      const m = plate();
      m.uv.project({ mode: 'box', scale: 0.1 });
      m.difference(drills(3, 12), { label: 'drill' });
      const boss = model();
      boss.cylinder({
        radiusTop: 0.03,
        radiusBottom: 0.03,
        height: 0.04,
        radialSegments: 20,
        center: [0, 0.02, -0.05],
      });
      m.union(boss, { label: 'boss' });
      return m;
    };
    const a = build();
    const b = build();
    expect(sha256(a.snapshot())).toBe(sha256(b.snapshot()));
    expect(job(a.journal.at(-1) as OpReport).cacheKey).toBe(
      job(b.journal.at(-1) as OpReport).cacheKey,
    );
  });

  it('cache keys change with inputs, params and backend identity', () => {
    const inputs = [plate().snapshot(), drills(1).snapshot()];
    const request = {
      kind: 'boolean' as const,
      inputs,
      params: { operation: 'difference' as const, tolerance: 1e-5 },
    };
    const key = computeCacheKey(request, 'ts@1');
    expect(computeCacheKey(request, 'ts@2')).not.toBe(key);
    expect(
      computeCacheKey({ ...request, params: { ...request.params, tolerance: 1e-4 } }, 'ts@1'),
    ).not.toBe(key);
    expect(
      computeCacheKey(
        { ...request, inputs: [inputs[1] as Uint8Array, inputs[0] as Uint8Array] },
        'ts@1',
      ),
    ).not.toBe(key);
    expect(sha256(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('runComputeJob reports backend, quality, metrics and per-output provenance', () => {
    const r = runComputeJob(
      {
        kind: 'boolean',
        inputs: [plate().snapshot(), drills(1).snapshot()],
        params: { operation: 'split', tolerance: 1e-5 },
      },
      tsBackend,
    );
    if (!r.ok) throw r.error;
    expect(r.value.status).toBe('ok');
    expect(r.value.outputs.length).toBe(2);
    expect(r.value.report).toMatchObject({ backend: 'ts', quality: 'baseline' });
    for (const [i, bytes] of r.value.outputs.entries()) {
      const mesh = decodeSnapshot(bytes);
      if (!mesh.ok) throw mesh.error;
      expect(r.value.provenance[i]?.face.length).toBe(mesh.value.faceCount);
      expect(meshVolume(mesh.value)).toBeGreaterThan(0);
    }
    const bad = runComputeJob(
      {
        kind: 'boolean',
        inputs: [plate().snapshot()],
        params: { operation: 'union', tolerance: 1e-5 },
      },
      tsBackend,
    );
    expect(bad.ok ? undefined : bad.error.code).toBe('model-invalid-argument');
    const unknown = runComputeJob(
      { kind: 'remesh' as never, inputs: [], params: {} as never },
      tsBackend,
    );
    expect(unknown.ok ? undefined : unknown.error.code).toBe('model-invalid-argument');
  });
});
