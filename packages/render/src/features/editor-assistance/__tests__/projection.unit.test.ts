import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import type { RenderFeaturePlanView } from '../../plan';
import { projectEditorAssistance } from '../projection';
import type { EditorAssistanceSourceFrame } from '../source';

function source(): EditorAssistanceSourceFrame {
  return {
    sourceIdentity: 'source',
    sourceMutationEpoch: 1,
    revision: 1,
    camera: undefined,
    outline: undefined,
    meshes: [],
    truncated: false,
    primitives: [
      {
        kind: 'icon',
        icon: 'camera',
        position: [0, 0, 0.5],
        pixels: 24,
        color: [1, 1, 1, 1],
        depth: 'always',
      },
    ],
  };
}
function view(width: number, height: number): RenderFeaturePlanView {
  return {
    identity: 'scene',
    render: true,
    frame: { frameNumber: 1, width, height },
    targets: [],
    sceneData: {} as never,
    selectedView: {
      viewProjection: mat4.identity(mat4.create()),
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
    },
  };
}
it('keeps icon size fixed in submitted physical pixels across viewport dimensions', () => {
  const bounds = (width: number, height: number) => {
    const frame = projectEditorAssistance(source(), view(width, height), {});
    expect(frame?.occluded).toHaveLength(0);
    const xs: number[] = [],
      ys: number[] = [];
    for (let i = 0; i < (frame?.always.length ?? 0); i += 8) {
      const vertices = frame?.always as Float32Array;
      xs.push(((vertices[i] ?? 0) * width) / 2);
      ys.push(((vertices[i + 1] ?? 0) * height) / 2);
    }
    return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  };
  const first = bounds(400, 200),
    second = bounds(1200, 800);
  expect(second[0]).toBeCloseTo(first[0] as number, 4);
  expect(second[1]).toBeCloseTo(first[1] as number, 4);
});
it('clips helper triangles to the submitted frustum and preserves their depth policy', () => {
  const frame = projectEditorAssistance(
    {
      ...source(),
      primitives: [
        {
          kind: 'line',
          start: [-4, 0, 0.5],
          end: [4, 0, 0.5],
          color: [1, 0, 0, 1],
          depth: 'occluded',
        },
      ],
    },
    view(400, 200),
    {},
  );
  expect(frame?.always).toHaveLength(0);
  expect(frame?.occluded.length).toBeGreaterThan(0);
  for (let i = 0; i < (frame?.occluded.length ?? 0); i += 8) {
    const values = frame?.occluded as Float32Array;
    expect(Math.abs(values[i] as number)).toBeLessThanOrEqual(values[i + 3] as number);
  }
});
