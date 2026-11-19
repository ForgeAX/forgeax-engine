import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry, withVertexColors } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import type { RenderFeaturePlanView } from '../../plan';
import { projectEditorAssistance } from '../projection';
import type { EditorAssistanceSourceFrame } from '../source';
import { extractEditorAssistance } from '../source';
import { editorAssistance } from '../state';

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

it.each([
  'triangles',
  'lines',
] as const)('projects admitted packed %s with the same positions, tint and depth as the author source', (kind) => {
  const box = createBoxGeometry(1, 1, 1).unwrap();
  const colors = new Float32Array(((box.attributes.position as Float32Array).length / 3) * 4);
  for (let index = 0; index < colors.length; index++) colors[index] = ((index % 4) + 1) / 4;
  const author: MeshAsset =
    kind === 'triangles'
      ? withVertexColors(box, colors).unwrap()
      : {
          kind: 'mesh',
          vertices: Float32Array.of(-0.5, 0, 0.5, 1, 0, 0, 1, 0.5, 0.25, 0.5, 0, 1, 0, 1),
          attributes: {
            position: Float32Array.of(-0.5, 0, 0.5, 0.5, 0.25, 0.5),
            color: Float32Array.of(1, 0, 0, 1, 0, 1, 0, 1),
          },
          submeshes: [
            {
              indexOffset: 0,
              indexCount: 0,
              vertexCount: 2,
              topology: 'line-list',
              materialSlot: 0,
            },
          ],
          materialSlots: [{ slotName: 'overlay' }],
        };
  const assets = new AssetRegistry(),
    world = new World({ assets });
  try {
    const handle = assets.create(author).unwrap(),
      state = editorAssistance(world);
    state.configure({ enabled: true }).unwrap();
    state
      .contribute({}, [
        {
          kind: 'mesh',
          mesh: handle,
          transform: Array.from(mat4.identity(mat4.create())),
          color: [0.5, 0.75, 1, 1],
          depth: 'occluded',
        },
      ])
      .unwrap();
    const captured = extractEditorAssistance({ world, frameNumber: 1, views: [] });
    if (captured === undefined) throw new Error('Missing admitted overlay source');
    expect(captured.meshes[0]?.value?.attributeStorage).toBe('interleaved');
    expect(captured.meshes[0]?.value?.attributes.position).toHaveLength(0);
    const original = projectEditorAssistance(
      { ...captured, meshes: captured.meshes.map((mesh) => ({ ...mesh, value: author })) },
      view(400, 200),
      {},
    );
    const admitted = projectEditorAssistance(captured, view(400, 200), {});
    expect(original?.occluded.length).toBeGreaterThan(0);
    expect(admitted).toEqual(original);
    expect(captured.meshes[0]?.value?.attributes.position).toHaveLength(0);
  } finally {
    assets.dispose();
  }
});
