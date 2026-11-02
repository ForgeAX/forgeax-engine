import { describe, expect, it } from 'vitest';
import { type Model, model } from '../model';
import { rig } from '../rig';
import { sel } from '../selectors';

/** A 10 cm base on the root, an arm on a revolute elbow `gap` m off the base's +x face. */
function arm(gap: number, extra?: (m: Model) => void) {
  const m = model();
  m.box({ size: [0.1, 0.1, 0.1], tag: 'base' });
  m.box({ size: [0.3, 0.05, 0.05], center: [0.05 + gap + 0.15, 0, 0], tag: 'arm' });
  extra?.(m);
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      { name: 'elbow', parent: 'root', position: [0.05, 0, 0], kind: 'revolute', axis: 'z' },
      { name: 'wrist', parent: 'elbow', position: [0.35, 0, 0], kind: 'revolute', axis: 'z' },
    ],
  });
  r.bindRigid(sel.tag('base'), 'root', { part: 'base' });
  r.bindRigid(sel.tag('arm'), 'elbow', { part: 'arm' });
  return { m, r };
}

describe('rig.connectivity (F1 criterion 13)', () => {
  it('across a joint only hardware connects: a flush child without it floats', () => {
    const { r } = arm(0);
    const report = r.connectivity([{}]);
    if (!report.ok) throw report.error;
    expect(report.value).toMatchObject({ attached: false, roots: ['base'], floating: ['arm'] });
    expect(report.value.poses[0]).toMatchObject({ detached: [['arm']], unlinked: ['elbow'] });
    // Counting every part as hardware, the touch alone connects.
    const all = r.connectivity([{}], { hardware: () => true });
    if (!all.ok) throw all.error;
    expect(all.value).toMatchObject({ attached: true, floating: [] });
    expect(all.value.poses[0]?.unlinked).toEqual([]);
  });

  it('a gap above 0.5 mm floats, with the nearest part it may attach to', () => {
    const { r } = arm(0.01);
    const hardware = () => true;
    const report = r.connectivity([{}], { hardware });
    if (!report.ok) throw report.error;
    expect(report.value.attached).toBe(false);
    const [floating] = report.value.poses[0]?.floating ?? [];
    expect(floating).toMatchObject({ part: 'arm', joint: 'elbow', nearest: { part: 'base' } });
    expect(floating?.nearest?.distance).toBeCloseTo(0.01, 6);
    // Within the gap: 0.4 mm still touches; the gap is an option.
    const near = arm(0.0004).r.connectivity([{}], { hardware });
    expect(near.ok && near.value.attached).toBe(true);
    const loose = arm(0.01).r.connectivity([{}], { gap: 0.02, hardware });
    expect(loose.ok && loose.value.attached).toBe(true);
  });

  it('hardware bound to either side bridges the joint', () => {
    // A bracket on the elbow from the base face to the arm closes the 1 cm gap.
    const { r } = arm(0.01, (m) =>
      m.box({ size: [0.012, 0.02, 0.02], center: [0.056, 0, 0], tag: 'bracket' }),
    );
    r.bindRigid(sel.tag('bracket'), 'elbow', { part: 'mount-elbow' });
    const report = r.connectivity([{}]);
    if (!report.ok) throw report.error;
    expect(report.value.floating).toEqual([]);
  });

  it('checks every pose: a part lifted off its support floats there only', () => {
    // The slider rests on the base's top face; a prismatic joint lifts it 1 cm.
    const m = model();
    m.box({ size: [0.1, 0.1, 0.1], tag: 'base' });
    m.box({ size: [0.05, 0.02, 0.05], center: [0, 0.06, 0], tag: 'slider' });
    const r = rig(m, {
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        { name: 'lift', parent: 'root', position: [0, 0.05, 0], kind: 'prismatic', axis: 'y' },
      ],
    });
    r.bindRigid(sel.tag('base'), 'root', { part: 'base' });
    r.bindRigid(sel.tag('slider'), 'lift', { part: 'slider' });
    const report = r.connectivity([{}, { lift: 0.01 }], { hardware: () => true });
    if (!report.ok) throw report.error;
    expect(report.value.poses.map((p) => p.floating.map((f) => f.part))).toEqual([[], ['slider']]);
    expect(report.value.poses[1]?.floating[0]?.nearest?.distance).toBeCloseTo(0.01, 6);
    expect(report.value.floating).toEqual(['slider']);
  });

  it('only kinematic neighbours connect: a grandchild touching the root part floats', () => {
    // The hand (wrist joint) sits on the base, far from its parent arm.
    const { r } = arm(0, (m) =>
      m.box({ size: [0.02, 0.02, 0.02], center: [0, 0.06, 0], tag: 'hand' }),
    );
    r.bindRigid(sel.tag('hand'), 'wrist', { part: 'hand' });
    const report = r.connectivity([{}], { hardware: () => true });
    if (!report.ok) throw report.error;
    expect(report.value.floating).toEqual(['hand']);
    // A part of the arm's joint that touches nothing floats too.
    const loose = arm(0, (m) =>
      m.box({ size: [0.02, 0.02, 0.02], center: [0.2, 0.3, 0], tag: 'badge' }),
    );
    loose.r.bindRigid(sel.tag('badge'), 'elbow', { part: 'badge' });
    const looseReport = loose.r.connectivity([{}], { hardware: () => true });
    expect(looseReport.ok && looseReport.value.floating).toEqual(['badge']);
  });

  it('a part enclosed by its neighbour counts as touching; bad input is rejected', () => {
    const { r } = arm(0, (m) =>
      m.box({ size: [0.02, 0.02, 0.02], center: [0.2, 0, 0], tag: 'pin' }),
    );
    r.bindRigid(sel.tag('pin'), 'elbow', { part: 'pin' });
    // The pin's box lies inside the arm: no surface within 0.5 mm, but enclosed.
    const report = r.connectivity([{}], { hardware: () => true });
    if (!report.ok) throw report.error;
    expect(report.value.floating).toEqual([]);
    expect(r.connectivity([]).ok).toBe(false);
    expect(r.connectivity([{}], { gap: -1 }).ok).toBe(false);
  });
});

describe('rig.mountHardware (F1 criterion 13)', () => {
  const sweep = (joint: string, values: readonly number[]) => ({
    keys: values.map((v, i) => ({ u: i / (values.length - 1), pose: { [joint]: v } })),
  });

  it('hinges a revolute arm to its base: attached in every pose, scan clear', () => {
    const { m, r } = arm(0.01);
    const report = r.mountHardware({ metal: 'gt-metal', frame: 'gt-frame' });
    expect(report.status, JSON.stringify(report.error)).toBe('ok');
    expect(report.joints.map((j) => [j.joint, j.element, j.part])).toEqual([
      ['root', undefined, 'mount-root'],
      ['elbow', 'hinge', 'mount-elbow'],
    ]);
    expect(report.pieces).toBeGreaterThan(0);
    expect([report.embedded, report.unroutable]).toEqual([0, []]);
    expect(m.count(sel.tag('hardware:elbow'))).toBeGreaterThan(0);
    // The arm clears the base only within about 20 degrees.
    const poses = [-20, -10, 0, 10, 20].map((elbow) => ({ elbow }));
    const report13 = r.connectivity(poses);
    if (!report13.ok) throw report13.error;
    expect(report13.value.floating).toEqual([]);
    const scan = r.scan(sweep('elbow', [-20, 20]), { step: 0.1 });
    if (!scan.ok) throw scan.error;
    expect(
      scan.value.pairs
        .filter((p) => p.status === 'confirmed')
        .map((p) => `${p.parts.join(' / ')} ${p.maxDepth.toFixed(5)} @${p.firstConfirmed}`),
    ).toEqual([]);
    expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('mounts a spherical joint with a ball in a ring and a prismatic one with a rail', () => {
    const m = model();
    m.box({ size: [0.1, 0.1, 0.1], tag: 'base' });
    m.box({ size: [0.05, 0.2, 0.05], center: [0, 0.2, 0], tag: 'neck' });
    m.box({ size: [0.04, 0.04, 0.04], center: [0.15, 0, 0], tag: 'slider' });
    const r = rig(m, {
      joints: [
        { name: 'root', parent: null, position: [0, 0, 0] },
        {
          name: 'ball',
          parent: 'root',
          position: [0, 0.08, 0],
          kind: 'spherical',
          limits: { x: [-30, 30], z: [-30, 30] },
        },
        {
          name: 'slide',
          parent: 'root',
          position: [0.1, 0, 0],
          kind: 'prismatic',
          axis: 'x',
          limits: [0, 0.05],
        },
      ],
    });
    r.bindRigid(sel.tag('base'), 'root', { part: 'base' });
    r.bindRigid(sel.tag('neck'), 'ball', { part: 'neck' });
    r.bindRigid(sel.tag('slider'), 'slide', { part: 'slider' });
    const report = r.mountHardware();
    expect(report.status, JSON.stringify(report.error)).toBe('ok');
    expect(report.unroutable).toEqual([]);
    expect(report.joints.map((j) => j.element)).toEqual([undefined, 'ball', 'slide']);
    const poses = [{}, { ball: { x: 30 }, slide: 0.05 }, { ball: { z: -30 }, slide: 0.025 }];
    const report13 = r.connectivity(poses);
    if (!report13.ok) throw report13.error;
    expect(report13.value.floating).toEqual([]);
    const scan = r.scan(
      {
        keys: [
          { u: 0, pose: {} },
          { u: 1, pose: { ball: { x: 30, z: 30 }, slide: 0.05 } },
        ],
      },
      { step: 0.1 },
    );
    if (!scan.ok) throw scan.error;
    expect(
      scan.value.pairs
        .filter((p) => p.status === 'confirmed')
        .map((p) => `${p.parts.join(' / ')} ${p.maxDepth.toFixed(5)} @${p.firstConfirmed}`),
    ).toEqual([]);
  });

  it('joins separate parts of one joint with standoffs, and seats nothing twice', () => {
    // A badge on the arm's joint, 2.5 cm above the arm.
    const { r } = arm(0.01, (m) =>
      m.box({ size: [0.02, 0.02, 0.02], center: [0.2, 0.06, 0], tag: 'badge' }),
    );
    r.bindRigid(sel.tag('badge'), 'elbow', { part: 'badge' });
    const report = r.mountHardware();
    expect(report.status).toBe('ok');
    expect(report.joints.find((j) => j.joint === 'elbow')?.standoffs).toBe(1);
    const report13 = r.connectivity([{}]);
    expect(report13.ok && report13.value.floating).toEqual([]);
  });
});

describe('criterion 13 options', () => {
  it('roots seed the connection; joints above them need no crossing', () => {
    // A stand joint above the structure's root carries a pedestal that touches nothing.
    const m = model();
    m.box({ size: [0.1, 0.02, 0.1], center: [0, -0.5, 0], tag: 'pedestal' });
    m.box({ size: [0.1, 0.1, 0.1], tag: 'base' });
    const r = rig(m, {
      joints: [
        { name: 'stand', parent: null, position: [0, -0.5, 0] },
        {
          name: 'body',
          parent: 'stand',
          position: [0, 0, 0],
          kind: 'prismatic',
          axis: 'y',
          limits: [0, 1],
        },
      ],
    });
    r.bindRigid(sel.tag('pedestal'), 'stand', { part: 'pedestal' });
    r.bindRigid(sel.tag('base'), 'body', { part: 'base' });
    const fromStand = r.connectivity([{}]);
    expect(fromStand.ok && fromStand.value.floating).toEqual(['base']);
    const fromBody = r.connectivity([{}], { roots: ['body'] });
    if (!fromBody.ok) throw fromBody.error;
    expect(fromBody.value).toMatchObject({ roots: ['pedestal', 'base'], floating: [] });
    expect(fromBody.value.poses[0]?.unlinked).toEqual([]);
    expect(r.connectivity([{}], { roots: ['nope'] }).ok).toBe(false);
    // With the same roots, mountHardware leaves the stand alone.
    const report = r.mountHardware({ roots: ['body'] });
    expect(report.status).toBe('ok');
    expect(report.pieces).toBe(0);
  });

  it('keeps existing hardware: a joint it already links gets no element; hardware has UVs', () => {
    const { m, r } = arm(0.01, (mm) =>
      mm.box({ size: [0.012, 0.02, 0.02], center: [0.056, 0, 0], tag: 'bracket' }),
    );
    r.bindRigid(sel.tag('bracket'), 'elbow', { part: 'hinge-elbow' });
    const report = r.mountHardware({
      hardware: (p) => p.startsWith('hinge-') || p.startsWith('mount-'),
    });
    expect(report.status).toBe('ok');
    expect(report.joints.find((j) => j.joint === 'elbow')?.element).toBeUndefined();
    // A joint without an existing link gets one, and its pieces carry UVs for export.
    const fresh = arm(0.01);
    expect(fresh.r.mountHardware().status).toBe('ok');
    const mesh = fresh.m.editMesh;
    const faces = sel.tag('hardware:elbow').evaluate(mesh);
    expect(faces.length).toBeGreaterThan(0);
    expect(
      faces.every((f) => mesh.faceHalves(f).every((h) => mesh.corner('uv0', h) !== undefined)),
    ).toBe(true);
    expect(m.poisoned).toBeUndefined();
  });
});

describe('mountHardware poses', () => {
  /** The arm fixture plus a gate block above, on a joint that drops it by `drop` m. */
  function gated(at: readonly [number, number] | undefined) {
    const { m, r } = arm(0.01, (mm) => {
      if (at !== undefined) {
        mm.box({ size: [0.06, 0.02, 0.06], center: [at[0], 0.5, at[1]], tag: 'gate' });
      }
    });
    return { m, r };
  }
  it('keeps hardware clear of parts that sweep through its rest spot in other poses', () => {
    // Where the elbow hardware lands without a gate.
    const plain = gated(undefined);
    expect(plain.r.mountHardware().status).toBe('ok');
    const mesh = plain.m.editMesh;
    const xs: number[] = [];
    const zs: number[] = [];
    for (const f of sel.tag('hardware:elbow').evaluate(mesh)) {
      for (const v of mesh.faceVertices(f)) {
        const [x, , z] = mesh.position(v);
        xs.push(x);
        zs.push(z);
      }
    }
    const spot = [
      (Math.min(...xs) + Math.max(...xs)) / 2,
      (Math.min(...zs) + Math.max(...zs)) / 2,
    ] as const;
    const build = (poses: boolean) => {
      const g = gated(spot);
      const rr = rig(g.m, {
        joints: [
          { name: 'root', parent: null, position: [0, 0, 0] },
          { name: 'elbow', parent: 'root', position: [0.05, 0, 0], kind: 'revolute', axis: 'z' },
          {
            name: 'drop',
            parent: 'root',
            position: [0, 0.5, 0],
            kind: 'prismatic',
            axis: 'y',
            limits: [-0.5, 0],
          },
        ],
      });
      rr.bindRigid(sel.tag('base'), 'root', { part: 'base' });
      rr.bindRigid(sel.tag('arm'), 'elbow', { part: 'arm' });
      rr.bindRigid(sel.tag('gate'), 'drop', { part: 'gate' });
      const report = rr.mountHardware(poses ? { poses: [{ drop: -0.5 }] } : {});
      expect(report.status).toBe('ok');
      const hit = rr.interference({ drop: -0.5 });
      if (!hit.ok) throw hit.error;
      return {
        rr,
        report,
        confirmed: hit.value.pairs.filter(
          (p) =>
            p.status === 'confirmed' &&
            p.parts.includes('gate') &&
            p.parts.some((x) => x.startsWith('mount-')),
        ),
      };
    };
    // The gate dropped to the rest spot hits hardware placed for rest only...
    expect(build(false).confirmed.length).toBeGreaterThan(0);
    // ...and misses hardware that had to keep clear in that pose too.
    const kept = build(true);
    expect(kept.confirmed).toEqual([]);
    const attached = kept.rr.connectivity([{}, { drop: -0.5 }], {
      hardware: (p) => p.startsWith('mount-'),
    });
    if (!attached.ok) throw attached.error;
    expect(attached.value.poses.map((p) => p.floating.filter((f) => f.part !== 'gate'))).toEqual([
      [],
      [],
    ]);
  });
});

describe('mountHardware posts', () => {
  it('joins groups of one joint within reach; farther groups are reported unroutable', () => {
    // A badge on the arm's joint, 30 cm above the arm.
    const build = () => {
      const { m, r } = arm(0.01, (mm) =>
        mm.box({ size: [0.02, 0.02, 0.02], center: [0.2, 0.335, 0], tag: 'badge' }),
      );
      r.bindRigid(sel.tag('badge'), 'elbow', { part: 'badge' });
      return { m, r };
    };
    const near = build().r.mountHardware();
    expect(near.unroutable).toEqual([{ joint: 'elbow', what: 'standoff', parts: ['badge'] }]);
    const far = build();
    const report = far.r.mountHardware({ reach: 0.4 });
    expect([report.unroutable, report.joints.find((j) => j.joint === 'elbow')?.standoffs]).toEqual([
      [],
      1,
    ]);
    const attached = far.r.connectivity([{}, { elbow: 10 }]);
    expect(attached.ok && attached.value.floating).toEqual([]);
  });
});
