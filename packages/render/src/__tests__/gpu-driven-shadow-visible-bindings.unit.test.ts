import { expect, it } from 'vitest';
import { shadowPublicationFixture } from './gpu-driven-shadow-publication-fixture';

it('keeps shadow bindings valid across object binding splits, rejoin and caster visibility changes', async () => {
  const f = await shadowPublicationFixture();
  try {
    const before = f.prepare();
    const split = new Map([
      ['0:1', 'A'],
      ['0:2', 'B'],
      ['0:3', 'A'],
    ]);
    const changed = f.prepare(undefined, split);
    expect(changed.views.reduce((sum, view) => sum + view.submission.plan.candidateCount, 0)).toBe(
      48 * 3,
    );
    for (const view of changed.views) {
      expect(view.bindings.size).toBe(view.submission.plan.batches.length);
      for (const batch of view.submission.plan.batches)
        expect(view.bindings.has(batch.batchId)).toBe(true);
    }
    expect(
      f
        .prepare([0], split)
        .views.reduce((sum, view) => sum + view.submission.plan.candidateCount, 0),
    ).toBe(16 * 3);
    const restored = f.prepare();
    expect(restored.views.map((view) => view.submission.plan.candidateCount)).toEqual(
      before.views.map((view) => view.submission.plan.candidateCount),
    );
    const steady = f.prepare();
    steady.views.forEach((view, index) => {
      expect(view.bindings).toBe(restored.views[index]?.bindings);
    });
  } finally {
    f.dispose();
  }
});
