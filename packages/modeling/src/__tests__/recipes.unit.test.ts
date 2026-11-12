import type { Result } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { ModelingError } from '../errors';
import { regionGroups } from '../ops';
import {
  type BallBearingOptions,
  type CoilSpringOptions,
  type HingeOptions,
  type HydraulicCylinderOptions,
  METRIC_SIZES,
  type MetricSize,
  type RecipePart,
  recipes,
  type SlideRailOptions,
} from '../recipes';
import { sel } from '../selectors';
import { corners, expectClean } from './recipe-contract';

describe('recipes: declared parameter ranges build clean parts', () => {
  it('hydraulic cylinder', { timeout: 120000 }, () => {
    const base: HydraulicCylinderOptions = { bore: 0.05, rod: 0.025, stroke: 0.2 };
    const sets = [
      ...corners(base, {
        extension: [0, 1],
        segments: [12, 64],
        pin: [0.3 * 0.6 * 0.031, 1.19 * 0.6 * 0.031],
      }),
      { bore: 0.01, rod: 0.003, stroke: 0.01, extension: 0, segments: 12 },
      { bore: 0.3, rod: 0.21, stroke: 6, extension: 1, segments: 64 },
      { bore: 0.01, rod: 0.007, stroke: 0.2 },
    ];
    for (const options of sets) {
      const part = expectClean(JSON.stringify(options), recipes.hydraulicCylinder(options));
      const { baseEye, rodEye } = part.anchors as unknown as {
        baseEye: number[];
        rodEye: number[];
      };
      expect((rodEye[1] as number) - (baseEye[1] as number)).toBeCloseTo(
        part.dimensions.pinToPin as number,
        12,
      );
    }
    const short = expectClean('retracted', recipes.hydraulicCylinder({ ...base, extension: 0 }));
    const long = expectClean('extended', recipes.hydraulicCylinder({ ...base, extension: 1 }));
    expect(
      (long.dimensions.pinToPin as number) - (short.dimensions.pinToPin as number),
    ).toBeCloseTo(0.2, 12);
  });

  it('ball bearing', { timeout: 120000 }, () => {
    const base: BallBearingOptions = { bore: 0.02, outer: 0.047, width: 0.014 };
    const sets = [
      ...corners(base, { balls: [3, 9], segments: [24, 96], width: [0.65 * 0.0135, 1.4 * 0.0135] }),
      { bore: 0.003, outer: 0.003 * 1.6, width: 0.65 * ((0.003 * 1.6 - 0.003) / 2), segments: 24 },
      { bore: 0.3, outer: 0.3 * 3.2, width: 1.4 * ((0.3 * 3.2 - 0.3) / 2), segments: 96 },
    ];
    for (const options of sets) {
      const part = expectClean(JSON.stringify(options), recipes.ballBearing(options));
      expect(part.model.count(sel.createdBy('bearing-ball'))).toBe(
        (part.dimensions.balls as number) * 16 * 10,
      );
    }
  });

  it('hex bolt, nut and washer for every metric size', { timeout: 120000 }, () => {
    for (const size of Object.keys(METRIC_SIZES) as MetricSize[]) {
      const d = METRIC_SIZES[size].d / 1000;
      for (const options of [
        { size, length: 1.5 * d, segments: 12 },
        { size, length: 20 * d, segments: 48 },
        { size, length: 5 * d, thread: 0 },
      ]) {
        const bolt = expectClean(`${size} ${JSON.stringify(options)}`, recipes.hexBolt(options));
        const m = bolt.model;
        expect(regionGroups(m.editMesh, m.editMesh.faces(), 'perIsland')).toHaveLength(1);
        if (options.thread === 0) expect(m.count(sel.createdBy('bolt-thread'))).toBe(0);
        else expect(m.count(sel.createdBy('bolt-thread', 'groove'))).toBeGreaterThan(0);
      }
      expectClean(`${size} nut`, recipes.hexNut({ size }));
      expectClean(`${size} nut 48`, recipes.hexNut({ size, segments: 48 }));
      expectClean(`${size} washer`, recipes.washer({ size }));
    }
  });

  it('coil spring', { timeout: 120000 }, () => {
    const base: CoilSpringOptions = { radius: 0.02, wire: 0.004, pitch: 0.01, turns: 6 };
    const sets = [
      ...corners(base, {
        pitch: [0.0046, 0.024],
        turns: [0.5, 20],
        segments: [8, 24],
        wireSegments: [6, 12],
      }),
      { radius: 0.02, wire: 0.001, pitch: 0.00115, turns: 6 },
      { radius: 0.02, wire: 0.008, pitch: 0.048, turns: 6 },
      { radius: 0.002, wire: 0.0001, pitch: 0.000115, turns: 0.5, segments: 8, wireSegments: 6 },
      { radius: 0.5, wire: 0.2, pitch: 1.2, turns: 3, segments: 24, wireSegments: 12 },
    ];
    for (const options of sets) {
      const part = expectClean(JSON.stringify(options), recipes.coilSpring(options));
      const box = part.model.bounds(sel.all());
      if (!box.ok) throw box.error;
      const lead = Math.atan(options.pitch / (2 * Math.PI * options.radius));
      const expected = options.pitch * options.turns + options.wire * Math.cos(lead);
      const height = box.value.max[1] - box.value.min[1];
      expect(Math.abs(height - expected), JSON.stringify(options)).toBeLessThan(
        options.wire * 0.15,
      );
    }
  });

  it('hinge', { timeout: 120000 }, () => {
    const base: HingeOptions = { length: 0.1, leafWidth: 0.04, thickness: 0.003, pin: 0.006 };
    const sets = [
      ...corners(base, {
        knuckles: [3, 9],
        holes: [0, 6],
        openAngle: [80, 300],
        segments: [12, 48],
        leafWidth: [0.025, 0.1],
        thickness: [0.001, 0.005],
        pin: [0.002, 0.012],
        pinOverhang: [0, 0.05],
      }),
      { length: 0.02, leafWidth: 0.005, thickness: 0.0002, pin: 0.0004, knuckles: 3, holes: 1 },
      {
        length: 1,
        leafWidth: 1,
        thickness: 0.05,
        pin: 0.12,
        knuckles: 9,
        holes: 6,
        openAngle: 100,
      },
    ];
    for (const options of sets) {
      const part = expectClean(JSON.stringify(options), recipes.hinge(options));
      expect(part.model.count(sel.tag('hinge-b'))).toBeGreaterThan(0);
      for (const leaf of ['a', 'b']) {
        expect(part.model.count(sel.createdBy(`hinge-leaf-${leaf}`, 'bevel'))).toBe(
          (options.holes ?? 3) * 16,
        );
      }
      // Leaf B turns with its countersinks: every face of the B side carries the tag.
      expect(part.model.count(sel.createdBy('hinge-leaf-b').minus(sel.tag('hinge-b')))).toBe(0);
    }
  });

  it('slide rail', { timeout: 120000 }, () => {
    const base: SlideRailOptions = { length: 0.3, width: 0.02 };
    const sets = [
      ...corners(base, {
        position: [0, 1],
        height: [0.012, 0.024],
        carriage: [0.024, 0.08],
        holePitch: [0.04, 0.2],
      }),
      { length: 0.02, width: 0.005, height: 0.003, carriage: 0.006, position: 0, holePitch: 0.01 },
      { length: 3, width: 0.1, height: 0.12, carriage: 0.4, position: 1, holePitch: 1 },
    ];
    for (const options of sets) {
      const part = expectClean(JSON.stringify(options), recipes.slideRail(options));
      expect(part.model.count(sel.createdBy('rail-track', 'groove'))).toBeGreaterThan(0);
      expect(part.model.count(sel.createdBy('rail-rail', 'bevel'))).toBe(
        (part.dimensions.holes as number) * 16,
      );
    }
  });
});

describe('recipes: failures and determinism', () => {
  it('returns structured errors with the violated range', () => {
    const failures: Result<RecipePart, ModelingError>[] = [
      recipes.gear({ module: 0, teeth: 20, width: 0.01 }),
      recipes.gear({ module: 0.002, teeth: 7, width: 0.01 }),
      recipes.gear({ module: 0.002, teeth: 20.5, width: 0.01 }),
      recipes.gear({ module: 0.002, teeth: 20, width: 0.01, bore: 0.5 }),
      recipes.gear({ module: 0.002, teeth: 10, width: 0.01, webHoles: 12 }),
      recipes.hydraulicCylinder({ bore: 0.05, rod: 0.04, stroke: 0.2 }),
      recipes.hydraulicCylinder({ bore: 0.05, rod: 0.025, stroke: 0.2, extension: 1.5 }),
      recipes.ballBearing({ bore: 0.02, outer: 0.025, width: 0.01 }),
      recipes.ballBearing({ bore: 0.02, outer: 0.047, width: 0.014, balls: 40 }),
      recipes.hexBolt({ size: 'M7' as MetricSize, length: 0.02 }),
      recipes.hexBolt({ size: 'M8', length: 0.001 }),
      recipes.coilSpring({ radius: 0.02, wire: 0.004, pitch: 0.004, turns: 5 }),
      recipes.coilSpring({ radius: 0.02, wire: 0.02, pitch: 0.05, turns: 5 }),
      recipes.hinge({ length: 0.1, leafWidth: 0.04, thickness: 0.003, pin: 0.006, knuckles: 4 }),
      recipes.hinge({ length: 0.1, leafWidth: 0.04, thickness: 0.005, pin: 0.006, openAngle: 20 }),
      recipes.slideRail({ length: 0.03, width: 0.02 }),
    ];
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      if (failure.ok) continue;
      expect(['model-invalid-argument', 'model-degenerate']).toContain(failure.error.code);
      expect(failure.error.hint.length).toBeGreaterThan(0);
    }
    const range = recipes.gear({ module: 0.002, teeth: 7, width: 0.01 });
    if (range.ok) throw new Error('teeth');
    expect(range.error.detail).toMatchObject({ teeth: 7, min: 8, max: 150 });
  });

  it('builds byte-identical parts and labels every feature', { timeout: 60000 }, () => {
    const builds: [string, () => Result<RecipePart, ModelingError>, string[]][] = [
      [
        'gear',
        () =>
          recipes.gear({ module: 0.002, teeth: 30, width: 0.01, webHoles: 4, hubLength: 0.004 }),
        ['gear', 'gear-chamfer', 'gear-bore-chamfer', 'gear-hub', 'gear-hub-chamfer'],
      ],
      [
        'cylinder',
        () => recipes.hydraulicCylinder({ bore: 0.04, rod: 0.02, stroke: 0.1 }),
        ['cylinder-barrel', 'cylinder-rod', 'cylinder-eye', 'cylinder-rod-eye'],
      ],
      [
        'bearing',
        () => recipes.ballBearing({ bore: 0.01, outer: 0.026, width: 0.008 }),
        ['bearing-inner', 'bearing-outer', 'bearing-ball'],
      ],
      [
        'bolt',
        () => recipes.hexBolt({ size: 'M6', length: 0.03 }),
        ['bolt-head', 'bolt-shank', 'bolt-thread', 'bolt-chamfer'],
      ],
      ['nut', () => recipes.hexNut({ size: 'M6' }), ['nut', 'nut-chamfer']],
      [
        'spring',
        () => recipes.coilSpring({ radius: 0.01, wire: 0.002, pitch: 0.005, turns: 4 }),
        ['spring'],
      ],
      [
        'hinge',
        () => recipes.hinge({ length: 0.08, leafWidth: 0.03, thickness: 0.002, pin: 0.005 }),
        ['hinge-leaf-a', 'hinge-leaf-b', 'hinge-knuckle-a', 'hinge-knuckle-b', 'hinge-pin'],
      ],
      [
        'rail',
        () => recipes.slideRail({ length: 0.2, width: 0.015 }),
        ['rail-rail', 'rail-track', 'rail-carriage', 'rail-seal-a', 'rail-seal-b'],
      ],
    ];
    for (const [name, build, labels] of builds) {
      const a = build();
      const b = build();
      if (!a.ok || !b.ok) throw new Error(name);
      expect(a.value.model.snapshot(), name).toEqual(b.value.model.snapshot());
      const owned = a.value.model
        .inspect()
        .labels.filter((l) => Object.values(l.roles).some((n) => n > 0))
        .map((l) => l.label);
      for (const label of labels) expect(owned, name).toContain(label);
      expect(a.value.model.count(sel.tag(name)), name).toBe(a.value.model.editMesh.faceCount);
    }
  });
});
