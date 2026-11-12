import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { AnimationClip, MeshAsset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { applyPoint } from '../affine';
import { captureModels } from '../capture';
import { type Model, model } from '../model';
import { type Rig, type RigSpec, rig } from '../rig';
import { sel } from '../selectors';

const ARM: RigSpec = {
  joints: [
    { name: 'base', parent: null, position: [0, 0, 0] },
    {
      name: 'shoulder',
      parent: 'base',
      position: [0, 1, 0],
      kind: 'revolute',
      axis: 'z',
      limits: [-90, 120],
    },
    {
      name: 'slide',
      parent: 'shoulder',
      position: [1, 1, 0],
      kind: 'prismatic',
      axis: 'x',
      limits: [0, 0.5],
    },
    {
      name: 'wrist',
      parent: 'slide',
      position: [1.5, 1, 0],
      kind: 'spherical',
      limits: { x: [-45, 45], z: [-30, 30] },
    },
  ],
};

function at(r: Rig, name: string, pose = {}): number[] {
  const posed = r.pose(pose);
  if (!posed.ok) throw posed.error;
  const w = posed.value.joints.find((j) => j.name === name)?.world as number[];
  return [w[3], w[7], w[11]].map((v) => Math.round((v as number) * 1e9) / 1e9);
}

/**
 * A fixed wall and an arm on a hinge at the origin, rotating about z. Dimensions are
 * binary-exact so `gap` 0 makes the arm's bottom face and the wall's top face coplanar.
 */
function hinged(gap = 0.25): { m: Model; r: Rig } {
  const m = model();
  m.box({ size: [1, 0.25, 0.25], center: [0.5, 0, 0], label: 'arm' });
  m.box({ size: [0.25, 0.5, 1], center: [0.75, -0.375 - gap, 0], label: 'wall' });
  m.uv.project({ mode: 'box', scale: 0.5 });
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      {
        name: 'hinge',
        parent: 'root',
        position: [0, 0, 0],
        kind: 'revolute',
        axis: 'z',
        limits: [-90, 90],
      },
    ],
  });
  r.bindRigid(sel.all(), 'root', { part: 'wall' });
  r.bindRigid(sel.createdBy('arm'), 'hinge', { part: 'arm' });
  return { m, r };
}

describe('rig: joints, limits and forward kinematics', () => {
  it('moves children by revolute, prismatic and spherical values', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const r = rig(m, ARM);
    expect(r.poisoned).toBeUndefined();
    expect(at(r, 'wrist')).toEqual([1.5, 1, 0]);
    expect(at(r, 'wrist', { shoulder: 90 })).toEqual([0, 2.5, 0]);
    expect(at(r, 'wrist', { shoulder: 90, slide: 0.25 })).toEqual([0, 2.75, 0]);
    expect(at(r, 'slide', { shoulder: 90, slide: 0.25, wrist: { z: 20 } })).toEqual([0, 2.25, 0]);
  });

  it('clamps values to their limits and reports every clamp; reject fails instead', () => {
    const r = rig(model(), ARM);
    const posed = r.pose({ shoulder: 150, slide: -1, wrist: { x: 10, y: 5, z: 40 } });
    if (!posed.ok) throw posed.error;
    expect(posed.value.clamped).toEqual([
      { joint: 'shoulder', requested: 150, applied: 120 },
      { joint: 'slide', requested: -1, applied: 0 },
      { joint: 'wrist', axis: 'y', requested: 5, applied: 0 },
      { joint: 'wrist', axis: 'z', requested: 40, applied: 30 },
    ]);
    expect(posed.value.joints.find((j) => j.name === 'wrist')?.value).toEqual({
      x: 10,
      y: 0,
      z: 30,
    });
    const rejected = r.pose({ shoulder: 150 }, { limits: 'reject' });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.detail?.clamped).toHaveLength(1);
  });

  it('rejects malformed tables, unknown joints and values of the wrong kind', () => {
    const bad: [RigSpec, string][] = [
      [{ joints: [] }, 'at least one joint'],
      [
        {
          joints: [
            { name: 'a', parent: null, position: [0, 0, 0] },
            { name: 'a', parent: 'a', position: [0, 0, 0] },
          ],
        },
        'unique',
      ],
      [{ joints: [{ name: 'a', parent: 'b', position: [0, 0, 0] }] }, 'precedes'],
      [
        {
          joints: [
            { name: 'a', parent: null, position: [0, 0, 0] },
            { name: 'b', parent: null, position: [0, 0, 0] },
          ],
        },
        'single root',
      ],
      [
        { joints: [{ name: 'a', parent: null, position: [0, 0, 0], kind: 'revolute' }] },
        'non-zero axis',
      ],
      [
        {
          joints: [
            {
              name: 'a',
              parent: null,
              position: [0, 0, 0],
              kind: 'prismatic',
              axis: 'x',
              limits: [1, 0],
            },
          ],
        },
        'min <= max',
      ],
      [
        { joints: [{ name: 'a', parent: null, position: [0, 0, 0], limits: [0, 1] }] },
        'fixed joint',
      ],
      [{ joints: [{ name: 'Arm', parent: null, position: [0, 0, 0] }] }, 'lowercase'],
    ];
    for (const [spec, expected] of bad) {
      const r = rig(model(), spec);
      expect(r.poisoned?.expected).toContain(expected);
      expect(r.pose().ok).toBe(false);
      expect(r.bindRigid(sel.all(), 'a').status).toBe('skipped');
    }
    const r = rig(model(), ARM);
    expect(r.pose({ elbow: 1 }).ok).toBe(false);
    expect(r.pose({ base: 1 }).ok).toBe(false);
    expect(r.pose({ shoulder: { x: 1 } }).ok).toBe(false);
    expect(r.pose({ wrist: 3 }).ok).toBe(false);
  });
});

describe('rig: transformation paths', () => {
  const r = rig(model(), ARM);
  const path = {
    keys: [
      { u: 0, pose: { shoulder: 0, slide: 0 } },
      { u: 0.5, pose: { shoulder: 90, wrist: { x: 40 } } },
      { u: 1, pose: { slide: 0.5 } },
    ],
  };

  it('interpolates each joint between its keys, from rest at u = 0, and holds the last', () => {
    const sample = (u: number, interpolation?: 'linear' | 'smooth' | 'step') => {
      const s = r.sample({ ...path, ...(interpolation === undefined ? {} : { interpolation }) }, u);
      if (!s.ok) throw s.error;
      return s.value;
    };
    // slide is keyed at u = 0 and 1 only: it interpolates across the key at 0.5. wrist is
    // first keyed at 0.5, so it ramps from rest at u = 0.
    expect(sample(0.25)).toEqual({ shoulder: 45, slide: 0.125, wrist: { x: 20 } });
    expect(sample(0.75)).toEqual({ shoulder: 90, slide: 0.375, wrist: { x: 40 } });
    expect(sample(-1)).toEqual({ shoulder: 0, slide: 0, wrist: {} });
    expect(sample(2)).toEqual({ shoulder: 90, slide: 0.5, wrist: { x: 40 } });
    expect(r.sample({ keys: [{ u: 0.5, pose: {} }] }, 0.3)).toEqual({ ok: true, value: {} });
    expect(sample(0.125, 'smooth').shoulder).toBeCloseTo(90 * (0.25 * 0.25 * (3 - 0.5)), 12);
    expect(sample(0.4, 'step').shoulder).toBe(0);
  });

  it('samples dense paths by binary search, compiled once per path', () => {
    // 200 keys on a wavy shoulder track; every sample matches direct interpolation.
    const keys = Array.from({ length: 200 }, (_, i) => ({
      u: i / 199,
      pose: { shoulder: ((i * 37) % 90) - 45 },
    }));
    const dense = { keys };
    for (let j = 0; j <= 500; j++) {
      const u = j / 500;
      const k = Math.min(198, Math.floor(u * 199));
      const a = keys[k] as (typeof keys)[number];
      const b = keys[k + 1] as (typeof keys)[number];
      const t = (u - a.u) / (b.u - a.u);
      const expected = a.pose.shoulder + (b.pose.shoulder - a.pose.shoulder) * t;
      const got = r.sample(dense, u);
      expect(got.ok && (got.value.shoulder as number)).toBeCloseTo(expected, 9);
    }
    expect(r.sample({ keys: [{ u: 0.5, pose: { base: 1 } }] }, 0).ok).toBe(false);
  });

  it('rejects unordered keys, fixed joints and unknown interpolation', () => {
    expect(r.sample({ keys: [] }, 0).ok).toBe(false);
    expect(
      r.sample(
        {
          keys: [
            { u: 0.5, pose: {} },
            { u: 0.5, pose: {} },
          ],
        },
        0,
      ).ok,
    ).toBe(false);
    expect(r.sample({ keys: [{ u: 0, pose: { base: 1 } }] }, 0).ok).toBe(false);
    expect(r.sample({ keys: [{ u: 0, pose: { wrist: 1 } }] }, 0).ok).toBe(false);
    expect(r.sample({ keys: [{ u: 0, pose: {} }], interpolation: 'cubic' as 'linear' }, 0).ok).toBe(
      false,
    );
  });
});

describe('rig: rigid bindings', () => {
  it('resolves bindings at use time; later bindings take over faces', () => {
    const { m, r } = hinged();
    const parts = r.parts();
    if (!parts.ok) throw parts.error;
    expect(parts.value).toEqual([
      { name: 'wall', joint: 'root', faces: 6, closed: true },
      { name: 'arm', joint: 'hinge', faces: 6, closed: true },
    ]);
    m.box({ size: [0.1, 0.1, 0.1], center: [3, 0, 0], label: 'later' });
    const grown = r.parts();
    expect(grown.ok && grown.value[0]?.faces).toBe(12);
  });

  it('fails on unbound faces, shared vertices, empty parts and bad names', () => {
    const m = model();
    m.box({ size: [1, 1, 1], label: 'a' });
    const unbound = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    unbound.bindRigid(sel.facing('+y', 1), 'root');
    const u = unbound.parts();
    expect(!u.ok && u.error.detail?.unbound).toBe(5);

    const shared = rig(m, {
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        { name: 'lid', parent: 'root', position: [0, 0.5, 0], kind: 'revolute', axis: 'x' },
      ],
    });
    shared.bindRigid(sel.all(), 'root');
    shared.bindRigid(sel.facing('+y', 1), 'lid');
    const s = shared.parts();
    expect(!s.ok && s.error.expected).toBe('rigid parts share no vertex');
    m.disconnect(sel.facing('+y', 1));
    expect(shared.parts().ok).toBe(true);

    const empty = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    empty.bindRigid(sel.all(), 'root', { part: 'first' });
    empty.bindRigid(sel.all(), 'root', { part: 'second' });
    const e = empty.parts();
    expect(!e.ok && e.error.detail?.part).toBe('first');

    const named = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    expect(named.bindRigid(sel.all(), 'root').status).toBe('ok');
    expect(named.bindRigid(sel.all(), 'root').status).toBe('failed');
    expect(named.poisoned?.hint).toContain('options.part');
    expect(rig(m, ARM).bindRigid(sel.all(), 'elbow').status).toBe('failed');
  });

  it('poses a copy of the session: the source stays at rest', () => {
    const { m, r } = hinged();
    const before = m.snapshot();
    const posed = r.toMesh({ hinge: 90 });
    if (!posed.ok) throw posed.error;
    const aabb = posed.value.mesh.aabb as Float32Array;
    expect(aabb[4]).toBeCloseTo(1, 6);
    expect(m.snapshot()).toEqual(before);
    const snapshot = r.posedSnapshot({ hinge: 90 });
    expect(snapshot.ok && snapshot.value.length).toBeGreaterThan(0);
  });
});

describe('rig: interference at a pose', () => {
  it('separates clear, touching, penetrating and contained parts', () => {
    const { r } = hinged();
    const clear = r.interference({ hinge: 0 });
    if (!clear.ok) throw clear.error;
    expect(clear.value).toMatchObject({ pass: true, confirmed: 0, candidates: 0, pairs: [] });

    const touching = hinged(0).r.interference({ hinge: 0 });
    if (!touching.ok) throw touching.error;
    expect(touching.value.pairs).toHaveLength(1);
    expect(touching.value.pairs[0]).toMatchObject({
      parts: ['arm', 'wall'],
      status: 'candidate',
      reason: 'contact',
      depth: 0,
    });
    expect(touching.value.pass).toBe(true);

    const designed = hinged(0).r.interference(
      { hinge: 0 },
      { contacts: [{ parts: ['wall', 'arm'] }] },
    );
    expect(designed.ok && designed.value.pairs[0]?.status).toBe('designed');

    const sunk = hinged(-0.0625).r.interference({ hinge: 0 });
    if (!sunk.ok) throw sunk.error;
    expect(sunk.value.pairs[0]).toMatchObject({ status: 'confirmed', reason: 'penetration' });
    expect(sunk.value.pairs[0]?.depth).toBe(0.0625);
    expect(sunk.value.pass).toBe(false);
    const tolerated = hinged(-0.0625).r.interference(
      { hinge: 0 },
      { contacts: [{ parts: ['arm', 'wall'], tolerance: 0.07 }] },
    );
    expect(tolerated.ok && tolerated.value.pairs[0]?.status).toBe('designed');

    const m = model();
    m.box({ size: [2, 2, 2], label: 'shell' });
    m.box({ size: [0.5, 0.5, 0.5], label: 'core' });
    const nested = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    nested.bindRigid(sel.createdBy('shell'), 'root', { part: 'shell' });
    nested.bindRigid(sel.createdBy('core'), 'root', { part: 'core' });
    const inside = nested.interference();
    if (!inside.ok) throw inside.error;
    expect(inside.value.pairs[0]).toMatchObject({
      parts: ['core', 'shell'],
      status: 'confirmed',
      reason: 'contained',
    });
    expect(inside.value.pairs[0]?.depth).toBeCloseTo(0.75, 9);
  });

  it('measures parts sunk along shared mesh lines, whose triangles only touch', () => {
    // Grid-aligned boxes: every intersection line runs along mesh edges, so no triangle pair crosses.
    const sunk = (dx: number) => {
      const m = model();
      m.box({ size: [0.2, 0.2, 0.2], center: [dx, 0.07, 0], segments: [4, 4, 4], label: 'a' });
      m.box({ size: [0.4, 0.2, 0.4], center: [0, -0.1, 0], segments: [4, 4, 4], label: 'b' });
      const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
      r.bindRigid(sel.all(), 'root', { part: 'b' });
      r.bindRigid(sel.createdBy('a'), 'root', { part: 'a' });
      const t = r.interference({}, { contacts: [{ parts: ['a', 'b'], tolerance: 0.005 }] });
      if (!t.ok) throw t.error;
      return t.value.pairs[0];
    };
    for (const dx of [0, 0.003]) {
      expect(sunk(dx)).toMatchObject({ status: 'confirmed', reason: 'penetration' });
      expect(sunk(dx)?.depth).toBeCloseTo(0.03, 12);
    }
    const m = model();
    m.sphere({
      radius: 0.1,
      widthSegments: 48,
      heightSegments: 24,
      center: [0, 0.07, 0],
      label: 'ball',
    });
    m.box({ size: [0.4, 0.2, 0.4], center: [0, -0.1, 0], segments: [16, 4, 16], label: 'slab' });
    const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    r.bindRigid(sel.all(), 'root', { part: 'slab' });
    r.bindRigid(sel.createdBy('ball'), 'root', { part: 'ball' });
    const ball = r.interference();
    // The pole vertex is the deepest point; crossing triangles alone reach only about 14 mm.
    expect(ball.ok && ball.value.pairs[0]?.depth).toBeCloseTo(0.03, 12);
  });

  it('accepts a faceted pin in a drilled hole within the designed tolerance', () => {
    const m = model();
    m.box({ size: [0.08, 0.02, 0.08], label: 'plate' });
    const drill = model();
    drill.cylinder({ radiusTop: 0.01, radiusBottom: 0.01, height: 0.04, radialSegments: 24 });
    m.difference(drill);
    m.cylinder({
      radiusTop: 0.01,
      radiusBottom: 0.01,
      height: 0.05,
      radialSegments: 16,
      label: 'pin',
    });
    const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    r.bindRigid(sel.all(), 'root', { part: 'plate' });
    r.bindRigid(sel.createdBy('pin'), 'root', { part: 'pin' });
    // Pin corners on the circle reach past the 24-gon's flats by at most r (1 - cos(pi / 24)).
    const reach = 0.01 * (1 - Math.cos(Math.PI / 24));
    const free = r.interference();
    if (!free.ok) throw free.error;
    const pair = free.value.pairs[0];
    expect(pair).toMatchObject({
      parts: ['pin', 'plate'],
      status: 'candidate',
      reason: 'penetration',
    });
    expect(pair?.depth).toBeGreaterThan(0);
    expect(pair?.depth).toBeLessThanOrEqual(reach + 1e-12);
    const designed = r.interference({}, { contacts: [{ parts: ['pin', 'plate'] }] });
    expect(designed.ok && designed.value.pairs[0]?.status).toBe('designed');
    const strict = r.interference({}, { tolerance: reach / 4 });
    expect(strict.ok && strict.value.pairs[0]?.status).toBe('confirmed');
  });

  it('applies designed contacts declared on the rig to every test', () => {
    const m = model();
    m.box({ size: [1, 0.25, 0.25], center: [0.5, 0, 0], label: 'arm' });
    m.box({ size: [0.25, 0.5, 1], center: [0.75, -0.375, 0], label: 'wall' });
    const r = rig(m, {
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        { name: 'hinge', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
      ],
      contacts: [{ parts: ['arm', 'wall'] }],
    });
    r.bindRigid(sel.all(), 'root', { part: 'wall' });
    r.bindRigid(sel.createdBy('arm'), 'hinge', { part: 'arm' });
    const touching = r.interference();
    expect(touching.ok && touching.value.pairs[0]?.status).toBe('designed');
    const tighter = r.interference({}, { contacts: [{ parts: ['arm', 'wall'], tolerance: 0 }] });
    expect(tighter.ok && tighter.value.pairs[0]?.status).toBe('designed');
  });

  it("gives the same report however the parts' shared ancestors move", () => {
    // A sheet split into two pieces that meet at a seam, each on its own hinge, under a
    // spherical root: root motion must not change the exact seam test.
    const m = model();
    m.plane({ width: 0.6, height: 0.4, widthSegments: 2, heightSegments: 1, label: 'skin' });
    m.disconnect(sel.facing('+z').and(sel.inBox([0, -1, -1], [1, 1, 1], { by: 'centroid' })));
    const r = rig(m, {
      joints: [
        { name: 'root', parent: null, position: [0.13, 0.27, 0.05], kind: 'spherical' },
        { name: 'left', parent: 'root', position: [-0.3, 0, 0], kind: 'revolute', axis: 'y' },
        { name: 'right', parent: 'root', position: [0.3, 0, 0], kind: 'revolute', axis: 'y' },
      ],
    });
    r.bindRigid(sel.all(), 'left', { part: 'left' });
    r.bindRigid(sel.inBox([0, -1, -1], [1, 1, 1], { by: 'centroid' }), 'right', { part: 'right' });
    const reports = [0, -10, -23, -45, -67, -90].map((x) => {
      const hit = r.interference({ root: { x, y: 31, z: -7 } });
      if (!hit.ok) throw hit.error;
      // `at` is a posed model-space point: it moves with the root, everything else may not.
      return hit.value.pairs.map(({ at: _at, ...pair }) => pair);
    });
    expect(reports[0]).toHaveLength(1);
    expect(reports[0]?.[0]).toMatchObject({
      parts: ['left', 'right'],
      status: 'candidate',
      reason: 'contact',
      depth: 0,
    });
    for (const report of reports) expect(report).toEqual(reports[0]);
  });

  it('reports the reach of thin parts slicing through each other', () => {
    const m = model();
    m.box({ size: [0.5, 0.004, 0.3], label: 'flat' });
    m.box({ size: [0.004, 0.5, 0.3], center: [0, 0, 0.02], label: 'upright' });
    const r = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    r.bindRigid(sel.createdBy('flat'), 'root', { part: 'flat' });
    r.bindRigid(sel.createdBy('upright'), 'root', { part: 'upright' });
    const hit = r.interference({}, { tolerance: 0.004 });
    if (!hit.ok) throw hit.error;
    const pair = hit.value.pairs[0];
    // Depth is bounded by half a 4 mm plate; reach shows they pass right through each other,
    // which is a clash whatever the tolerance (audit A3).
    expect(pair?.depth).toBeLessThanOrEqual(0.002 + 1e-12);
    expect(pair?.reach).toBeGreaterThan(0.1);
    expect(pair).toMatchObject({ status: 'confirmed', reason: 'through' });
  });

  it('validates tolerances and designed contact names', () => {
    const { r } = hinged();
    expect(r.interference({}, { tolerance: -1 }).ok).toBe(false);
    expect(r.interference({}, { contacts: [{ parts: ['arm', 'nose'] }] }).ok).toBe(false);
    expect(r.interference({}, { contacts: [{ parts: ['arm', 'arm'] }] }).ok).toBe(false);
  });
});

describe('rig: path scan', () => {
  const path = {
    keys: [
      { u: 0, pose: { hinge: 0 } },
      { u: 1, pose: { hinge: -90 } },
    ],
  };

  it('reports first contacts per pair, refined between samples', () => {
    const { r } = hinged();
    const scan = r.scan(path, { step: 0.1, refine: 8 });
    if (!scan.ok) throw scan.error;
    expect(scan.value.samples).toHaveLength(11);
    expect(scan.value.pass).toBe(false);
    const pair = scan.value.pairs[0];
    expect(pair?.parts).toEqual(['arm', 'wall']);
    expect(pair?.status).toBe('confirmed');
    const first = pair?.firstContact as number;
    const confirmed = pair?.firstConfirmed as number;
    expect(confirmed).toBeGreaterThanOrEqual(first);
    const before = r.interference({ hinge: -90 * (first - 0.1 / 256) });
    const hit = r.interference({ hinge: -90 * first });
    expect(before.ok && before.value.pairs).toEqual([]);
    expect(hit.ok && hit.value.pairs.length).toBe(1);
    // The arm's bottom edge (0.125 below its axis) first meets the wall's top corner (0.875, -0.375).
    const analytic =
      (Math.atan2(0.375, 0.875) - Math.asin(0.125 / Math.hypot(0.875, 0.375))) / (Math.PI / 2);
    expect(Math.abs(first - analytic)).toBeLessThan(0.1 / 256 + 1e-9);
  });

  it('subdivides by travel, so a part cannot pass through another between samples', () => {
    const { r } = hinged();
    // With samples at u = 0 and 1 only, both ends are clear: the arm swings through the wall in between.
    const coarse = r.scan(path, { step: 1, refine: 8 });
    if (!coarse.ok) throw coarse.error;
    expect(coarse.value.samples.map((s) => s.u)).toEqual([0, 1]);
    expect(coarse.value.samples.every((s) => s.confirmed === 0)).toBe(true);
    expect(coarse.value.pass).toBe(false);
    expect(coarse.value.pairs[0]?.status).toBe('confirmed');
    const analytic =
      (Math.atan2(0.375, 0.875) - Math.asin(0.125 / Math.hypot(0.875, 0.375))) / (Math.PI / 2);
    expect(Math.abs((coarse.value.pairs[0]?.firstContact as number) - analytic)).toBeLessThan(0.01);
    expect(r.scan(path, { maxTravel: 0 }).ok).toBe(false);
  });

  it('spends no extra poses on parts that stay farther apart than they can move', () => {
    const { r } = hinged(2);
    const up = r.scan(
      {
        keys: [
          { u: 0, pose: { hinge: 0 } },
          { u: 1, pose: { hinge: 90 } },
        ],
      },
      { step: 0.25 },
    );
    if (!up.ok) throw up.error;
    expect(up.value.evaluated).toBe(up.value.samples.length);
  });

  it('is clear when nothing meets, and validates its step', () => {
    const { r } = hinged();
    const up = r.scan({
      keys: [
        { u: 0, pose: { hinge: 0 } },
        { u: 1, pose: { hinge: 90 } },
      ],
    });
    expect(up.ok && up.value).toMatchObject({ pass: true, pairs: [] });
    expect(up.ok && up.value.samples).toHaveLength(21);
    expect(r.scan(path, { step: 0 }).ok).toBe(false);
    expect(r.scan(path, { refine: 1.5 }).ok).toBe(false);
  });
});

describe('rig: export for the Engine', () => {
  const packageId = PackageId.parse('01900000-0000-7000-8000-0000000c0107');
  if (!packageId.ok) throw packageId.error;
  const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId.value, key));
  const path = {
    keys: [
      { u: 0, pose: { hinge: 0 } },
      { u: 1, pose: { hinge: 60 } },
    ],
  };

  it('writes part meshes in joint space, a joint scene and a clip', () => {
    const { r } = hinged();
    const out = r.finish({
      key: 'limb',
      packageId: packageId.value,
      path,
      duration: 2,
      frameRate: 10,
    });
    if (!out.ok) throw out.error;
    expect(Object.keys(out.value).sort()).toEqual([
      'animation-clip/limb',
      'mesh/limb.arm',
      'mesh/limb.wall',
      'scene/limb',
    ]);
    const scene = out.value['scene/limb'] as SceneAsset;
    expect(Object.keys(scene.entities)).toEqual([
      'rig',
      'joint.root',
      'joint.hinge',
      'part.wall',
      'part.arm',
    ]);
    expect(scene.entities['part.arm']?.components).toMatchObject({
      ChildOf: { parent: 'joint.hinge' },
      MeshFilter: { assetHandle: guid('mesh/limb.arm') },
    });
    expect(scene.entities.rig?.components.AnimationPlayer).toMatchObject({
      clips: [guid('animation-clip/limb')],
    });
    const clip = out.value['animation-clip/limb'];
    if (clip?.kind !== 'animation-clip') throw new Error('clip');
    expect(clip.duration).toBe(2);
    expect(clip.channels.map((c) => c.property)).toEqual(['rotation']);
    const sampler =
      clip.channels[0]?.property === 'rotation' ? clip.channels[0].sampler : undefined;
    expect(sampler?.input).toHaveLength(21);
    const last = Array.from((sampler?.output as Float32Array).slice(-4));
    expect(last[2]).toBeCloseTo(Math.sin(Math.PI / 6), 6);
    expect(last[3]).toBeCloseTo(Math.cos(Math.PI / 6), 6);
  });

  it('writes several named clips with a loop flag each', () => {
    const { r } = hinged();
    const back = {
      keys: [
        { u: 0, pose: { hinge: 60 } },
        { u: 1, pose: { hinge: 0 } },
      ],
    };
    const clips = [
      { name: 'open', path, duration: 2, frameRate: 10 },
      { name: 'close', path: back, duration: 1, frameRate: 10, loop: true },
    ];
    const out = r.finish({ key: 'limb', packageId: packageId.value, clips });
    if (!out.ok) throw out.error;
    expect(Object.keys(out.value).sort()).toEqual([
      'animation-clip/limb/close',
      'animation-clip/limb/open',
      'mesh/limb.arm',
      'mesh/limb.wall',
      'scene/limb',
    ]);
    const keys = r.outputKeys({ key: 'limb', clips });
    expect(keys.ok && keys.value).toEqual(Object.keys(out.value).sort());
    expect((out.value['animation-clip/limb/open'] as AnimationClip).duration).toBe(2);
    expect((out.value['animation-clip/limb/close'] as AnimationClip).duration).toBe(1);
    expect(r.exportedClips).toEqual([
      { name: 'open', key: 'animation-clip/limb/open', loop: false, duration: 2, frames: 21 },
      { name: 'close', key: 'animation-clip/limb/close', loop: true, duration: 1, frames: 11 },
    ]);
    const scene = out.value['scene/limb'] as SceneAsset;
    expect(scene.entities.rig?.components.AnimationPlayer).toMatchObject({
      clips: [guid('animation-clip/limb/open'), guid('animation-clip/limb/close')],
      weights: [1, 0],
      looping: false,
    });
  });

  it('rejects duplicate or invalid clip names and path together with clips', () => {
    const { r } = hinged();
    const base = { key: 'limb', packageId: packageId.value };
    const clip = (name: string) => ({ name, path, duration: 1 });
    const dup = r.finish({ ...base, clips: [clip('a'), clip('a')] });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe('model-invalid-argument');
    for (const name of ['', 'A b', 'x/y'])
      expect(r.finish({ ...base, clips: [clip(name)] }).ok).toBe(false);
    const both = r.finish({ ...base, path, clips: [clip('a')] });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error.hint).toBeDefined();
    expect(r.finish({ ...base, clips: [{ ...clip('a'), duration: 0 }] }).ok).toBe(false);
  });

  it('exports single-influence skinning with a skeleton and skin', () => {
    const { r } = hinged();
    const out = r.finish({ key: 'limb', packageId: packageId.value, form: 'skinned' });
    if (!out.ok) throw out.error;
    expect(Object.keys(out.value).sort()).toEqual([
      'mesh/limb',
      'scene/limb',
      'skeleton/limb',
      'skin/limb',
    ]);
    const mesh = out.value['mesh/limb'] as MeshAsset;
    const joints = mesh.attributes.skinIndex as Uint16Array;
    const weights = mesh.attributes.skinWeight as Float32Array;
    const position = mesh.attributes.position as Float32Array;
    for (let v = 0; v < position.length / 3; v++) {
      expect(weights[v * 4]).toBe(1);
      expect(joints[v * 4]).toBe((position[v * 3 + 1] as number) > -0.25 ? 1 : 0);
    }
    expect(out.value['skin/limb']).toEqual({
      kind: 'skin',
      skeletonGuid: guid('skeleton/limb'),
      jointPaths: ['limb/root', 'limb/root/hinge'],
    });
    expect((out.value['scene/limb'] as SceneAsset).skinGuids).toEqual([guid('skin/limb')]);
  });

  it('selects a part with partFaces and records what finish exported', () => {
    const { m, r } = hinged();
    const wall = r.partFaces('wall');
    if (!wall.ok) throw wall.error;
    expect(m.count(wall.value)).toBe(6);
    expect(r.partFaces('nose').ok).toBe(false);
    expect(r.output).toBeUndefined();
    expect(r.finish({ key: 'limb', packageId: packageId.value, path }).ok).toBe(true);
    expect(r.output).toBe('scene/limb');
    expect(r.path).toBe(path);
  });

  it('rejects a bad key and is captured with its sessions', async () => {
    const { r } = hinged();
    expect(r.finish({ key: 'Limb', packageId: packageId.value }).ok).toBe(false);
    const captured = await captureModels(() => hinged().r);
    if (!captured.ok) throw captured.error;
    expect(captured.value.rigs).toHaveLength(1);
    expect(captured.value.sessions).toHaveLength(1);
  });

  it('keeps part meshes at the joint origin', () => {
    const m = model();
    m.box({ size: [0.2, 0.2, 0.2], center: [2, 1, 0], label: 'tip' });
    m.uv.project({ mode: 'box', scale: 0.5 });
    const r = rig(m, {
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        {
          name: 'tip',
          parent: 'root',
          position: [2, 1, 0],
          rotation: { z: 90 },
          kind: 'revolute',
          axis: 'x',
        },
      ],
    });
    r.bindRigid(sel.all(), 'tip');
    const out = r.finish({ key: 'tip', packageId: packageId.value });
    if (!out.ok) throw out.error;
    const aabb = Array.from((out.value['mesh/tip.tip'] as MeshAsset).aabb as Float32Array);
    for (const v of aabb) expect(Math.abs(v)).toBeCloseTo(0.1, 6);
    const rest = r.joints.find((j) => j.name === 'tip')?.rest as number[];
    expect(applyPoint(rest, [1, 0, 0]).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([2, 2, 0]);
  });
});
