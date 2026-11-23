import type { PlatformEvent } from '@forgeax/engine-platform';
import { afterEach, describe, expect, it } from 'vitest';
import {
  verifyFileStore,
  verifyRecordStore,
} from '../../../platform/src/__tests__/storage-contract.fixture';
import { createBrowserFileStore } from '../file-storage';
import { createBrowserPlatform } from '../index.js';
import {
  createBrowserRecordStore,
  createBrowserSaveRecords,
  createIndexedDbTransaction,
} from '../record-storage';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const release of cleanup.splice(0).reverse()) release();
});
function fixture(document: Document = globalThis.document) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:200px;height:100px';
  canvas.width = 800;
  canvas.height = 400;
  document.body.append(canvas);
  cleanup.push(() => canvas.remove());
  const platform = createBrowserPlatform(canvas).unwrap();
  cleanup.push(() => platform.dispose());
  return { canvas, platform };
}

describe('real browser native platform', () => {
  it('retains display identity, physical buffer and browser monotonic milliseconds', async () => {
    const { canvas, platform } = fixture();
    const first = platform.now().unwrap();
    await new Promise<void>((resolve) => {
      platform.requestFrame(resolve).unwrap();
    });
    expect(platform.now().unwrap()).toBeGreaterThanOrEqual(first);
    expect(platform.canvas).toBe(canvas);
    const facts = platform.display().unwrap();
    expect(facts).toMatchObject({
      width: 200,
      height: 100,
      drawingWidth: 800,
      drawingHeight: 400,
      pixelRatio: devicePixelRatio,
    });
    expect(facts.safeArea.x).toBeGreaterThanOrEqual(0);
    expect(facts.safeArea.width).toBeLessThanOrEqual(200);
    expect(document.querySelectorAll('div[style*="safe-area-inset"]')).toHaveLength(0);
  });

  it('uses an iframe canvas native Window and reports real CSS resizing', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    cleanup.push(() => frame.remove());
    const owner = frame.contentDocument;
    if (owner === null) throw new Error('iframe document unavailable');
    const { canvas, platform } = fixture(owner);
    const events: PlatformEvent[] = [];
    platform.subscribe((event) => events.push(event)).unwrap();
    canvas.style.width = '240px';
    await expect
      .poll(() => events.some((event) => event.kind === 'display' && event.display.width === 240))
      .toBe(true);
    expect(platform.now().unwrap()).toBeCloseTo(owner.defaultView?.performance.now() ?? NaN, -1);
  });

  it('cancels real frames, disposes subscriptions, and preserves the borrowed canvas', async () => {
    const { canvas, platform } = fixture();
    let calls = 0;
    const cancel = platform
      .requestFrame(() => {
        calls += 1;
      })
      .unwrap();
    cancel();
    cancel();
    let events = 0;
    const release = platform
      .subscribe(() => {
        events += 1;
      })
      .unwrap();
    release();
    release();
    platform
      .requestFrame(() => {
        calls += 1;
      })
      .unwrap();
    platform.dispose();
    platform.dispose();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    window.dispatchEvent(new Event('resize'));
    expect(calls).toBe(0);
    expect(events).toBe(0);
    expect(canvas.isConnected).toBe(true);
    expect(platform.display()).toMatchObject({ ok: false, error: { code: 'platform-disposed' } });
  });

  it('keeps pagehide/pageshow visibility consistent with event facts', () => {
    const { platform } = fixture();
    const events: PlatformEvent[] = [];
    const release = platform.subscribe((event) => events.push(event)).unwrap();
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(platform.visible()).toBe(false);
    window.dispatchEvent(new PageTransitionEvent('pageshow'));
    expect(platform.visible()).toBe(document.visibilityState !== 'hidden');
    expect(events.filter((event) => event.kind === 'visibility')).toHaveLength(2);
    release();
  });

  it('rejects a detached canvas before allocating host listeners', () => {
    expect(createBrowserPlatform(document.createElement('canvas'))).toMatchObject({
      ok: false,
      error: { code: 'platform-unavailable' },
    });
  });

  it('observes page lifetime without a subscriber and after the last subscriber releases', () => {
    const { platform } = fixture();
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    expect(platform.visible()).toBe(false);
    const release = platform.subscribe(() => {}).unwrap();
    release();
    window.dispatchEvent(new PageTransitionEvent('pageshow'));
    expect(platform.visible()).toBe(document.visibilityState !== 'hidden');
  });

  it('reports a detached display through the surface failure path', async () => {
    const { canvas, platform } = fixture();
    const events: PlatformEvent[] = [];
    platform.subscribe((event) => events.push(event)).unwrap();
    canvas.remove();
    window.dispatchEvent(new Event('resize'));
    expect(platform.display().ok).toBe(false);
    expect(events.some((event) => event.kind === 'surface-lost')).toBe(true);
  });
});

it('reopens IndexedDB records and reads bounded OPFS ranges in a separate Worker', async () => {
  const project = crypto.randomUUID();
  const records = () => createBrowserSaveRecords(() => indexedDB, project);
  const signal = new AbortController().signal;
  const first = createBrowserFileStore(project, 'contract');
  const reopened = createBrowserFileStore(project, 'contract');
  await verifyFileStore(first, reopened);

  const record = new TextEncoder().encode('{"version":1,"data":{"zone":3}}');
  const legacy = createIndexedDbTransaction(() => indexedDB, 'forgeax-game-saves', 'slots');
  await legacy('readwrite', signal, (store) => {
    store.put(new TextDecoder().decode(record), [project, 'slot']);
  });
  const writer = (await first.beginWrite(4, signal)).unwrap();
  (await writer.append(Uint8Array.of(10, 20, 30, 40), signal)).unwrap();
  const ref = (await writer.commit(signal)).unwrap();
  const worker = new Worker(new URL('./storage-worker.fixture.ts', import.meta.url), {
    type: 'module',
  });
  try {
    const reply = new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) =>
        data?.error ? reject(new Error(data.error)) : resolve(data);
      worker.onerror = reject;
    });
    worker.postMessage({ project, ref });
    expect(await reply).toEqual({ record: [...record], range: [20, 30] });
    const binaryRecords = () => createBrowserRecordStore(project, 'contract');
    await verifyRecordStore(binaryRecords(), binaryRecords());
    (await binaryRecords().replace('binary', Uint8Array.of(255, 0), signal)).unwrap();
    expect((await binaryRecords().read('binary', signal)).unwrap()).toEqual(Uint8Array.of(255, 0));
    (await binaryRecords().remove('binary', signal)).unwrap();
  } finally {
    worker.terminate();
    (await reopened.remove(ref, signal)).unwrap();
    (await records().remove('slot', signal)).unwrap();
  }
});
