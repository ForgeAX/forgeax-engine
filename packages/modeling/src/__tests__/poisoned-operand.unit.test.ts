import { describe, expect, it } from 'vitest';
import { bakeMaps } from '../bake';
import { model } from '../model';
import { sel } from '../selectors';

/** A session that built panels, then failed: its snapshot is the partial state (B11b R-1). */
function poisoned() {
  const part = model();
  part.box({ size: [0.2, 0.2, 0.2], tag: 'panel' });
  part.extrude(sel.tag('missing'), { distance: 0.1, region: 'merged' });
  return part;
}

describe('a poisoned session snapshot is a failing operand (B11b R-1)', () => {
  it('append, array, booleans and shrinkwrap fail with the cause instead of adding partial geometry', () => {
    const bytes = poisoned().snapshot();
    const calls = [
      (m: ReturnType<typeof model>) => m.append(bytes),
      (m: ReturnType<typeof model>) => m.array(bytes, { linear: { count: 2, offset: [1, 0, 0] } }),
      (m: ReturnType<typeof model>) => m.union(bytes),
      (m: ReturnType<typeof model>) => m.shrinkwrap(sel.all(), { onto: bytes }),
    ];
    for (const call of calls) {
      const m = model();
      m.box({ size: [1, 1, 1] });
      const faces = m.editMesh.faceCount;
      const r = call(m);
      expect(r.status).toBe('failed');
      expect(r.error?.code).toBe('model-precondition');
      expect(r.error?.detail).toMatchObject({ cause: 'model-selection-empty' });
      expect(m.editMesh.faceCount).toBe(faces);
    }
  });

  it('bake refuses it too; snapshots of healthy sessions still work', () => {
    const base = model();
    base.box({ size: [1, 1, 1] });
    base.uv.project({ mode: 'box', scale: 1 });
    const baked = bakeMaps({
      base,
      detail: poisoned().snapshot(),
      maps: ['ao'],
      resolution: 16,
    } as never);
    expect(baked.ok).toBe(false);
    if (!baked.ok) expect(baked.error.code).toBe('model-precondition');
    const healthy = model();
    healthy.box({ size: [0.2, 0.2, 0.2] });
    const m = model();
    expect(m.append(healthy.snapshot()).status).toBe('ok');
  });
});
