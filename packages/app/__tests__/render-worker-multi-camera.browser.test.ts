import { type ExecutionApp } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import type { CameraViewInspection } from '@forgeax/engine-render';
import {
  buildFrameModel,
  decodeTape,
  openReplay,
  replayDeviceRequest,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { commands, page } from 'vitest/browser';
import type { ExecutionInspectResultMessage } from '../src/execution/protocol';

interface Picture {
  id: number;
  error?: unknown;
  frameId: number;
  views: CameraViewInspection[];
  cut?: CameraViewInspection[];
  observation: {
    bytes: Uint8Array;
    metadata: { width: number; height: number; bytesPerRow: number; format: string };
  };
}
function request<T>(
  port: MessagePort | BroadcastChannel,
  message: { id: number; kind: string; frameId?: number },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      port.removeEventListener('message', receive);
      reject(new Error(`Worker ${message.kind} timed out`));
    }, 60_000);
    const receive = (messageEvent: Event) => {
      const event = messageEvent as MessageEvent;
      if (event.data.id !== message.id) return;
      clearTimeout(timer);
      port.removeEventListener('message', receive);
      if (event.data.error !== undefined) reject(new Error(JSON.stringify(event.data.error)));
      else resolve(event.data);
    };
    port.addEventListener('message', receive);
    port.postMessage(message);
  });
}
async function save(name: string, bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  await commands.writeFile(`artifacts/multi-camera/worker/${name}`, btoa(binary), 'base64');
}
function packed(picture: Picture): Uint8Array {
  const {
    bytes,
    metadata: { width, height, bytesPerRow },
  } = picture.observation;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    pixels.set(bytes.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  return pixels;
}
function pixel(picture: Picture, x: number, y: number) {
  const offset = (y * picture.observation.metadata.width + x) * 4;
  const rgba = [...packed(picture).subarray(offset, offset + 4)];
  return picture.observation.metadata.format.startsWith('bgra')
    ? [rgba[2]!, rgba[1]!, rgba[0]!, rgba[3]!]
    : (rgba as number[]);
}

function mapRedCenter(picture: Picture): number {
  const { bytes, metadata } = picture.observation;
  const red = metadata.format.startsWith('bgra') ? 2 : 0;
  let sum = 0,
    count = 0;
  for (let y = 0; y < metadata.height / 4; y++)
    for (let x = (metadata.width * 3) / 4; x < metadata.width; x++) {
      const i = y * metadata.bytesPerRow + x * 4;
      if (bytes[i + red]! - bytes[i + 1]! > 70) {
        sum += y;
        count++;
      }
    }
  expect(count).toBeGreaterThan(0);
  return sum / count;
}

it('keeps multi-camera pixels, cadence and source ownership through actual Render Worker replacement', async () => {
  await page.viewport(800, 600);
  const NativeWorker = globalThis.Worker;
  let sourceWorker: Worker | undefined;
  globalThis.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      if (options?.name === 'forgeax-engine') sourceWorker = this;
    }
  };
  const canvas = document.createElement('canvas');
  canvas.style.width = '128px';
  canvas.style.height = '64px';
  document.body.append(canvas);
  const source = new MessageChannel();
  source.port1.start();
  const name = `multi-camera-${crypto.randomUUID()}`;
  const channel = new BroadcastChannel(name);
  let id = 10_000;
  let ownedApp: ExecutionApp | undefined;
  try {
    const app = (
      await createApp(
        canvas,
        {
          execution: {
            workers: { engine: true, render: true, kernels: false },
            bootstrap: new URL('./render-worker-multi-camera-bootstrap.ts', import.meta.url),
            bootstrapData: name,
            bootstrapPort: source.port2,
            diagnostics: { rhiCapture: true },
            startupTimeoutMs: 90_000,
            frameTimeoutMs: 30_000,
          },
        },
        { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
      )
    ).unwrap();
    ownedApp = app;
    const execution = app.execution!;
    const command = (kind: string) => request(source.port1, { id: ++id, kind });
    const observe = (kind = 'observe') => request<Picture>(channel, { id: ++id, kind });
    const advance = async (frames: number) => {
      const start = execution.report().render?.completedFrame ?? 0;
      await expect
        .poll(
          () => {
            if (app.lastError !== undefined) throw new Error(JSON.stringify(app.lastError));
            return execution.report().render?.completedFrame ?? 0;
          },
          { timeout: 60_000 },
        )
        .toBeGreaterThanOrEqual(start + frames);
    };
    const inspect = async (code: string) => {
      const requestId = ++id;
      const response = await new Promise<ExecutionInspectResultMessage>((resolve, reject) => {
        const worker = sourceWorker!;
        const timer = setTimeout(() => {
          worker.removeEventListener('message', receive);
          reject(new Error('Worker inspection timed out'));
        }, 60_000);
        const receive = (event: MessageEvent<ExecutionInspectResultMessage>) => {
          if (event.data.kind !== 'inspect-result' || event.data.requestId !== requestId) return;
          clearTimeout(timer);
          worker.removeEventListener('message', receive);
          resolve(event.data);
        };
        worker.addEventListener('message', receive);
        worker.postMessage({
          kind: 'inspect',
          requestId,
          worldIdentity: execution.report().world.identity,
          code,
        });
      });
      if (!response.result.ok) throw response.result.error;
      return response.result.value;
    };
    const capture = async (label: string) => {
      await request(channel, { id: ++id, kind: 'begin-capture' });
      const captured = (await inspect(
        `const { decodeTape, encodeTape } = await _import('@forgeax/engine-rhi-debug');
         const pin = new BroadcastChannel(${JSON.stringify(name)});
         try {
           const r = await rhiCapture.captureFrame();
           if (!r.ok) return { error: r.error };
           const bytes = r.value.bytes;
           const tape = decodeTape(bytes).unwrap();
           const encoder = tape.events.find(event => event.kind === 'createCommandEncoder');
           if (!encoder?.desc.label.startsWith('multi-camera-frame:'))
             throw new Error('Missing captured frame identity');
           const frameId = Number(encoder.desc.label.split(':').at(-1));
           await new Promise((resolve, reject) => {
             const timer = setTimeout(() => reject(new Error('Capture pin timed out')), 60_000);
             pin.onmessage = event => {
               if (event.data.id !== 1) return;
               clearTimeout(timer);
               if (event.data.error !== undefined) reject(new Error(JSON.stringify(event.data.error)));
               else resolve();
             };
             pin.postMessage({ id: 1, kind: 'pin-capture', frameId });
           });
           return { bytes: Array.from(encodeTape(tape, { compression: 'gzip' }).unwrap()) };
         } finally { pin.close(); }`,
      )) as { bytes?: number[]; error?: unknown };
      if (captured.error !== undefined)
        throw new Error(JSON.stringify({ error: captured.error, report: execution.report() }));
      const bytes = new Uint8Array(captured.bytes!);
      await save(`${label}.rhitape`, bytes);
      const tape = decodeTape(bytes).unwrap();
      const encoder = tape.events.find((event) => event.kind === 'createCommandEncoder') as
        | { desc: { label: string } }
        | undefined;
      if (!encoder?.desc.label.startsWith('multi-camera-frame:'))
        throw new Error('Missing captured frame identity');
      const capturedFrame = Number(encoder.desc.label.split(':').at(-1));
      const live = await request<Picture>(channel, {
        id: ++id,
        kind: 'capture-picture',
        frameId: capturedFrame,
      });
      expect(live.frameId).toBe(capturedFrame);
      app.pause().unwrap();
      await save(`${label}.rgba`, packed(live));
      const model = buildFrameModel(tape);
      const work = model.works
        .filter((item) =>
          item.pipeline.shaders.some((shader) =>
            shader.source?.includes('var picture: texture_2d'),
          ),
        )
        .at(-1)!;
      expect(tape.events.filter((event) => event.kind === 'submit')).toHaveLength(1);
      const adapter = (await webgpu.rhi.requestAdapter()).unwrap();
      const device = (
        await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
      ).unwrap();
      const replay = (
        await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      try {
        const replayed = (
          await replay.inspectWork(work.workIndex, ['pixels', 'bindings', 'pipeline'])
        ).unwrap().attachment!;
        const pixels = packed(live);
        expect(replayed.bytes.length).toBe(pixels.length);
        let delta = 0;
        for (let i = 0; i < pixels.length; i++)
          delta = Math.max(delta, Math.abs(pixels[i]! - replayed.bytes[i]!));
        await save(`${label}-replay.rgba`, replayed.bytes);
        await save(
          `${label}.json`,
          new TextEncoder().encode(
            JSON.stringify(
              {
                delta,
                frameId: live.frameId,
                workIndex: work.workIndex,
                views: live.views,
                report: execution.report(),
              },
              null,
              2,
            ),
          ),
        );
        expect(delta).toBeLessThanOrEqual(1);
      } finally {
        (await replay.dispose()).unwrap();
      }
      app.resume().unwrap();
      return live;
    };
    app.start().unwrap();
    await advance(60);
    const world = execution.report().world.identity;
    const split = await capture('split');
    expect(split.views).toHaveLength(2);
    expect(split.views.map((v) => [v.width, v.height])).toEqual([
      [64, 64],
      [64, 64],
    ]);
    expect(pixel(split, 32, 32)[0]! - pixel(split, 32, 32)[1]!).toBeGreaterThan(70);
    expect(pixel(split, 96, 32)[1]! - pixel(split, 96, 32)[0]!).toBeGreaterThan(70);
    await command('map');
    await advance(4);
    const map = await observe();
    expect(map.views.at(-1)).toMatchObject({ width: 16, height: 8 });
    await command('move');
    await advance(8);
    const moved = await observe();
    expect(Math.abs(mapRedCenter(moved) - mapRedCenter(map))).toBeGreaterThan(1);
    const mapFrames = moved.views.at(-1)!.renderedFrames - map.views.at(-1)!.renderedFrames;
    const mainFrames = moved.views[0]!.renderedFrames - map.views[0]!.renderedFrames;
    expect(mapFrames).toBeGreaterThan(0);
    expect(mapFrames).toBeLessThan(mainFrames);
    await save('minimap.rgba', packed(moved));
    await command('cut');
    await advance(3);
    const cut = (await observe()).cut;
    expect(cut?.[0]?.temporal.status).toBe('reset');
    expect(cut?.[1]?.temporal.status).toBe('stable');
    await save('history-cut.json', new TextEncoder().encode(JSON.stringify(cut, null, 2)));
    await command('disable');
    await advance(2);
    expect((await observe()).views).toHaveLength(2);
    await command('enable');
    await advance(3);
    expect((await observe()).views).toHaveLength(3);
    canvas.style.width = '160px';
    canvas.style.height = '80px';
    await advance(3);
    expect((await observe()).views[0]).toMatchObject({ width: 80, height: 80 });
    canvas.style.width = '128px';
    canvas.style.height = '64px';
    await command('monitor');
    await advance(60);
    const monitor = await capture('monitor');
    expect(monitor.views.some((view) => view.output === 'texture' && view.width === 32)).toBe(true);
    expect(pixel(monitor, 96, 32)[0]! - pixel(monitor, 96, 32)[1]!).toBeGreaterThan(60);
    const epoch = execution.report().render!.epoch;
    await command('crash');
    await expect.poll(() => execution.report().render?.epoch, { timeout: 40_000 }).toBe(epoch + 1);
    await advance(60);
    expect(execution.report().world.identity).toBe(world);
    expect(canvas.isConnected).toBe(false);
    expect(app.canvas?.isConnected).toBe(true);
    const recovered = await capture('recovered-monitor');
    expect(pixel(recovered, 96, 32)[0]! - pixel(recovered, 96, 32)[1]!).toBeGreaterThan(60);
    expect(app.lastError).toBeUndefined();
  } finally {
    await ownedApp?.dispose();
    channel.close();
    source.port1.close();
    ownedApp?.canvas?.remove();
    canvas.remove();
    globalThis.Worker = NativeWorker;
  }
}, 240_000);
