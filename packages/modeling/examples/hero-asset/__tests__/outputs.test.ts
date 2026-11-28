// Pinned verdicts of the one-source, several-outputs run (outputs.ts). Checks read the outputs.json of a
// finished run and are skipped unless HERO_OUTPUTS_DIR points at it.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = process.env.HERO_OUTPUTS_DIR;
const runIt = DIR === undefined ? it.skip : it;
const read = () => JSON.parse(readFileSync(join(DIR as string, 'outputs.json'), 'utf8'));

// Pinned values of the current run (outputs.ts over deliverAsset, branch feat/fable-deliver). Change them only with a regenerated run.
// Triangles and vertices do not change under material assignment or merge: each part has one slot, so material
// borders coincide with the part-tag borders that uv.plan already cuts; a merge only renames existing faces' slot.
export const PINNED = {
  ids: ['desktop-hero', 'mobile-hero', 'mobile-prop'],
  quadSize: { 'desktop-hero': 0.35, 'mobile-hero': 0.9, 'mobile-prop': 1.2 },
  triangles: { 'desktop-hero': 55790, 'mobile-hero': 11170, 'mobile-prop': 7442 },
  // Vertices grow because the export now uses the crease normals the bake used (autoSmooth 30 deg): hard edges split
  // vertices that the former smooth export shared. The before-merge measurement runs the same export path, so both sides match.
  vertices: { 'desktop-hero': 31887, 'mobile-hero': 7491, 'mobile-prop': 5376 },
  verticesBefore: { 'desktop-hero': 31887, 'mobile-hero': 7491, 'mobile-prop': 5376 },
  exactUvOverlapPairs: { 'desktop-hero': 0, 'mobile-hero': 0, 'mobile-prop': 0 },
  sourceMaterials: ['BodyMetal', 'Glass', 'DarkHardware', 'Accent'],
  materialSlotsBefore: {
    'desktop-hero': ['BodyMetal', 'Glass', 'DarkHardware', 'Accent'],
    'mobile-hero': ['BodyMetal', 'Glass', 'DarkHardware', 'Accent'],
    'mobile-prop': ['BodyMetal', 'Glass', 'DarkHardware', 'Accent'],
  },
  materialSlotsAfter: {
    'desktop-hero': ['BodyMetal', 'Glass', 'DarkHardware', 'Accent'],
    'mobile-hero': ['Atlas'],
    'mobile-prop': ['BodyMetal', 'Glass', 'Accent'],
  },
  merge: {
    'desktop-hero': {},
    'mobile-hero': { BodyMetal: 'Atlas', DarkHardware: 'Atlas', Glass: 'Atlas', Accent: 'Atlas' },
    'mobile-prop': { DarkHardware: 'BodyMetal' },
  },
  propSizesTried: [1, 1.1, 1.2],
  propVerdicts: [
    { ok: false, codes: ['budget-triangles', 'budget-vertices'] },
    { ok: false, codes: ['budget-triangles'] },
    { ok: true, codes: [] },
  ],
  beforeMergeVerdicts: {
    'desktop-hero': { ok: true, codes: [] },
    'mobile-hero': { ok: false, codes: ['budget-materials'] },
    'mobile-prop': { ok: false, codes: ['budget-materials'] },
  },
  // Bake (deliverAsset bake, normal map from the desktop-hero detail onto each mobile base, one cage group per part).
  bakeCodes: { 'mobile-hero': [], 'mobile-prop': [] },
  // Per-part groups: 12 parts, each cage offset a small share of the part instead of a cross-part 7 cm.
  bakeGroups: 12,
  maxCageOffset: 0.25,
  sourceRefusals: ['R1'],
} as const;

const byId = (doc: { outputs: { id: string }[] }, id: string) => {
  const o = doc.outputs.find((x) => x.id === id);
  if (o === undefined) throw new Error(`output ${id} missing`);
  return o as Record<string, any>;
};

describe('outputs run', () => {
  runIt('lists the three outputs in order', () => {
    expect(read().outputs.map((o: { id: string }) => o.id)).toEqual(PINNED.ids);
  });
  runIt('every output passes its profile budget with no issues', () => {
    for (const o of read().outputs) {
      expect(o.ok, o.id).toBe(true);
      expect(o.issues, o.id).toEqual([]);
    }
  });
  runIt('quad size, triangles and vertices match the pinned run', () => {
    for (const o of read().outputs) {
      expect(o.quadSize, o.id).toBe(PINNED.quadSize[o.id as keyof typeof PINNED.quadSize]);
      expect(o.triangles, o.id).toBe(PINNED.triangles[o.id as keyof typeof PINNED.triangles]);
      expect(o.vertices, o.id).toBe(PINNED.vertices[o.id as keyof typeof PINNED.vertices]);
      expect(o.verticesBefore, o.id).toBe(PINNED.verticesBefore[o.id as keyof typeof PINNED.verticesBefore]);
    }
  });
  runIt('source materials are the four closed slots, carried into every output before merge', () => {
    const doc = read();
    expect(doc.source.materials).toEqual(PINNED.sourceMaterials);
    for (const o of doc.outputs) {
      expect(o.materialSlotsBefore, o.id).toEqual(
        PINNED.materialSlotsBefore[o.id as keyof typeof PINNED.materialSlotsBefore],
      );
    }
  });
  runIt('each output records its merge and the slots after merge', () => {
    for (const o of read().outputs) {
      const id = o.id as keyof typeof PINNED.merge;
      expect(o.merge, o.id).toEqual(PINNED.merge[id]);
      expect(o.materialSlotsAfter, o.id).toEqual(PINNED.materialSlotsAfter[id as keyof typeof PINNED.materialSlotsAfter]);
      expect(o.materials, o.id).toBe(PINNED.materialSlotsAfter[id as keyof typeof PINNED.materialSlotsAfter].length);
    }
  });
  runIt('per-slot triangles before and after merge cover every triangle', () => {
    for (const o of read().outputs) {
      const before = o.slotTrianglesBefore.reduce((n: number, s: { triangles: number }) => n + s.triangles, 0);
      const after = o.slotTrianglesAfter.reduce((n: number, s: { triangles: number }) => n + s.triangles, 0);
      expect(before, `${o.id} before`).toBe(o.triangles);
      expect(after, `${o.id} after`).toBe(o.triangles);
    }
  });
  runIt('the verdict before merge fails exactly on the material budget for each mobile output', () => {
    for (const o of read().outputs) {
      const id = o.id as keyof typeof PINNED.beforeMergeVerdicts;
      expect(o.verdictBefore.ok, o.id).toBe(PINNED.beforeMergeVerdicts[id].ok);
      expect(
        o.verdictBefore.issues.map((i: { code: string }) => i.code),
        o.id,
      ).toEqual(PINNED.beforeMergeVerdicts[id].codes);
    }
  });
  runIt('exact UV overlap pair counts match the pinned run', () => {
    for (const o of read().outputs) {
      expect(o.exactUvOverlapPairs, o.id).toBe(
        PINNED.exactUvOverlapPairs[o.id as keyof typeof PINNED.exactUvOverlapPairs],
      );
    }
  });
  runIt('mobile-prop size sweep records each size with its verdict and issue codes', () => {
    const prop = byId(read(), 'mobile-prop');
    expect(prop.sizesTried.map((s: { size: number }) => s.size)).toEqual(PINNED.propSizesTried);
    prop.sizesTried.forEach((s: { after: { ok: boolean; issues: string[] } }, i: number) => {
      expect(s.after.ok, `size ${PINNED.propSizesTried[i]}`).toBe(PINNED.propVerdicts[i]?.ok);
      expect(s.after.issues, `size ${PINNED.propSizesTried[i]}`).toEqual(PINNED.propVerdicts[i]?.codes);
    });
  });
  runIt('the only source refusal is the named R1 receiver refusal', () => {
    expect(read().source.refusals.map((r: { id: string }) => r.id)).toEqual(PINNED.sourceRefusals);
  });
  runIt('mobile outputs carry a normal bake whose result is recorded, never silently dropped', () => {
    for (const id of ['mobile-hero', 'mobile-prop'] as const) {
      const bake = byId(read(), id).bake;
      expect(bake, id).not.toBeNull();
      expect(bake.refused, id).toBe(false);
      expect(bake.pass, id).toBe(true);
      expect(
        bake.issues.map((i: { code: string }) => i.code),
        id,
      ).toEqual(PINNED.bakeCodes[id]);
      expect(bake.resolution, id).toBe(1024);
      expect(bake.provenance.covered, id).toBeGreaterThan(0);
    }
    expect(byId(read(), 'desktop-hero').bake).toBeNull();
  });
  runIt('every cage sample hits its part: no clipped sample, no ray miss, bounded offsets', () => {
    for (const id of ['mobile-hero', 'mobile-prop'] as const) {
      const cage = byId(read(), id).bake.cage;
      expect(cage.groups.length, id).toBe(PINNED.bakeGroups);
      expect(cage.samples, id).toBeGreaterThan(400_000);
      expect(cage.clipped, id).toBe(0);
      expect(cage.clippedShare, id).toBe(0);
      expect(cage.rayMisses, id).toBe(0);
      expect(cage.maxOffset, id).toBeGreaterThan(0);
      expect(cage.maxOffset, id).toBeLessThan(PINNED.maxCageOffset);
      for (const g of cage.groups) expect(g.maxRay, `${id} ${g.id}`).toBeGreaterThanOrEqual(g.offset);
    }
  });
  runIt('the normal map brings each lit view closer to the fine picture than the flat low-poly', () => {
    for (const id of ['mobile-hero', 'mobile-prop'] as const) {
      const diff = byId(read(), id).litDifference as { view: string; flat: number; normalMapped: number }[];
      expect(diff.map((d) => d.view), id).toEqual(['iso', 'muzzle-fins', 'grip']);
      for (const d of diff) {
        expect(d.normalMapped, `${id} ${d.view}`).toBeGreaterThan(0);
        expect(d.normalMapped, `${id} ${d.view}`).toBeLessThan(d.flat);
      }
    }
  });
  runIt('OBJ face counts reproduce the triangle totals (2 per quad plus tris)', () => {
    for (const o of read().outputs) {
      expect(2 * o.files.objFaces.quads + o.files.objFaces.tris, o.id).toBe(o.triangles);
    }
  });
  runIt('OBJ, pictures, lit pictures and normal maps exist and are non-empty', () => {
    for (const o of read().outputs) {
      for (const rel of [o.files.obj, ...o.files.pictures]) {
        const path = join(DIR as string, rel);
        expect(existsSync(path), rel).toBe(true);
        expect(statSync(path).size, rel).toBeGreaterThan(0);
      }
    }
    const mobile = byId(read(), 'mobile-hero').files.pictures as string[];
    for (const name of [
      'mobile-hero/lit-desktop-hero-iso.png',
      'mobile-hero/lit-mobile-hero-flat-iso.png',
      'mobile-hero/lit-mobile-hero-normalmap-iso.png',
    ]) {
      expect(mobile, name).toContain(name);
    }
  });
  runIt('no output has exact UV overlap pairs', () => {
    for (const o of read().outputs) expect(o.exactUvOverlapPairs, o.id).toBe(0);
  });
});
