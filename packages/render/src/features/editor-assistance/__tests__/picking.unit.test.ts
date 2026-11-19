import type { EntityHandle } from '@forgeax/engine-ecs';
import { expect, it } from 'vitest';
import {
  type EditorAssistancePickRequest,
  pickSubmittedEditorAssistance,
  type SubmittedEditorAssistanceFrame,
} from '../picking';

const request: EditorAssistancePickRequest = {
  frameId: 3,
  deviceGeneration: 2,
  sourceIdentity: 'source',
  sourceMutationEpoch: 4,
  viewIdentity: 'scene',
  x: 2,
  y: 2,
};
function frame(): SubmittedEditorAssistanceFrame {
  return {
    ...request,
    revision: 1,
    views: [
      {
        identity: 'scene',
        width: 100,
        height: 100,
        hits: [
          {
            action: { kind: 'gizmo', entity: 17 as EntityHandle, handle: 'X' },
            depth: 'always',
            triangle: [0, 0, 10, 0, 0, 10],
          },
          {
            action: { kind: 'entity', entity: 18 as EntityHandle },
            depth: 'always',
            triangle: [0, 0, 10, 0, 0, 10],
          },
        ],
      },
    ],
  };
}
it('uses submitted geometry and prioritizes manipulators over entity icons', () => {
  expect(pickSubmittedEditorAssistance(frame(), request)).toEqual({
    status: 'hit',
    action: { kind: 'gizmo', entity: 17, handle: 'X' },
  });
  expect(pickSubmittedEditorAssistance(frame(), { ...request, x: 50 })).toEqual({ status: 'miss' });
});
it.each([
  { frameId: 4 },
  { deviceGeneration: 3 },
  { sourceIdentity: 'replacement' },
  { sourceMutationEpoch: 5 },
])('refuses a mismatched frame identity: %j', (patch) => {
  expect(pickSubmittedEditorAssistance(frame(), { ...request, ...patch })).toEqual({
    status: 'unavailable',
    reason: 'stale-frame',
  });
});
it('refuses exact occlusion claims without matching depth evidence', () => {
  const source = frame();
  const views = source.views.map((view) => ({
    ...view,
    hits: view.hits.map((hit) => ({ ...hit, depth: 'occluded' as const })),
  }));
  expect(pickSubmittedEditorAssistance({ ...source, views }, request)).toEqual({
    status: 'unavailable',
    reason: 'depth-not-observed',
  });
});
