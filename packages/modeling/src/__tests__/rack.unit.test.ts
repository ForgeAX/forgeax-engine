import { describe, expect, it } from 'vitest';
import { model } from '../model';
import { recipes } from '../recipes';
import { rig } from '../rig';
import { sel } from '../selectors';

const M = 0.004;
const WIDTH = 0.02;

function part(r: ReturnType<typeof recipes.rack>) {
  if (!r.ok) throw r.error;
  return r.value;
}

/** A 20-tooth gear over gap `k` of a 12-tooth rack (or over tooth `k` when `onTooth`), each on its joint. */
function pair(k: number, onTooth = false) {
  const rack = part(recipes.rack({ module: M, teeth: 12, width: WIDTH, name: 'rack' }));
  const gear = part(recipes.gear({ module: M, teeth: 20, width: WIDTH, name: 'pinion' }));
  const pitch = rack.dimensions.pitch as number;
  const r = gear.dimensions.pitchRadius as number;
  const x = (k + (onTooth ? 0 : 0.5)) * pitch;
  const m = model();
  m.append(rack.model, { tag: 'rack' });
  m.append(gear.model, { tag: 'pinion' });
  m.rotate(sel.tag('pinion'), 'z', -90);
  m.translate(sel.tag('pinion'), [x, r, 0]);
  const rg = rig(m, {
    joints: [
      { name: 'frame', parent: null, position: [0, 0, 0] },
      { name: 'slide', parent: 'frame', position: [0, 0, 0], kind: 'prismatic', axis: 'x' },
      { name: 'spin', parent: 'frame', position: [x, r, 0], kind: 'revolute', axis: 'z' },
    ],
  });
  rg.bindRigid(sel.tag('rack'), 'slide', { part: 'rack' });
  rg.bindRigid(sel.tag('pinion'), 'spin', { part: 'pinion' });
  return { m, rg, rack, gear, r, pitch };
}

describe('recipes.rack', () => {
  it('builds a closed involute rack with one tooth per pitch', () => {
    const rack = part(recipes.rack({ module: M, teeth: 12, width: WIDTH }));
    expect(rack.dimensions.pitch).toBeCloseTo(Math.PI * M, 15);
    expect(rack.dimensions.minPinionTeeth).toBe(18);
    expect(rack.anchors.pitchEnd?.[0]).toBeCloseTo(11 * Math.PI * M, 12);
    const report = rack.model.validate();
    expect(report.closed).toBe(true);
    expect(report.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    // Tip lands face +Y above the pitch line; root lands face +Y below it: 11 gaps cut in
    // half at the gap planes, plus the 2 ends.
    const up = sel.createdBy('rack', 'side').and(sel.facing('+y'));
    expect(rack.model.count(up.and(sel.inBox([-1, 0, -1], [1, 1, 1], { by: 'centroid' })))).toBe(
      12,
    );
    expect(rack.model.count(up.and(sel.inBox([-1, -1, -1], [1, 0, 1], { by: 'centroid' })))).toBe(
      24,
    );
  });

  it('meshes with a gear of the same module: rolling the pair stays clear', () => {
    const { rg, r } = pair(4);
    // Three tooth pitches: the gear turns 54 degrees, the rack moves r * theta along +X.
    const theta = (3 * 360) / 20;
    const travel = (r * theta * Math.PI) / 180;
    const scan = rg.scan({
      keys: [
        { u: 0, pose: { spin: 0, slide: 0 } },
        { u: 1, pose: { spin: theta, slide: travel } },
      ],
    });
    if (!scan.ok) throw scan.error;
    expect(scan.value.pairs).toEqual([]);
    expect(scan.value.pass).toBe(true);
  });

  it('confirms a gear placed tooth on tooth', () => {
    const { rg } = pair(4, true);
    const hit = rg.interference();
    if (!hit.ok) throw hit.error;
    expect(hit.value.pairs[0]).toMatchObject({ parts: ['pinion', 'rack'], status: 'confirmed' });
  });

  it('exports in any orientation: the caps never fan into slivers', () => {
    // One rack-long cap n-gon collapsed in f32 once turned (F1 motion line report).
    const turns: readonly (readonly ['x' | 'y' | 'z', number])[][] = [
      [['z', 90]],
      [
        ['x', 17],
        ['z', 23],
      ],
      [
        ['y', 61],
        ['x', -33],
        ['z', 11],
      ],
    ];
    for (const teeth of [12, 80]) {
      const rack = part(recipes.rack({ module: M, teeth, width: WIDTH }));
      for (const turn of turns) {
        const m = model();
        m.append(rack.model.snapshot());
        for (const [axis, degrees] of turn) m.rotate(sel.all(), axis, degrees);
        const out = m.toMesh({ normals: { mode: 'weighted' } });
        expect(out.ok ? 'ok' : out.error.code).toBe('ok');
      }
    }
  });

  it('checks its ranges', () => {
    expect(recipes.rack({ module: 0.1, teeth: 10, width: 0.5 }).ok).toBe(false);
    expect(recipes.rack({ module: M, teeth: 1, width: WIDTH }).ok).toBe(false);
    expect(recipes.rack({ module: M, teeth: 10, width: WIDTH, backlash: M }).ok).toBe(false);
  });
});
