import { assert, expect, it, vi } from 'vitest';
import { snapshotBackingBytes, snapshotBudgetFixture } from './scene-field-snapshot-budget.fixture';

it('rejects the omitted canonical surface bytes before cloning a retained field', async () => {
  const f = await snapshotBudgetFixture();
  const cloned = vi.spyOn(globalThis, 'structuredClone');
  try {
    const field = f.fields[0];
    assert(field);
    const legacyBytes = field.bricks.byteLength + field.values.byteLength;
    expect(snapshotBackingBytes(field)).toBeGreaterThan(legacyBytes);
    const result = f.project(legacyBytes);
    expect({
      accepted: result.ok,
      fieldCopies: cloned.mock.calls.filter(([value]) => value === field).length,
    }).toEqual({ accepted: false, fieldCopies: 0 });
    if (!result.ok) expect(result.error.code).toBe('ray-reference-limit');
  } finally {
    cloned.mockRestore();
    f.dispose();
  }
});

it('admits the complete payload at the exact backing boundary and detaches it', async () => {
  const f = await snapshotBudgetFixture();
  try {
    const field = f.fields[0];
    assert(field);
    const result = f.project(snapshotBackingBytes(field));
    assert(result.ok);
    const snapshot = result.value.sources[0]?.fieldSnapshot;
    assert(snapshot);
    expect(snapshot).not.toBe(field);
    expect(snapshotBackingBytes(snapshot)).toBe(snapshotBackingBytes(field));
    expect(snapshot.bricks).toEqual(field.bricks);
    if (field.policy.kind === 'sampled-visibility') {
      assert(snapshot.surface && field.surface);
      expect(snapshot.surface.positions).toEqual(field.surface.positions);
      expect(snapshot.surface.positions.buffer).not.toBe(field.surface.positions.buffer);
    }
  } finally {
    f.dispose();
  }
});

it('deduplicates the actual detached snapshot shared by two instances', async () => {
  const f = await snapshotBudgetFixture(2);
  try {
    const field = f.fields[0];
    assert(field);
    expect(f.fields[1]).toBe(field);
    const result = f.project(snapshotBackingBytes(field));
    assert(result.ok);
    expect(result.value.sources).toHaveLength(2);
    expect(result.value.sources[0]?.fieldSnapshot).toBe(result.value.sources[1]?.fieldSnapshot);
  } finally {
    f.dispose();
  }
});

it('does not deduplicate two distinct field allocations merely because their values match', async () => {
  const f = await snapshotBudgetFixture(2, true);
  try {
    const field = f.fields[0];
    assert(field);
    expect(f.fields[1]).not.toBe(field);
    const result = f.project(snapshotBackingBytes(field));
    expect(result.ok).toBe(false);
  } finally {
    f.dispose();
  }
});

for (const backing of ['padded', 'aliased'] as const) {
  it(`normalizes ${backing} authoring views before charging canonical field snapshots`, async () => {
    const f = await snapshotBudgetFixture(1, false, backing);
    try {
      const field = f.fields[0];
      assert(field);
      expect(field.bricks.byteOffset).toBe(0);
      expect(field.bricks.buffer.byteLength).toBe(field.bricks.byteLength);
      if (backing === 'aliased') expect(field.values.buffer).not.toBe(field.bricks.buffer);
      const bytes = snapshotBackingBytes(field);
      const result = f.project(bytes);
      assert(result.ok);
      const snapshot = result.value.sources[0]?.fieldSnapshot;
      assert(snapshot);
      expect(snapshotBackingBytes(snapshot)).toBe(bytes);
      expect(f.project(bytes - 1).ok).toBe(false);
    } finally {
      f.dispose();
    }
  });
}

it('isolates different assets before their independently versioned field snapshots', async () => {
  const f = await snapshotBudgetFixture(2, false, 'plain', true);
  try {
    const field = f.fields[0];
    assert(field);
    const second = f.fields[1];
    assert(second);
    expect(second).not.toBe(field);
    const bytes = snapshotBackingBytes(field) + snapshotBackingBytes(second);
    const warm = f.project(bytes);
    assert(warm.ok);
    expect(warm.value.sources[0]?.assetRevision).not.toBe(warm.value.sources[1]?.assetRevision);
    f.touchBoth();
    expect(f.fields[0]).not.toBe(f.fields[1]);
    const changed = f.changes(bytes);
    assert(changed.ok);
    expect(changed.value.sources).toHaveLength(2);
    expect(changed.value.sources[0]?.assetRevision).not.toBe(
      changed.value.sources[1]?.assetRevision,
    );
    expect(changed.value.sources[0]?.fieldSnapshot).not.toBe(
      changed.value.sources[1]?.fieldSnapshot,
    );
  } finally {
    f.dispose();
  }
});

it('rejects replacement growth before copying and recovers when the original field returns', async () => {
  const f = await snapshotBudgetFixture();
  try {
    const original = f.fields[0];
    assert(original);
    const budget = snapshotBackingBytes(original);
    const warm = f.project(budget);
    assert(warm.ok);
    const held = warm.value.sources[0]?.fieldSnapshot;
    assert(held);
    const oldValues = Array.from(held.values);
    await f.growFirst();
    const grown = f.fields[0];
    assert(grown);
    expect(snapshotBackingBytes(grown)).toBeGreaterThan(budget);
    const copied = vi.spyOn(globalThis, 'structuredClone');
    try {
      const rejected = f.changes(budget);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe('ray-reference-limit');
      expect(copied.mock.calls.filter(([value]) => value === grown)).toHaveLength(0);
    } finally {
      copied.mockRestore();
    }
    f.restoreFirst();
    const restored = f.project(budget);
    assert(restored.ok);
    const returned = restored.value.sources[0]?.fieldSnapshot;
    assert(returned);
    expect(snapshotBackingBytes(returned)).toBe(budget);
    expect(Array.from(held.values)).toEqual(oldValues);
  } finally {
    f.dispose();
  }
});

it('keeps shared storage admitted until the final instance leaves, then admits an empty roster', async () => {
  const f = await snapshotBudgetFixture(2);
  try {
    const field = f.fields[0];
    assert(field);
    const budget = snapshotBackingBytes(field);
    const initial = f.project(budget);
    assert(initial.ok);
    f.remove(0);
    const one = f.project(budget);
    assert(one.ok);
    expect(one.value.sources).toHaveLength(1);
    expect(one.value.sources[0]?.fieldSnapshot).toBe(initial.value.sources[0]?.fieldSnapshot);
    f.remove(1);
    const empty = f.project(budget);
    assert(empty.ok);
    expect(empty.value.sources).toHaveLength(0);
    expect(empty.value.instances).toHaveLength(0);
    expect(f.project(1).ok).toBe(true);
  } finally {
    f.dispose();
  }
});

it('reapplies the complete numeric admission after reset without mutating held snapshots', async () => {
  const f = await snapshotBudgetFixture();
  try {
    const field = f.fields[0];
    assert(field);
    const budget = snapshotBackingBytes(field);
    const initial = f.project(budget);
    assert(initial.ok);
    const held = initial.value.sources[0]?.fieldSnapshot;
    assert(held);
    f.reset();
    expect(f.project(budget - 1).ok).toBe(false);
    const recovered = f.project(budget);
    assert(recovered.ok);
    expect(recovered.value.sources[0]?.fieldSnapshot).not.toBe(held);
    expect(recovered.value.sources[0]?.fieldSnapshot).toEqual(held);
  } finally {
    f.dispose();
  }
});
