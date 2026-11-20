import { type BrowserFrameCompleted, FORGEAX_FRAME_COMPLETED_EVENT } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { appLevelOwner } from '@forgeax/engine-app/internal';
import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import physics3d from '@forgeax/engine-physics-rapier3d';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import { installLevelFixture, type LevelFixtureStatus as Status } from './level-runtime.fixture';

declare module 'vitest/browser' {
  interface BrowserCommands {
    openLevelRuntimeFixture(): Promise<{
      origin: string;
      catalog: string;
      rootGuid: string;
      scope: { scopeId: string; generation: number };
    }>;
    waitForLevelRuntimeDownload(origin: string): Promise<void>;
    releaseLevelRuntimeDownload(origin: string): Promise<void>;
    closeLevelRuntimeFixture(origin: string): Promise<void>;
  }
}

async function picture(canvas: HTMLCanvasElement) {
  const screenshot = await page.elementLocator(canvas).screenshot({ base64: true });
  const bytes = Uint8Array.from(
    atob(typeof screenshot === 'string' ? screenshot : screenshot.base64),
    (value) => value.charCodeAt(0),
  );
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const context = new OffscreenCanvas(128, 128).getContext('2d');
  if (context === null) throw Error('Missing pixel decoder');
  context.drawImage(bitmap, 0, 0, 128, 128);
  bitmap.close();
  return context.getImageData(44, 56, 68, 48).data;
}

function changedPixels(before: Uint8ClampedArray, after: Uint8ClampedArray) {
  let changed = 0;
  for (let i = 0; i < before.length; i += 4) {
    const distance =
      Math.abs((before[i] ?? 0) - (after[i] ?? 0)) +
      Math.abs((before[i + 1] ?? 0) - (after[i + 1] ?? 0)) +
      Math.abs((before[i + 2] ?? 0) - (after[i + 2] ?? 0));
    if (distance > 24) changed++;
  }
  return changed;
}

it.each(['local', 'split Worker', 'first Level in split Worker'] as const)('runs the same cooked Level lifecycle with %s execution', async (tier) => {
  const fixture = await commands.openLevelRuntimeFixture();
  const channel = new MessageChannel();
  let nextId = 0;
  let completed = 0;
  const readyFrames = new Set<number>();
  let dispose: (() => Promise<void>) | undefined;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  canvas.style.width = canvas.style.height = '128px';
  canvas.setAttribute('data-forgeax-render-width-limit', '128');
  canvas.setAttribute('data-forgeax-render-height-limit', '128');
  canvas.addEventListener(FORGEAX_FRAME_COMPLETED_EVENT, (event) => {
    const frame = (event as CustomEvent<BrowserFrameCompleted>).detail;
    if (frame.presentation === 'ready') {
      readyFrames.add(frame.frameId);
      completed++;
    }
  });
  document.body.append(canvas);
  channel.port1.start();
  const requestWorker = (kind: string): Promise<Status> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        channel.port1.removeEventListener('message', receive);
        reject(Error(`Split Level source timed out waiting for ${kind}`));
      }, 30_000);
      const receive = ({ data }: MessageEvent<Status & { id: number }>) => {
        if (data.id !== id) return;
        clearTimeout(timer);
        channel.port1.removeEventListener('message', receive);
        resolve(data);
      };
      channel.port1.addEventListener('message', receive);
      channel.port1.postMessage({ id, kind });
    });
  };
  try {
    const bundler = { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href };
    const assetCatalog = { url: fixture.catalog, expectedScope: fixture.scope };
    const app = tier === 'local'
      ? (await createApp(canvas, { plugins: [physics3d], assetCatalog: createCatalogSource(assetCatalog) }, bundler)).unwrap()
      : (await createApp(
          canvas,
          {
            execution: {
              workers: { engine: true, render: true, kernels: false },
              bootstrap: new URL('./level-runtime-split-bootstrap.ts', import.meta.url),
              bootstrapPort: channel.port2,
              bootstrapData: { rootGuid: fixture.rootGuid, firstLevel: tier === 'first Level in split Worker' },
              assetCatalog,
              startupTimeoutMs: 90_000,
            },
          },
          bundler,
        )).unwrap();
    dispose = async () => { (await app.dispose()).unwrap(); };
    let requestSource = requestWorker;
    if (tier === 'local') {
      if (app.assets === undefined) throw Error('Missing local asset registry');
      const local = installLevelFixture(
        app.world, app.assets, app.physics, appLevelOwner(app), fixture.rootGuid,
      );
      requestSource = local.request;
      dispose = async () => {
        local.dispose();
        (await app.dispose()).unwrap();
      };
    }
    const request = async (kind: string) => {
      const status = await requestSource(kind);
      if (status.error !== undefined) throw Error(`${kind}: ${status.error}`);
      if (status.phase === 'failed' || status.failure !== undefined || status.cleanupFailure !== undefined)
        throw Error(status.failure ?? status.cleanupFailure ?? 'Level failed');
      return status;
    };
    const errors: unknown[] = [];
    const removeErrors = app.onError((cause) => errors.push(cause));
    try {
      app.start().unwrap();
      await expect.poll(() => completed, { timeout: 45_000 }).toBeGreaterThanOrEqual(60);
      const old = await request('inspect');
      const readyBefore = completed;
      const baseline = await picture(canvas);
      expect(old.hit).toBeUndefined();
      const loading = request('load').then(
        () => undefined,
        (cause: unknown) => ({ cause }),
      );
      try {
        await commands.waitForLevelRuntimeDownload(fixture.origin);
        await expect.poll(() => completed).toBeGreaterThanOrEqual(readyBefore + 3);
        expect((await request('inspect')).tick).toBeGreaterThan(old.tick);
        expect(changedPixels(baseline, await picture(canvas))).toBeLessThan(16);
      } finally {
        await commands.releaseLevelRuntimeDownload(fixture.origin);
      }
      const loadFailure = await loading;
      if (loadFailure !== undefined) throw loadFailure.cause;
      const when = async (phase: string) => {
        let state: Status | undefined;
        await expect.poll(async () => {
          state = await request('inspect');
          return state.phase;
        }, { timeout: 45_000, interval: 50 }).toBe(phase);
        if (state === undefined) throw Error('Missing source status');
        return state;
      };
      const prepared = await when('prepared');
      expect(prepared.current).toBe(true);
      expect(prepared.memberCount).toBeGreaterThan(3);
      expect(prepared.tick).toBeGreaterThan(old.tick);
      expect(completed).toBeGreaterThan(readyBefore);
      expect(prepared.hit).toBeUndefined();
      expect(changedPixels(baseline, await picture(canvas))).toBeLessThan(16);
      await request('active');
      const shown = await when('active');
      expect(shown.hit).toBeTypeOf('number');
      if (tier !== 'local') {
        const receipt = shown.renderSelection;
        expect(receipt?.active).toBe(true);
        if (receipt === undefined) throw Error('Missing completed Level activation receipt');
        await expect.poll(() => readyFrames.has(receipt.frameId)).toBe(true);
      }
      await expect.poll(async () => changedPixels(baseline, await picture(canvas))).toBeGreaterThan(24);
      await request('prepared');
      expect((await when('prepared')).hit).toBeUndefined();
      await expect.poll(async () => changedPixels(baseline, await picture(canvas))).toBeLessThan(16);
      await request('active');
      expect((await when('active')).hit).toBeTypeOf('number');
      await request('prepared');
      expect((await when('prepared')).hit).toBeUndefined();
      const previous = completed;
      await request('open-split-view');
      await expect.poll(() => completed).toBeGreaterThanOrEqual(previous + 3);
      await request('inspect');
      const resized = await picture(canvas);
      await request('active');
      expect((await when('active')).hit).toBeTypeOf('number');
      await expect.poll(async () => changedPixels(resized, await picture(canvas))).toBeGreaterThan(24);
      await request('unloaded');
      expect((await when('retired')).hit).toBeUndefined();
      if (tier === 'split Worker') {
        await request('load');
        expect((await when('prepared')).hit).toBeUndefined();
        await request('active');
        expect((await when('active')).hit).toBeTypeOf('number');
        await request('unloaded');
        expect((await when('retired')).hit).toBeUndefined();
      }
      expect(errors).toEqual([]);
    } finally {
      removeErrors();
    }
  } finally {
    await dispose?.();
    channel.port1.close();
    channel.port2.close();
    canvas.remove();
    await commands.closeLevelRuntimeFixture(fixture.origin);
  }
}, 180_000);
