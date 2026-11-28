import { describe, expect, it } from 'vitest';
import { buildBracket, HOLED_BRACKET_STEPS } from '../../../examples/planar-boolean/bracket';
import { tessellate } from '../tessellate';
import type { Shape } from '../types';
import { validate } from '../validate';

function boundaryEdges(shape: Shape): number {
  const result = tessellate(shape);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  const mesh = result.value;
  const uses = new Map<string, number>();
  for (const face of mesh.faces()) {
    const vertices = mesh.faceVertices(face);
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i] as number;
      const b = vertices[(i + 1) % vertices.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  return [...uses.values()].filter((count) => count !== 2).length;
}

describe('multi-feature bracket built by chained planar booleans', () => {
  const stages = buildBracket();

  it('has the expected face count after every feature', () => {
    expect(stages.map((s) => [s.name, s.faces])).toEqual([
      ['plate', 6],
      ['wall', 14],
      ['groove', 18],
      ['boss', 24],
      ['gusset', 27],
      ['pocket', 32],
    ]);
  });

  it('keeps every intermediate solid valid and watertight', () => {
    for (const stage of stages) {
      expect(validate(stage.shape).ok, stage.name).toBe(true);
      expect(boundaryEdges(stage.shape), stage.name).toBe(0);
    }
  });

  it('matches an analytic CSG grid volume at every step (2 percent)', () => {
    for (const stage of stages) {
      expect(Math.abs(stage.volume - stage.gridVolume) / stage.gridVolume, stage.name).toBeLessThan(
        0.02,
      );
    }
  });

  it('matches the exact box inclusion-exclusion volumes for the box-only steps', () => {
    const byName = new Map(stages.map((s) => [s.name, s.volume]));
    expect(byName.get('wall')).toBeCloseTo(48 + 5.6 * 0.8 * 3.8 - 5.6 * 0.4 * 2, 9);
    expect(byName.get('groove')).toBeCloseTo(60.544 - 0.8 * 3.4 * 0.8, 9);
  });
});

describe('bracket with the pocket cut mid-chain (holed faces as later operands)', () => {
  const stages = buildBracket(HOLED_BRACKET_STEPS);

  it('has the expected face count after every feature', () => {
    expect(stages.map((s) => [s.name, s.faces])).toEqual([
      ['plate', 6],
      ['wall', 14],
      ['boss', 20],
      ['pocket', 25],
      ['groove', 29],
      ['gusset', 32],
    ]);
  });

  it('keeps every intermediate solid valid, watertight and within 2 percent of the CSG grid volume', () => {
    for (const stage of stages) {
      expect(validate(stage.shape).ok, stage.name).toBe(true);
      expect(boundaryEdges(stage.shape), stage.name).toBe(0);
      expect(Math.abs(stage.volume - stage.gridVolume) / stage.gridVolume, stage.name).toBeLessThan(
        0.02,
      );
    }
  });

  it('matches exact inclusion-exclusion volumes and keeps one holed face to the end', () => {
    const byName = new Map(stages.map((s) => [s.name, s.volume]));
    expect(byName.get('boss')).toBeCloseTo(60.544 + 1.2 * 1.2 * 1.5 - 1.2 * 0.6 * 0.7, 9);
    expect(byName.get('pocket')).toBeCloseTo(62.2 - 0.5 * 0.5 * 0.5, 9);
    expect(byName.get('groove')).toBeCloseTo(62.075 - 0.8 * 3.4 * 0.8, 9);
    for (const name of ['pocket', 'groove', 'gusset']) {
      const stage = stages.find((s) => s.name === name);
      expect(stage?.shape.faces.filter((f) => f.loops.length > 1).length, name).toBe(1);
    }
  });

  it('agrees with the original step order on the final volume', () => {
    const original = buildBracket();
    const last = (list: typeof stages) => (list[list.length - 1] as (typeof stages)[number]).volume;
    expect(last(stages)).toBeCloseTo(last(original), 6);
  });
});
