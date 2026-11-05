import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createFeatureSceneInputs } from '../assembly/feature-scene-inputs';
import { createRenderFeatureHost } from '../features/host';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';
import * as frameKernels from '../record/frame';
import type { RenderSystemInternals } from '../record/render-context';
import { ViewCaptureWork } from '../world/capture-systems';
import {
  RENDER_CAPTURE_GRAPH_ENCODE_SYSTEM,
  ViewGraphSeal,
  viewGraphEncodingOutcome,
} from '../world/graph-seal-systems';
import { awaitsRenderRecord } from '../world/graph-systems';
import { endRenderFrame, RenderRecord } from '../world/render-world';
import { stageFeatureFrame } from './feature-frame-driver';
import { type FrameRecording, submitFrameRecordings } from './frame-recording-driver';

it.each([
  { render: true, failure: 'capture' },
  { render: false, failure: 'capture' },
  { render: true, failure: 'submit' },
  { render: false, failure: 'submit' },
  { render: false, failure: 'complete' },
  { render: true, failure: 'pending' },
  { render: true, failure: 'barrier' },
] as const)('drains scene inputs with render=$render and $failure failure', async ({
  render,
  failure,
}) => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const internals = {
    device,
    deviceScope: { generation: 0 },
    canvas: { width: 8, height: 8 },
    errorRegistry: { fire() {} },
  } as unknown as RenderSystemInternals;
  const shader = (await rhi.createShaderModule(device, { code: 'synthetic' })).unwrap();
  const gpuWork = createRenderFeatureGpuWorkOwner({
    getDevice: () => device,
    getShaderModuleFactory: () => ({ createShaderModule: () => ok(shader) }),
  });
  const owner = createFeatureSceneInputs(internals, () => undefined);
  internals.featureSceneInputs = owner;
  const events: string[] = [];
  const feature: RenderFeature<undefined> = {
    identity: 'depth-consumer',
    extract: () => ok(undefined),
    plan: () =>
      ok({
        work: [
          {
            scope: 'frame',
            resources: [
              {
                kind: 'scene-depth',
                name: 'depth',
                camera: {
                  position: new Float32Array([0, 0, 3]),
                  right: new Float32Array([1, 0, 0]),
                  up: new Float32Array([0, 1, 0]),
                  viewProjection: new Float32Array([
                    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.1, 0, 0, 0, 0.5, 1,
                  ]),
                },
              },
            ],
            passes: [],
          },
        ],
      }),
    onFrameSubmitted: () => {
      events.push('feature-submit');
    },
    onSourceFrameSubmitted: () => {
      events.push('source-ack');
    },
    onFrameAborted: () => {
      events.push('feature-abort');
    },
  };
  const reported: unknown[] = [];
  const host = createRenderFeatureHost([feature], undefined, (error) =>
    reported.push(error),
  ).unwrap();
  const complete = owner.complete.bind(owner);
  const completed = vi.spyOn(owner, 'complete').mockImplementation((submitted) => {
    complete(submitted);
    events.push(`scene-complete:${submitted}`);
    if (failure === 'complete') throw new Error('scene complete failure');
  });
  const submit = vi.spyOn(device.queue, 'submit');
  Object.assign(internals, { renderWorld: host.world });
  const outcome = stageFeatureFrame(host, [
    {
      identity: 'held-or-active',
      render,
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: device.caps,
      sceneResources: owner,
      gpuWork,
    },
  ]);
  expect(outcome.kind === 'sealed' && outcome.batch.views.get('held-or-active')?.errors).toEqual(
    [],
  );
  const view = host.world
    .spawn({
      component: ViewGraphSeal,
      data: {
        state: host.world.allocUniqueRef('ViewGraphSeal', {
          frame: 1,
          prepared: {
            internals,
            frameState: { pipelinePreparationPending: false },
            cubeCapture: { sceneInputs: owner.work },
          },
          outcome: { kind: 'sealed', graph: {}, value: {} },
        }),
      },
    })
    .unwrap();
  host.world
    .addComponent(view, {
      component: ViewCaptureWork,
      data: {
        state: host.world.allocUniqueRef('ViewCaptureWork', {
          frame: 1,
          outcome: {
            kind: 'prepared',
            value: { sceneInputs: owner.work, cube: [], auxiliaryCameras: [], faces: [] },
          },
        }),
      },
    })
    .unwrap();
  const captures = vi.spyOn(frameKernels, 'encodePreparedFrameCaptures').mockImplementation(() => {
    expect(owner.work).toHaveLength(1);
    events.push('capture');
    if (failure === 'capture') throw new Error('capture failure');
    return { kind: failure === 'pending' ? 'pending' : 'ready' };
  });
  const encode = vi.spyOn(frameKernels, 'encodePreparedViewGraph').mockImplementation(() => {
    events.push('view');
    return {
      kind: 'encoded',
      value: {
        kind: 'capture',
        work: {
          reportError() {},
          isCurrent: () => failure !== 'submit',
        },
      },
    };
  });
  if (failure === 'barrier')
    host.world.removeSystem(RenderRecord, RENDER_CAPTURE_GRAPH_ENCODE_SYSTEM).unwrap();
  function* record(): FrameRecording {
    yield { kind: 'shared-work', internals, sceneInputs: owner.work.length > 0 };
    if (awaitsRenderRecord(host.world)) yield { kind: 'compile', world: host.world };
    const encoded = viewGraphEncodingOutcome(host.world, view);
    if (encoded.kind === 'failed') throw encoded.cause;
    if (encoded.kind === 'pending') {
      events.push('view');
      const submitted = yield { presentation: 'pending', reportError() {} };
      events.push(`view-complete:${submitted.ok}`);
      return submitted.ok;
    }
    if (encoded.kind !== 'encoded' || encoded.value.kind !== 'capture') return false;
    const submitted = yield encoded.value.work;
    events.push(`view-complete:${submitted.ok}`);
    return submitted.ok;
  }
  // RenderCommit/RenderCleanup settle the Feature frame once its submission published.
  const submitFrame = () => {
    try {
      return submitFrameRecordings({ world: host.world, device, rendererInternals: internals }, [
        record(),
      ]);
    } finally {
      endRenderFrame(host.world);
    }
  };
  try {
    // The settlement systems never throw: a scene-input completion failure is reported.
    if (failure === 'pending' || failure === 'complete') expect(submitFrame()).toBe(true);
    else if (failure === 'submit')
      expect(() => submitFrame()).toThrowError(
        expect.objectContaining({
          code: 'frame-submit-rejected',
          detail: expect.objectContaining({
            operation: 'draw',
            stage: 'submit',
            accepted: false,
            cause: expect.objectContaining({ code: 'frame-generation-stale' }),
          }),
        }),
      );
    else
      expect(() => submitFrame()).toThrow(
        failure === 'capture'
          ? 'capture failure'
          : expect.objectContaining({ code: 'graph-build-failed' }),
      );
    expect(reported).toEqual(
      failure === 'complete'
        ? [
            expect.objectContaining({
              detail: expect.objectContaining({
                error: expect.objectContaining({ code: 'render-feature-settlement-failed' }),
              }),
            }),
          ]
        : [],
    );
    expectEncodedStages(events, encode.mock.calls.length, failure);
    expect(completed).toHaveBeenCalledExactlyOnceWith(
      failure === 'complete',
      failure === 'complete' || failure === 'pending' ? expect.any(Promise) : undefined,
    );
    expect(events.filter((event) => event === 'feature-abort')).toHaveLength(
      failure === 'complete' ? 0 : 1,
    );
    expect(events.filter((event) => event === 'source-ack')).toHaveLength(
      failure === 'complete' ? 1 : 0,
    );
    expect(submit).toHaveBeenCalledTimes(failure === 'complete' || failure === 'pending' ? 1 : 0);
    // The candidate scope is closed even when another finalizer reports an error.
    completed.mockImplementation(complete);
    owner.begin(2);
    owner.complete(false);
  } finally {
    captures.mockRestore();
    encode.mockRestore();
    host.dispose();
    gpuWork.dispose().unwrap();
    owner.dispose();
  }
});

function expectEncodedStages(events: readonly string[], encodes: number, failure: string): void {
  const expected =
    failure === 'capture' ? ['capture'] : failure === 'barrier' ? [] : ['capture', 'view'];
  expect(events.slice(0, expected.length)).toEqual(expected);
  expect(encodes).toBe(
    failure === 'capture' || failure === 'barrier' || failure === 'pending' ? 0 : 1,
  );
}
