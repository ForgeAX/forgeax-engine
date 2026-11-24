import { expect, it } from 'vitest';
import {
  createSurfaceAcceptEvaluator,
  type SurfaceAcceptTuple,
} from '../../../../shader/src/__tests__/sdf-surface-accept.fixture';
import { SDF_SURFACE_TRACE_WGSL } from '../../../../shader/src/sdf-surface-trace-wgsl';
import { SDF_SCENE_SURFACE_TRACE_WGSL } from '../../raytracing/sdf-surface-trace';

/** Execute only the actual final state/copy/min branch. These exact f32 inputs
 * test aggregation, not triangle reachability, BVH traversal or GPU arithmetic. */
function finish(source: string, name: string, best: SurfaceAcceptTuple, last: number) {
  const start = source.indexOf(`fn ${name}(`);
  if (start < 0) throw new Error('Owning trace function required');
  const opening = source.indexOf('{', start);
  let depth = 1;
  let end = opening + 1;
  for (; depth > 0 && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  if (depth !== 0) throw new Error('Complete owning function required');
  const owner = source.slice(start, end);
  const branch = owner.lastIndexOf('\n if(best.');
  if (branch < 0) throw new Error('Owning final aggregation branch required');
  const body = owner.slice(branch, owner.lastIndexOf('}'));
  const permitted = new Set([
    'if',
    'best',
    'state',
    'lower',
    'upper',
    'uncertain',
    'hasUncertainty',
    'last',
    'ray',
    'tMax',
    'return',
    'min',
  ]);
  const normalized = body.replace(/\b(\d+)u\b/g, '$1');
  for (const token of normalized.matchAll(/\b[A-Za-z_]\w*\b/g))
    if (!permitted.has(token[0])) throw new Error('Unsupported aggregation operation');
  if (/[^\s\w().,;{}=!<>&]/.test(normalized)) throw new Error('Unsupported aggregation syntax');
  const values: readonly number[] = best;
  const record = {
    state: best[0],
    lower: best[4],
    upper: best[5],
    uncertain: best[6],
    hasUncertainty: values[9],
  };
  const invoke = new Function('best', 'last', 'ray', 'min', normalized) as (
    value: typeof record,
    end: number,
    ray: { tMax: number },
    minimum: typeof Math.min,
  ) => typeof record;
  return invoke(record, last, { tMax: last }, Math.min);
}

const owners = [
  [SDF_SURFACE_TRACE_WGSL, 'sdfSurfaceTraceRow'],
  [SDF_SCENE_SURFACE_TRACE_WGSL, 'sdfSceneSurfaceTraceRows'],
] as const;

it('keeps a closed-end unknown distinct from an entirely clear trace', () => {
  expect(SDF_SCENE_SURFACE_TRACE_WGSL).toContain(
    'return sdfSceneSurfaceTraceRows(ray,count,remaining,&candidates);',
  );
  const accept = createSurfaceAcceptEvaluator();
  for (const last of [0, 1, -1, 128]) {
    const empty: SurfaceAcceptTuple = [0, 0xffffffff, 0xffffffff, 0, last, last, last, 0, 0, 0];
    const unknown: SurfaceAcceptTuple = [2, 0, 0, 1, last, last, last, 0, 0, 0];
    for (const [source, owner] of owners) {
      expect(finish(source, owner, empty, last).state, `${owner}: clear ${last}`).toBe(0);
      expect(
        finish(source, owner, accept(empty, unknown), last).state,
        `${owner}: closed endpoint ${last}`,
      ).toBe(2);
    }
  }
});

it('preserves a known hit enclosure when uncertainty overlaps or lies behind it', () => {
  const accept = createSurfaceAcceptEvaluator();
  const best: SurfaceAcceptTuple = [1, 0, 0, 1, 0.25, 0.75, 1, 0, 0, 0];
  for (const [source, owner] of owners) {
    const overlap: SurfaceAcceptTuple = [2, 1, 1, 0, 0.5, 0.5, 1, 0, 0, 0];
    const result = finish(source, owner, accept(best, overlap), 1);
    expect(result.state, owner).toBe(2);
    expect(result.lower, owner).toBe(0.25);
    expect(result.upper, owner).toBe(0.75);
    const behind: SurfaceAcceptTuple = [2, 1, 1, 0, 1, 1, 1, 0, 0, 0];
    expect(finish(source, owner, accept(best, behind), 1).state, owner).toBe(1);
  }
});
