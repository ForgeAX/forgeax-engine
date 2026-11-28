import { describe, expect, it } from 'vitest';
import { tyre, tyreSize, type WheelRimOptions, wheelRim } from '../recipes/wheel';
import { sel } from '../selectors';
import { expectClean } from './recipe-contract';

const close = (actual: number, expected: number, tolerance = 1e-12) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);

function dim(
  part: { readonly dimensions: Readonly<Record<string, number>> },
  name: string,
): number {
  const value = part.dimensions[name];
  if (value === undefined) throw new Error(`missing dimension ${name}`);
  return value;
}

const rimOptions = (offset = 0.04): WheelRimOptions => ({
  diameter: 0.4318,
  width: 0.1905,
  offset,
  pcd: 0.112,
  bolts: 5,
  boltHole: 0.012,
  centerBore: 0.0286,
  spokes: 5,
});

describe('recipes: ISO metric tyre sizes', () => {
  it('parses the closed-form 225/45R17 dimensions', () => {
    const parsed = tyreSize('225/45R17');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    close(parsed.value.sectionWidth, 0.225);
    close(parsed.value.aspectRatio, 0.45);
    close(parsed.value.sidewall, 0.10125);
    close(parsed.value.rimDiameter, 0.4318);
    close(parsed.value.overallDiameter, 0.6343);
    close(parsed.value.circumference, Math.PI * 0.6343);
  });

  it.each([
    ['P215/65R15', 0.215, 0.65, 15 * 0.0254, 'R', undefined, undefined],
    ['LT265/70R17', 0.265, 0.7, 17 * 0.0254, 'R', undefined, undefined],
    ['205/55ZR16 91W', 0.205, 0.55, 16 * 0.0254, 'R', 91, 'W'],
    ['195/65 R15', 0.195, 0.65, 15 * 0.0254, 'R', undefined, undefined],
    ['185/75D14', 0.185, 0.75, 14 * 0.0254, 'D', undefined, undefined],
    ['205/60B16', 0.205, 0.6, 16 * 0.0254, 'B', undefined, undefined],
  ] as const)('parses %s', (code, width, aspect, rim, construction, loadIndex, speedSymbol) => {
    const parsed = tyreSize(code);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    close(parsed.value.sectionWidth, width);
    close(parsed.value.aspectRatio, aspect);
    close(parsed.value.rimDiameter, rim);
    expect(parsed.value.construction).toBe(construction);
    expect(parsed.value.loadIndex).toBe(loadIndex);
    expect(parsed.value.speedSymbol).toBe(speedSymbol);
  });

  it.each([
    '',
    '22545R17',
    '225/45X17',
    '225/45R',
    '225/45R170',
    '225/45ZR17 91WZ',
    'P/LT225/45R17',
    '225/45R17 91WW',
    '225/45R17 000W',
    '999/45R17',
    '225/00R17',
    '225/45R99',
  ])('rejects malformed code %j with its source detail', (code) => {
    const parsed = tyreSize(code);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected invalid tyre code');
    expect(parsed.error.code).toBe('model-invalid-argument');
    expect(parsed.error.detail?.code).toBe(code);
  });
});

describe('recipes: tyre', () => {
  it('builds a closed, tagged solid with tread grooves, dimensions and assembly anchors', () => {
    const part = expectClean('tyre', tyre({ size: '225/45R17' }));
    const m = part.model;
    const box = m.bounds(sel.all());
    expect(box.ok).toBe(true);
    if (!box.ok) throw box.error;
    const radius = dim(part, 'overallDiameter') / 2;
    const sectionWidth = dim(part, 'sectionWidth');
    const sagitta = radius * (1 - Math.cos(Math.PI / 64)) + 1e-12;
    close(box.value.max[1] - box.value.min[1], sectionWidth, 1e-12);
    expect(box.value.max[0] - box.value.min[0]).toBeGreaterThanOrEqual(2 * radius - 2 * sagitta);
    expect(box.value.max[0] - box.value.min[0]).toBeLessThanOrEqual(2 * radius + 1e-12);
    expect(box.value.max[2] - box.value.min[2]).toBeGreaterThanOrEqual(2 * radius - 2 * sagitta);
    expect(box.value.max[2] - box.value.min[2]).toBeLessThanOrEqual(2 * radius + 1e-12);
    expect(part.anchors.center).toEqual([0, 0, 0]);
    expect(part.anchors.contact).toEqual([0, 0, -radius]);
    close(part.anchors.beadInner?.[1] as number, -dim(part, 'rimWidth') / 2);
    close(part.anchors.beadOuter?.[1] as number, dim(part, 'rimWidth') / 2);
    close(
      Math.hypot(...(part.anchors.beadInner as [number, number, number]).filter((_, i) => i !== 1)),
      dim(part, 'rimDiameter') / 2,
    );
    expect(m.count(sel.tag('tyre-tread'))).toBeGreaterThan(0);
    expect(m.count(sel.tag('tyre-sidewall'))).toBeGreaterThan(0);
    expect(m.count(sel.tag('tyre-bead'))).toBeGreaterThan(0);

    const positions = m.editMesh.vertices().map((vertex) => m.editMesh.position(vertex));
    const halfTread = dim(part, 'treadWidth') / 2;
    const grooveWidth = dim(part, 'grooveWidth');
    const grooveDepth = dim(part, 'grooveDepth');
    const crown = Math.min(0.0003, dim(part, 'treadWidth') * 0.001, dim(part, 'sidewall') * 0.003);
    const groovedBands = new Set<number>();
    for (let i = 0; i < dim(part, 'grooves'); i++) {
      const center = -halfTread + (dim(part, 'treadWidth') * (i + 1)) / (dim(part, 'grooves') + 1);
      for (const y of [center - grooveWidth / 2, center + grooveWidth / 2]) {
        const expectedRadius = radius - crown * ((y / halfTread) * (y / halfTread)) - grooveDepth;
        expect(
          positions.filter(
            (p) =>
              Math.abs(p[1] - y) < 1e-12 &&
              Math.abs(Math.hypot(p[0], p[2]) - expectedRadius) < 1e-12,
          ).length,
        ).toBeGreaterThanOrEqual(dim(part, 'segments'));
        groovedBands.add(i);
      }
    }
    expect(groovedBands.size).toBe(4);

    const repeat = tyre({ size: '225/45R17' });
    expect(repeat.ok).toBe(true);
    if (!repeat.ok) throw repeat.error;
    expect(Array.from(repeat.value.model.snapshot())).toEqual(Array.from(m.snapshot()));
  });

  it.each([
    [{ size: '225/45R17', treadWidth: 0.01 }, 'treadWidth'],
    [{ size: '225/45R17', grooves: 7 }, 'grooves'],
    [{ size: '225/45R17', grooveDepth: 0.03 }, 'grooveDepth'],
    [{ size: '225/45R17', grooveWidth: 0.04 }, 'grooveWidth'],
    [{ size: '225/45R17', rimWidth: 0.01 }, 'rimWidth'],
    [{ size: '225/45R17', shoulderRadius: 0.03 }, 'shoulderRadius'],
    [{ size: '225/45R17', segments: 16 }, 'segments'],
    [{ size: '225/45R17', grooves: 6, grooveWidth: 0.03 }, 'grooveWidth'],
    [{ size: { sectionWidth: 0.225, aspectRatio: 1.5, rimDiameter: 0.4318 } }, 'aspectRatio'],
  ] as const)('rejects tyre cross-parameter or range failure %j', (options, _parameter) => {
    const result = tyre(options);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid tyre options');
    expect(result.error.code).toBe('model-invalid-argument');
  });
});

describe('recipes: wheel rim', () => {
  it('builds an assembled closed rim with PCD anchors, bore, flange and distinct spokes', () => {
    const options = rimOptions();
    const part = expectClean('wheel rim', wheelRim(options));
    const m = part.model;
    expect(dim(part, 'flangeOuterDiameter')).toBeCloseTo(
      options.diameter + 2 * (options.flangeHeight ?? 0.0175),
      12,
    );
    expect(dim(part, 'backspacing')).toBeCloseTo(options.width / 2 + options.offset, 12);
    close(part.anchors.mount?.[1] as number, options.offset);
    for (let i = 0; i < options.bolts; i++) {
      const bolt = part.anchors[`bolt-${i}`] as [number, number, number];
      close(Math.hypot(bolt[0], bolt[2]), options.pcd / 2);
      close(bolt[1], options.offset);
      const next = part.anchors[`bolt-${(i + 1) % options.bolts}`] as [number, number, number];
      const a = Math.atan2(bolt[0], bolt[2]);
      const b = Math.atan2(next[0], next[2]);
      close((b - a + 2 * Math.PI) % (2 * Math.PI), (2 * Math.PI) / options.bolts, 1e-12);
    }
    const vertices = m.editMesh.vertices().map((vertex) => m.editMesh.position(vertex));
    const boreRadius = options.centerBore / 2;
    const boreRing = vertices.filter(
      (p) =>
        Math.abs(p[1] - options.offset) < 1e-10 &&
        Math.abs(Math.hypot(p[0], p[2]) - boreRadius) < 1e-9,
    );
    expect(boreRing.length).toBeGreaterThanOrEqual(options.segments ?? 64);
    for (let i = 0; i < options.spokes; i++) {
      expect(m.count(sel.createdBy(`wheel-rim-spoke-${i}`))).toBeGreaterThan(0);
    }
    expect(m.count(sel.tag('wheel-rim-barrel'))).toBeGreaterThan(0);
    expect(m.count(sel.tag('wheel-rim-hub'))).toBeGreaterThan(0);
    expect(m.count(sel.tag('wheel-rim-spoke'))).toBeGreaterThan(0);
  });

  it.each([0.04, -0.04])('places the mounting face and PCD plane at signed offset %s', (offset) => {
    const options = rimOptions(offset);
    const part = expectClean(`wheel rim ET ${offset}`, wheelRim(options));
    close(part.anchors.mount?.[1] as number, offset);
    for (let i = 0; i < options.bolts; i++)
      close((part.anchors[`bolt-${i}`] as [number, number, number])[1], offset);
    close(dim(part, 'backspacing'), options.width / 2 + offset);
  });

  it.each([
    [{ ...rimOptions(), diameter: 0.1 }],
    [{ ...rimOptions(), width: 0.5 }],
    [{ ...rimOptions(), offset: 0.2 }],
    [{ ...rimOptions(), pcd: 0.01 }],
    [{ ...rimOptions(), bolts: 2 }],
    [{ ...rimOptions(), boltHole: 0.04 }],
    [{ ...rimOptions(), centerBore: 0.005 }],
    [{ ...rimOptions(), spokes: 13 }],
    [{ ...rimOptions(), spokeWidth: 0.1 }],
    [{ ...rimOptions(), hubDiameter: 0.05 }],
    [{ ...rimOptions(), flangeHeight: 0.001 }],
    [{ ...rimOptions(), barrelThickness: 0.02 }],
    [{ ...rimOptions(), segments: 16 }],
    [{ ...rimOptions(), pcd: 0.04, centerBore: 0.035 }],
    [{ ...rimOptions(), bolts: 8, pcd: 0.05, boltHole: 0.02 }],
    [{ ...rimOptions(), hubDiameter: 0.12, pcd: 0.112, boltHole: 0.012 }],
    [{ ...rimOptions(), spokes: 12, spokeWidth: 0.08 }],
    [{ ...rimOptions(), offset: 0.12 }],
  ])('rejects wheel-rim range or clearance failure %j', (options) => {
    const result = wheelRim(options);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected invalid wheel rim options');
    expect(result.error.code).toBe('model-invalid-argument');
  });

  it('mates a tyre bead seat diameter and bead width to the rim dimensions', () => {
    const tyrePart = expectClean('tyre', tyre({ size: '225/45R17' }));
    const rimPart = expectClean(
      'composed wheel rim',
      wheelRim({
        ...rimOptions(),
        diameter: dim(tyrePart, 'rimDiameter'),
        width: dim(tyrePart, 'rimWidth'),
      }),
    );
    expect(dim(tyrePart, 'rimDiameter')).toBe(dim(rimPart, 'diameter'));
    expect(dim(tyrePart, 'rimWidth')).toBe(dim(rimPart, 'width'));
  });
});
