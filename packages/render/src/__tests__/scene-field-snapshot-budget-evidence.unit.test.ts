import { assert, expect, it, vi } from 'vitest';
import { snapshotBudgetFixture } from './scene-field-snapshot-budget.fixture';
import { saveSnapshotBudgetEvidence } from './scene-field-snapshot-budget-evidence.fixture';

it('rejects an actually captured full surface snapshot exceeding the unchanged legacy budget', async () => {
  const f = await snapshotBudgetFixture();
  const cloned = vi.spyOn(globalThis, 'structuredClone');
  try {
    const field = f.fields[0];
    assert(field);
    const budget = field.bricks.byteLength + field.values.byteLength;
    const result = f.project(budget);
    const fieldCopies = cloned.mock.calls.filter(([value]) => value === field).length;
    saveSnapshotBudgetEvidence(
      f.fields,
      result.ok ? result.value.sources.map((source) => source.fieldSnapshot) : [],
      budget,
      result.ok,
      fieldCopies,
    );
    expect({ accepted: result.ok, fieldCopies }).toEqual({ accepted: false, fieldCopies: 0 });
  } finally {
    cloned.mockRestore();
    f.dispose();
  }
});
