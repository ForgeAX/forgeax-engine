import { Disabled, FixedTime } from '@forgeax/engine-ecs';
import {
  Camera,
  CameraView,
  createRenderPublisher,
  perspective,
  renderPublicationAssetTransfers,
  renderPublicationTransfers,
} from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import type {
  ClosedLevelFrameSelection,
  ClosedLevelRowReceipt,
} from '../execution/closed-level-row-protocol';
import type { RenderWorkerInput, RenderWorkerOutput } from '../execution/render-worker-protocol';
import { SourceClosedLevelRows } from '../execution/source-closed-level-rows';
import { closedLevelWorld } from './fixtures/closed-level-world';

function waitFor<K extends RenderWorkerOutput['kind']>(
  worker: Worker,
  kind: K,
  match?: (message: Extract<RenderWorkerOutput, { kind: K }>) => boolean,
): Promise<Extract<RenderWorkerOutput, { kind: K }>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      remove();
      reject(new Error(`Render Worker did not report ${kind}`));
    }, 30_000);
    const onError = (event: ErrorEvent) => {
      remove();
      reject(new Error(event.message));
    };
    const onMessage = ({ data }: MessageEvent<RenderWorkerOutput>) => {
      if (data.kind === 'failed') {
        remove();
        reject(new Error(`Render Worker ${data.stage}: ${JSON.stringify(data.error)}`));
      } else if (data.kind === kind) {
        const message = data as Extract<RenderWorkerOutput, { kind: K }>;
        if (match !== undefined && !match(message)) return;
        remove();
        resolve(message);
      }
    };
    const remove = () => {
      clearTimeout(timeout);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('message', onMessage);
    };
    worker.addEventListener('error', onError);
    worker.addEventListener('message', onMessage);
  });
}

it('prepares cold Level content hidden and selects it on an exact completed Render Worker frame', async () => {
  const f = closedLevelWorld();
  const publication = { source: 'closed-level-chromium', epoch: 1 };
  const worldIdentity = f.world.identity;
  const worker = new Worker(new URL('../../dist/render-worker-runtime.mjs', import.meta.url), {
    type: 'module',
    name: 'closed-level-render',
  });
  const display = document.createElement('canvas');
  display.width = 64;
  display.height = 64;
  document.body.append(display);
  const canvas = display.transferControlToOffscreen();
  const readback = new OffscreenCanvas(64, 64).getContext('2d', { willReadFrequently: true });
  if (readback === null) throw Error('browser screenshot decoder unavailable');
  const picture = page.elementLocator(display);
  const redPixels = async () => {
    const shot = await picture.screenshot({ base64: true });
    const bytes = Uint8Array.from(atob(typeof shot === 'string' ? shot : shot.base64), (c) =>
      c.charCodeAt(0),
    );
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    readback.drawImage(bitmap, 0, 0, 64, 64);
    bitmap.close();
    const { data } = readback.getImageData(0, 0, 64, 64);
    let redPixels = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      const red = data[offset] ?? 0;
      const green = data[offset + 1] ?? 0;
      if (red > 80 && red > 1.5 * green) redPixels++;
    }
    return redPixels;
  };
  const post = (message: RenderWorkerInput, transfer: Transferable[] = []) =>
    worker.postMessage(message, transfer);
  let live = true;
  let held: ClosedLevelRowReceipt | undefined;
  let holdSerial: number | undefined;
  const source = new SourceClosedLevelRows(() => ({
    publication,
    worldIdentity,
    post(message, transfer) {
      if (message.operation.kind === 'stage') holdSerial = message.serial;
      post(message, transfer);
    },
    isCurrent: () => live,
  }));
  worker.addEventListener('message', ({ data }: MessageEvent<RenderWorkerOutput>) => {
    if (data.kind !== 'closed-level-rows-result') return;
    if (holdSerial === data.serial) held = data;
    else source.receive(data);
  });
  let publisher: ReturnType<typeof createRenderPublisher> | undefined;
  try {
    const initializing = waitFor(worker, 'ready');
    const shaderManifestUrl = new URL('/shaders/manifest.json', location.href).href;
    post({ kind: 'stage-shader-manifest', url: shaderManifestUrl });
    post(
      {
        kind: 'init',
        canvas,
        identity: publication,
        worldIdentity,
        bootstrapUrl: new URL('../../__tests__/worker-resize-bootstrap.ts', import.meta.url).href,
        shaderManifestUrl,
        renderBackend: 'webgpu',
      },
      [canvas],
    );
    const ready = await initializing;
    const closedRows = new Set<number>(f.members);
    const frames = createRenderPublisher(
      f.world,
      f.assets,
      publication,
      ready.capabilities,
      [],
      undefined,
      ready.limits,
      undefined,
      undefined,
      undefined,
      (entity) => closedRows.has(entity),
    );
    publisher = frames;
    const coldHandles = new Set<number>(f.coldAssets.map(({ handle }) => handle));
    let revision = 0;
    let frameId = 0;
    let pendingReason: unknown;
    const draw = async (groupSelection?: ClosedLevelFrameSelection) => {
      frameId++;
      f.world.set(f.resident, Transform, { pos: [(frameId % 5) * 0.25, 0, 0] }).unwrap();
      f.world.update(1 / 60).unwrap();
      const current = frames.prepare(frameId / 60).unwrap();
      expect(current.packet.base).toBe(revision);
      expect(current.packet.assets.every(({ handle }) => !coldHandles.has(handle))).toBe(true);
      expect(
        current.packet.upserts.every((value, index) => index % 2 !== 0 || !closedRows.has(value)),
      ).toBe(true);
      expect(current.packet.removed.every((entity) => !closedRows.has(entity))).toBe(true);
      const completed = waitFor(worker, 'completed');
      post(
        {
          kind: 'draw',
          worldIdentity,
          frameId,
          width: 64,
          height: 64,
          publication: current.message,
          ...(groupSelection === undefined ? {} : { groupSelection }),
          sourceFixedStep: f.world.getResource(FixedTime).tick,
        },
        [
          ...renderPublicationTransfers(current.message),
          ...renderPublicationAssetTransfers(current.message),
        ],
      );
      current.accept();
      const receipt = await completed;
      expect(receipt.frame.frameId).toBe(frameId);
      expect(receipt.revision).toBe(current.packet.revision);
      frames.recycle(receipt.revision, receipt.buffers).unwrap();
      revision = receipt.revision;
      pendingReason = receipt.frame.presentationPendingReason;
      return receipt.frame.presentation;
    };
    // The first frames can complete while the ordinary Renderer warms its pipelines.
    const deadline = performance.now() + 20_000;
    let presentation = await draw();
    while (presentation !== 'ready' && performance.now() < deadline) presentation = await draw();
    expect(presentation, JSON.stringify(pendingReason)).toBe('ready');
    expect(await redPixels()).toBe(0);
    const stagingReceipt = waitFor(
      worker,
      'closed-level-rows-result',
      (receipt) => receipt.serial === holdSerial,
    );
    const preparing = source.stage({ instance: 1, generation: 1, request: 1, attempt: 1 }, f.rows, {
      assets: f.coldAssets,
    });
    expect((await stagingReceipt).result.ok).toBe(true);
    const previousTick = f.world.getResource(FixedTime).tick;
    for (let step = 0; step < 3; step++) expect(await draw()).toBe('ready');
    expect(f.world.getResource(FixedTime).tick).toBeGreaterThan(previousTick);
    const visible = waitFor(worker, 'bounds-result');
    post({ kind: 'bounds', requestId: 1, entity: f.resident });
    expect((await visible).bounds?.max[0]).toBeCloseTo((frameId % 5) * 0.25 + 0.5);
    const query = waitFor(worker, 'bounds-result');
    const member = f.members[0];
    if (member === undefined) throw new Error('missing hidden Level member');
    post({ kind: 'bounds', requestId: 2, entity: member });
    expect((await query).bounds).toBeUndefined();
    if (held === undefined) throw new Error('missing retained chunk receipt');
    holdSerial = undefined;
    source.receive(held);
    const sealed = (await preparing).unwrap();
    const native = sealed.prepare().then(
      () => undefined,
      (cause: unknown) => ({ cause }),
    );
    for (let step = 0; step < 3; step++) expect(await draw()).toBe('ready');
    const rejected = await native;
    if (rejected !== undefined) throw new Error('Native Level preparation failed', rejected);
    const hidden = waitFor(worker, 'bounds-result');
    post({ kind: 'bounds', requestId: 3, entity: member });
    expect((await hidden).bounds).toBeUndefined();
    const select = async (id: typeof sealed.id, active: boolean, accepted = true) => {
      if (accepted)
        for (const entity of f.members) {
          if (active) f.world.removeComponent(entity, Disabled).unwrap();
          else f.world.addComponent(entity, { component: Disabled, data: {} }).unwrap();
        }
      const selection = { id, active };
      const expected = waitFor(worker, 'closed-level-selection-result');
      expect(await draw(selection)).toBe('ready');
      const selected = await expected;
      expect(selected).toMatchObject({ ...selection, frameId, revision });
      expect(selected.result).toEqual(accepted ? { ok: true } : { ok: false, reason: 'identity' });
      if (active && accepted) await expect.poll(redPixels).toBeGreaterThan(16);
    };
    await select(sealed.id, true);
    const shown = waitFor(worker, 'bounds-result');
    post({ kind: 'bounds', requestId: 4, entity: member });
    expect((await shown).bounds?.min[0]).toBeCloseTo(-3);

    const stale = { ...sealed.id, level: { ...sealed.id.level, attempt: 2 } };
    await select(stale, false, false);
    await expect.poll(redPixels).toBeGreaterThan(16);
    await select(sealed.id, false);
    await expect.poll(redPixels).toBe(0);
    for (let step = 0; step < 20; step++) expect(await draw()).toBe('ready');
    await select(sealed.id, true);
    await select(sealed.id, false);
    await expect.poll(redPixels).toBe(0);

    // The same source needs another physical View after the player opens a split screen.
    f.world
      .addComponent(f.camera, {
        component: CameraView,
        data: { viewport: [0, 0, 0.5, 1] },
      })
      .unwrap();
    f.world
      .spawn(
        { component: Transform, data: { pos: [0, 0, 10] } },
        { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 1 }) },
        { component: CameraView, data: { viewport: [0.5, 0, 0.5, 1], order: 1 } },
      )
      .unwrap();
    const cameraDeadline = performance.now() + 20_000;
    presentation = await draw();
    while (presentation !== 'ready' && performance.now() < cameraDeadline)
      presentation = await draw();
    expect(presentation, JSON.stringify(pendingReason)).toBe('ready');
    expect(await redPixels()).toBe(0);
    const obsolete = waitFor(worker, 'closed-level-selection-result');
    expect(await draw({ id: sealed.id, active: true })).toBe('ready');
    expect(await obsolete).toMatchObject({
      frameId,
      revision,
      result: { ok: false, reason: 'view-obsolete' },
    });
    expect(await redPixels()).toBe(0);
    await sealed.prepare(undefined, () =>
      f.members.every((entity) => f.world.hasComponent(entity, Disabled)),
    );
    await select(sealed.id, true);
    await select(sealed.id, false);
    await expect.poll(redPixels).toBe(0);
    await sealed.retire();
    await select(sealed.id, true, false);
    expect(await redPixels()).toBe(0);
    expect(await draw()).toBe('ready');
    const disposed = waitFor(worker, 'disposed');
    post({ kind: 'dispose' });
    expect((await disposed).error).toBeUndefined();
  } finally {
    live = false;
    source.invalidate();
    worker.terminate();
    display.remove();
    publisher?.dispose();
    f.assets.dispose();
  }
}, 120_000);
