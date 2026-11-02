import { bakeMaps, model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { COUNTS, HIGH, LOW, resetCounts } from '../kit';
import { GROUPS } from '../mech';
import { BAKE_SLOTS, bakeSettings, buildGroup, buildLowSet, exportDump, HIGH_NORMALS, LOW_NORMALS, assertNoSlivers, assertRigidUnion, mergeRigid, tris } from '../pipeline';

const group = (name: string) => GROUPS.find((g) => g.name === name)!;

describe('C-410 sci-fi mech: one description, a form layer and a detail source', () => {
  it('builds every low group into the eight bake classes within the form budget', { timeout: 120000 }, () => {
    let total = 0;
    for (const g of GROUPS) {
      const m = buildGroup(g, LOW);
      check(m.inspect().materials.filter((s) => m.count(sel.material(s)) > 0));
      m.uv.project({ mode: 'box', scale: 1 });
      total += tris(exportDump(m, g.name, LOW_NORMALS)) * (g.mirrored ? 2 : 1);
    }
    expect(total).toBeGreaterThan(8000);
    expect(total).toBeLessThan(16000);
    function check(slots: string[]) {
      for (const s of slots) expect(BAKE_SLOTS as readonly string[]).toContain(s);
    }
  });

  it('builds a high group far denser than its low, with counted features and at most eight slots', { timeout: 120000 }, () => {
    resetCounts();
    const high = buildGroup(group('hand'), HIGH);
    expect(COUNTS.bolts).toBeGreaterThan(10);
    expect(COUNTS.plates).toBeGreaterThan(0);
    const low = buildGroup(group('hand'), LOW);
    high.uv.project({ mode: 'box', scale: 1 });
    low.uv.project({ mode: 'box', scale: 1 });
    const h = exportDump(high, 'hand', HIGH_NORMALS);
    const l = exportDump(low, 'hand', LOW_NORMALS);
    expect(tris(h) / tris(l)).toBeGreaterThan(30);
    expect(h.slots.length).toBeLessThanOrEqual(8);
    for (const s of h.slots) expect(BAKE_SLOTS as readonly string[]).toContain(s);
  });

  it('is deterministic: two builds give the same FXEM bytes', { timeout: 120000 }, () => {
    const a = buildGroup(group('head'), LOW).snapshot();
    const b = buildGroup(group('head'), LOW).snapshot();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('merges the overlapping rigid parts of every low group into shells before unwrapping', { timeout: 120000 }, () => {
    const merged: Record<string, { parts: number; shells: number }> = {};
    for (const g of GROUPS) {
      const m = buildGroup(g, LOW);
      mergeRigid(m, g.name);
      const info = m.journal.at(-1)?.diagnostics?.find((d) => d.message.startsWith('lowpoly'))?.detail as
        | { union: string; fallback: boolean; parts: number; components: unknown[] }
        | undefined;
      expect(info, g.name).toMatchObject({ union: 'exact', fallback: false });
      merged[g.name] = { parts: info!.parts, shells: info!.components.length };
    }
    // The union-then-triangulate-once guard: no shell of the merged set crosses another.
    for (const g of GROUPS) {
      const m = buildGroup(g, LOW);
      mergeRigid(m, g.name);
      expect(() => assertRigidUnion(m, g.name), g.name).not.toThrow();
    }
    // Falsifier: without the merge every kit element is its own shell (torso: 25 parts, hoses included).
    expect(merged.torso).toEqual({ parts: 25, shells: 1 });
    for (const [name, r] of Object.entries(merged)) expect(r.shells, name).toBeLessThan(r.parts);
  });

  it('merges every low group to zero slivers at 2 mm, closed, within a 0.1 % volume change', { timeout: 240000 }, () => {
    for (const g of GROUPS) {
      const m = buildGroup(g, LOW);
      mergeRigid(m, g.name, { slivers: 0.002 });
      assertNoSlivers(m, g.name, 0.002);
      expect(m.validate().closed, g.name).toBe(true);
      const info = m.journal.find((j) => j.op === 'lowpoly')?.diagnostics?.find((d) => d.message.startsWith('lowpoly'))?.detail as
        | { slivers: { kept: number; volumeChange: number } }
        | undefined;
      expect(info!.slivers.kept, g.name).toBe(0);
      expect(Math.abs(info!.slivers.volumeChange), g.name).toBeLessThan(1e-3);
    }
  });

  it('falsifier: without the sliver pass the merged upperarm shells still hold slivers the gate reports', { timeout: 120000 }, () => {
    const m = buildGroup(group('upperarm'), LOW);
    mergeRigid(m, 'upperarm', { slivers: 1e-9 });
    expect(() => assertNoSlivers(m, 'upperarm', 0.002)).toThrow(/slivers remain/);
  });

  it('packs the three sets at about one texel density (within 8 %) with hard edges as chart borders', { timeout: 120000 }, () => {
    const density: number[] = [];
    for (const set of ['set1', 'set2', 'set3'] as const) {
      const { model: s } = buildLowSet(set, 2048, 16);
      const auto = s.journal.find((j) => j.op === 'uv.auto')!;
      const pack = auto.diagnostics!.map((d) => (d.detail as { metrics?: { texelsPerMeter?: number } } | undefined)?.metrics?.texelsPerMeter).find((v) => v !== undefined);
      const charts = auto.diagnostics!.map((d) => (d.detail as { crossedEdges?: number } | undefined)?.crossedEdges).find((v) => v !== undefined);
      expect(charts ?? 0).toBe(0);
      density.push(pack as number);
    }
    const mean = density.reduce((a, b) => a + b, 0) / density.length;
    for (const d of density) expect(Math.abs(d / mean - 1)).toBeLessThan(0.08);
    expect(mean).toBeGreaterThan(370);
  });

  it('bakes detail into the normal map; baking the low onto itself is the flat falsifier', { timeout: 120000 }, () => {
    const { model: s } = buildLowSet('set1', 256, 4);
    const base = model();
    base.append(s.snapshot());
    base.delete(sel.all().minus(sel.material('head')));
    const detail = buildGroup(group('head'), HIGH);
    const opts = { ...bakeSettings('after', 8), maps: ['normal'] as const, resolution: 256, samples: 1 as const };
    const baked = bakeMaps({ base, detail, ...opts });
    const self = bakeMaps({ base, detail: base.snapshot(), ...opts, detailNormals: LOW_NORMALS });
    if (!baked.ok) throw baked.error;
    if (!self.ok) throw self.error;
    const tilt = (data: Uint8Array) => {
      let n = 0;
      for (let i = 0; i < data.length; i += 4) if (Math.abs((data[i] as number) - 128) > 25 || Math.abs((data[i + 1] as number) - 128) > 25) n++;
      return n;
    };
    const detailTexels = tilt(baked.value.textures.normal!.data as Uint8Array);
    expect(detailTexels).toBeGreaterThan(500);
    expect(tilt(self.value.textures.normal!.data as Uint8Array)).toBeLessThan(detailTexels / 20);
  });
});
