import { World } from '@forgeax/engine-ecs';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { ANTIALIAS_NONE, Camera } from '../components/camera';
import { CameraView } from '../components/camera-view';
import { CubeCamera } from '../components/cube-camera';
import * as graphs from '../record/typed-frame-graph';
import { RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM } from '../world/capture-graph-systems';
import {
  RENDER_GRAPH_SEAL_SYSTEM,
  ViewGraphSeal,
  viewGraphSealOutcome,
} from '../world/graph-seal-systems';
import { RENDER_GRAPH_COMPILE_SYSTEM } from '../world/graph-systems';
import { RENDER_ENCODER_OPEN_SYSTEM } from '../world/record-systems';
import { RenderView, RenderViewInput, ViewSubmission } from '../world/render-views';
import { RenderRecord, renderSubmission } from '../world/render-world';
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
    const input = {
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    };
    if (renderWorld === undefined) throw new Error('expected the Renderer Render World');
    let compilingCaptures = false;
    renderWorld
      .addSystem(RenderRecord, {
        name: 'test-capture-compile-enter',
        after: [RENDER_ENCODER_OPEN_SYSTEM],
        before: [RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM],
        queries: [],
        fn: () => {
          compilingCaptures = true;
        },
      })
      .unwrap();
    renderWorld
      .addSystem(RenderRecord, {
        name: 'test-capture-compile-leave',
        after: [RENDER_CAPTURE_GRAPH_COMPILE_SYSTEM],
        before: [RENDER_GRAPH_COMPILE_SYSTEM],
        queries: [],
        fn: () => {
          compilingCaptures = false;
        },
      })
      .unwrap();
    const sealed: string[] = [];
    renderWorld
      .addSystem(RenderRecord, {
        name: 'test-capture-seal-product',
        after: [RENDER_GRAPH_SEAL_SYSTEM],
        queries: [{ read: [ViewGraphSeal] }],
        fn: (world, [rows]) => {
          for (const row of rows) sealed.push(viewGraphSealOutcome(world, row.entity).kind);
        },
      })
      .unwrap();
    const compile = graphs.compileTargetCaptureFrameGraph;
    const calls: boolean[] = [];
    const captureCompile = vi
      .spyOn(graphs, 'compileTargetCaptureFrameGraph')
      .mockImplementation((...args) => {
        calls.push(compilingCaptures);
        return compile(...args);
      });
    expect(world.update().ok).toBe(true);
    const result = renderer.draw(input);
    if (!result.ok) throw result.error;
    if (result.value === undefined) throw new Error('expected submitted receipt');
    expect((await result.value.completed).ok).toBe(true);
    captureCompile.mockRestore();
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
  } finally {
    await renderer.dispose();
  }
});
