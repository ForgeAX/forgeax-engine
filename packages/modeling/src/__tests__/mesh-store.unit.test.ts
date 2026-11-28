import { describe, expect, it, vi } from 'vitest';
import { checkInvariants, invariantChecksEnabled } from '../invariants';
import { EditMesh } from '../mesh';
import { TsEditMeshStore } from '../mesh-store';
import { model } from '../model';
import { sel } from '../selectors';

describe('EditMeshStore and zero-clone production run path', () => {
  it('exposes live zero-copy SoA views and tracks memoryGeneration on growth', () => {
    const store = new TsEditMeshStore();
    const v0 = store.addVertex(0, 0, 0);
    const v1 = store.addVertex(1, 0, 0);
    const v2 = store.addVertex(0, 1, 0);
    const f0 = store.addFace([v0, v1, v2]).unwrap();
    expect(f0).toBe(0);
    const views = store.views();
    expect(views.vertexHighWater).toBe(3);
    expect(views.faceHighWater).toBe(1);
    // In-place geometry mutation via SoA view reflects immediately without copying.
    views.pos[v1 * 3] = 2.5;
    store.bumpShapeStamp();
    expect(store.mesh.position(v1)).toEqual([2.5, 0, 0]);

    const snap = store.takeSnapshot();
    store.removeFace(f0);
    expect(store.faceCount).toBe(0);
    store.restoreSnapshot(snap);
    expect(store.faceCount).toBe(1);
    store.releaseSnapshot(snap);
    store.dispose();
  });

  it('avoids per-operation EditMesh.clone() when invariant checks are off, while m.try() still snapshots', () => {
    const prev = invariantChecksEnabled();
    checkInvariants(false);
    const cloneSpy = vi.spyOn(EditMesh.prototype, 'clone');
    try {
      const m = model();
      m.box({ size: [1, 1, 1], tag: 'shell' });
      m.inset(sel.tag('shell').and(sel.facing('+z')).one(), {
        thickness: 0.1,
        region: 'merged',
        label: 'v',
      });
      m.extrude(sel.createdBy('v', 'inner'), { distance: -0.05, region: 'merged' });
      m.uv.project({ mode: 'box', scale: 1 });
      expect(cloneSpy).not.toHaveBeenCalled();

      const attempt = m.try((inner) => {
        inner.extrude(sel.tag('missing'), { distance: 0.1, region: 'merged' });
      });
      expect(attempt.ok).toBe(false);
      // One clone on try() entry + one clone inside EditMesh.assign() on rollback.
      expect(cloneSpy).toHaveBeenCalledTimes(2);
      expect(m.finish({ key: 'test' }).ok).toBe(true);
    } finally {
      cloneSpy.mockRestore();
      checkInvariants(prev);
    }
  });
});
