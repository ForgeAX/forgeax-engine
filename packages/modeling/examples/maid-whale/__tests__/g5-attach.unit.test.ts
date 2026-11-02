import { sel, type Tuple3 } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { extentAlong, lobeSection, partPoints, ringRadius, SEATS, seatGap } from '../attach-metrics.ts';
import { attachmentContacts, FLUKE, TAIL } from '../attachments.ts';
import { buildAttached } from '../g5-attach.pack.ts';
import { LANDMARK, part } from '../reference.ts';

/** C-200 G5 (structure-first): the attachments, each seated on the part it hangs on. */
describe('C-200 G5 attachments', () => {
  const m = buildAttached();
  // One validation (crossings and designed contacts) for the tests that read it.
  const v = m.validate({ contacts: attachmentContacts() });
  const bounds = (tag: string) => {
    const b = m.bounds(sel.tag(tag));
    if (!b.ok) throw b.error;
    return b.value;
  };

  it('is closed, exports, and crosses nothing beyond its designed contacts', () => {
    expect(m.poisoned).toBeUndefined();
    expect(v.closed).toBe(true);
    expect(v.issues.filter((i) => i.code === 'self-intersection')).toEqual([]);
    expect(m.toMesh().ok).toBe(true);
  });

  it('meets every designed contact (none apart, exceeded or naming an unknown part)', () => {
    const fits = (v.issues.find((i) => i.code === 'designed-contact') as { detail: { fits: { parts: string[]; status: string }[] } } | undefined)?.detail.fits ?? [];
    expect(fits.length).toBe(attachmentContacts().length);
    expect(fits.filter((f) => f.status !== 'within').map((f) => `${f.parts.join('|')}: ${f.status}`)).toEqual([]);
  });

  it('has every attached part of the breakdown as a tagged part', () => {
    for (const t of ['tail', 'fluke', 'bowtie', 'brooch', 'brooch-gem', 'back-bow', 'apron-ties', 'headdress', 'fin-l', 'fin-r', 'ribbon-l', 'ribbon-r']) expect(sel.tag(t).evaluate(m.editMesh).length, t).toBeGreaterThan(0);
  });

  it('seats every attachment on what it hangs on (no floating part)', () => {
    for (const [tag, seat] of SEATS) expect(seatGap(m, sel.tag(tag), seat), tag).toBeLessThanOrEqual(0.0005);
  });

  it('gives the tail a full body, fullest after the root (sheet: about 10 cm through)', () => {
    // Ring radii at the path's stations from where it falls over the hem to where it rises.
    const radii = [2, 3, 4, 5].map((i) => ringRadius(m, sel.createdBy('tail'), TAIL.path, i));
    expect(radii[0]).toBeGreaterThan(0.05);
    expect(radii[1]).toBeGreaterThan(0.047);
    expect(radii[2]).toBeGreaterThan(0.039);
    for (const [i, r] of radii.entries()) if (i > 0) expect(r).toBeLessThan(radii[i - 1] as number);
  });

  it('gives the fluke two broad lobes (sheet front: about 12 x 21 cm together)', () => {
    const fluke = partPoints(m, sel.tag('fluke'));
    expect(extentAlong(fluke, [1, 0, 0])).toBeGreaterThan(0.08);
    expect(extentAlong(fluke, [0, 1, 0])).toBeGreaterThan(0.18);
    // Each lobe's middle (30-70% from the tail's end to the sheet's tip) is at least 3.8 cm wide
    // in the plane of the two lobes.
    const end = TAIL.path.at(-1) as Tuple3;
    const [a, b] = FLUKE.tips as [Tuple3, Tuple3];
    const [ea, eb] = [a.map((x, i) => x - (end[i] as number)), b.map((x, i) => x - (end[i] as number))] as [number[], number[]];
    const [ax, ay, az] = ea as [number, number, number];
    const [bx, by, bz] = eb as [number, number, number];
    const normal = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx] as const;
    for (const [label, tip] of [['fluke-upper', a], ['fluke-lower', b]] as const) expect(lobeSection(m, sel.createdBy(label), end, tip, normal, 0.3, 0.7)[0], label).toBeGreaterThan(0.038);
  });

  it('makes the frill of chunky blocks, big and small alternating (sheet: 2.5-3 cm)', () => {
    const labels = m.inspect().labels.map((l) => l.label).filter((l) => l.startsWith('headdress-tooth-'));
    const heights: number[] = [];
    for (const label of labels) {
      const pts = partPoints(m, sel.createdBy(label));
      // Along the band (tangent about the head's axis) and across it (depth): near-cubic.
      const [cx, cy] = [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length - 0.775];
      const r = Math.hypot(cx, cy);
      const radial = [cx / r, cy / r, 0] as const;
      expect(extentAlong(pts, [radial[1], -radial[0], 0]), label).toBeGreaterThan(0.018);
      expect(extentAlong(pts, [0, 0, 1]), label).toBeGreaterThan(0.018);
      heights.push(extentAlong(pts, radial));
    }
    for (const [i, h] of heights.entries()) if (i > 0) expect(Math.abs(h - (heights[i - 1] as number))).toBeGreaterThan(0.004);
  });

  it('sets an oval gem about 2 cm proud of the brooch rim', () => {
    const gem = partPoints(m, sel.tag('brooch-gem'));
    expect(gem.length).toBeGreaterThan(0);
    expect(Math.max(extentAlong(gem, [1, 0, 0]), extentAlong(gem, [0, 1, 0]))).toBeGreaterThan(0.018);
    expect(Math.max(...gem.map((p) => p[2]))).toBeGreaterThan(Math.max(...partPoints(m, sel.tag('brooch')).map((p) => p[2])) + 0.003);
  });

  it('grows the tail from the skirt at a seam (one piece with it)', () => {
    const skirt = sel.createdBy('skirt').evaluate(m.editMesh);
    const connected = new Set(sel.tag('tail').connected('any').evaluate(m.editMesh));
    expect(skirt.some((f) => connected.has(f))).toBe(true);
  });

  it('matches the sheet extents of the attachments', () => {
    // Headdress: frill top (0.984) with 11-13 blocks across the front.
    expect(Math.abs(bounds('headdress').max[1] - (LANDMARK['headdress-top'] as number))).toBeLessThan(0.01);
    const teeth = m.inspect().labels.filter((l) => l.label.startsWith('headdress-tooth-')).length;
    expect(teeth).toBeGreaterThanOrEqual(11);
    expect(teeth).toBeLessThanOrEqual(13);
    // Fins out to the sheet's 0.266 (front view), from 0.695 to 0.819 tall.
    const fin = bounds('fin-l');
    expect(Math.abs(fin.max[0] - part('front', 'fin-l').bounds[2])).toBeLessThan(0.02);
    expect(Math.abs(fin.max[1] - part('front', 'fin-l').bounds[3])).toBeLessThan(0.01);
    // Tail: out to the sheet's 0.371 (front) and back to 0.407 (side); the fluke near the floor.
    const tail = bounds('tail');
    expect(Math.abs(tail.max[0] - part('front', 'tail').bounds[2])).toBeLessThan(0.02);
    expect(Math.abs(-tail.min[2] - part('right', 'tail').bounds[2])).toBeLessThan(0.02);
    expect(Math.abs(bounds('fluke').min[1] - (LANDMARK['tail-tip-side'] as number))).toBeLessThan(0.02);
    // Bowtie across 13 cm, tails to about 0.50.
    const bowtie = bounds('bowtie');
    expect(Math.abs(bowtie.max[0] - bowtie.min[0] - part('front', 'bowtie').size[0])).toBeLessThan(0.02);
    expect(Math.abs(bowtie.min[1] - part('front', 'bowtie').bounds[1])).toBeLessThan(0.02);
  });
});
