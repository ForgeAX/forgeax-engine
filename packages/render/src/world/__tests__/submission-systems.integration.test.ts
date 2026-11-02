import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import type { RhiAdapter, RhiDevice, RhiError, Texture } from '@forgeax/engine-rhi';
import { RhiError as RuntimeRhiError } from '@forgeax/engine-rhi';
import {
  rhi as nullRhi,
  RhiNullCommandEncoder,
  RhiNullDevice,
  RhiNullQueue,
} from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { err, ok, type Result } from '@forgeax/engine-types';
import { expect, it, onTestFinished, vi } from 'vitest';
import { renderLifecycleManifestUrl } from '../../__tests__/shader-manifest-fixture';
import { Camera, perspective } from '../../components/camera';
import { CameraView } from '../../components/camera-view';
import { constructRendererHost } from '../../construct-renderer';
import * as renderWorlds from '../render-world';
import { RenderCleanup, RenderCommit } from '../render-world';
import {
  RENDER_RECORD_COMMIT_SYSTEM,
  RENDER_SUBMISSION_RETIRE_SYSTEM,
} from '../submission-systems';

vi.mock('../render-world', async (actual) => {
  const module = await actual<typeof import('../render-world')>();
  return { ...module, createRenderWorld: vi.fn(module.createRenderWorld) };
});

type LostInfo = { readonly reason: 'destroyed' | 'unknown'; readonly message: string };

/** Queue completions wait for an open gate, so a frame's GPU work stays in flight. */
class GatedQueue extends RhiNullQueue {
  private gate: Promise<void> | undefined;
  private openGate: (() => void) | undefined;

  close(): void {
    this.gate = new Promise((resolve) => {
      this.openGate = resolve;
    });
  }

  open(): void {
    this.openGate?.();
    this.gate = undefined;
  }

  override onSubmittedWorkDone(): Promise<undefined> {
    const done = super.onSubmittedWorkDone();
    const gate = this.gate;
    return gate === undefined ? done : Promise.all([done, gate]).then(() => undefined);
  }
}

class LosableDevice extends RhiNullDevice {
  readonly outputs = new Map<string, Texture>();
  readonly destroyed = new Set<Texture>();
  private readonly lostInfo: Promise<LostInfo>;
  private resolveLost!: (info: LostInfo) => void;

  constructor(readonly gated: GatedQueue) {
    super(gated, (bookkeeper, device) => new RhiNullCommandEncoder(bookkeeper, device));
    this.lostInfo = new Promise((resolve) => {
      this.resolveLost = resolve;
    });
  }

  override get lost(): Promise<LostInfo> {
    return this.lostInfo;
  }

  override createTexture(descriptor: Parameters<RhiNullDevice['createTexture']>[0]) {
    const created = super.createTexture(descriptor);
    const label = descriptor.label ?? '';
    if (created.ok && label.endsWith(':output')) this.outputs.set(label, created.value);
    return created;
  }

  override destroyTexture(texture: Texture) {
    this.destroyed.add(texture);
    return super.destroyTexture(texture);
  }

  lose(): void {
    this.resolveLost({ reason: 'unknown', message: 'submission lifecycle probe' });
  }
}

class LosableAdapter implements RhiAdapter {
  readonly features: ReadonlySet<GPUFeatureName> = new Set();
  readonly limits: Readonly<Record<string, number>> = {};
  readonly devices: LosableDevice[] = [];

  requestDevice(): Promise<Result<RhiDevice, RhiError>> {
    const device = new LosableDevice(new GatedQueue());
    this.devices.push(device);
    return Promise.resolve(ok(device));
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup() {
  const adapter = new LosableAdapter();
  const made = await constructRendererHost(
    { width: 64, height: 64, getContext: () => null },
    { rhi: { ...nullRhi, requestAdapter: () => Promise.resolve(ok(adapter)) } },
    { shaderManifestUrl: renderLifecycleManifestUrl() },
  );
  if (!made.ok) throw made.error;
  const renderer = made.value.renderer;
  const created = vi.mocked(renderWorlds.createRenderWorld).mock.results.at(-1);
  if (created?.type !== 'return') throw new Error('the Renderer creates its Render World');
  const renderWorld = created.value;
  const world = new World();
  registerPropagateTransforms(world);
  const cameras: EntityHandle[] = [0, 1].map((index) =>
    world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 3] } },
        { component: Camera, data: perspective({ fov: Math.PI / 2, aspect: 1 }) },
        {
          component: CameraView,
          data: { viewport: new Float32Array([index * 0.5, 0, 0.5, 1]), order: index },
        },
      )
      .unwrap(),
  );
  world.update(1 / 60).unwrap();
  const attached = renderer.attach(world);
  if (!attached.ok) throw attached.error;
  const lease = attached.value;
  onTestFinished(async () => {
    lease.dispose();
    for (const device of adapter.devices) device.gated.open();
    await renderer.dispose();
  });
  const request = { leases: [lease], camera: { lease }, environment: { lease } };
  const device = () => adapter.devices.at(-1) as LosableDevice;
  const submitted = () => renderer.inspect().recoveryEvidence.submissions.count;
  /** Issue a frame; its completion settles once the device's gate opens. */
  const issue = () => {
    world.update(1 / 60).unwrap();
    const drawn = renderer.draw(request);
    return drawn.ok ? drawn.value.completed.then((completed) => completed.ok) : false;
  };
  return { renderer, renderWorld, world, cameras, device, submitted, issue };
}

it('a failed queue submit never advances the submission count or view history', async () => {
  const { renderWorld, device, submitted, issue } = await setup();
  expect(await issue()).toBe(true);
  const before = submitted();
  expect(before).toBeGreaterThan(0);
  const submit = vi
    .spyOn(device().gated, 'submit')
    .mockReturnValueOnce(
      err(new RuntimeRhiError({ code: 'queue-submit-failed', expected: 'x', hint: 'y' })),
    );
  expect(await issue()).toBe(false);
  submit.mockRestore();
  expect(submitted()).toBe(before);
  expect(await issue()).toBe(true);
  expect(submitted()).toBe(before + 1);
  // The count is the render-record-commit system's product.
  renderWorld.removeSystem(RenderCommit, RENDER_RECORD_COMMIT_SYSTEM).unwrap();
  expect(await issue()).toBe(true);
  expect(submitted()).toBe(before + 1);
});

it.each([
  true,
  false,
])('a view retired with its frame in flight releases its output after that completion (system: %s)', async (system) => {
  const { renderWorld, world, cameras, device, issue } = await setup();
  if (!system) renderWorld.removeSystem(RenderCleanup, RENDER_SUBMISSION_RETIRE_SYSTEM).unwrap();
  expect(await issue()).toBe(true);
  const outputs = [...device().outputs.values()];
  expect(outputs.length).toBeGreaterThanOrEqual(2);
  device().gated.close();
  // The removed view despawns in this frame's RenderExtract: inside the open frame.
  world.removeComponent(cameras[1] as EntityHandle, CameraView).unwrap();
  const inFlight = issue();
  await flush();
  const released = () => outputs.filter((texture) => device().destroyed.has(texture)).length;
  expect(released()).toBe(0);
  device().gated.open();
  expect(await inFlight).toBe(true);
  await flush();
  expect(released()).toBe(system ? 1 : 0);
});

it('a device lost mid-flight retires its views on the lost generation queue', async () => {
  const { renderer, device, issue, submitted } = await setup();
  expect(await issue()).toBe(true);
  const lost = device();
  const outputs = [...lost.outputs.values()];
  lost.gated.close();
  const inFlight = issue();
  lost.lose();
  await flush();
  expect(renderer.state()).toBe('device-lost');
  const recovered = await renderer.recover();
  if (!recovered.ok) throw recovered.error;
  const next = device();
  expect(next).not.toBe(lost);
  // The recovered generation's frame completes; the lost generation's views
  // still wait for their own queue, never the new generation's completion.
  expect(await issue()).toBe(true);
  // Recovery installs a fresh RenderSystem; its count starts at the first recovered frame.
  expect(submitted()).toBe(1);
  expect(outputs.filter((texture) => lost.destroyed.has(texture))).toEqual([]);
  lost.gated.open();
  await inFlight;
  await flush();
  expect(outputs.every((texture) => lost.destroyed.has(texture))).toBe(true);
});
