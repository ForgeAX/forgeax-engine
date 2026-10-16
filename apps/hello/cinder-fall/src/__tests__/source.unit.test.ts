import { describe, expect, it } from 'vitest';
import { parseParticleEffectSourceV3 } from '@forgeax/engine-vfx';
import { CINDER_FALL_SOURCE } from '../cast.js';

describe('Cinder Fall V3 source contract', () => {
  it('keeps the three phase emitters and bounded event/sub-emitter edges', () => {
    const parsed = parseParticleEffectSourceV3(CINDER_FALL_SOURCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.emitters.map((emitter) => emitter.id)).toEqual([
      'cinder.travel',
      'cinder.impact',
      'cinder.burn',
    ]);
    expect(parsed.value.emitters[0]?.events?.[0]?.subEmitter).toBe('cinder.impact');
    expect(parsed.value.emitters[1]?.events?.[0]?.subEmitter).toBe('cinder.burn');
  });
});
