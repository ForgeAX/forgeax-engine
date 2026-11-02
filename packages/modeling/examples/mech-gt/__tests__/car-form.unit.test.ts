import { model, rig, sel } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildS3Car, buildS3Mech } from '../s3-rough';
import { buildS5Internals } from '../s5-chassis';
import { buildS5JointsStowed } from '../s5-joints';

/**
 * C-100 car form at rest: every stowed mech volume (S3), every S5 internal part
 * and every S5 joint mechanism, placed at its joint's car-form frame, inside the S3 panels
 * (sheet form, so a thin panel's reach is measured) with no confirmed interference.
 */
describe('C-100 car form: stowed mech, internals and joint mechanisms inside the S3 body', () => {
  it('has no confirmed interference at rest', { timeout: 600000 }, () => {
    const m = model();
    m.append(buildS3Car(() => model(), 'sheet').snapshot());
    m.append(buildS3Mech().snapshot());
    m.append(buildS5Internals().snapshot());
    m.append(buildS5JointsStowed().snapshot());
    const parts = m.inspect().tags.filter((t) => t.startsWith('part:')).map((t) => t.slice(5));
    const r = rig(m, { joints: [{ name: 'car', parent: null, position: [0, 0, 0] }] });
    for (const p of parts) r.bindRigid(sel.tag(`part:${p}`), 'car', { part: p });
    const rest = r.interference({});
    if (!rest.ok) throw rest.error;
    const confirmed = rest.value.pairs.filter((p) => p.status === 'confirmed').map((p) => `${p.parts.join(' / ')} ${p.depth.toFixed(3)}`);
    expect(confirmed.join('\n')).toBe('');
  });
});
