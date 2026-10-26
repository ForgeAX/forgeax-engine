import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { createFeatureSceneInputs } from '../assembly/feature-scene-inputs';
import { type FrameRecording, submitFrameRecordings } from '../assembly/frame-recording';
import { createRenderFeatureHost } from '../features/host';
import { createRenderFeatureGpuWorkOwner } from '../features/prepared-gpu-work';
import type { RenderFeature } from '../features/types';
import type { RenderSystemInternals } from '../record/render-context';
import type { CubeCaptureGraphWork } from '../record/target-capture-graph';

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
  const host = createRenderFeatureHost([feature]).unwrap();
  const complete = owner.complete.bind(owner);
  const completed = vi.spyOn(owner, 'complete').mockImplementation((submitted) => {
    complete(submitted);
    events.push(`scene-complete:${submitted}`);
    if (failure === 'complete') throw new Error('scene complete failure');
  });
  const submit = vi.spyOn(device.queue, 'submit');
  function* record(): FrameRecording {
    const encoder = device.createCommandEncoder().unwrap();
    let work: readonly CubeCaptureGraphWork[] = [];
    yield {
      kind: 'features',
      host,
      internals,
      encoder,
      input: {
        identity: 'held-or-active',
        render,
        worlds: [],
        owner: 0,
        frameNumber: 1,
        caps: device.caps,
        sceneResources: owner,
        gpuWork,
      },
      captures: {
        snapshots: [],
        exclusive: false,
        accept: (_cube, scene) => {
          work = scene;
        },
      },
      accept: (result) => {
        expect(result.errors).toEqual([]);
      },
    };
    expect(work).toHaveLength(1);
    events.push('capture');
    if (failure === 'capture') throw new Error('capture failure');
    if (failure !== 'pending' && failure !== 'barrier') yield { kind: 'scene-inputs', encoder };
    events.push('view');
    const submitted = yield {
      ...(failure === 'pending' ? { presentation: 'pending' as const } : {}),
      device,
      encoder,
      reportError() {},
      isCurrent: () => failure !== 'submit',
    };
    events.push(`view-complete:${submitted.ok}`);
    return submitted.ok;
  }
  try {
    if (failure === 'pending') expect(submitFrameRecordings([record()])).toBe(true);
    else if (failure === 'submit')
      expect(() => submitFrameRecordings([record()])).toThrowError(
        expect.objectContaining({
          code: 'frame-submit-rejected',
          detail: { operation: 'draw', stage: 'submit', accepted: false },
        }),
      );
    else
      expect(() => submitFrameRecordings([record()])).toThrow(
        failure === 'capture'
          ? 'capture failure'
          : failure === 'barrier'
            ? 'Scene input capture did not reach the shared Feature barrier'
            : 'scene complete failure',
      );
    expect(events.slice(0, failure === 'capture' ? 1 : 2)).toEqual(
      failure === 'capture' ? ['capture'] : ['capture', 'view'],
    );
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
    host.dispose();
    gpuWork.dispose().unwrap();
    owner.dispose();
  }
});
