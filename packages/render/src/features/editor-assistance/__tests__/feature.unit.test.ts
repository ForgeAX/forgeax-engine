import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import { expect, it } from 'vitest';
import type { RenderFeaturePlanContext } from '../../plan';
import { createEditorAssistanceFeature } from '../feature';
import { editorAssistance } from '../state';

function fixture() {
  const world = new World({ assets: new AssetRegistry() });
  const entity = world.spawn().unwrap();
  const feature = createEditorAssistanceFeature();
  const context: RenderFeaturePlanContext = {
    frame: { frameNumber: 7 },
    generation: 1,
    caps: {} as never,
    views: [
      {
        identity: 'camera:17',
        render: true,
        frame: { frameNumber: 7, width: 200, height: 100 },
        sceneData: {} as never,
        selectedView: {
          position: new Float32Array(3),
          right: new Float32Array([1, 0, 0]),
          up: new Float32Array([0, 1, 0]),
          viewProjection: mat4.identity(mat4.create()),
        },
        targets: [
          { name: 'editor-input', kind: 'color', format: 'rgba16float', sampleCount: 1 },
          { name: 'editor-output', kind: 'color', format: 'rgba16float', sampleCount: 1 },
          { name: 'depth', kind: 'depth', format: 'depth32float', sampleCount: 4 },
          { name: 'editor-depth', kind: 'depth', format: 'depth32float', sampleCount: 4 },
        ],
      },
    ],
  };
  return { world, entity, feature, context };
}
it('declares no resources or passes for an idle source', () => {
  const f = fixture();
  const source = f.feature.extract({ world: f.world, frameNumber: 1, views: [] }).unwrap();
  expect(source).toBeUndefined();
  expect(f.feature.plan(source, f.context).unwrap()).toEqual({ work: [] });
});
it('declares the ordinary program, persistent vertex buffer and same-frame depth read', () => {
  const f = fixture();
  const state = editorAssistance(f.world);
  state.configure({ enabled: true }).unwrap();
  state
    .contribute({}, [
      {
        kind: 'line',
        start: [-0.5, 0, 0.5],
        end: [0.5, 0, 0.5],
        color: [1, 0, 0, 1],
        depth: 'occluded',
        action: { kind: 'entity', entity: f.entity },
      },
    ])
    .unwrap();
  const source = f.feature.extract({ world: f.world, frameNumber: 1, views: [] }).unwrap();
  const plan = f.feature.plan(source, f.context).unwrap();
  expect(plan.work[0]?.passes.map((pass) => pass.name)).toEqual(['editor-copy', 'editor-occluded']);
  expect(plan.work[0]?.resources).toContainEqual(
    expect.objectContaining({
      kind: 'fullscreen-program',
      name: 'editor-occluded',
      vertexLayout: 'clip-position-color',
      depthSampleCount: 4,
    }),
  );
  expect(plan.work[0]?.resources).toContainEqual(
    expect.objectContaining({ kind: 'vertex-data', buffer: 'editor-occluded-buffer' }),
  );
  expect(
    f.feature.editorAssistance.bindReceipt(7, { frameId: 11, deviceGeneration: 2 }),
  ).toBeUndefined();
  f.feature.onFrameSubmitted?.(source);
  expect(
    f.feature.editorAssistance.bindReceipt(8, { frameId: 11, deviceGeneration: 2 }),
  ).toBeUndefined();
  const submitted = f.feature.editorAssistance.bindReceipt(7, { frameId: 11, deviceGeneration: 2 });
  expect(submitted).toMatchObject({
    frameId: 11,
    deviceGeneration: 2,
    sourceIdentity: f.world.identity,
  });
  expect(submitted?.views[0]?.hits.length).toBeGreaterThan(0);
  expect(submitted?.views[0]).not.toHaveProperty('occluded');
  state.clear();
  f.feature.plan(undefined, { ...f.context, frame: { frameNumber: 8 } }).unwrap();
  expect(f.feature.editorAssistance.view(7, 'camera:17')).toBeUndefined();
});
