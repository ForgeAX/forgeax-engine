import { type Model, model } from '@forgeax/engine-modeling';
import { describe, expect, it } from 'vitest';
import { buildWheelRim, type WheelRimParameters } from '../wheel-rim';

/**
 * The seven in-range parameter sets (of 186 sampled) on which the TS boolean left an
 * open seam before the seam-vertex collapse (case wheel-rim).
 */
const FAILED: readonly (WheelRimParameters & { readonly session: string })[] = [
  { diameter: 0.557057191471689, width: 0.29197133084636706, spokes: 10, offset: 0.039807535475030326, session: 'windows' },
  { diameter: 0.5586259297008747, width: 0.22920060325115946, spokes: 10, offset: 0.031817789418538, session: 'windows' },
  { diameter: 0.5541175328787964, width: 0.25541886741287023, spokes: 8, offset: 0.026282992719804398, session: 'lug-seats' },
  { diameter: 0.4746595169431807, width: 0.22982658004771292, spokes: 9, offset: 0.059998784940689234, session: 'lugs' },
  { diameter: 0.5583155157526561, width: 0.3117915686150974, spokes: 10, offset: 0.05617329435244822, session: 'windows' },
  { diameter: 0.5581957345199751, width: 0.20833759652764425, spokes: 10, offset: 0.059813494030299355, session: 'windows' },
  { diameter: 0.52170118479305, width: 0.32946602098963507, spokes: 10, offset: 0.02796421533821347, session: 'windows' },
];

describe('C-101 wheel rim over the parameter sets that once left open boolean seams', () => {
  for (const { session, ...p } of FAILED) {
    it(`builds ${p.spokes} spokes at ${(p.diameter / 0.0254).toFixed(2)} in (was ${session})`, { timeout: 120000 }, () => {
      const sessions = new Map<string, Model>();
      const rim = buildWheelRim(p, (name) => {
        const m = model();
        sessions.set(name, m);
        return m;
      });
      const poisoned = [...sessions].filter(([, m]) => m.poisoned !== undefined).map(([name, m]) => `${name}: ${m.poisoned?.code}`);
      expect(poisoned).toEqual([]);
      const v = rim.validate();
      expect(v.closed).toBe(true);
      expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
    });
  }
});
