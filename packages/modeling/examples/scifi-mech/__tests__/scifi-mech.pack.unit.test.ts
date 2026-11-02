import { describe, expect, it } from 'vitest';
import pack from '../scifi-mech.pack';
import { SHOW_META } from '../show';
import { C410_JOBS, C410_OUTPUTS, QUALITIES, SHOW } from '../show-job';

describe('C-410 show Pack', () => {
  it('lists its outputs without running a job: every mesh, texture and material key, in milliseconds', { timeout: 15000 }, async () => {
    const t0 = performance.now();
    const built = await pack.build({ values: {}, packageId: pack.packageId } as never);
    expect(performance.now() - t0).toBeLessThan(1500);
    if (!built.ok) throw new Error(JSON.stringify(built.error));
    const keys = Object.keys(built.value);
    for (const part of SHOW_META.parts) expect(keys).toContain(`mesh/c410-low.${part}`);
    expect(keys).toContain('mesh/c410-high');
    for (const slot of SHOW_META.slots) {
      expect(keys).toContain(slot.material);
      for (const key of Object.values(slot.maps)) expect(keys).toContain(key);
    }
    expect(keys).toContain('material/c410-plain');
    expect(keys.filter((k) => k.startsWith('texture/')).length).toBe(SHOW.sets.length * 4);
    expect(keys.filter((k) => k.startsWith('mesh/c410-low.')).length).toBe(SHOW_META.parts.length);
    expect(SHOW_META.parts.length).toBe(19);
  });

  it('names one cook job per set plus the preview, each listing distinct outputs', () => {
    expect(C410_JOBS.map((j) => j.name)).toEqual(['c410.set1', 'c410.set2', 'c410.set3', 'c410.high']);
    const all = Object.values(C410_OUTPUTS).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('keeps the texture budget: three sets of two full-size and two half-size maps; page is a quarter of full', () => {
    const bytes = (q: keyof typeof QUALITIES) => SHOW.sets.length * (2 * QUALITIES[q].resolution ** 2 + 2 * QUALITIES[q].halfMaps ** 2) * 4;
    expect(QUALITIES.full.resolution).toBe(2048);
    expect(bytes('full')).toBeLessThan(8 * 2048 ** 2 * 4 * 1.34);
    expect(bytes('page') * 4).toBe(bytes('full'));
    expect(SHOW.previewTris).toBeLessThanOrEqual(300_000);
  });

  it('has the same output keys for both qualities', async () => {
    const keys = async (quality: string) => Object.keys((await pack.build({ values: { quality }, packageId: pack.packageId } as never) as { value: object }).value).sort();
    expect(await keys('full')).toEqual(await keys('page'));
  });
});
