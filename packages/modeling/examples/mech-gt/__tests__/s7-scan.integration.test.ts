import { describe, expect, it } from 'vitest';
import { buildS7 } from '../s7-motion';
import { FROZEN_PAIRS } from './s7-frozen';

/**
 * C-100 stage S7, the mech-gt gate: the whole run of the single assembly in sheet form,
 * scanned every 0.05 u with travel subdivision. It costs minutes and a large heap, so the
 * default modeling stage leaves it out; `pnpm test:modeling -- --mech-gt` runs it and every
 * mech-gt change must pass it.
 */
describe.runIf(process.env.FORGEAX_MECH_GT_SCAN === '1')('C-100 S7 whole-run scan', () => {
  it('scans the whole run clear: no confirmed interference, no clamped limit', { timeout: 1800000 }, () => {
    const s7 = buildS7('sheet');
    const scan = s7.rig.scan(s7.forward, { step: 0.05 });
    if (!scan.ok) throw scan.error;
    expect(scan.value.clamped).toEqual([]);
    const confirmed = scan.value.pairs.filter((p) => p.status === 'confirmed').map((p) => ({ name: p.parts.join(' / '), depth: p.maxDepth }));
    expect(confirmed.filter((p) => !(p.depth <= (FROZEN_PAIRS[p.name] ?? -1) + 1e-3)).map((p) => `${p.name} ${p.depth.toFixed(4)}`)).toEqual([]);
  });
});
