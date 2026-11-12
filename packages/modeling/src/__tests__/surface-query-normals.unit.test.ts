import { expect, it, vi } from 'vitest';
import * as dmath from '../dmath';
import { model } from '../model';
import { sel } from '../selectors';
import { SurfaceQuery } from '../shrinkwrap';

it('derives captured surface normals once for point queries, never for occlusion', () => {
  const source = model();
  source.box({ size: [1, 1, 1] });
  const angles = vi.spyOn(dmath, 'atan2');
  try {
    const query = SurfaceQuery.of(source.editMesh, [...source.editMesh.faces()]);
    if (!query.ok) throw query.error;
    expect(angles).not.toHaveBeenCalled();
    expect(query.value.occluded([0, 0, 2], [0, 0, -1], -1)).toBe(true);
    expect(query.value.occluded([2, 0, 2], [0, 0, -1], -1)).toBe(false);
    expect(angles).not.toHaveBeenCalled();
    source.translate(sel.all(), [10, 0, 0]);
    const nearest = query.value.nearest([0, 0, 2]);
    expect(nearest?.point).toEqual([0, 0, 0.5]);
    expect(nearest?.normal).toEqual([0, 0, 1]);
    const computed = angles.mock.calls.length;
    expect(computed).toBeGreaterThan(0);
    expect(query.value.nearest([0, 0, 2])).toEqual(nearest);
    expect(query.value.cast([0, 0, 2], [0, 0, -1])?.normal).toEqual(nearest?.normal);
    expect(angles).toHaveBeenCalledTimes(computed);
  } finally {
    angles.mockRestore();
  }
});
