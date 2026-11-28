import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { rig } from '../rig';
import { sel } from '../selectors';

function sliders(thick: number, sliderThick = thick) {
  const m = model();
  m.box({ size: [thick, 0.2, 0.2], center: [0, 0, 0], label: 'plate' });
  m.box({ size: [sliderThick, 0.05, 0.05], center: [0, 0, 0], label: 'slider' });
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      { name: 'slide', parent: 'root', position: [0, 0, 0], kind: 'prismatic', axis: 'x' },
    ],
  });
  r.bindRigid(sel.createdBy('plate'), 'root', { part: 'plate' });
  r.bindRigid(sel.createdBy('slider'), 'slide', { part: 'slider' });
  return r;
}

// The slider crosses the plate 4 mm per regular sample, under the 5 mm default maxTravel.
const crossing = {
  keys: [
    { u: 0, pose: { slide: -0.042 } },
    { u: 1, pose: { slide: 0.038 } },
  ],
};

describe('scan: plates thinner than maxTravel (F-2, B14-1)', () => {
  it('confirms 1 and 2 mm plates crossing between the regular samples', () => {
    for (const thick of [0.001, 0.002]) {
      const s = sliders(thick).scan(crossing);
      if (!s.ok) throw s.error;
      expect(s.value.pass).toBe(false);
      expect(s.value.pairs[0]?.status).toBe('confirmed');
      expect(s.value.evaluated).toBeLessThan(100);
    }
  });

  it('lets the thicker wall of the two nodes set the guard', () => {
    // A 50 mm slider crossing a 1 mm plate overlaps over 51 mm of relative travel, so the
    // 5 mm guard suffices; the thinner wall would subdivide to 1 mm needlessly.
    const s = sliders(0.001, 0.05).scan(crossing);
    if (!s.ok) throw s.error;
    expect(s.value.pass).toBe(false);
    expect(s.value.evaluated).toBeLessThan(60);
  });

  it('fails with model-work-budget when the motion bound cannot be met', () => {
    const s = sliders(0.001).scan(crossing, { maxTravel: 1e-9 });
    expect(s.ok).toBe(false);
    if (s.ok) return;
    expect(s.error.code).toBe('model-work-budget');
    expect(s.error.detail?.parts).toEqual(['plate', 'slider']);
  });

  it('stops at the subdivision pose limit, well before the 1e-7 spacing in u', () => {
    const s = sliders(0.001).scan(crossing, { maxTravel: 1e-8 });
    expect(s.ok).toBe(false);
    if (s.ok) return;
    expect(s.error.code).toBe('model-work-budget');
    expect(s.error.detail?.evaluated as number).toBeLessThan(70000);
  });
});

// A crank-rocker four-bar: crank a, coupler b, rocker c, ground d; the rocker carries a blade.
const [a, b, c, d] = [0.04, 0.12, 0.08, 0.1];
const crankPin: [number, number] = [a * Math.cos(Math.PI / 3), a * Math.sin(Math.PI / 3)];
const rockerPin = ((): [number, number] => {
  const dx = d - crankPin[0];
  const dy = -crankPin[1];
  const l = Math.hypot(dx, dy);
  const along = (b * b - c * c + l * l) / (2 * l);
  const h = Math.sqrt(b * b - along * along);
  const m = [crankPin[0] + (along * dx) / l, crankPin[1] + (along * dy) / l] as const;
  return [m[0] - (h * dy) / l, m[1] + (h * dx) / l];
})();
const BLADE = 0.15;

function fourBar(stopAngle: number) {
  const m = model();
  m.box({ size: [BLADE, 0.006, 0.01], center: [d + BLADE / 2, 0, 0], label: 'blade' });
  const rest = (Math.atan2(rockerPin[1], rockerPin[0] - d) * 180) / Math.PI;
  m.rotate(sel.createdBy('blade'), 'z', rest, [d, 0, 0]);
  const thick = 0.02;
  const cx = d + 0.75 * BLADE * Math.cos(stopAngle) - (thick / 2) * Math.sin(stopAngle);
  const cy = 0.75 * BLADE * Math.sin(stopAngle) + (thick / 2) * Math.cos(stopAngle);
  m.box({ size: [0.5 * BLADE, thick, 0.03], center: [cx, cy, 0], label: 'stop' });
  m.rotate(sel.createdBy('stop'), 'z', (stopAngle * 180) / Math.PI, [cx, cy, 0]);
  const r = rig(m, {
    joints: [
      { name: 'ground', parent: null, position: [0, 0, 0] },
      { name: 'crank', parent: 'ground', position: [0, 0, 0], kind: 'revolute', axis: 'z' },
      {
        name: 'coupler',
        parent: 'crank',
        position: [crankPin[0], crankPin[1], 0],
        kind: 'revolute',
        axis: 'z',
      },
      { name: 'rocker', parent: 'ground', position: [d, 0, 0], kind: 'revolute', axis: 'z' },
    ],
    loops: [
      {
        name: 'b',
        a: 'rocker',
        b: 'coupler',
        kind: 'pin',
        at: [rockerPin[0], rockerPin[1], 0],
        axis: 'z',
      },
    ],
  });
  r.bindRigid(sel.createdBy('stop'), 'ground', { part: 'stop' });
  r.bindRigid(sel.createdBy('blade'), 'rocker', { part: 'blade' });
  return r;
}

const fullTurn = {
  keys: [
    { u: 0, pose: { crank: 0 } },
    { u: 1, pose: { crank: 360 } },
  ],
};

describe('scan: solved loop joints reversing between samples (F-3)', () => {
  it('confirms a rocker overshooting its sampled extreme into a stop', () => {
    // 0.5 mm past where every regular sample (crank every 18 deg) is clear; the true
    // extreme at crank 171.3 deg reaches 0.6 mm past them.
    const r = fourBar(2.2826338004032483);
    const extreme = r.interference({ crank: 171.3 });
    if (!extreme.ok) throw extreme.error;
    expect(extreme.value.pass).toBe(false);
    const s = r.scan(fullTurn);
    if (!s.ok) throw s.error;
    expect(s.value.pass).toBe(false);
  });

  it('confirms a rocker swinging through a stop when both ends of the path coincide', () => {
    const s = fourBar(1.923994999161161).scan(fullTurn, { step: 1 });
    if (!s.ok) throw s.error;
    expect(s.value.pass).toBe(false);
    expect(s.value.pairs[0]?.status).toBe('confirmed');
  });
});
