import { model, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { deltaE00, G7_PALETTE, hairOmbre, labToLinear, linearToLab, ombreBands, ombreColours, paletteEntry, SLOT_PALETTE, skinSlots, slotColours, srgbToLinear } from '../materials.ts';
import { REF } from '../reference.ts';

/** C-200 G7 materials: the palette mapping, the measured hair ramp and the per-face ombre. */
describe('C-200 G7 materials', () => {
  it('maps every G6 slot and every palette entry', () => {
    const slots = ['skin', 'leg-skin', 'hand-skin', 'navy', 'white', 'hair', 'ribbon', 'gem', 'gold', 'shoe', 'tail', 'tail-underside'];
    for (const s of slots) expect(SLOT_PALETTE[s], s).toBeDefined();
    const used = new Set(Object.values(SLOT_PALETTE));
    // hair-tip ends the ombre; the gem, shoe and tail class medians give way to the G7 part means.
    const unused = REF.palette.map((p) => p.name).filter((n) => !used.has(n as never));
    expect(unused).toEqual(['hair-tip', 'gem', 'shoe', 'tail']);
    for (const n of Object.keys(G7_PALETTE)) expect(used.has(n as never), n).toBe(true);
    const colours = slotColours(6);
    for (const s of [...slots, 'hair-0', 'hair-5', 'Default']) expect(colours[s], s).toHaveLength(3);
  });

  it('keeps each slot colour within dE00 1 of the sheet', () => {
    const colours = slotColours();
    for (const [slot, name] of Object.entries(SLOT_PALETTE)) {
      const sheet = paletteEntry(name).srgb.map(srgbToLinear) as [number, number, number];
      expect(deltaE00(colours[slot] as [number, number, number], sheet), slot).toBeLessThanOrEqual(1);
    }
    expect(deltaE00([0.2, 0.3, 0.4], [0.2, 0.3, 0.4])).toBe(0);
    expect(deltaE00([0.5, 0.5, 0.5], [0.5, 0.2, 0.2])).toBeGreaterThan(10);
  });

  it('stores the G7 supplement as measured L*a*b* and converts it exactly', () => {
    for (const [name, { lab }] of Object.entries(G7_PALETTE)) {
      const back = linearToLab(paletteEntry(name as keyof typeof G7_PALETTE).linear);
      for (let k = 0; k < 3; k++) expect(back[k], name).toBeCloseTo(lab[k] as number, 4);
    }
    expect(labToLinear(linearToLab([0.2, 0.5, 0.9])).map((v) => Number(v.toFixed(5)))).toEqual([0.2, 0.5, 0.9]);
    // The legs sit in the skirt's shade: far from the face skin, and the hands a shade from both.
    expect(deltaE00(paletteEntry('leg-skin').linear, paletteEntry('skin').linear)).toBeGreaterThan(10);
    expect(deltaE00(paletteEntry('hand-skin').linear, paletteEntry('skin').linear)).toBeGreaterThan(3);
  });

  it('moves leg and hand skin into their slots and leaves the rest', () => {
    const m = model();
    m.box({ size: [0.1, 0.1, 0.1], center: [0, 0.1, 0], tag: 'leg-l', material: 'skin' });
    m.box({ size: [0.1, 0.1, 0.1], center: [0.3, 0.4, 0], tag: 'hand-r', material: 'skin' });
    m.box({ size: [0.1, 0.1, 0.1], center: [0, 0.7, 0], tag: 'head', material: 'skin' });
    m.box({ size: [0.1, 0.1, 0.1], center: [0, 0.25, 0], tag: 'leg-r', material: 'white' });
    expect(skinSlots(m)).toEqual({ leg: 6, hand: 6 });
    expect(m.count(sel.material('leg-skin'))).toBe(6);
    expect(m.count(sel.material('hand-skin'))).toBe(6);
    expect(m.count(sel.material('skin'))).toBe(6);
    expect(m.count(sel.material('white'))).toBe(6);
  });

  it('ramps monotonically from hair-root to hair-tip with descending bands', () => {
    const ramp = ombreColours(6);
    expect(ramp[0]).toEqual(paletteEntry('hair-root').linear);
    for (let k = 0; k < 3; k++) expect(ramp[5]?.[k]).toBeCloseTo(paletteEntry('hair-tip').linear[k] as number, 9);
    const root = ramp[0] as readonly number[];
    const dist = ramp.map((c) => deltaE00(c, root as never));
    for (let i = 1; i < dist.length; i++) expect(dist[i]).toBeGreaterThan(dist[i - 1] as number);
    const bands = ombreBands(6);
    for (let i = 1; i < bands.length; i++) expect(bands[i]?.[1]).toBe(bands[i - 1]?.[0]);
    expect(bands[0]?.[0]).toBeLessThanOrEqual(0.6);
    expect(bands[5]?.[1]).toBeGreaterThanOrEqual(0.48);
  });

  it('assigns one bucket per hair face by centroid height', () => {
    const m = model();
    m.box({ size: [0.1, 0.6, 0.1], center: [0, 0.5, 0], tag: 'hair', material: 'hair' });
    m.subdivide(sel.all(), { levels: 3 });
    const total = m.count(sel.tag('hair'));
    const counts = hairOmbre(m, 6);
    expect(m.inspect().poisoned).toBeUndefined();
    expect(counts.reduce((a, b) => a + b, 0)).toBe(total);
    expect(m.count(sel.material('hair'))).toBe(0);
  });
});
