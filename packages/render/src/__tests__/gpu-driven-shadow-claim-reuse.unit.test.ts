import { expect, it } from 'vitest';
import { shadowPublicationFixture } from './gpu-driven-shadow-publication-fixture';

it('retains shared shadow projections across 60 unchanged frames and six independent views', async () => {
  const f = await shadowPublicationFixture(512);
  try {
    const first = f.prepare();
    expect(first.views.reduce((sum, view) => sum + view.submission.plan.candidateCount, 0)).toBe(
      1536 * 3,
    );
    for (let frame = 0; frame < 60; frame++) {
      const next = f.prepare();
      for (const [index, view] of next.views.entries()) {
        expect(view.submission.plan.candidateCount).toBe(
          first.views[index]?.submission.plan.candidateCount,
        );
        expect(view.bindings).toBe(first.views[index]?.bindings);
        expect(view.submission.view.visibleBuffer).toBe(
          first.views[index]?.submission.view.visibleBuffer,
        );
      }
    }
  } finally {
    f.dispose();
  }
});

it('aborts a replacement attempt and recovers the accepted shadow selections', async () => {
  const f = await shadowPublicationFixture();
  try {
    const first = f.prepare();
    const attempt = f.prepare([1], undefined, false);
    expect(attempt.frame._abortResourceReplacement).toBeDefined();
    attempt.frame._abortResourceReplacement?.();
    const retry = f.prepare();
    expect(retry.views.map((view) => view.submission.plan.candidateCount)).toEqual(
      first.views.map((view) => view.submission.plan.candidateCount),
    );
    for (let index = 0; index < 6; index += 2)
      for (const slot of f.source.slots)
        expect(
          retry.views
            .slice(index, index + 2)
            .some((view) =>
              view.submission.selection.ownsSlot(slot.snapshot, 0, slot.slot, slot.generation),
            ),
        ).toBe(true);
  } finally {
    f.dispose();
  }
});
