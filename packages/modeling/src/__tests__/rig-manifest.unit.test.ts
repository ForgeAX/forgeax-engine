import { definePackageId } from '@forgeax/engine-pack/source';
import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { recipes } from '../recipes';
import { type JointSpec, type Pose, type Rig, rig } from '../rig';
import {
  poseRigManifest,
  type RigManifest,
  readRigManifest,
  rigManifestJson,
} from '../rig-manifest';
import { sel } from '../selectors';

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw r.error as Error;
  return r.value;
};

const rev = (name: string, extra: Partial<JointSpec> = {}): JointSpec => ({
  name,
  parent: 'frame',
  position: [0, 0, 0],
  kind: 'revolute',
  axis: 'z',
  ...extra,
});

/** A mechanism touching every field: fixed root, revolute crank with stops, prismatic slider, a gear pair, a spherical joint. */
function mechanism(): Rig {
  const m = model();
  m.box({ size: [0.2, 0.1, 0.1], center: [0, 0, 0], label: 'frame-body', material: 'paint' });
  const r = rig(m, {
    joints: [
      { name: 'frame', parent: null, position: [0, 0, 0] },
      rev('crank', {
        position: [0.1, 0, 0],
        axis: 'y',
        limits: [-30, 60],
        stops: { min: { stop: 'frame' }, max: { stop: 'frame', against: 'crank' } },
      }),
      {
        name: 'slider',
        parent: 'frame',
        position: [0, 0.2, 0],
        kind: 'prismatic',
        axis: 'x',
        limits: [0, 0.05],
      },
      rev('gear', { position: [0.3, 0, 0], mimic: { joint: 'crank', ratio: -2, offset: 5 } }),
      {
        name: 'ball',
        parent: 'frame',
        position: [0, 0, 0.3],
        kind: 'spherical',
        limits: { x: [-20, 20], y: [-45, 45], z: [-10, 10] },
      },
    ],
  });
  r.bindRigid(sel.all(), 'frame', { part: 'body' });
  return r;
}

const POSES: readonly Pose[] = [
  {},
  { crank: 20 },
  { crank: -25, slider: 0.02 },
  { crank: 55, slider: 0.05, ball: { x: 10, y: -30, z: 5 } },
  { ball: { x: -15, y: 40, z: -8 } },
];

describe('rig manifest: content', () => {
  it('describes the joint table in declaration order with the schema tag and units', () => {
    const r = mechanism();
    const m = ok(r.manifest());
    expect(m.schema).toBe('forgeax.rig-manifest/1');
    expect(m.units).toEqual({ length: 'm', angle: 'deg' });
    expect(m.key).toBeUndefined();
    expect(m.joints.map((j) => j.name)).toEqual(['frame', 'crank', 'slider', 'gear', 'ball']);
    const crank = m.joints.find((j) => j.name === 'crank');
    expect(crank?.kind).toBe('revolute');
    expect(crank?.axis).toEqual([0, 1, 0]);
    expect(crank?.limits).toEqual([-30, 60]);
    expect(crank?.stops).toEqual({
      min: { stop: 'frame' },
      max: { stop: 'frame', against: 'crank' },
    });
    expect(crank?.driven).toBe(true);
  });

  it('records followers with their declared and composed root relation', () => {
    const m = ok(mechanism().manifest());
    const gear = m.joints.find((j) => j.name === 'gear');
    expect(gear?.driven).toBe(false);
    expect(gear?.mimic).toEqual({ joint: 'crank', ratio: -2, offset: 5 });
    expect(gear?.leader).toEqual({ joint: 'crank', ratio: -2, offset: 5 });
  });

  it('exports the rest transform in model space and the rest-relative local transform', () => {
    const r = mechanism();
    const m = ok(r.manifest());
    const slider = m.joints.find((j) => j.name === 'slider');
    expect(slider?.restLocal.position).toEqual([0, 0.2, 0]);
    expect(slider?.rest.position).toEqual([0, 0.2, 0]);
    expect(slider?.rest.rotation).toEqual([0, 0, 0, 1]);
    const crank = m.joints.find((j) => j.name === 'crank');
    expect(crank?.rest.position).toEqual([0.1, 0, 0]);
  });

  it('lists each rigid part with its bound joint', () => {
    const m = ok(mechanism().manifest());
    expect(m.parts).toEqual([{ name: 'body', joint: 'frame', skinned: false }]);
  });

  it('reports the finished output keys once finish() has run', () => {
    const r = mechanism();
    const m0 = ok(r.manifest());
    expect(m0.key).toBeUndefined();
    const m2 = model();
    m2.box({ size: [0.1, 0.1, 0.1], center: [0, 0, 0], label: 'body', material: 'paint' });
    m2.uv.project({ mode: 'box', scale: 0.1 });
    const r2 = rig(m2, {
      joints: [{ name: 'root', parent: null, position: [0, 0, 0] }],
    });
    r2.bindRigid(sel.all(), 'root', { part: 'base' });
    ok(
      r2.finish({
        key: 'arm',
        packageId: definePackageId('01900000-0000-7000-8000-0000000c7001'),
      }),
    );
    const m = ok(r2.manifest());
    expect(m.key).toBe('arm');
    expect(m.parts).toEqual([
      { name: 'base', joint: 'root', skinned: false, sourceKey: 'mesh/arm.base' },
    ]);
  });
});

describe('rig manifest: JSON', () => {
  it('serialises deterministically: the same rig gives the same bytes', () => {
    const a = rigManifestJson(ok(mechanism().manifest()));
    const b = rigManifestJson(ok(mechanism().manifest()));
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
  });

  it('round-trips through JSON.parse and the reader', () => {
    const m = ok(mechanism().manifest());
    const text = rigManifestJson(m);
    const back = ok(readRigManifest(JSON.parse(text)));
    expect(rigManifestJson(back)).toBe(text);
  });

  it('sorts object keys and rounds numbers to 1e-9', () => {
    const sorted = model();
    sorted.box({ size: [0.1, 0.1, 0.1], center: [0, 0, 0], label: 'body', material: 'paint' });
    const r = rig(sorted, {
      joints: [
        { name: 'root', parent: null, position: [1 / 3, 0, 0] },
        rev('arm', { parent: 'root', position: [0, 0, 0] }),
      ],
    });
    r.bindRigid(sel.all(), 'root', { part: 'body' });
    const text = rigManifestJson(ok(r.manifest()));
    expect(text).toContain('0.333333333');
    expect(text).not.toContain('0.3333333333');
    const parsed = JSON.parse(text) as { joints: Record<string, unknown>[] };
    const firstKeys = Object.keys(parsed.joints[0] as Record<string, unknown>);
    expect(firstKeys).toEqual([...firstKeys].sort());
    expect(text.indexOf('"driven"')).toBeLessThan(text.indexOf('"name"'));
  });
});

describe('rig manifest: poses agree with Rig.pose', () => {
  for (const [i, pose] of POSES.entries()) {
    it(`pose ${i} matches the Rig to 1e-9 in memory`, () => {
      const r = mechanism();
      const manifest = ok(r.manifest());
      const evaluated = ok(poseRigManifest(manifest, toTuples(pose)));
      const rigPose = ok(r.pose(pose));
      for (const j of rigPose.joints) {
        const mine = evaluated.joints[j.name] as number[];
        const want = mineToColumnMajor(j.world);
        for (let k = 0; k < 16; k++) {
          expect(Math.abs((mine[k] as number) - (want[k] as number))).toBeLessThan(1e-9);
        }
      }
    });
  }

  it('a JSON round trip poses the same joints to about 1e-8', () => {
    const r = mechanism();
    const manifest = ok(readRigManifest(JSON.parse(rigManifestJson(ok(r.manifest())))));
    const evaluated = ok(poseRigManifest(manifest, { crank: 55, slider: 0.05 }));
    const rigPose = ok(r.pose({ crank: 55, slider: 0.05 }));
    for (const j of rigPose.joints) {
      const mine = evaluated.joints[j.name] as number[];
      const want = mineToColumnMajor(j.world);
      for (let k = 0; k < 16; k++) {
        expect(Math.abs((mine[k] as number) - (want[k] as number))).toBeLessThan(1e-8);
      }
    }
  });

  it('a follower takes its leader value through the relation', () => {
    const r = mechanism();
    const manifest = ok(r.manifest());
    const gearJoint = ok(r.pose({ crank: 20 })).joints.find((j) => j.name === 'gear');
    expect(gearJoint?.value).toBe(-35);
    const evaluated = ok(poseRigManifest(manifest, { crank: 20 }));
    const direct = ok(poseRigManifest(manifest, { crank: 20 }));
    expect(evaluated.joints.gear).toEqual(direct.joints.gear);
    const want = mineToColumnMajor(
      ok(r.pose({ crank: 20 })).joints.find((j) => j.name === 'gear')?.world as number[],
    );
    for (let k = 0; k < 16; k++) {
      expect(
        Math.abs((evaluated.joints.gear as number[])[k] as number) - Math.abs(want[k] as number),
      ).toBeLessThan(1e-9);
    }
  });

  it('a rigid part reports its joint transform', () => {
    const evaluated = ok(poseRigManifest(ok(mechanism().manifest()), { crank: 10 }));
    expect(evaluated.parts.body).toEqual(evaluated.joints.frame);
  });
});

describe('rig manifest: pose errors and clamping', () => {
  const manifest = (): RigManifest => ok(mechanism().manifest());

  it('rejects an out-of-range value and names its range', () => {
    const e = poseRigManifest(manifest(), { crank: 90 });
    expect(e.ok).toBe(false);
    if (e.ok) return;
    expect(e.error.code).toBe('pose-out-of-range');
    expect(e.error.detail).toMatchObject({ joint: 'crank', requested: 90, range: [-30, 60] });
  });

  it('clamps to the nearest limit and reports the clamp when asked', () => {
    const p = ok(poseRigManifest(manifest(), { crank: 90 }, { clamp: true }));
    expect(p.clamped).toEqual([{ joint: 'crank', requested: 90, applied: 60 }]);
    const same = ok(poseRigManifest(manifest(), { crank: 60 }, { clamp: true }));
    expect(same.clamped).toEqual([]);
  });

  it('rejects an unknown joint name', () => {
    const e = poseRigManifest(manifest(), { nope: 1 });
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error.code).toBe('pose-unknown-joint');
  });

  it('rejects a value for a fixed joint', () => {
    const e = poseRigManifest(manifest(), { frame: 1 });
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error.code).toBe('pose-fixed-joint');
  });

  it('rejects naming a follower instead of its leader', () => {
    const e = poseRigManifest(manifest(), { gear: 10 });
    expect(e.ok).toBe(false);
    if (!e.ok) {
      expect(e.error.code).toBe('pose-follower-driven');
      expect(e.error.detail).toMatchObject({ joint: 'gear', leader: 'crank' });
    }
  });

  it('rejects a value of the wrong shape', () => {
    const e = poseRigManifest(manifest(), { crank: [1, 2, 3] as unknown as number });
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error.code).toBe('pose-value-shape');
  });
});

describe('rig manifest: reader rejects invalid documents', () => {
  const good = () =>
    JSON.parse(rigManifestJson(ok(mechanism().manifest()))) as Record<string, unknown>;
  const codes = (value: unknown): string[] => {
    const r = readRigManifest(value);
    if (r.ok) return [];
    return r.error.detail.issues.map((i) => i.code);
  };

  it('accepts the generated document', () => {
    expect(codes(good())).toEqual([]);
  });

  it('rejects a non-object document', () => {
    expect(codes(null)).toEqual(['manifest-wrong-type']);
  });

  it('rejects a wrong schema tag', () => {
    expect(codes({ ...good(), schema: 'forgeax.rig-manifest/2' })).toContain('manifest-schema');
  });

  it('rejects an unknown top-level field', () => {
    expect(codes({ ...good(), extra: true })).toContain('manifest-unknown-field');
  });

  it('rejects a changed unit', () => {
    expect(codes({ ...good(), units: { length: 'cm', angle: 'deg' } })).toContain('manifest-units');
  });

  it('rejects a revolute joint whose axis is not a unit vector', () => {
    const doc = good() as { joints: { name: string; axis?: number[] }[] };
    const crank = doc.joints.find((j) => j.name === 'crank');
    if (crank) crank.axis = [0, 2, 0];
    expect(codes(doc)).toContain('manifest-axis');
  });

  it('rejects a follower whose leader is itself a follower', () => {
    const doc = good() as { joints: { name: string; leader?: { joint: string } }[] };
    const gear = doc.joints.find((j) => j.name === 'gear');
    if (gear?.leader) gear.leader.joint = 'gear';
    expect(codes(doc)).toContain('manifest-leader');
  });

  it('rejects a transform that is not parent.rest * restLocal', () => {
    const doc = good() as { joints: { name: string; rest: { position: number[] } }[] };
    const slider = doc.joints.find((j) => j.name === 'slider');
    if (slider) slider.rest.position = [0, 9, 0];
    expect(codes(doc)).toContain('manifest-transform');
  });
});

describe('rig manifest: mutants', () => {
  const codes = (mutate: (d: Record<string, unknown>) => void): string[] => {
    const d = JSON.parse(rigManifestJson(ok(mechanism().manifest()))) as Record<string, unknown>;
    mutate(d);
    const r = readRigManifest(d);
    return r.ok ? [] : r.error.detail.issues.map((i) => i.code);
  };
  const withBadPart = (part: Record<string, unknown>) =>
    codes((d) => {
      (d.parts as Record<string, unknown>[]).push(part);
    });
  type J = { name: string } & Record<string, unknown>;
  const joint = (d: Record<string, unknown>, name: string): J =>
    (d.joints as J[]).find((j) => j.name === name) as J;

  it('driven flag contradicts the kind', () => {
    expect(codes((d) => (joint(d, 'frame').driven = true))).toContain('manifest-driven');
  });

  it('a stop on a fixed joint', () => {
    expect(codes((d) => (joint(d, 'frame').stops = { min: { stop: 'x' } }))).toContain(
      'manifest-stops',
    );
  });

  it('limits out of order', () => {
    expect(codes((d) => (joint(d, 'crank').limits = [60, -30]))).toContain('manifest-limits');
  });

  it('a reach outside the limits', () => {
    expect(codes((d) => (joint(d, 'crank').reach = [-40, 10]))).toContain('manifest-reach');
  });

  it('a parent that is listed after its child', () => {
    expect(codes((d) => (joint(d, 'crank').parent = 'ball'))).toContain('manifest-parent-order');
  });

  it('a duplicate joint name', () => {
    expect(codes((d) => (joint(d, 'ball').name = 'crank'))).toContain('manifest-joint-name');
  });

  it('a part bound to a joint that does not exist', () => {
    expect(withBadPart({ name: 'p', joint: 'missing', skinned: false })).toContain(
      'manifest-part-joint',
    );
  });

  it('a source key that does not match its part', () => {
    expect(
      codes((d) => {
        d.key = 'arm';
        (d.parts as Record<string, unknown>[])[0] = {
          name: 'body',
          joint: 'frame',
          skinned: false,
          sourceKey: 'mesh/other.body',
        };
      }),
    ).toContain('manifest-part-source');
  });

  it('an unknown key in a joint', () => {
    expect(codes((d) => (joint(d, 'crank').extra = 1))).toContain('manifest-unknown-field');
  });

  it('a non-finite transform component', () => {
    expect(
      codes((d) => ((joint(d, 'slider').rest as Record<string, unknown>).position = [0, 'x', 0])),
    ).toContain('manifest-transform');
  });
});

describe('rig manifest: determinism and loops', () => {
  it('refuses a rig with closed loops', () => {
    const lm = model();
    lm.box({ size: [0.1, 0.1, 0.1], center: [0, 0, 0], label: 'body', material: 'paint' });
    const loopRig = rig(lm, {
      joints: [
        { name: 'frame', parent: null, position: [0, 0, 0] },
        rev('a', { parent: 'frame' }),
        rev('b', { parent: 'frame', position: [0.1, 0, 0] }),
      ],
      loops: [{ name: 'l', a: 'a', b: 'b', kind: 'pin', at: [0.1, 0.05, 0], axis: 'z' }],
    });
    loopRig.bindRigid(sel.all(), 'frame', { part: 'body' });
    const r = loopRig.manifest();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
  });

  it('a recipe hinge with a gear pair produces a valid document', () => {
    const h = recipes.hinge({
      length: 0.24,
      leafWidth: 0.06,
      thickness: 0.006,
      pin: 0.012,
      knuckles: 5,
      holes: 2,
      name: 'fh',
    });
    if (!h.ok) throw h.error;
    const m = model();
    m.append(h.value.model, { tag: 'fh' });
    const r = rig(m, {
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        rev('pin', { parent: 'root', position: [0.02, 0, 0] }),
        rev('gear', {
          parent: 'root',
          position: [0.04, 0, 0],
          mimic: { joint: 'pin', ratio: 1.5 },
        }),
      ],
    });
    r.bindRigid(sel.all(), 'root', { part: 'base' });
    r.bindRigid(sel.tag('fh-b'), 'pin', { part: 'leaf' });
    const doc = ok(r.manifest());
    expect(ok(readRigManifest(JSON.parse(rigManifestJson(doc))))).toBeDefined();
    expect(doc.parts.map((p) => p.name)).toEqual(['base', 'leaf']);
  });
});

/** The manifest takes spherical values as [x, y, z] tuples; Rig.pose takes { x?, y?, z? } objects. */
function toTuples(pose: Pose): Record<string, number | [number, number, number]> {
  const out: Record<string, number | [number, number, number]> = {};
  for (const [name, value] of Object.entries(pose)) {
    if (typeof value === 'number') {
      out[name] = value;
    } else if (value !== undefined) {
      out[name] = [value.x ?? 0, value.y ?? 0, value.z ?? 0];
    }
  }
  return out;
}

function mineToColumnMajor(world: readonly number[]): number[] {
  const m = world;
  return [
    m[0] as number,
    m[4] as number,
    m[8] as number,
    0,
    m[1] as number,
    m[5] as number,
    m[9] as number,
    0,
    m[2] as number,
    m[6] as number,
    m[10] as number,
    0,
    m[3] as number,
    m[7] as number,
    m[11] as number,
    1,
  ];
}
