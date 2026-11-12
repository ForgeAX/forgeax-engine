import { describe, expect, it } from 'vitest';
import { type GearOptions, recipes } from '../recipes';
import { sel } from '../selectors';
import { corners, expectClean } from './recipe-contract';

const base: GearOptions = { module: 0.002, teeth: 24, width: 0.016 };
const sets: GearOptions[] = [
  ...corners(base, {
    teeth: [8, 150],
    pressureAngle: [14.5, 25],
    flankSegments: [2, 12],
    bore: [0.001, 2 * (0.024 - 0.0025 - 0.0025)],
    width: [0.004, 0.06],
    chamfer: [0, 0.25 * 0.002],
    hubLength: [0.002, 0.016],
  }),
  { module: 0.002, teeth: 30, width: 0.01, webHoles: 6, hubLength: 0.005, hubDiameter: 0.026 },
  { module: 0.0005, teeth: 8, width: 0.001, pressureAngle: 14.5, flankSegments: 2 },
  { module: 0.02, teeth: 60, width: 0.6, pressureAngle: 25, flankSegments: 12, webHoles: 12 },
  { module: 0.002, teeth: 40, width: 0.01, webHoles: 5 },
];
/** The chamfer default is 0.25 x module: its range maximum builds the base gear again. */
const unique = sets.filter(
  (options, i) =>
    sets.findIndex(
      (other) =>
        JSON.stringify({ chamfer: 0.25 * other.module, ...other }) ===
        JSON.stringify({ chamfer: 0.25 * options.module, ...options }),
    ) === i,
);

// One test per parameter set: each owns its time budget, so a loaded host spreads the
// range corners (the 150-tooth gear alone is ~3 s idle) instead of one test timing out.
describe('recipes: declared parameter ranges build clean parts (gear)', () => {
  it.each(unique.map((options) => [JSON.stringify(options), options] as const))(
    'gear %s',
    { timeout: 60000 },
    (_name, options) => {
      const part = expectClean(JSON.stringify(options), recipes.gear(options));
      expect(part.model.count(sel.createdBy('gear', 'side'))).toBeGreaterThan(options.teeth * 6);
      expect(part.dimensions.pitchRadius).toBeCloseTo((options.module * options.teeth) / 2, 12);
      const m = part.model;
      const chamfered = options.chamfer !== 0;
      expect(m.count(sel.createdBy('gear-chamfer', 'bevel')) > options.teeth * 4).toBe(chamfered);
      expect(m.count(sel.createdBy('gear-bore-chamfer', 'bevel'))).toBe(chamfered ? 64 : 0);
      const hub = (options.hubLength ?? 0) > 0;
      expect(m.count(sel.createdBy('gear-hub-chamfer', 'bevel'))).toBe(hub && chamfered ? 64 : 0);
      if (hub) {
        const box = m.bounds(sel.all());
        if (!box.ok) throw box.error;
        expect(box.value.max[2]).toBeCloseTo(options.width / 2 + (options.hubLength as number), 12);
      }
    },
  );

  it('covers every declared range corner once', () => {
    expect(unique.length).toBe(sets.length - 1);
  });
});
