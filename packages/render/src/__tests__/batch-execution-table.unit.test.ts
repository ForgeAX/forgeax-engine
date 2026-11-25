import { describe, expect, it } from 'vitest';
import { BatchExecutionTable } from '../gpu-driven/batch-execution-table';
import type { GpuDrivenBatchBinding } from '../gpu-driven/batch-topology';
import type { BatchExecutions } from '../gpu-driven/material-artifacts';

function execution(): BatchExecutions {
  return { forward: { route: 'none' }, shadow: { route: 'none' } };
}

describe('published batch executions', () => {
  it('keeps first insertion order and last values through sparse and dense edits', () => {
    const bindings = Array.from({ length: 97 }, () => ({}) as GpuDrivenBatchBinding);
    const last = bindings[96] as GpuDrivenBatchBinding;
    const first = bindings[0] as GpuDrivenBatchBinding;
    const expected = new Map<GpuDrivenBatchBinding, BatchExecutions>();
    const before = BatchExecutionTable.collect(
      [...bindings, first, last],
      (b) => b,
      (b) => {
        const value = execution();
        expected.set(b, value);
        return value;
      },
    );
    expect([...before]).toEqual([...expected]);
    expect(before.reconcile((prior) => prior)).toBe(before);
    const sparse = before.reconcile((prior, binding) =>
      binding === first || binding === last ? execution() : prior,
    );
    const dense = sparse.reconcile(() => execution());
    const visited: GpuDrivenBatchBinding[] = [];
    sparse.forEach((value, binding, map) => {
      visited.push(binding);
      expect(map).toBe(sparse);
      expect(sparse.get(binding)).toBe(value);
      expect(before.get(binding)).toBe(expected.get(binding));
      expect(value === before.get(binding)).toBe(binding !== first && binding !== last);
      expect(dense.get(binding)).not.toBe(value);
    });
    const changed: GpuDrivenBatchBinding[] = [];
    expect(
      sparse.visitChanges(before, (binding, prior, after) => {
        changed.push(binding);
        expect(prior).toBe(before.get(binding));
        expect(after).toBe(sparse.get(binding));
      }),
    ).toBe(true);
    expect(changed).toEqual([first, last]);
    expect(
      sparse.visitChanges(expected, () => {
        throw new Error('unrelated roster');
      }),
    ).toBe(false);
    expect(visited).toEqual(bindings);
    expect([...dense.values()]).toEqual(bindings.map((binding) => dense.get(binding)));
    expect([...dense.keys()]).toEqual(bindings);
    expect(before.get({} as GpuDrivenBatchBinding)).toBeUndefined();
  });
});
