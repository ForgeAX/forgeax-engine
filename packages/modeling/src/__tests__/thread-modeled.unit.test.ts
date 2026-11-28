import { describe, expect, it } from 'vitest';
import { sin } from '../dmath';
import { meshVolume } from '../geom';
import { model } from '../model';
import { recipes } from '../recipes';
import { rig } from '../rig';
import { sel } from '../selectors';
import { threadRadii, threadReach, threadSweep } from '../thread-sweep';
import { specOf } from '../threads';

const m8 = specOf('M8');
const top = sel.facing('+y');
const SEGMENTS = 24;

function lowerPlate(geometry: 'cosmetic' | 'modeled' | undefined, depth: number | 'through') {
  const m = model({ tolerance: 1e-8 });
  m.box({ size: [0.04, 0.02, 0.04], center: [0, -0.01, 0], label: 'lower' });
  const r = m.hole(sel.createdBy('lower').and(top), {
    kind: 'tapped',
    thread: 'M8',
    depth,
    centers: [[0, 0]],
    ...(geometry === undefined ? {} : { threadGeometry: geometry }),
    label: 'lower-hole',
  });
  return { m, r };
}

function roleCounts(m: ReturnType<typeof model>): Record<string, number> {
  const mesh = m.editMesh;
  const out: Record<string, number> = {};
  for (const f of mesh.faces()) {
    if (mesh.labelNames[mesh.fLabel[f] as number] !== 'lower-hole') continue;
    const role = String(mesh.roleNames[mesh.fRole[f] as number]);
    out[role] = (out[role] ?? 0) + 1;
  }
  return out;
}

describe('modeled thread sweep', () => {
  it('ridge volume follows Pappus on the faceted helix', () => {
    const turns = 4;
    const from = 0;
    const to = turns * m8.pitch;
    const ridge = model({ tolerance: m8.pitch * 1e-6 });
    const options = threadSweep(m8, 'ridge', from, to, SEGMENTS);
    expect(ridge.sweep({ ...options, label: 'ridge' }).status).toBe('ok');
    const points = options.profile;
    let area = 0;
    let cx = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i] as [number, number];
      const b = points[(i + 1) % points.length] as [number, number];
      const cross = a[0] * b[1] - b[0] * a[1];
      area += cross / 2;
      cx += ((a[0] + b[0]) * cross) / 6;
    }
    cx /= area;
    const radius = threadRadii(m8, SEGMENTS).bore - cx;
    const chord = 2 * radius * sin(Math.PI / SEGMENTS);
    const expected = Math.abs(area) * turns * SEGMENTS * chord;
    const volume = Math.abs(meshVolume(ridge.editMesh));
    expect(Math.abs(volume - expected) / expected).toBeLessThan(0.03);
  });

  it('reach bounds the axial extent of the section', () => {
    const lip = threadReach(m8, SEGMENTS, 'groove');
    expect(lip).toBeGreaterThan(m8.pitch / 16);
    expect(lip).toBeLessThan(m8.pitch / 2);
  });
});

describe('modeled tapped hole', () => {
  it('cosmetic stays the default and threadGeometry cosmetic is identical', () => {
    const a = lowerPlate(undefined, 0.012);
    const b = lowerPlate('cosmetic', 0.012);
    expect(a.r.status).toBe('ok');
    expect(b.r.status).toBe('ok');
    expect(a.m.editMesh.faces().length).toBe(b.m.editMesh.faces().length);
    expect(meshVolume(a.m.editMesh)).toBe(meshVolume(b.m.editMesh));
    expect(roleCounts(a.m)['hole-thread']).toBeUndefined();
  });

  it('blind hole carries hole-thread faces and removes more than the bore', () => {
    const cosmetic = lowerPlate('cosmetic', 0.012);
    const modeled = lowerPlate('modeled', 0.012);
    expect(modeled.r.status).toBe('ok');
    const roles = roleCounts(modeled.m);
    expect(roles['hole-thread']).toBeGreaterThan(0);
    expect(roles['hole-floor']).toBe(1);
    expect(Math.abs(meshVolume(modeled.m.editMesh))).toBeLessThan(
      Math.abs(meshVolume(cosmetic.m.editMesh)),
    );
  });

  it('through hole has thread faces and no floor', () => {
    const modeled = lowerPlate('modeled', 'through');
    expect(modeled.r.status).toBe('ok');
    const roles = roleCounts(modeled.m);
    expect(roles['hole-thread']).toBeGreaterThan(0);
    expect(roles['hole-floor']).toBeUndefined();
  });

  it('a hole shorter than one pitch is a model-precondition', () => {
    const { r } = lowerPlate('modeled', 0.5 * m8.pitch);
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.error?.code).toBe('model-precondition');
    expect(r.error?.detail).toMatchObject({ reason: 'thread-length' });
  });
});

describe('modeled M8 bolt in its modeled tapped hole', () => {
  function pairs(seat: number, degrees: number): readonly { parts: readonly string[] }[] {
    const { m, r } = lowerPlate('modeled', 'through');
    expect(r.status).toBe('ok');
    const bolt = recipes.hexBolt({
      size: 'M8',
      length: seat + 0.012,
      threadGeometry: 'modeled',
      segments: SEGMENTS,
    });
    expect(bolt.ok).toBe(true);
    if (!bolt.ok) return [];
    if (degrees !== 0) bolt.value.model.rotate(sel.all(), 'y', degrees);
    expect(m.append(bolt.value.model, { translate: [0, seat, 0] }).status).toBe('ok');
    const r2 = rig(m, { joints: [{ name: 'root', parent: null, position: [0, 0, 0] }] });
    r2.bindRigid(sel.all(), 'root', { part: 'lower' });
    r2.bindRigid(sel.tag('bolt'), 'root', { part: 'bolt' });
    const report = r2.interference({}, { tolerance: 1e-5 });
    expect(report.ok).toBe(true);
    return report.ok ? report.value.pairs.filter((p) => p.status === 'confirmed') : [];
  }

  it('a seat a whole number of pitches above the face has zero interference', {
    timeout: 120000,
  }, () => {
    expect(pairs(4 * m8.pitch, 0)).toEqual([]);
  });

  it('a fractional seat fits when the bolt turns 360 y / pitch degrees', {
    timeout: 120000,
  }, () => {
    const seat = 0.006;
    const turn = (360 * seat) / m8.pitch;
    expect(pairs(seat, turn % 360)).toEqual([]);
  });

  it('the wrong phase interferes with the thread', { timeout: 120000 }, () => {
    const found = pairs(0.006, 72);
    expect(found.some((p) => p.parts.includes('bolt') && p.parts.includes('lower'))).toBe(true);
  });
});
