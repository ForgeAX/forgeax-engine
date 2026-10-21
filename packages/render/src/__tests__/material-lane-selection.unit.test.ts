import { describe, expect, it } from 'vitest';
import {
  buildMatchedMaterialHandlesByRenderable,
  filterDispatchBySelector,
} from '../record/shadow-pass';
import type { DispatchEntry } from '../render-system-extract';

function entry(renderableIndex: number, materialHandle: number, lightMode: string): DispatchEntry {
  return {
    entityIndex: renderableIndex,
    renderableIndex,
    materialHandle,
    passIndex: 0,
    queue: 2000,
    layer: 0,
    tags: { LightMode: lightMode },
    renderState: undefined,
    defines: undefined,
    vertexEntry: 'vs_main',
    fragmentEntry: lightMode === 'Deferred' ? 'fs_gbuffer' : 'fs_main',
    materialShaderId: 'forgeax::default-standard-pbr',
  };
}

describe('material membership across graph lanes', () => {
  const dispatch = [
    entry(0, 1, 'Forward'),
    entry(0, 1, 'Deferred'),
    entry(0, 2, 'Forward'),
    entry(1, 2, 'Deferred'),
    entry(1, 3, 'Forward'),
  ];
  it('selects G-buffer entries by renderable and material without admitting Forward-only slots', () => {
    const selected = buildMatchedMaterialHandlesByRenderable(dispatch, { LightMode: ['Deferred'] });
    expect([...(selected ?? [])].map(([index, handles]) => [index, [...handles]])).toEqual([
      [0, [1]],
      [1, [2]],
    ]);
    const draws = filterDispatchBySelector(dispatch, { LightMode: ['Deferred'] }).filter((draw) =>
      selected?.get(draw.renderableIndex)?.has(draw.materialHandle),
    );
    expect(draws.map((draw) => draw.fragmentEntry)).toEqual(['fs_gbuffer', 'fs_gbuffer']);
  });
  it('keeps the later Forward-only lane disjoint from Deferred membership', () => {
    const selected = buildMatchedMaterialHandlesByRenderable(
      dispatch,
      { LightMode: ['Forward'] },
      { LightMode: ['Deferred'] },
    );
    expect([...(selected ?? [])].map(([index, handles]) => [index, [...handles]])).toEqual([
      [0, [2]],
      [1, [3]],
    ]);
  });
});

it('shares immutable singleton membership without coupling exclusions or later selections', () => {
  const selected = buildMatchedMaterialHandlesByRenderable(
    [
      entry(0, 1, 'Forward'),
      entry(1, 1, 'Forward'),
      entry(2, 1, 'Forward'),
      entry(2, 2, 'Forward'),
      entry(0, 1, 'Deferred'),
    ],
    { LightMode: ['Forward'] },
    { LightMode: ['Deferred'] },
  );
  expect(selected?.has(0)).toBe(false);
  const first = selected?.get(1),
    multiple = selected?.get(2);
  if (first === undefined || multiple === undefined) throw new Error('missing material membership');
  expect([...first]).toEqual([1]);
  expect([...multiple]).toEqual([1, 2]);
  const shared = buildMatchedMaterialHandlesByRenderable(
    [
      entry(0, NaN, 'Forward'),
      entry(1, NaN, 'Forward'),
      entry(2, -0, 'Forward'),
      entry(2, 0, 'Forward'),
    ],
    { LightMode: ['Forward'] },
  );
  expect(shared?.get(0)).toBe(shared?.get(1));
  expect(shared?.get(0)?.has(NaN)).toBe(true);
  const zero = shared?.get(2);
  if (zero === undefined) throw new Error('missing zero membership');
  expect(zero.size).toBe(1);
  expect(Object.is([...zero][0], -0)).toBe(false);
  const pair = zero.entries().next().value;
  if (pair === undefined) throw new Error('missing membership entry');
  pair[0] = 99;
  expect(zero.has(0)).toBe(true);
  expect(Object.isFrozen(zero)).toBe(true);
  expect(
    buildMatchedMaterialHandlesByRenderable([entry(0, 9, 'Forward')], { LightMode: ['Forward'] })
      ?.get(0)
      ?.has(9),
  ).toBe(true);
  expect(shared?.get(0)?.has(NaN)).toBe(true);
});
