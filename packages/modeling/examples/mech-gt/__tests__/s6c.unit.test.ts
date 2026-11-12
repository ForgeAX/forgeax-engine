import { type Model, model, sel } from '@forgeax/engine-modeling';
import { executePackBuild } from '@forgeax/engine-pack/source';
import { describe, expect, it } from 'vitest';
import parts from '../parts.json' with { type: 'json' };
import { TRANSFORM } from '../pose';
import { buildS3Mech } from '../s3-rough';
import { buildS5Internals } from '../s5-chassis';
import { buildS5JointsStowed } from '../s5-joints';
import { buildS6c, S6C_GROUPS, s6cMaterials } from '../s6c-assembly';
import { centerConsole, seat, steeringWheel } from '../s6c-cockpit';
import { exhaust, intakeMesh, lampCavity } from '../s6c-details';
import { s6cPack } from '../s6c-pack';
import { floorPanel } from '../s6c-underbody';
import { brakeDisc, caliper, forgedWheel } from '../s6c-wheels';

/** C-100 stage S6c: cockpit and exterior details as parametric recipes placed on the car. */
const hosts = new Set([...parts.parts.map((p) => p.id), ...TRANSFORM.pieces.map((p) => p.id)]);
const crossings = (m: Model) => m.validate().issues.filter((i) => i.code === 'self-intersection' && i.severity !== 'info');

describe.each(S6C_GROUPS)('C-100 S6c %s group', (group) => {
  const { model: m, pieces } = buildS6c(group);

  it('builds and validates with no issue above info', { timeout: 120000 }, () => {
    expect(m.poisoned).toBeUndefined();
    expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('every face rides a part-list part or S4 piece, belongs to a named detail and has a recipe material', () => {
    const tags = m.inspect().tags;
    const partTags = tags.filter((t) => t.startsWith('part:')).map((t) => t.slice(5));
    for (const t of partTags) expect([t, hosts.has(t)]).toEqual([t, true]);
    expect(m.count(sel.all().minus(partTags.map((t) => sel.tag(`part:${t}`)).reduce((a, b) => a.or(b))))).toBe(0);
    const details = tags.filter((t) => t.startsWith('detail:'));
    expect(m.count(sel.all().minus(details.map((t) => sel.tag(t)).reduce((a, b) => a.or(b))))).toBe(0);
    const recipes = s6cMaterials();
    for (const slot of m.inspect().materials.filter((s) => m.count(sel.material(s)) > 0)) expect([slot, recipes[slot] !== undefined]).toEqual([slot, true]);
    expect(pieces.length).toBeGreaterThan(10);
    // Criterion 12c: one shared paint scheme, every used slot is a gt-* slot.
    for (const slot of m.inspect().materials.filter((x) => m.count(sel.material(x)) > 0)) expect([slot, slot.startsWith('gt-')]).toEqual([slot, true]);
    expect(m.inspect().labels.length).toBeGreaterThanOrEqual(pieces.length / 2);
  });
});

describe('C-100 S6c placement', () => {
  it('mirrored pairs carry the left and right host part and a side tag', () => {
    const side = buildS6c('side').model;
    for (const [l, r] of [['door-l-outer', 'door-r-outer'], ['side-intake-l', 'side-intake-r']]) {
      const left = sel.tag(`part:${l}`);
      const right = sel.tag(`part:${r}`);
      expect(side.count(left)).toBe(side.count(right));
      expect(side.count(left.and(sel.tag('side:r')))).toBe(0);
      const lb = side.bounds(left);
      if (!lb.ok) throw lb.error;
      expect(lb.value.min[0]).toBeGreaterThan(0);
    }
  });

  it.each([
    ['stowed core', buildS3Mech],
    ['joint mechanisms', buildS5JointsStowed],
    ['internals', buildS5Internals],
  ] as const)('the cockpit stays clear of the %s in car form', { timeout: 120000 }, (_name, build) => {
    const cockpit = buildS6c('cockpit').model;
    const both = model();
    both.append(cockpit.snapshot());
    both.append(build().snapshot());
    expect(crossings(both)).toEqual([]);
  });

  it('the underbody leaves the robot belly and chest band (S6b) empty', () => {
    const under = buildS6c('underbody').model;
    expect(under.count(sel.inBox([-0.6, 0.1306, -0.42], [0.6, 0.18, 0.98], { by: 'any' }))).toBe(0);
    expect(under.count(sel.inBox([-0.6, 0, -0.42], [0.6, 0.18, 0.98], { by: 'centroid' }))).toBe(0);
  });

  it('splits the exhaust and the fins per rear centre half, clear of its x = 0 shut line', () => {
    const rear = buildS6c('rear').model;
    for (const name of ['exhaust', 'diffuser-fins']) {
      const detail = sel.tag(`detail:${name}`);
      const l = rear.bounds(detail.and(sel.tag('side:l')));
      const r = rear.bounds(detail.and(sel.tag('side:r')));
      if (!l.ok || !r.ok) throw new Error(`${name}: no faces on a side`);
      expect([name, l.value.min[0] >= 0.0015, r.value.max[0] <= -0.0015]).toEqual([name, true, true]);
      expect(rear.count(detail.minus(sel.tag('side:l')).minus(sel.tag('side:r')))).toBe(0);
    }
  });

  it('the console bridge keeps its channel open over the stowed spine', () => {
    const c = centerConsole({ name: 'c', channel: 0.12, clearance: 0.27 });
    if (!c.ok) throw c.error;
    const inChannel = c.value.model.count(sel.inBox([-0.119, 0.001, -0.9], [0.119, 0.269, -0.03], { by: 'any' }));
    expect(inChannel).toBe(0);
  });
});

describe('C-100 S6c recipes', () => {
  it('reject parameters outside their declared ranges with a structured error', () => {
    const cases = [seat({ name: 's', width: 0.9 }), steeringWheel({ name: 'w', radius: 0.4 }), exhaust({ name: 'e', tips: 9 }), intakeMesh({ name: 'm', outline: [[0, 0], [0.1, 0], [0, 0.1]], pitch: 0.5 }), forgedWheel({ name: 'w', diameter: 0.9, width: 0.3 }), brakeDisc({ name: 'd', radius: 0.4 }), caliper({ name: 'c', disc: 0.18, thickness: 0.034, pistons: 8 }), floorPanel({ name: 'f', width: 3, length: 1 })];
    for (const r of cases) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('model-invalid-argument');
    }
  });

  it('a lamp follows its outline: wider openings carry more LEDs and its parts stay inside the opening', () => {
    const outline = (w: number) => [[-w / 2, -0.04], [w / 2, -0.04], [w / 2, 0.04], [-w / 2, 0.04]] as [number, number][];
    const count = (w: number) => {
      const r = lampCavity({ name: 'lamp', outline: outline(w), depth: 0.08, projectors: 1, signature: 'y', light: 'headlight' });
      if (!r.ok) throw r.error;
      const b = r.value.model.bounds(sel.all());
      if (!b.ok) throw b.error;
      expect(b.value.min[0]).toBeGreaterThanOrEqual(-w / 2 - 1e-6);
      expect(b.value.max[0]).toBeLessThanOrEqual(w / 2 + 1e-6);
      return r.value.pieces.filter((p) => p.startsWith('lamp-led-')).length;
    };
    expect(count(0.4)).toBeGreaterThan(count(0.2));
  });
});

describe('C-100 S6c Packs', () => {
  it('every Pack in examples/mech-gt has its own package id', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = new URL('..', import.meta.url);
    const ids = new Map<string, string[]>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      for (const id of readFileSync(new URL(file, dir), 'utf8').match(/01900000-0000-7000-8000-[0-9a-f]{12}/g) ?? []) ids.set(id, [...new Set([...(ids.get(id) ?? []), file])]);
    }
    expect([...ids].filter(([, files]) => files.length > 1)).toEqual([]);
  });

  it('each group Pack outputs its mesh with two LOD levels and a material per slot', { timeout: 300000 }, async () => {
    for (const group of S6C_GROUPS) {
      const pack = s6cPack(group);
      const built = await executePackBuild(pack, {
        packageId: pack.packageId,
        readByGuid: async () => {
          throw new Error('no reads expected');
        },
        values: {},
      });
      if (!built.ok) throw built.error;
      const outputs = built.value as Record<string, { kind: string; indices?: ArrayLike<number> }>;
      const tris = [`mesh/s6c-${group}`, `mesh/s6c-${group}/lod1`, `mesh/s6c-${group}/lod2`].map((k) => {
        expect([k, outputs[k]?.kind]).toEqual([k, 'mesh']);
        return (outputs[k]?.indices?.length ?? 0) / 3;
      });
      // Import's faceted/UV-split LOD falls back to the previous level when a level cannot reach
      // its target: a level never grows, and the chain as a whole must still reduce the mesh.
      expect([
        group,
        (tris[1] as number) < (tris[0] as number),
        (tris[2] as number) <= (tris[1] as number),
        (tris[2] as number) < (tris[0] as number),
      ]).toEqual([group, true, true, true]);
      expect(Object.keys(outputs).filter((k) => k.startsWith('material/')).length).toBeGreaterThan(2);
    }
  });
});
