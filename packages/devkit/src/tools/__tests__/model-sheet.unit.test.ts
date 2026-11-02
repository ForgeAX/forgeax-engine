import { describe, expect, it } from 'vitest';
import { annotateView, viewFrame, viewName, viewProblem } from '../model-render.js';
import { type OrthoMapping, SheetCanvas } from '../model-sheet.js';

const blank = (w: number, h: number) => new Uint8Array(w * h * 4);
const ISO = (() => {
  const toward = [0.56, 0.42, 0.71];
  const l = Math.hypot(...toward);
  const f = toward.map((c) => c / l) as [number, number, number];
  // right = up(Y) x toward, normalized; up = toward x right.
  const r: [number, number, number] = [f[2], 0, -f[0]];
  const rl = Math.hypot(...r);
  const right = r.map((c) => c / rl) as [number, number, number];
  const up: [number, number, number] = [
    f[1] * right[2] - f[2] * right[1],
    f[2] * right[0] - f[0] * right[2],
    f[0] * right[1] - f[1] * right[0],
  ];
  return { right, up };
})();

function mapping(right: OrthoMapping['right'], up: OrthoMapping['up']): OrthoMapping {
  return { width: 480, height: 480, pixelsPerMeter: 150, center: [0, 0, 0], right, up };
}

describe('model.render sheet annotation', () => {
  it('moves a label that would cover an earlier one', () => {
    const canvas = new SheetCanvas(320, 240, blank(320, 240));
    canvas.dimension([40, 120], [280, 120], 'A 1.00 M', [1, 1, 1, 1], 14, 1);
    canvas.dimension([40, 121], [280, 121], 'B 1.00 M', [1, 1, 1, 1], 14, 1);
    const [a, b] = canvas.labels;
    if (a === undefined || b === undefined) throw new Error('two labels');
    const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    expect(overlapX <= 0 || overlapY <= 0).toBe(true);
    expect(canvas.displaced).toBe(1);
    expect(canvas.overlapping).toEqual([]);
  });

  it('labels iso views with true 3D sizes, never projected extents', () => {
    const subject = [-0.5, -0.2, -0.3, 0.5, 0.2, 0.3] as const;
    const iso = annotateView(
      blank(480, 480),
      blank(480, 480),
      mapping(ISO.right, ISO.up),
      'iso',
      subject,
      { drawings: [], contours: [] },
      [{ from: [-0.5, 0, 0], to: [0.5, 0, 0.3], label: 'brace' }],
    );
    expect(iso.extents).toBeUndefined();
    expect(iso.size?.x).toBeCloseTo(1, 9);
    expect(iso.size?.y).toBeCloseTo(0.4, 9);
    expect(iso.size?.z).toBeCloseTo(0.6, 9);
    expect(iso.measures[0]?.length).toBeCloseTo(Math.hypot(1, 0.3), 9);
    expect(iso.labels.overlapping).toEqual([]);
    const front = annotateView(
      blank(480, 480),
      blank(480, 480),
      mapping([1, 0, 0], [0, 1, 0]),
      'front',
      subject,
      { drawings: [], contours: [] },
      [],
    );
    expect(front.extents).toEqual({ horizontal: 1, vertical: expect.closeTo(0.4, 9) });
    expect(front.size).toBeUndefined();
  });
});

describe('free model.render cameras', () => {
  it('derives names and frames and rejects malformed cameras', () => {
    expect(viewName({ yaw: 90, pitch: 0 })).toBe('yaw90-pitch0');
    expect(viewName({ direction: [0, 1, 0] })).toBe('dir-0_1_0');
    expect(viewName({ name: 'sheet-front', yaw: 0, pitch: 7.4 })).toBe('sheet-front');
    const right = viewFrame('right');
    const free = viewFrame({ yaw: 90, pitch: 0 });
    for (const key of ['right', 'up', 'toward'] as const)
      free[key].forEach((c, i) => {
        expect(c).toBeCloseTo(right[key][i] as number, 12);
      });
    const down = viewFrame({ direction: [0, 1, 0] });
    expect(Math.hypot(...down.right)).toBeCloseTo(1, 12);
    expect(viewProblem({ yaw: 0, pitch: 95 })).toBeDefined();
    expect(viewProblem({ yaw: 0 })).toBeUndefined();
    expect(viewProblem({ direction: [0, 0, 0] })).toBeDefined();
    expect(viewProblem({ yaw: 0, pitch: 0, direction: [1, 0, 0] })).toBeDefined();
    expect(viewProblem({ yaw: 0, pitch: 0, extra: 1 })).toBeDefined();
    expect(viewProblem('sideways')).toBeDefined();
    expect(viewProblem({ yaw: 10, pitch: -30 })).toBeUndefined();
  });
});
