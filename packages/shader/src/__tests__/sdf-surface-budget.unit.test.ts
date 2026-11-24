import { expect, it } from 'vitest';
import {
  SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL,
  SDF_SURFACE_TRACE_WGSL,
} from '../sdf-surface-trace-wgsl';
import { budgetPlaneControl } from './sdf-surface-budget.fixture';

it('reaches a closer opaque thin neighbour without spending the fixed bank behind an earlier unknown bound', () => {
  const original = SDF_SURFACE_TRACE_WGSL.replace(
    'if(best.hasUncertainty==1u){traversalLimit=min(traversalLimit,best.uncertain);}',
    '',
  );
  const reference = budgetPlaneControl({ near: 0.5, budget: 4096 }, original);
  expect(reference.result.state).toBe(1);
  expect(reference.result.lower).toBe(0.5);
  const actual = budgetPlaneControl({ near: 0.5 });
  expect(actual.result.state).toBe(1);
  expect(actual.result.primitive).toBe(reference.result.primitive);
  expect(actual.result.lower).toBe(0.5);
  expect(actual.result.upper).toBe(0.5);
  expect(actual.charged).toBeLessThan(256);
});

it('retains the nearer opaque result and independent thin neighbour identity', () => {
  for (const near of [0.5, 1 - 2 ** -16]) {
    const actual = budgetPlaneControl({ near });
    expect(actual.result.state).toBe(1);
    expect(actual.result.lower).toBe(near);
    expect(actual.result.primitive).toBe(513);
    expect(actual.result.hasUncertainty).toBe(1);
    expect(actual.result.uncertain).toBe(1);
  }
});

it('keeps unknown before or exactly at an opaque boundary unavailable', () => {
  for (const near of [undefined, 1, 1 + 2 ** -16]) {
    const actual = budgetPlaneControl({ ...(near === undefined ? {} : { near }) });
    expect(actual.result.state).toBe(2);
    expect(actual.result.hasUncertainty).toBe(1);
    expect(actual.result.lower).toBe(1);
    expect(actual.result.uncertain).toBe(1);
    expect(actual.charged).toBeLessThan(256);
  }
});

it('preserves complete opaque behavior without interpreting absence as uncertainty', () => {
  const source = SDF_SURFACE_TRACE_WGSL.replace(
    'if(best.hasUncertainty==1u){traversalLimit=min(traversalLimit,best.uncertain);}',
    '',
  );
  for (const near of [undefined, 0.5]) {
    const input = { allOpaque: true, ...(near === undefined ? {} : { near }) };
    expect(budgetPlaneControl(input)).toEqual(budgetPlaneControl(input, source));
  }
});

it('does not prune an unqualified slab merely because its near estimate is late', () => {
  const actual = budgetPlaneControl({ near: 0.5, unqualifiedSlab: true, budget: 4096 });
  expect(actual.result.state).toBe(1);
  expect(actual.result.lower).toBe(0.5);
  expect(actual.triangleTests).toBe(515);
});

it('detects clipping a node whose far bound straddles an earlier opaque hit', () => {
  const anchor = 'bounds.near>traversalLimit';
  expect(SDF_SURFACE_TRACE_WGSL.split(anchor)).toHaveLength(2);
  const mutant = SDF_SURFACE_TRACE_WGSL.replace(anchor, 'bounds.far>traversalLimit');
  expect(budgetPlaneControl({ near: 0.5, straddling: true }).result.state).toBe(1);
  expect(budgetPlaneControl({ near: 0.5, straddling: true }, mutant).result.state).not.toBe(1);
});

it('reaches the near opaque sibling before spending the bank on certified far false positives', () => {
  const input = { near: 0.5, allOpaque: true, firstTriangleMisses: true };
  const originalFull = budgetPlaneControl({ ...input, budget: 4096 });
  expect(originalFull.result.state).toBe(1);
  expect(originalFull.result.lower).toBe(0.5);
  expect(originalFull.result.upper).toBe(0.5);
  const fixedBank = budgetPlaneControl(input, SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL);
  expect(fixedBank.result.state).toBe(1);
  expect(fixedBank.result.primitive).toBe(originalFull.result.primitive);
  expect(fixedBank.result.lower).toBe(originalFull.result.lower);
  expect(fixedBank.result.upper).toBe(originalFull.result.upper);
  expect(fixedBank.charged).toBeLessThan(256);
  expect(fixedBank.charged).toBe(fixedBank.nodeTests + fixedBank.triangleTests);
});

it('continues with the postponed root child when the nearer enclosure contains no hit', () => {
  const input = { near: 0.5, allOpaque: true, nearTrianglesMiss: true };
  const actual = budgetPlaneControl(input, SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL);
  expect(actual.result).toEqual(budgetPlaneControl(input).result);
  expect(actual.result).toMatchObject({ state: 1, primitive: 0, lower: 1, upper: 1 });
  expect(actual.charged).toBe(actual.nodeTests + actual.triangleTests);
});

it('retains preorder for an equal or invalid nominal sibling rank', () => {
  for (const input of [{ near: 1 }, { near: 0.5, invalidRank: true }]) {
    const control = { ...input, allOpaque: true, firstTriangleMisses: true };
    const actual = budgetPlaneControl(control, SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL);
    expect(actual.result).toEqual(budgetPlaneControl(control).result);
    expect(actual.result.state).toBe(3);
    expect(actual.charged).toBe(256);
    expect(actual.charged).toBe(actual.nodeTests + actual.triangleTests);
    expect(actual.maximumDeferred).toBe(0);
  }
});

it('orders overlapping siblings without using the nominal rank as a cull', () => {
  const input = { near: 0.5, straddling: true, allOpaque: true, firstTriangleMisses: true };
  const exact = budgetPlaneControl({ ...input, budget: 4096 });
  const actual = budgetPlaneControl(input, SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL);
  expect(actual.maximumDeferred).toBeGreaterThan(0);
  expect(actual.result).toEqual(exact.result);
  expect(actual.result).toMatchObject({ state: 1, primitive: 513, lower: 0.5, upper: 0.5 });
  expect(actual.charged).toBe(actual.nodeTests + actual.triangleTests);

  const unqualified = budgetPlaneControl(
    { ...input, unqualifiedSlab: true },
    SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL,
  );
  expect(unqualified.maximumDeferred).toBeGreaterThan(0);
  expect(unqualified.result.state).toBe(3);
  expect(unqualified.charged).toBe(256);
});

it('falls back at six pending siblings and completes every deferred subtree once', () => {
  const input = { near: 0.5, allOpaque: true, firstTriangleMisses: true, nestedReversals: 8 };
  const reference = budgetPlaneControl({ ...input, budget: 4096 });
  const actual = budgetPlaneControl(input, SDF_SURFACE_TRACE_HINTED_RECEIVER_WGSL);
  expect(actual.result).toEqual(reference.result);
  expect(actual.result).toMatchObject({ state: 1, primitive: 513, lower: 0.5, upper: 0.5 });
  expect(actual.maximumDeferred).toBe(6);
  expect(actual.rankTests).toBeGreaterThanOrEqual(6);
  expect(actual.charged).toBe(actual.nodeTests + actual.triangleTests);
  expect(actual.charged).toBeLessThan(256);
});
