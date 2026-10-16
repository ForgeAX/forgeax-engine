import { describe, expect, it } from 'vitest';
import { createPointsLinesSnapshot, type PointsLinesRetainedSnapshot } from '../snapshot';

function snapshotInput(): Parameters<typeof createPointsLinesSnapshot>[0] {
  return {
    worldId: 3,
    entityKey: 17,
    component: 'Points',
    meshHandle: 11,
    meshGeneration: 4,
    materialHandle: 23,
    materialGeneration: 8,
    style: { kind: 'points', sizePx: 6, shape: 'circle' },
    layer: 12,
    sortKey: -2,
    visible: true,
    sourceBounds: new Float32Array([-1, -2, -3, 1, 2, 3]),
    viewport: { width: 800, height: 600, dpr: 2 },
    projection: new Float32Array(16),
  };
}

describe('Points/Lines retained snapshot', () => {
  it('detaches ECS identity, owner generations, style, and view facts', () => {
    const source = snapshotInput();
    const snapshot = createPointsLinesSnapshot(source);

    expect(snapshot).toEqual<PointsLinesRetainedSnapshot>({
      worldId: 3,
      entityKey: 17,
      component: 'Points',
      meshHandle: 11,
      meshGeneration: 4,
      materialHandle: 23,
      materialGeneration: 8,
      style: { kind: 'points', sizePx: 6, shape: 'circle' },
      layer: 12,
      sortKey: -2,
      visible: true,
      sourceBounds: new Float32Array([-1, -2, -3, 1, 2, 3]),
      viewport: { width: 800, height: 600, dpr: 2 },
      projection: new Float32Array(16),
    });
    expect(snapshot).not.toHaveProperty('world');
    expect(snapshot.sourceBounds).not.toBe(source.sourceBounds);
    expect(snapshot.projection).not.toBe(source.projection);
  });

  it('records a dedicated-resource zero when the style component is absent', () => {
    const snapshot = createPointsLinesSnapshot({
      ...snapshotInput(),
      component: undefined,
      style: undefined,
    });

    expect(snapshot).toMatchObject({ component: undefined, dedicatedResourceBytes: 0 });
  });
});
