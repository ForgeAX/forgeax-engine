import { describe, expect, it } from 'vitest';
import { booleanSolids } from '../boolean';
import { box, cylinder } from '../build';
import {
  constraintsOfFace,
  deriveFeatureConstraints,
  inspectConstraints,
} from '../feature-constraints';
import { filletBox } from '../fillet-box';
import type { Shape } from '../types';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const drilled = (): Shape =>
  must(
    booleanSolids(
      must(box({ size: [2.6, 1, 1] })),
      must(cylinder({ radius: 0.3, height: 3 })),
      'difference',
    ),
  );

describe('deriveFeatureConstraints', () => {
  it('a plain box has twelve sharp edges and no trimmed face', () => {
    const set = must(deriveFeatureConstraints(must(box({ size: [1, 2, 3] }))));
    expect(set.trimmedFaces).toEqual([]);
    const sharp = set.constraints.filter((c) => c.origin === 'sharp-edge');
    expect(sharp).toHaveLength(12);
    expect(sharp.every((c) => c.kind === 'align-tangent' && c.faces.length === 2)).toBe(true);
    expect(set.constraints).toHaveLength(12);
  });

  it('a drilled box trims its two caps: one tangent and one hard even-count constraint per loop', () => {
    const shape = drilled();
    const set = must(deriveFeatureConstraints(shape));
    expect(set.trimmedFaces).toHaveLength(2);
    for (const f of set.trimmedFaces) {
      const own = constraintsOfFace(set, f).filter((c) => c.id.includes(`:trim-loop:f${f}:`));
      expect(own.filter((c) => c.kind === 'align-tangent')).toHaveLength(2);
      expect(own.filter((c) => c.kind === 'even-count' && c.hard)).toHaveLength(2);
    }
  });

  it('a trim-loop edge is not restated as a sharp-edge constraint', () => {
    const set = must(deriveFeatureConstraints(drilled()));
    const looped = new Set(
      set.constraints.filter((c) => c.origin === 'trim-loop').flatMap((c) => c.edges),
    );
    const sharp = set.constraints.filter((c) => c.origin === 'sharp-edge');
    expect(sharp).toHaveLength(4);
    expect(sharp.every((c) => !looped.has(c.edges[0] as number))).toBe(true);
  });

  it('a trim loop shares its edges with every neighbouring face (ring-id sharing)', () => {
    const shape = drilled();
    const set = must(deriveFeatureConstraints(shape));
    const bore = set.constraints.filter((c) => c.origin === 'trim-loop' && c.kind === 'even-count');
    expect(bore.length).toBeGreaterThan(0);
    for (const c of bore) {
      // every loop lies between its own face and one neighbour at least
      expect(c.faces.length).toBeGreaterThanOrEqual(2);
      expect(c.faces).toEqual([...c.faces].sort((a, b) => a - b));
    }
  });

  it('a filleted box has tangent chains and no sharp edge', () => {
    const set = must(deriveFeatureConstraints(must(filletBox({ size: [2, 3, 4], radius: 0.25 }))));
    expect(set.constraints.some((c) => c.origin === 'sharp-edge')).toBe(false);
    const chains = set.constraints.filter((c) => c.kind === 'continue-across');
    expect(chains.length).toBeGreaterThan(0);
    expect(chains.every((c) => c.origin === 'g1-chain' && c.hard === false)).toBe(true);
  });

  it('is deterministic and JSON-safe', () => {
    const a = JSON.stringify(must(inspectConstraints(drilled())));
    const b = JSON.stringify(must(inspectConstraints(drilled())));
    expect(a).toBe(b);
    const back = JSON.parse(a) as { byKind: Record<string, number> };
    expect(back.byKind['even-count']).toBeGreaterThan(0);
  });
});
