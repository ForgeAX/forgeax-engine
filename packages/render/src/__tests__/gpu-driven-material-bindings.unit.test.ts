import { expect, it } from 'vitest';
import {
  EMPTY_MATERIAL_BINDINGS,
  ReflectionProbeBindingProjection,
} from '../gpu-driven/material-bindings';
import { buildReflectionProbeTable } from '../reflection/gpu-table';
import type { ReflectionProbeSelectionResult } from '../reflection/projection';

function table(index: number, generation = 1) {
  return buildReflectionProbeTable([
    {
      primitiveKey: '7',
      index,
      entityKey: 7,
      center: [0, 0, 0],
      halfExtents: [1, 1, 1],
      intensity: 1,
      generation,
    },
  ]);
}

it('projects a selected probe once per object independently of material Passes', () => {
  const projection = new ReflectionProbeBindingProjection();
  const selections = new Map<string, ReflectionProbeSelectionResult>([
    ['1', { kind: 'probe', entityKey: 7, normalizedDistance: 0 }],
  ]);
  expect([...projection.project(selections, table(2))]).toEqual([['1', 'probe:2']]);
  expect([...projection.project(selections, table(3))]).toEqual([['1', 'probe:3']]);
  expect(projection.project(selections, buildReflectionProbeTable([]))).toBe(
    EMPTY_MATERIAL_BINDINGS,
  );
});

it('does not revisit receivers when only the probe texture generation changes', () => {
  let reads = 0;
  class Selections extends Map<string, ReflectionProbeSelectionResult> {
    override [Symbol.iterator]() {
      reads++;
      return super[Symbol.iterator]();
    }
  }
  const selections = new Selections([
    ['1', { kind: 'probe', entityKey: 7, normalizedDistance: 0 }],
  ]);
  const projection = new ReflectionProbeBindingProjection();
  const before = projection.project(selections, table(2));
  expect(reads).toBe(1);
  expect(projection.project(selections, table(2, 99))).toBe(before);
  expect(reads).toBe(1);
});

it('keeps distinct receiver handles and adopts replacement selections', () => {
  const projection = new ReflectionProbeBindingProjection();
  const selected = { kind: 'probe' as const, entityKey: 7, normalizedDistance: 0 };
  const first = projection.project(new Map([['2', selected]]), table(2));
  expect([...first]).toEqual([['2', 'probe:2']]);
  const next = projection.project(new Map([['1', selected]]), table(2));
  expect([...next]).toEqual([['1', 'probe:2']]);
  expect([...first]).toEqual([['2', 'probe:2']]);
});

it('does no receiver iteration without a resident probe', () => {
  class Selections extends Map<string, ReflectionProbeSelectionResult> {
    override [Symbol.iterator](): MapIterator<[string, ReflectionProbeSelectionResult]> {
      throw new Error('No receiver scan is needed');
    }
  }
  const projection = new ReflectionProbeBindingProjection();
  expect(projection.project(new Selections(), buildReflectionProbeTable([]))).toBe(
    EMPTY_MATERIAL_BINDINGS,
  );
});
