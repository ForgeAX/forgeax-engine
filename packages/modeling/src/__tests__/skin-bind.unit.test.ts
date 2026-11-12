import { PackageId } from '@forgeax/engine-pack/guid';
import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { runComputeJob } from '../compute/job';
import { tsSkinBackend } from '../compute/skin-ts';
import { encodeSnapshot } from '../fxem';
import { type Model, model } from '../model';
import { type Rig, type RigSpec, rig, type SkinWeights } from '../rig';
import { sel } from '../selectors';

/** Three joints up the Y axis: a root, a bending joint at y = 1, the tip at y = 2. */
const LIMB: RigSpec = {
  joints: [
    { name: 'base', parent: null, position: [0, 0, 0] },
    { name: 'bend', parent: 'base', position: [0, 1, 0], kind: 'revolute', axis: 'z' },
    { name: 'tip', parent: 'bend', position: [0, 2, 0] },
  ],
};

const RINGS = Array.from({ length: 21 }, (_, i) => i * 0.1);

/** A capped tube of radius 0.2 from y = 0 to 2 with a vertex ring every 0.1. */
function limb(): Model {
  const m = model();
  m.revolve({
    points: [[0, 0], ...RINGS.map((y) => [0.2, y] as [number, number]), [0, 2]],
    segments: 16,
    label: 'limb',
  });
  m.uv.project({ mode: 'cylinder', scale: 1 });
  return m;
}

function weightsOf(r: Rig, part: string): SkinWeights {
  const w = r.weights(part);
  if (!w.ok) throw w.error;
  return w.value;
}

/** Weight of `joint` (index in the rig table) on region row `row`. */
function weightOn(w: SkinWeights, row: number, joint: number): number {
  let total = 0;
  for (let k = 0; k < 4; k++)
    if (w.joints[row * 4 + k] === joint) total += w.weights[row * 4 + k] as number;
  return total;
}

function rowsAt(m: Model, w: SkinWeights, y: number): number[] {
  const rows: number[] = [];
  for (let r = 0; r < w.vertices.length; r++) {
    const p = m.editMesh.position(w.vertices[r] as number);
    if (Math.abs(p[1] - y) < 1e-9 && Math.hypot(p[0], p[2]) > 0.1) rows.push(r);
  }
  return rows;
}

describe('rig.bindAuto (skin.bind TS baseline)', () => {
  it('blends neighboring bones along a limb, normalized with at most four influences', () => {
    const m = limb();
    const r = rig(m, LIMB);
    expect(r.bindAuto(sel.all(), ['base', 'bend']).status).toBe('ok');
    const w = weightsOf(r, 'base-bend');
    expect(w.status).toBe('ok');
    expect(w.report.backend).toBe('ts');
    expect(w.report.quality).toBe('baseline');
    for (let row = 0; row < w.vertices.length; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const value = w.weights[row * 4 + k] as number;
        expect(value).toBeGreaterThanOrEqual(0);
        if (k > 0) expect(value).toBeLessThanOrEqual(w.weights[row * 4 + k - 1] as number);
        sum += value;
      }
      expect(sum).toBeCloseTo(1, 5);
    }
    const mean = (y: number, joint: number) => {
      const rows = rowsAt(m, w, y);
      return rows.reduce((s, row) => s + weightOn(w, row, joint), 0) / rows.length;
    };
    expect(mean(0.2, 0)).toBeGreaterThan(0.9);
    expect(mean(1.8, 1)).toBeGreaterThan(0.9);
    // The elbow blends both bones; weight moves monotonically from one to the other.
    expect(mean(1.0, 0)).toBeGreaterThan(0.35);
    expect(mean(1.0, 1)).toBeGreaterThan(0.35);
    const profile = RINGS.map((y) => mean(y, 1));
    for (let i = 1; i < profile.length; i++)
      expect(profile[i] as number).toBeGreaterThanOrEqual((profile[i - 1] as number) - 1e-6);
  });

  it('poses the region by linear blend skinning', () => {
    const m = limb();
    const r = rig(m, LIMB);
    r.bindAuto(sel.all(), ['base', 'bend', 'tip']);
    const rest = r.toMesh();
    const bent = r.toMesh({ bend: 90 });
    if (!rest.ok || !bent.ok) throw new Error('pose failed');
    const top = (mesh: MeshAsset) => {
      const p = mesh.attributes.position as Float32Array;
      let best = 0;
      for (let i = 1; i < p.length / 3; i++)
        if ((p[i * 3 + 1] as number) > (p[best * 3 + 1] as number)) best = i;
      return [p[best * 3] as number, p[best * 3 + 1] as number];
    };
    expect(top(rest.value.mesh)[1]).toBeCloseTo(2, 6);
    // Bending +90 degrees about z at (0, 1, 0) swings the tip toward -x at y = 1.
    const bentPos = bent.value.mesh.attributes.position as Float32Array;
    let tipX = Infinity;
    for (let i = 0; i < bentPos.length / 3; i++) tipX = Math.min(tipX, bentPos[i * 3] as number);
    expect(tipX).toBeLessThan(-0.9);
    // The base stays within the falloff tail of the bend bone (about 4 % weight at y = 0).
    let lowest = Infinity;
    for (let i = 0; i < bentPos.length / 3; i++)
      lowest = Math.min(lowest, bentPos[i * 3 + 1] as number);
    expect(Math.abs(lowest)).toBeLessThan(0.05);
  });

  it('follows the shape: a bone does not reach across air to a neighboring finger', () => {
    const m = model();
    m.box({ size: [0.6, 0.2, 0.2], center: [0, 0.1, 0], label: 'palm' });
    m.box({ size: [0.1, 0.8, 0.1], center: [-0.25, 0.6, 0], label: 'left' });
    m.box({ size: [0.1, 0.8, 0.1], center: [0.25, 0.6, 0], label: 'right' });
    const r = rig(m, {
      joints: [
        { name: 'palm', parent: null, position: [0, 0.1, 0] },
        { name: 'left', parent: 'palm', position: [-0.25, 0.2, 0] },
        { name: 'left-tip', parent: 'left', position: [-0.25, 1, 0] },
        { name: 'right', parent: 'palm', position: [0.25, 0.2, 0] },
        { name: 'right-tip', parent: 'right', position: [0.25, 1, 0] },
      ],
    });
    r.bindAuto(sel.all(), ['palm', 'left', 'right'], { part: 'hand', smoothing: 0, prune: 0 });
    const w = weightsOf(r, 'hand');
    // The inner top corner of the left finger: 0.3 from the right bone through the air,
    // about 1.5 along the shape.
    let row = -1;
    for (let k = 0; k < w.vertices.length; k++) {
      const p = m.editMesh.position(w.vertices[k] as number);
      if (Math.abs(p[0] + 0.2) < 1e-9 && Math.abs(p[1] - 1) < 1e-9 && p[2] > 0) row = k;
    }
    expect(row).toBeGreaterThanOrEqual(0);
    const right = weightOn(w, row, 3);
    const left = weightOn(w, row, 1);
    expect(left).toBeGreaterThan(0.9);
    // Straight distances (0.05 vs 0.45 from the bones) would give the right bone
    // (0.05 / 0.45)^2 / (1 + ...) ~ 1.2 %; along the shape it is far less.
    expect(right).toBeLessThan(0.004);
  });

  it('reaches an open sleeve from a bone inside its hollow', () => {
    const m = model();
    m.revolve({
      points: RINGS.map((y) => [0.2, y] as [number, number]),
      segments: 16,
      label: 'sleeve',
    });
    const r = rig(m, LIMB);
    r.bindAuto(sel.all(), ['base', 'bend'], { part: 'sleeve' });
    const w = weightsOf(r, 'sleeve');
    expect(w.status).toBe('ok');
    expect(w.report.metrics.unreached).toBe(0);
    const bottom = rowsAt(m, w, 0.1);
    const top = rowsAt(m, w, 1.9);
    for (const row of bottom) expect(weightOn(w, row, 0)).toBeGreaterThan(0.8);
    for (const row of top) expect(weightOn(w, row, 1)).toBeGreaterThan(0.8);
  });

  it('pins vertices shared with a rigid part to its joint', () => {
    const m = limb();
    const r = rig(m, LIMB);
    r.bindRigid(sel.all(), 'base', { part: 'socket' });
    r.bindAuto(sel.inBox([-1, 0.55, -1], [1, 3, 1], { by: 'all' }), ['base', 'bend', 'tip'], {
      part: 'skin',
    });
    const w = weightsOf(r, 'skin');
    const seam = rowsAt(m, w, 0.6);
    expect(seam.length).toBe(16);
    for (const row of seam) {
      expect(w.joints[row * 4]).toBe(0);
      expect(w.weights[row * 4]).toBe(1);
    }
    // A bend leaves the rigid socket and the seam in place: no crack opens.
    const bent = r.toMesh({ bend: 45 });
    expect(bent.ok).toBe(true);

    const missing = rig(limb(), LIMB);
    missing.bindRigid(sel.all(), 'base', { part: 'socket' });
    missing.bindAuto(sel.inBox([-1, 0.55, -1], [1, 3, 1], { by: 'all' }), ['bend', 'tip']);
    const failed = missing.weights('bend-tip');
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('model-precondition');
      expect(failed.error.detail).toMatchObject({ joint: 'base', rigid: 'socket' });
    }
  });

  it('exports blended skinIndex / skinWeight with form skinned and rejects form rigid', () => {
    const m = limb();
    const r = rig(m, LIMB);
    r.bindAuto(sel.all(), ['base', 'bend', 'tip'], { part: 'skin' });
    const packageId = PackageId.parse('01900000-0000-7000-8000-0000000c0108');
    if (!packageId.ok) throw new Error('package id');
    const rigid = r.finish({ key: 'limb', packageId: packageId.value });
    expect(rigid.ok).toBe(false);
    if (!rigid.ok) expect(rigid.error.code).toBe('model-invalid-argument');
    const skinned = r.finish({ key: 'limb', packageId: packageId.value, form: 'skinned' });
    if (!skinned.ok) throw skinned.error;
    const mesh = skinned.value['mesh/limb'] as MeshAsset;
    const weights = mesh.attributes.skinWeight as Float32Array;
    const indices = mesh.attributes.skinIndex as Uint16Array;
    let blended = 0;
    for (let v = 0; v < weights.length / 4; v++) {
      const sum =
        (weights[v * 4] as number) +
        (weights[v * 4 + 1] as number) +
        (weights[v * 4 + 2] as number) +
        (weights[v * 4 + 3] as number);
      expect(sum).toBeCloseTo(1, 5);
      for (let k = 0; k < 4; k++) expect(indices[v * 4 + k]).toBeLessThan(3);
      if ((weights[v * 4 + 1] as number) > 0.05) blended++;
    }
    expect(blended).toBeGreaterThan(16);
  });

  it('is deterministic and keeps the job contract', () => {
    const a = weightsOf(
      (() => {
        const r = rig(limb(), LIMB);
        r.bindAuto(sel.all(), ['base', 'bend']);
        return r;
      })(),
      'base-bend',
    );
    const b = weightsOf(
      (() => {
        const r = rig(limb(), LIMB);
        r.bindAuto(sel.all(), ['base', 'bend']);
        return r;
      })(),
      'base-bend',
    );
    expect(a.report.cacheKey).toBe(b.report.cacheKey);
    expect(Buffer.from(a.weights.buffer).equals(Buffer.from(b.weights.buffer))).toBe(true);
    expect(Buffer.from(a.joints.buffer).equals(Buffer.from(b.joints.buffer))).toBe(true);

    const request = {
      kind: 'skin.bind' as const,
      inputs: [encodeSnapshot(limb().editMesh)],
      params: {
        bones: [{ root: [0, 0, 0] as [number, number, number], tips: [] }],
        resolution: 32,
        stiffness: 0.2,
        smoothing: 0,
        smoothingStrength: 0.5,
        maxInfluences: 5,
        prune: 0,
      },
    };
    const invalid = runComputeJob(request, tsSkinBackend);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe('model-invalid-argument');
    const native = runComputeJob(
      { ...request, params: { ...request.params, maxInfluences: 4 } },
      tsSkinBackend,
      {
        policy: 'native',
      },
    );
    expect(native.ok).toBe(false);
    if (!native.ok) expect(native.error.code).toBe('model-capability-unavailable');
    const budget = runComputeJob(
      { ...request, params: { ...request.params, maxInfluences: 4 } },
      tsSkinBackend,
      {
        budget: 1000,
      },
    );
    expect(budget.ok).toBe(false);
    if (!budget.ok) expect(budget.error.code).toBe('model-work-budget');
  });

  it('rejects unknown joints and duplicate part names', () => {
    const r = rig(limb(), LIMB);
    const bad = r.bindAuto(sel.all(), ['base', 'elbow']);
    expect(bad.status).toBe('failed');
    expect(bad.error?.code).toBe('model-invalid-argument');
    const r2 = rig(limb(), LIMB);
    r2.bindRigid(sel.all(), 'base');
    expect(r2.bindAuto(sel.all(), ['base', 'bend'], { part: 'base' }).status).toBe('failed');
  });
});
