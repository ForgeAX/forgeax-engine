import { expect, it } from 'vitest';
import { shadowPublicationFixture } from './gpu-driven-shadow-publication-fixture';

it('selects per-view caster membership without altering the source or main draw selection', async () => {
  const f = await shadowPublicationFixture();
  try {
    const before = f.prepare();
    expect(before.views).toHaveLength(6);
    for (let index = 0; index < 6; index += 2)
      expect(
        (before.views[index]?.submission.plan.candidateCount ?? 0) +
          (before.views[index + 1]?.submission.plan.candidateCount ?? 0),
      ).toBe(48);
    const selected = f.prepare([1]);
    for (let index = 0; index < 6; index += 2) {
      const layers = selected.views.slice(index, index + 2);
      expect(layers.reduce((total, view) => total + view.submission.plan.candidateCount, 0)).toBe(
        16,
      );
      for (const slot of f.source.slots)
        expect(
          layers.some((view) =>
            view.submission.selection.ownsSlot(slot.snapshot, 0, slot.slot, slot.generation),
          ),
        ).toBe(slot.slot === 1);
    }
    expect(f.input.scene.plan.candidateCount).toBe(48);
    expect(before.views.reduce((sum, view) => sum + view.submission.plan.candidateCount, 0)).toBe(
      48 * 3,
    );
    for (const view of f.prepare([]).views) expect(view.submission.plan.candidateCount).toBe(0);
    expect(
      f.prepare().views.reduce((sum, view) => sum + view.submission.plan.candidateCount, 0),
    ).toBe(48 * 3);
  } finally {
    f.dispose();
  }
});

it('withdraws and restores a shared shadow Pass without enumerating object membership', async () => {
  const f = await shadowPublicationFixture(2048);
  try {
    const accepted = f.source.material.snapshot;
    f.prepare();
    f.source.material.adopt({
      ...accepted,
      passes: accepted.passes.filter((pass) => pass.name !== 'shadow'),
      materialProgramKeys: { forward: 'forgeax::default-standard-pbr' },
    });
    f.scene.sync({ ...f.projection.apply([]), materialUpdates: [f.source.material] }).unwrap();
    const off = f.prepare();
    for (const view of off.views)
      for (const slot of f.source.slots)
        expect(
          view.submission.selection.ownsSlot(slot.snapshot, 0, slot.slot, slot.generation),
        ).toBe(false);
    f.source.material.adopt(accepted);
    f.scene.sync({ ...f.projection.apply([]), materialUpdates: [f.source.material] }).unwrap();
    expect(
      f.prepare().views.reduce((sum, view) => sum + view.submission.plan.candidateCount, 0),
    ).toBe(6144 * 3);
  } finally {
    f.dispose();
  }
});
