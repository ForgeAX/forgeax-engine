import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { mat4 } from '@forgeax/engine-math';
import type { RhiRenderPassEncoder } from '@forgeax/engine-rhi';
import { createShaderModuleImmediate, type RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { DeviceScope } from '../../device/device-scope';
import type { RenderSystemInternals } from '../../record/render-context';
import type { DebugOverlayBatch, RenderDebugOverlay } from '../../render-contract';
import type { ExtractedFrame } from '../../render-system-extract';
import {
  consumeDebugOverlay,
  debugOverlayHolderOf,
  encodeDebugOverlay,
  inspectDebugOverlay,
  RENDER_DEBUG_OVERLAY_DISCARD_SYSTEM,
  RENDER_DEBUG_OVERLAY_PREPARE_SYSTEM,
  registerDebugOverlaySystems,
  viewDebugOverlayOf,
} from '../debug-overlay-systems';
import {
  RenderViewFrameSource,
  RenderViewInput,
  ViewRecorder,
  ViewSubmission,
} from '../render-views';
import {
  beginRenderFrame,
  createRenderWorld,
  endRenderFrame,
  RenderCleanup,
  RenderExtract,
  RenderPrepare,
} from '../render-world';
import {
  RENDER_VIEW_FRAME_SYSTEM,
  RENDER_VIEW_RECORDERS_SYSTEM,
  stageViewFrame,
} from '../view-frame-systems';
import { registerViewFrameStub, withInertTemporal } from './temporal-owner-fixture';

const opts = { cameraOwner: 0, resourceOwner: 0 } as const;
const IDENTITY = mat4.identity(mat4.create());

interface Source extends RenderDebugOverlay {
  takes: number;
  failTake: boolean;
  pending: DebugOverlayBatch | null;
}

function createSource(): Source {
  const source: Source = {
    takes: 0,
    failTake: false,
    pending: null,
    shader: {
      vertexWgsl: 'vs',
      fragmentWgsl: 'fs',
      vertexEntry: 'vs_main',
      fragmentEntry: 'fs_main',
      vertexStrideBytes: 16,
      attributes: [
        { format: 'float32x3', offset: 0, shaderLocation: 0 },
        { format: 'unorm8x4', offset: 12, shaderLocation: 1 },
      ],
    },
    take() {
      source.takes += 1;
      if (source.failTake) throw new Error('take failed');
      const batch = source.pending;
      source.pending = null;
      return batch;
    },
  };
  return source;
}

function batch(vertexCount: number): DebugOverlayBatch {
  return { bytes: new Uint8Array(vertexCount * 16), vertexCount, truncated: false };
}

function submit(world: World, view: EntityHandle, attempt: number): void {
  const data = { accepted: false, attempt, scene: false, temporal: false };
  if (world.hasComponent(view, ViewSubmission)) world.set(view, ViewSubmission, data).unwrap();
  else world.addComponent(view, { component: ViewSubmission, data }).unwrap();
}

async function setup(viewCount = 2) {
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap() as RhiNullDevice;
  const world = createRenderWorld();
  world.insertResource(
    RenderViewInput,
    new RenderViewFrameSource({ canvas: { width: 8, height: 8 } }),
  );
  registerDebugOverlaySystems(world);
  const source = createSource();
  const errors: { code: string; detail: unknown }[] = [];
  const base = {
    renderWorld: world,
    device,
    deviceScope: DeviceScope.create(1, 'debug-overlay-test'),
    errorRegistry: { fire: (error: { code: string; detail: unknown }) => errors.push(error) },
    immediateShaderModuleFactory: {
      createShaderModule: (desc: { code: string; label?: string }) =>
        createShaderModuleImmediate(device, desc),
    },
    debugOverlay: source,
  };
  const recorder = {
    prepareViewFrame: () => ({
      ok: true as const,
      value: { renderables: [], cameras: [{ entityKey: 5 }] } as unknown as ExtractedFrame,
    }),
  };
  registerViewFrameStub(world, recorder.prepareViewFrame);
  const views: EntityHandle[] = [];
  const runtimes = new Map<EntityHandle, RenderSystemInternals>();
  for (let i = 0; i < viewCount; i += 1) {
    const view = world.spawn().unwrap();
    views.push(view);
    const internals = { ...base, viewEntity: view } as unknown as RenderSystemInternals;
    runtimes.set(view, internals);
    const state = world.allocUniqueRef(
      'ViewRecorder',
      withInertTemporal({}, { internals, frameState: {} }),
    );
    world.addComponent(view, { component: ViewRecorder, data: { state } }).unwrap();
  }
  world
    .addSystem(RenderExtract, {
      name: RENDER_VIEW_RECORDERS_SYSTEM,
      queries: [],
      fn: (world) => {
        for (const view of views) stageViewFrame(world, view, opts, true);
      },
    })
    .unwrap();
  const pass = () => {
    const calls: string[] = [];
    const encoder = {
      setPipeline: () => calls.push('pipeline'),
      setBindGroup: () => calls.push('bindGroup'),
      setVertexBuffer: () => calls.push('vertexBuffer'),
      draw: (count: number) => calls.push(`draw:${count}`),
    } as unknown as RhiRenderPassEncoder;
    return { calls, encoder };
  };
  return { world, device, source, errors, views, runtimes, pass };
}

describe('debug overlay systems', () => {
  it('declares the prepare and discard systems in their Render World phases', async () => {
    const { world } = await setup();
    const names = (schedule: string) =>
      world
        .scheduleData()
        .find((data) => data.name === schedule)
        ?.systems.map((system) => system.name);
    expect(names('RenderPrepare')).toEqual(
      expect.arrayContaining([RENDER_VIEW_FRAME_SYSTEM, RENDER_DEBUG_OVERLAY_PREPARE_SYSTEM]),
    );
    expect(names('RenderCleanup')).toContain(RENDER_DEBUG_OVERLAY_DISCARD_SYSTEM);
    registerDebugOverlaySystems(world);
    expect(
      names('RenderPrepare')?.filter((name) => name === RENDER_DEBUG_OVERLAY_PREPARE_SYSTEM),
    ).toHaveLength(1);
  });

  it('takes the source once per frame and draws it in both views', async () => {
    const { world, source, views, runtimes, pass } = await setup();
    source.pending = batch(4);
    beginRenderFrame(world, 1);
    expect(source.takes).toBe(1);
    const drawn = views.map((view) => {
      const runtime = runtimes.get(view) as RenderSystemInternals;
      expect(consumeDebugOverlay(runtime).kind).toBe('staged');
      const target = pass();
      encodeDebugOverlay(runtime, target.encoder, IDENTITY, 'rgba8unorm');
      return target.calls;
    });
    expect(drawn).toEqual(Array(2).fill(['pipeline', 'bindGroup', 'vertexBuffer', 'draw:4']));
    expect(inspectDebugOverlay(world)).toMatchObject({ kind: 'staged', vertexCount: 4 });
    endRenderFrame(world);
  });

  it('does not accumulate geometry across frames that never draw', async () => {
    const { world, source, views, runtimes } = await setup(1);
    const view = views[0] as EntityHandle;
    for (const frame of [1, 2, 3]) {
      source.pending = batch(2);
      beginRenderFrame(world, frame);
      // The frame is rejected: it drew nothing.
      expect(viewDebugOverlayOf(world, view)?.kind).toBe('staged');
      submit(world, view, frame);
      endRenderFrame(world);
      expect(viewDebugOverlayOf(world, view)?.kind).toBe('none');
      expect(source.pending).toBeNull();
    }
    expect(source.takes).toBe(3);
    // The next frame stages only its own geometry.
    source.pending = batch(1);
    beginRenderFrame(world, 4);
    const outcome = viewDebugOverlayOf(world, view);
    expect(outcome).toMatchObject({ kind: 'staged', vertexCount: 1 });
    expect(runtimes.size).toBe(1);
    endRenderFrame(world);
  });

  it('records no outcome once nothing was staged', async () => {
    const { world, views } = await setup(1);
    beginRenderFrame(world, 1);
    expect(viewDebugOverlayOf(world, views[0])?.kind).toBe('none');
    endRenderFrame(world);
  });

  it('skips the overlay with a closed code and one report per failing run', async () => {
    const { world, source, errors, views, runtimes, pass } = await setup(1);
    const runtime = runtimes.get(views[0] as EntityHandle) as RenderSystemInternals;
    source.failTake = true;
    for (const frame of [1, 2]) {
      beginRenderFrame(world, frame);
      const outcome = consumeDebugOverlay(runtime);
      expect(outcome).toMatchObject({ kind: 'failed', code: 'overlay-source-failed' });
      const target = pass();
      encodeDebugOverlay(runtime, target.encoder, IDENTITY, 'rgba8unorm');
      expect(target.calls).toEqual([]);
      endRenderFrame(world);
    }
    expect(errors.map((error) => error.code)).toEqual(['debug-overlay-failed']);
    expect(inspectDebugOverlay(world)).toMatchObject({
      kind: 'failed',
      code: 'overlay-source-failed',
    });
    // A healthy frame clears the run; the next failure is reported again.
    source.failTake = false;
    beginRenderFrame(world, 3);
    endRenderFrame(world);
    source.failTake = true;
    beginRenderFrame(world, 4);
    endRenderFrame(world);
    expect(errors).toHaveLength(2);
  });

  it('fails naming the prepare system once it is removed', async () => {
    const { world, source, views, runtimes } = await setup(1);
    world.removeSystem(RenderPrepare, RENDER_DEBUG_OVERLAY_PREPARE_SYSTEM).unwrap();
    source.pending = batch(2);
    beginRenderFrame(world, 1);
    const runtime = runtimes.get(views[0] as EntityHandle) as RenderSystemInternals;
    expect(() => consumeDebugOverlay(runtime)).toThrow(RENDER_DEBUG_OVERLAY_PREPARE_SYSTEM);
    expect(source.takes).toBe(0);
    endRenderFrame(world);
  });

  it('keeps a staged outcome after a blocked frame once the discard system is removed', async () => {
    const { world, source, views } = await setup(1);
    world.removeSystem(RenderCleanup, RENDER_DEBUG_OVERLAY_DISCARD_SYSTEM).unwrap();
    const view = views[0] as EntityHandle;
    source.pending = batch(2);
    beginRenderFrame(world, 1);
    submit(world, view, 1);
    endRenderFrame(world);
    expect(debugOverlayHolderOf(world)?.outcome?.kind).toBe('staged');
    expect(viewDebugOverlayOf(world, view)?.kind).toBe('staged');
  });
});
