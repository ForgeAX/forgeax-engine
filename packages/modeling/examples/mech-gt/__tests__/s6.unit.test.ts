import { model, sel } from '@forgeax/engine-modeling';
import { executePackBuild } from '@forgeax/engine-pack/source';
import { describe, expect, it } from 'vitest';
import parts from '../parts.json' with { type: 'json' };
import { TRANSFORM } from '../pose';
import { CAR } from '../proportions';
import { ATLAS, buildS6, buildS6Detail, S6_GROUPS, type S6Group, s6Bake, s6Materials, texelDensity, VENTED } from '../s6-exterior';
import { buildS6Mechanics, S6_MECHANICS, s6MechanicsMaterials } from '../s6-mechanics';
import { s6MechanicsPack, s6Pack } from '../s6-pack';
import { buildS6c, S6C_GROUPS } from '../s6c-assembly';
import { INTERNAL } from '../s5-chassis';

/** C-100 stage S6: the final exterior part groups, each its own Pack under the build budget. */
const ids = new Set([...parts.parts.map((p) => p.id), ...TRANSFORM.pieces.map((p) => p.id)]);
const GROUPS = Object.keys(S6_GROUPS) as S6Group[];

describe.each(GROUPS)('C-100 S6 %s group', (group) => {
  const m = buildS6(group);

  it('builds and validates with no issue above info', { timeout: 120000 }, () => {
    expect(m.poisoned).toBeUndefined();
    expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('every face belongs to exactly the group parts, which are part-list parts or S4 pieces', () => {
    const tags = m.inspect().tags.filter((t) => t.startsWith('part:')).map((t) => t.slice(5));
    expect(new Set(tags)).toEqual(new Set(S6_GROUPS[group]));
    for (const t of tags) expect([t, ids.has(t)]).toEqual([t, true]);
    const anyPart = tags.map((t) => sel.tag(`part:${t}`)).reduce((a, b) => a.or(b));
    expect(m.count(sel.all().minus(anyPart))).toBe(0);
  });

  it('every slot has a procedural material, and the vented panels take the baked normal map', () => {
    const recipes = s6Materials();
    for (const slot of m.inspect().materials.filter((s) => m.count(sel.material(s)) > 0)) expect([slot, recipes[slot] !== undefined]).toEqual([slot, true]);
    expect(s6Bake(group).maps).toEqual(VENTED(group).length > 0 ? ['normal', 'ao'] : ['ao']);
    if (VENTED(group).length > 0) expect(m.count(sel.material('louvre'))).toBeGreaterThan(0);
  });

  // Criterion 4 / one texel density across the groups (within 1.5x), and a louver rib spans 4 texels.
  it('holds the exterior texel density: 370-555 texels/m (within 1.5x), the vented groups at least 512', () => {
    const density = texelDensity(m, ATLAS.resolution[group]);
    expect([group, density >= 370 && density <= 555]).toEqual([group, true]);
    if (VENTED(group).length > 0) expect([group, density >= 512]).toEqual([group, true]);
  });

  it('the bake source is the group plus louver ribs, separate from its panels', { timeout: 120000 }, () => {
    const detail = buildS6Detail(group, m);
    expect(detail.poisoned).toBeUndefined();
    const ribs = VENTED(group).length * 9;
    expect(detail.inspect().labels.filter((l) => l.label.startsWith('louver-')).length).toBe(ribs);
    expect(detail.validate().issues.filter((i) => i.code === 'self-intersection' && i.severity !== 'info')).toEqual([]);
  });
});

describe('C-100 S6 Packs', () => {
  it('each group Pack lists its mesh with LODs, a material per slot and the baked maps as cook sources', async () => {
    for (const group of GROUPS) {
      const pack = s6Pack(group);
      const built = await executePackBuild(pack, {
        packageId: pack.packageId,
        readByGuid: async () => {
          throw new Error('no reads expected');
        },
        values: {},
      });
      if (!built.ok) throw built.error;
      const outputs = built.value as Record<string, { kind: string; execution?: string }>;
      const keys = Object.keys(outputs);
      for (const k of [`mesh/s6-${group}`, `mesh/s6-${group}/lod1`, `mesh/s6-${group}/lod2`, `texture/s6-${group}-ao`]) expect(keys).toContain(k);
      if (VENTED(group).length > 0) expect(keys).toContain(`texture/s6-${group}-normal`);
      expect(keys.filter((k) => k.startsWith('material/')).length).toBeGreaterThan(0);
      for (const k of keys) expect([k, outputs[k]]).toMatchObject([k, { kind: 'modeling-mesh-job', execution: 'cooked' }]);
    }
  });
});

describe.each(S6_MECHANICS)('C-100 S6 %s mechanics', (group) => {
  const m = buildS6Mechanics(group);

  it('builds and validates with no issue above info; every face is a part and every slot has a material', { timeout: 120000 }, () => {
    expect(m.poisoned).toBeUndefined();
    expect(m.validate().issues.filter((i) => i.severity !== 'info')).toEqual([]);
    const tags = m.inspect().tags.filter((t) => t.startsWith('part:'));
    expect(m.count(sel.all().minus(tags.map((t) => sel.tag(t)).reduce((a, b) => a.or(b))))).toBe(0);
    if (group === 'internals') for (const id of INTERNAL) expect(tags).toContain(`part:${id}`);
    const recipes = s6MechanicsMaterials();
    for (const slot of m.inspect().materials.filter((s) => m.count(sel.material(s)) > 0)) expect([slot, recipes[slot] !== undefined]).toEqual([slot, true]);
  });

  it('its Pack outputs the mesh, two LOD levels and the materials', { timeout: 300000 }, async () => {
    const pack = s6MechanicsPack(group);
    const built = await executePackBuild(pack, { packageId: pack.packageId, readByGuid: async () => { throw new Error('no reads expected'); }, values: {} });
    if (!built.ok) throw built.error;
    const keys = Object.keys(built.value);
    for (const k of [`mesh/s6-${group}`, `mesh/s6-${group}/lod1`, `mesh/s6-${group}/lod2`]) expect(keys).toContain(k);
    expect(keys.filter((k) => k.startsWith('material/')).length).toBeGreaterThan(0);
  });
});

describe('C-100 S6 exterior assembly', () => {
  const ext = model();
  for (const group of GROUPS) ext.append(buildS6(group).snapshot());

  it('covers every body part of parts.json with S6a or S6c geometry, directly or through its S4 pieces', { timeout: 300000 }, () => {
    // The lamps are S6c cavities placed in the S6a openings.
    const detail = S6C_GROUPS.flatMap((g) => buildS6c(g).model.inspect().tags);
    const tags = new Set([...ext.inspect().tags, ...detail].filter((t) => t.startsWith('part:')).map((t) => t.slice(5)));
    const covered = (id: string) => tags.has(id) || TRANSFORM.pieces.some((p) => p.part === id && tags.has(p.id));
    const missing = parts.parts.filter((p) => p.system === 'body' && !covered(p.id)).map((p) => p.id);
    expect(missing).toEqual([]);
  });

  it('keeps length, width, height and wheelbase within 2 % of S1 (criterion 2)', () => {
    const box = ext.bounds(sel.all());
    if (!box.ok) throw box.error;
    const { min, max } = box.value;
    const axle = (tag: string) => {
      const b = ext.bounds(sel.tag(tag));
      if (!b.ok) throw b.error;
      return (b.value.min[2] + b.value.max[2]) / 2;
    };
    const measured = { length: max[2] - min[2], width: max[0] - min[0], height: max[1] - min[1], wheelbase: axle('part:front-wheel-l') - axle('part:rear-wheel-l') };
    for (const [key, value] of Object.entries(measured)) {
      const target = CAR[key as keyof typeof measured].value;
      expect([key, Math.abs(value - target) / target <= 0.02]).toEqual([key, true]);
    }
  });
});
