import { expect, it } from 'vitest';
import { projectCaptureScene } from '../capture/scene-projection';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';

it('retains offscreen draws, excludes authored hidden rows, and rebases display indices across worlds', () => {
  const rows = [
    { worldId: 0, entityKey: 1 },
    { worldId: 1, entityKey: 1 },
    { worldId: 0, entityKey: 2, authorVisible: false },
  ] as RenderableSnapshot[];
  const dispatch = rows.map((_, renderableIndex) => ({
    renderableIndex,
    materialHandle: renderableIndex,
  })) as DispatchEntry[];
  if (rows[1] === undefined || dispatch[1] === undefined) throw new Error('Missing scene fixture');
  const result = projectCaptureScene(
    { renderables: rows, dispatch },
    [rows[1]],
    [{ ...dispatch[1], renderableIndex: 0 }],
  );
  expect(result.renderables).toEqual(rows.slice(0, 2));
  expect(result.captureDispatch.map((row) => row.renderableIndex)).toEqual([0, 1]);
  expect(result.displayDispatch.map((row) => row.renderableIndex)).toEqual([1]);
});

it('keeps terrain sections distinct when rebasing visible draws into the retained capture roster', () => {
  const rows = [0, 1].map((index) => ({
    worldId: 0,
    entityKey: 7,
    assetHandle: 20 + index,
    transform: { world: new Float32Array(16) },
    material: {} as never,
    materials: [],
    materialBindingSources: [],
    terrainSection: { index, lod: index, neighbors: [index, index, index, index] },
  })) satisfies RenderableSnapshot[];
  const dispatch = rows.map((_, renderableIndex) => ({
    renderableIndex,
    materialHandle: 30 + renderableIndex,
  })) as DispatchEntry[];
  const first = rows[0],
    second = rows[1];
  if (first === undefined || second === undefined) throw new Error('Missing terrain sections');
  const result = projectCaptureScene({ renderables: rows, dispatch }, [second, first], [
    { ...dispatch[1], renderableIndex: 0 },
    { ...dispatch[0], renderableIndex: 1 },
  ] as DispatchEntry[]);
  expect(result.displayDispatch.map((row) => [row.renderableIndex, row.materialHandle])).toEqual([
    [1, 31],
    [0, 30],
  ]);
  expect(result.captureDispatch.map((row) => row.renderableIndex)).toEqual([0, 1]);
});
