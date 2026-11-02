import { World } from '@forgeax/engine-ecs';
import { equirectContribution } from '@forgeax/engine-image';
import { RhiNullDevice, rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { drawReadyFrame } from '../../../../../scripts/test/ready-render-frame.mjs';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { createRenderer } from '../../assembly/factory';
import { exposeRenderer } from '../../assembly/renderer-facade';
import { ANTIALIAS_NONE, Camera } from '../../components/camera';
import { PlanarReflection } from '../../components/planar-reflection';
import { Skylight } from '../../components/skylight';
import { GpuResidencyCache } from '../../device/gpu-residency';
import { createRenderPublisher } from '../../publication/publisher';
import { encodeRenderPublication, renderPublicationTransfers } from '../../publication/record';
import { RenderViewInput } from '../render-views';
import { RenderPrepare, RenderQueue, RenderRecord, renderSubmission } from '../render-world';
import { ViewRecordAttempt, type ViewRecordAttemptState } from '../view-record-systems';

async function fixture(published = false, withUi = false) {
  const identity = { source: 'view-record-systems', epoch: 1 };
  const adapter = (await rhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  if (!(device instanceof RhiNullDevice)) throw new Error('Expected the null device');
  vi.spyOn(adapter, 'requestDevice').mockResolvedValue(ok(device));
  let renderWorld: World | undefined;
  const insert = World.prototype.insertResource;
  const observe = vi.spyOn(World.prototype, 'insertResource').mockImplementation(function (
    this: World,
    key,
    value,
  ) {
    if (typeof key !== 'string' && key.name === RenderViewInput.name) renderWorld = this;
    return insert.call(this, key, value);
  });
  const paint = vi.fn(
    (_time: number, width: number, height: number) => new Uint8Array(width * height * 4),
  );
  const host = await createRenderer(
    { width: 32, height: 32, getContext: () => null },
    {
      rhi: { ...rhi, requestAdapter: async () => ok(adapter) },
      ...(published ? { publicationSource: identity } : {}),
      ...(withUi
        ? {
            ui: {
              kind: 'rgba' as const,
              paint,
            },
          }
        : {}),
    },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  observe.mockRestore();
  expect((await host.initialization).ok).toBe(true);
  const renderer = exposeRenderer(host);
  const world = new World({ assets: host.assetRegistry });
  const attachment = published ? undefined : renderer.attach(world);
  if (attachment?.ok === false) throw attachment.error;
  const attached = attachment?.value;
  const publisher = published
    ? createRenderPublisher(world, host.assetRegistry, identity)
    : undefined;
  registerPropagateTransforms(world);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      {
        component: Camera,
        data: { fov: 1, aspect: 1, near: 0.1, far: 100, antialias: ANTIALIAS_NONE },
      },
    )
    .unwrap();
  world.update().unwrap();
  if (renderWorld === undefined) throw new Error('Renderer did not publish its World');
  const submit = vi.spyOn(device.queue, 'submit');
  const nextInput = () => {
    if (publisher !== undefined) {
      const candidate = publisher.prepare(0).unwrap();
      const packet = structuredClone(candidate.packet, {
        transfer: renderPublicationTransfers(candidate.message),
      });
      candidate.accept();
      return { publication: encodeRenderPublication(packet) };
    }
    if (attached === undefined) throw new Error('Missing frame source');
    return { leases: [attached], camera: { lease: attached }, environment: { lease: attached } };
  };
  return {
    renderer,
    camera,
    device,
    assets: host.assetRegistry,
    paint,
    world,
    renderWorld,
    submit,
    input: nextInput(),
    nextInput,
    dispose: async () => {
      await renderer.dispose();
      publisher?.dispose();
    },
  };
}

it.each([
  [RenderQueue, 'render-view-record-start'],
  [RenderQueue, 'render-view-graph-prepare'],
  [RenderRecord, 'render-frame-submit'],
  [RenderQueue, 'render-temporal-resolve'],
  [RenderPrepare, 'render-temporal-stage'],
] as const)('does not run a manual fallback after removing %s/%s', async (schedule, name) => {
  const f = await fixture();
  try {
    f.renderWorld.removeSystem(schedule, name).unwrap();
    expect(f.renderer.draw(f.input).ok).toBe(false);
    expect(f.submit).not.toHaveBeenCalled();
    expect(renderSubmission(f.renderWorld).accepted).toBe(false);
    expect(f.renderWorld.execution.health).toBe('healthy');
  } finally {
    await f.dispose();
  }
});

it('cancels at the one frame checkpoint, releases attempts and records the next frame normally', async () => {
  const f = await fixture(true);
  const controller = new AbortController();
  const checkpoint = vi.fn(async () => controller.abort());
  try {
    if (f.renderer.drawScheduled === undefined || f.input.publication === undefined)
      throw new Error('Missing scheduled publication capability');
    const canceled = await f.renderer.drawScheduled(
      { publication: f.input.publication },
      {
        checkpoint,
        signal: controller.signal,
      },
    );
    expect(canceled.ok).toBe(false);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.renderWorld.execution.health).toBe('healthy');
    for (const row of f.renderWorld.query({ read: [ViewRecordAttempt] }).unwrap()) {
      const state = f.renderWorld
        .resolveUniqueRef<ViewRecordAttemptState>(row.get(ViewRecordAttempt).state)
        .unwrap();
      expect(state.attempt).toBeUndefined();
      expect(state.recording).toBeUndefined();
    }
    const next = f.renderer.draw(f.nextInput());
    if (!next.ok) throw next.error;
    expect((await next.value.completed).ok).toBe(true);
    expect(f.submit).toHaveBeenCalledTimes(1);
    expect(f.renderWorld.execution.health).toBe('healthy');
  } finally {
    await f.dispose();
  }
});

it('does not present or submit UI through an assembly fallback when its Record owner is removed', async () => {
  const f = await fixture(false, true);
  try {
    f.renderWorld.removeSystem(RenderRecord, 'render-surface-ui-encode').unwrap();
    expect(f.renderer.draw(f.input).ok).toBe(false);
    expect(f.submit).not.toHaveBeenCalled();
    expect(renderSubmission(f.renderWorld).accepted).toBe(false);
    expect(f.renderWorld.execution.health).toBe('healthy');
  } finally {
    await f.dispose();
  }
});

it('submits a UI-only frame after retiring a submitted scene without reusing its view attempts', async () => {
  const f = await fixture(false, true);
  try {
    const scene = f.renderer.draw(f.input);
    if (!scene.ok) throw scene.error;
    expect((await scene.value.completed).ok).toBe(true);
    const presented = f.renderer.draw({ leases: [], camera: null, environment: null });
    if (!presented.ok) throw presented.error;
    expect(presented.value.presentation).toBe('pending');
    expect((await presented.value.completed).ok).toBe(true);
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.renderWorld.execution.health).toBe('healthy');
  } finally {
    await f.dispose();
  }
});

it.each([
  [RenderPrepare, 'render-surface-ui-prepare', false],
  [RenderRecord, 'render-surface-ui-present-prepare', true],
] as const)('owns actual UI paint in %s/%s without a frame-entry fallback', async (schedule, system, presentationOnly) => {
  const f = await fixture(false, true);
  try {
    f.renderWorld.removeSystem(schedule, system).unwrap();
    const input = presentationOnly
      ? { leases: [] as const, camera: null, environment: null }
      : f.input;
    expect(f.renderer.draw(input).ok).toBe(false);
    expect(f.paint).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.renderWorld.execution.health).toBe('healthy');
  } finally {
    await f.dispose();
  }
});

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])('renders the first image picture, then defers pending work and resumes on the real cube (UI=%s, planar=%s)', async (withUi, planar) => {
  const f = await fixture(false, withUi);
  const pending = vi
    .spyOn(GpuResidencyCache.prototype, 'getCubemapStatus')
    .mockReturnValue('pending');
  try {
    f.assets.installDecoder(equirectContribution.kind, equirectContribution.decoder);
    const equirect = f.assets
      .create({
        kind: 'equirect',
        width: 4,
        height: 2,
        format: 'rgba16float',
        colorSpace: 'linear',
        data: new Uint8Array(64),
      })
      .unwrap();
    f.world.spawn({ component: Skylight, data: { equirect } }).unwrap();
    if (planar) {
      const created = f.renderer.createRenderTarget({
        shape: '2d',
        width: 32,
        height: 32,
        format: 'rgba16float',
        sampleCount: 1,
        mipLevels: 1,
        sampled: true,
        readback: false,
      });
      if (!created.ok) throw created.error;
      const target = created.value;
      f.world
        .addComponent(f.camera, {
          component: PlanarReflection,
          data: { target: f.world.allocSharedRef('RenderTarget', target), distance: 0 },
        })
        .unwrap();
    }
    f.world.update().unwrap();
    const initial = f.device.framePassNames.length;
    const first = f.renderer.draw(f.nextInput());
    if (!first.ok) throw first.error;
    expect((await first.value.completed).ok).toBe(true);
    expect(first.value.presentation).toBe('pending');
    expect(f.device.framePassNames.slice(initial)).toContain('main');
    const before = f.device.framePassNames.length;
    const submitted = f.renderer.draw(f.nextInput());
    if (!submitted.ok) throw submitted.error;
    const barrier = submitted.value;
    expect((await barrier.completed).ok).toBe(true);
    expect(barrier.presentation).toBe('pending');
    expect(f.device.framePassNames.slice(before)).not.toContain('main');
    if (withUi) expect(f.paint).toHaveBeenCalled();
    pending.mockRestore();
    const input = f.nextInput();
    if (input.leases === undefined) throw new Error('Expected attached scene input');
    const ready = await drawReadyFrame(f.renderer, input);
    expect(ready.presentation).toBe('ready');
    expect(f.device.framePassNames.slice(before)).toContain('main');
    expect(renderSubmission(f.renderWorld).accepted).toBe(true);
  } finally {
    pending.mockRestore();
    await f.dispose();
  }
});
