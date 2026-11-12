import { err } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { modelingError } from '../errors';
import { model } from '../model';

vi.mock('../diff', async (importOriginal) => {
  const real = await importOriginal<typeof import('../diff')>();
  return {
    ...real,
    diffMeshes: () =>
      err(modelingError('model-precondition', 'both snapshots decode', { reason: 'forced' })),
  };
});

describe('regen gate when the mesh comparison itself fails (R-M8)', () => {
  it('reports diff-failed instead of passing', async () => {
    const { regen } = await import('../regen');
    const report = regen(
      (p: { size: number }) => {
        const m = model();
        m.box({ size: [p.size, p.size, p.size], label: 'block' });
        return m;
      },
      [{ size: 1 }, { size: 2 }],
    );
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.pass).toBe(false);
    expect(report.value.findings.map((f) => f.reason)).toEqual(['diff-failed']);
    expect(report.value.findings[0]?.paramSet).toBe(1);
  });
});
