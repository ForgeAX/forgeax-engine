import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { Selector, sel } from '../selectors';
import type { FeatureLine } from '../surface-quality';

const crown = {
  name: 'crown',
  curve: {
    degree: 2,
    points: [
      [0, 0, 0],
      [1, 1, 0],
      [2, 0, 0],
    ] as Tuple3[],
    knots: [0, 0, 0, 1, 1, 1],
  },
} satisfies FeatureLine;

function throwing(): Selector<'face'> {
  return new Selector('face', 'throws', () => {
    throw new RangeError('Invalid array length');
  });
}

describe('operation boundary', () => {
  it('turns a thrown kernel exception into a model-internal failure and keeps the mesh', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const before = m.snapshot();
    const report = m.inset(throwing(), { thickness: 0.1, region: 'merged' });
    expect(report.status).toBe('failed');
    expect(report.error?.code).toBe('model-internal');
    expect(report.error?.detail?.cause).toContain('Invalid array length');
    expect(m.poisoned?.code).toBe('model-internal');
    expect(m.journal.at(-1)?.status).toBe('failed');
    expect(m.journal).toHaveLength(2);
    expect(m.snapshot()).toEqual(before);
    expect(m.finish({ key: 'x' }).ok).toBe(false);
  });

  it('rolls back what the throwing operation had already changed', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const before = m.snapshot();
    const faces = m.editMesh.faceCount;
    const held = m.editMesh;
    const mutating = new Selector('face', 'mutates then throws', (mesh) => {
      mesh.setPosition(0, 9, 9, 9);
      mesh.removeFace(0);
      throw new Error('boom');
    });
    expect(m.inset(mutating, { thickness: 0.1, region: 'merged' }).error?.code).toBe(
      'model-internal',
    );
    expect(m.editMesh.faceCount).toBe(faces);
    expect(m.snapshot()).toEqual(before);
    expect(m.editMesh).toBe(held);
  });

  it('lets an InvariantError from a nested operation through try() instead of swallowing it', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const corrupting = new Selector('face', 'breaks a face loop length', (mesh) => {
      mesh.fLen[0] = 99;
      return [0];
    });
    expect(() =>
      m.try((inner) => {
        inner.tag(corrupting, 'x');
      }),
    ).toThrow(/InvariantError/);
  });

  it('try() restores every collection a failed body touched', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const before = m.diagnostics();
    const attempt = m.try((inner) => {
      inner.featureLine(crown);
      inner.drawing({ name: 'sheet', views: [] } as never);
      inner.inset(sel.all(), { thickness: 5, region: 'merged' });
    });
    expect(attempt.ok).toBe(false);
    const after = m.diagnostics();
    expect(after.featureLines).toEqual(before.featureLines);
    expect(after.drawings).toEqual(before.drawings);
    expect(after.surfaces).toEqual(before.surfaces);
    expect(m.journal).toHaveLength(1);
    expect(m.poisoned).toBeUndefined();
    expect(m.featureLine(crown).status).toBe('ok');
  });

  it('try() reports a thrown body as model-internal and rolls back', () => {
    const m = model();
    m.box({ size: [1, 1, 1] });
    const before = m.snapshot();
    const attempt = m.try((inner) => {
      inner.featureLine(crown);
      inner.tag(throwing(), 'x');
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe('model-internal');
    expect(m.poisoned).toBeUndefined();
    expect(m.snapshot()).toEqual(before);
    expect(m.featureLine(crown).status).toBe('ok');
  });

  it('try() un-builds a layout so the surface can be built again', () => {
    const net: Tuple3[][] = [];
    for (let i = 0; i < 4; i++) {
      const row: Tuple3[] = [];
      for (let j = 0; j < 4; j++) row.push([i, j, 0.1 * i * j]);
      net.push(row);
    }
    const free = { u0: { free: true }, u1: { free: true }, v0: { free: true }, v1: { free: true } };
    const m = model();
    m.patchLayout({
      name: 'l',
      patches: [
        {
          id: 'A',
          role: 'primary',
          degree: [3, 3],
          net: [4, 4],
          fit: { points: net },
          sides: free,
        },
      ],
    } as never);
    const attempt = m.try((inner) => {
      inner.surface({ layout: 'l', chord: 0.05 });
      inner.tag(throwing(), 'x');
    });
    expect(attempt.ok).toBe(false);
    expect(m.diagnostics().surfaces).toHaveLength(0);
    expect(m.surface({ layout: 'l', chord: 0.05 }).status).toBe('ok');
  });

  it('keeps cancellation and budget failures poisoned without rollback', () => {
    const m = model({ budget: { faces: 3 } });
    const attempt = m.try((inner) => {
      inner.box({ size: [1, 1, 1] });
    });
    expect(attempt.ok).toBe(false);
    expect(m.poisoned?.code).toBe('model-work-budget');
  });
});
