import { defineSystem, World } from '@forgeax/engine-ecs';
import { renderGraphCompileCount } from '@forgeax/engine-render-graph';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { ANTIALIAS_NONE, Camera } from '../components/camera';
import { CameraView } from '../components/camera-view';
import { CubeCamera } from '../components/cube-camera';
import {
  REFLECTION_PROBE_UPDATE_CONTINUOUS,
  ReflectionProbe,
} from '../components/reflection-probe';
import {
  captureRecordingRequests,
  NativeProbeCapture,
  NativeTargetCapture,
} from '../record/native-target-capture';
import type { ScenePassRequest } from '../record/scene-pass-work';
import * as graphs from '../record/typed-frame-graph';
import {
  RenderCaptureGraphCompileOrder,
  RenderEncoderOpenOrder,
  RenderGraphSealOrder,
} from '../system-order';
import { viewGraphSealOutcome } from '../world/graph-seal-systems';
import { RenderView, RenderViewInput, ViewSubmission } from '../world/render-views';
import { RenderRecord, renderSubmission } from '../world/render-world';
import { ViewRecordAttempt } from '../world/view-record-attempt';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it("records the multi-view shared capture attempt on the primary recorder's view entity", async () => {
  let renderWorld: World | undefined;
  const actual = World.prototype.insertResource;
  const insert = vi.spyOn(World.prototype, 'insertResource').mockImplementation(function (
    this: World,
    key,
    value,
  ) {
    if (typeof key !== 'string' && key.name === RenderViewInput.name) renderWorld = this;
    return actual.call(this, key, value);
  });
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  insert.mockRestore();
  try {
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    registerPropagateTransforms(world);
    const camera = { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_NONE };
    const spawnView = (order: number, enabled: boolean) =>
      world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 4 + order] } },
          { component: Camera, data: camera },
          {
            component: CameraView,
            data: { order, enabled, viewport: new Float32Array([0, 0, 0.5, 0.5]) },
          },
        )
        .unwrap();
    spawnView(0, false);
    const enabled = spawnView(1, true);
    const cube = renderer.createRenderTarget({
      shape: 'cube',
      width: 8,
      height: 8,
      format: 'rgba16float',
      mipLevels: 1,
      sampleCount: 1,
      sampled: true,
      readback: false,
    });
    if (!cube.ok) throw cube.error;
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: CubeCamera,
          data: { target: world.allocSharedRef('RenderTarget', cube.value) },
        },
      )
      .unwrap();
    const input = { source: attached.value };
    if (renderWorld === undefined) throw new Error('expected the Renderer Render World');
    let compilingCaptures = false;
    const systemToken1 = defineSystem({
      name: 'test-capture-compile-enter',
      after: [RenderEncoderOpenOrder],
      before: [RenderCaptureGraphCompileOrder],
      queries: [],
      fn: () => {
        compilingCaptures = true;
      },
    });
    renderWorld.addSystem(RenderRecord, systemToken1).unwrap();
    const systemToken2 = defineSystem({
      name: 'test-capture-compile-leave',
      after: [RenderCaptureGraphCompileOrder],
      before: [RenderGraphSealOrder],
      queries: [],
      fn: () => {
        compilingCaptures = false;
      },
    });
    renderWorld.addSystem(RenderRecord, systemToken2).unwrap();
    const sealed: string[] = [];
    const systemToken3 = defineSystem({
      name: 'test-capture-seal-product',
      after: [RenderGraphSealOrder],
      queries: [{ read: [ViewRecordAttempt] }],
      fn: (world, [rows]) => {
        for (const row of rows) sealed.push(viewGraphSealOutcome(world, row.entity).kind);
      },
    });
    renderWorld.addSystem(RenderRecord, systemToken3).unwrap();
    const compile = graphs.prepareTargetCaptureRecording;
    const calls: boolean[] = [];
    const captureRequests: (readonly ScenePassRequest[])[] = [];
    const captureCompile = vi
      .spyOn(graphs, 'prepareTargetCaptureRecording')
      .mockImplementation((...args) => {
        calls.push(compilingCaptures);
        const before = renderGraphCompileCount();
        const graph = compile(...args);
        expect(renderGraphCompileCount()).toBe(before);
        expect(graph).toBeInstanceOf(NativeTargetCapture);
        captureRequests.push(captureRecordingRequests(graph));
        return graph;
      });
    expect(world.update().ok).toBe(true);
    const result = renderer.draw(input);
    if (!result.ok) throw result.error;
    if (result.value === undefined) throw new Error('expected submitted receipt');
    expect((await result.value.completed).ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(Boolean)).toBe(true);
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed.every((kind) => kind === 'sealed')).toBe(true);
    if (renderWorld === undefined) throw new Error('expected the Renderer Render World');
    const shared: unknown[] = [];
    // Query rows are reused cursors: copy each primary row's facts.
    for (const row of renderWorld.query({ read: [RenderView, ViewSubmission] }).unwrap())
      if (row.get(RenderView).primary)
        shared.push({ ...row.get(RenderView), ...row.get(ViewSubmission) });
    expect(shared).toEqual([
      expect.objectContaining({
        capture: true,
        camera: Number(enabled),
        accepted: true,
        attempt: renderSubmission(renderWorld).frame,
      }),
    ]);
    // The same physical view keeps its scene requests across face and camera updates.
    for (let index = 0; index < 2; index += 1) {
      expect(world.update().ok).toBe(true);
      const next = renderer.draw(input);
      if (!next.ok) throw next.error;
      expect(next.value).toBeDefined();
      if (next.value !== undefined) expect((await next.value.completed).ok).toBe(true);
    }
    captureCompile.mockRestore();
    expect(captureRequests).toHaveLength(3);
    expect(captureRequests[0]).toHaveLength(2);
    for (const requests of captureRequests.slice(1)) {
      expect(requests[0]).toBe(captureRequests[0]?.[0]);
      expect(requests[1]).toBe(captureRequests[0]?.[1]);
    }
  } finally {
    vi.restoreAllMocks();
    await renderer.dispose();
  }
});

it('records two generations of changing probe faces using the issued capture view', async () => {
  const renderer = await createRenderer(
    { width: 64, height: 64, getContext: () => null },
    { rhi },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  const prepare = graphs.prepareTargetCaptureRecording;
  const faces: number[] = [];
  const generations: number[] = [];
  const spy = vi.spyOn(graphs, 'prepareTargetCaptureRecording').mockImplementation((...args) => {
    const before = renderGraphCompileCount();
    const recording = prepare(...args);
    const probe = args[7];
    if (probe?.rawCaptureFace !== undefined) {
      expect(renderGraphCompileCount()).toBe(before);
      expect(recording).toBeInstanceOf(NativeProbeCapture);
      const requests = captureRecordingRequests(recording);
      expect(requests).toHaveLength(1);
      const camera = requests[0]?.camera?.();
      expect(camera).toBe(probe.faceCamera);
      expect(recording instanceof NativeProbeCapture && recording.declarations()).toContainEqual({
        kind: 'raster',
        name: `reflection-probe.${probe.probeIndex}.capture.${probe.rawCaptureFace}`,
      });
      faces.push(probe.rawCaptureFace);
      generations.push(probe.captureGeneration ?? 0);
    }
    return recording;
  });
  try {
    expect((await renderer.initialization).ok).toBe(true);
    const world = new World();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    registerPropagateTransforms(world);
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        {
          component: Camera,
          data: { fov: 1, aspect: 1, near: 0.1, far: 20, antialias: ANTIALIAS_NONE },
        },
      )
      .unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        {
          component: ReflectionProbe,
          data: { resolution: 64, updateIntent: REFLECTION_PROBE_UPDATE_CONTINUOUS },
        },
      )
      .unwrap();
    for (let frame = 0; frame < 120 && faces.length < 12; frame++) {
      world.update(1 / 60).unwrap();
      const submitted = renderer.draw({ source: attached.value });
      if (!submitted.ok) throw submitted.error;
      if (submitted.value !== undefined) expect((await submitted.value.completed).ok).toBe(true);
    }
    expect(faces).toEqual([0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5]);
    expect(generations[0]).not.toBe(generations[6]);
    expect(renderer.inspect().reflectionProbes.activeCount).toBe(1);
  } finally {
    spy.mockRestore();
    await renderer.dispose();
  }
});
