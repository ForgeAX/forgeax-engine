import { createBrowserPlatform } from '@forgeax/engine/platform-browser';
import { configureRuntimeAssetCatalog, createRuntimeAssetImportTransport, runtimeBinding } from '@forgeax/apps-shared/asset-runtime-config';
import { createApp, type CreateAppOptions } from '@forgeax/engine-app';
import { createApp as createBrowserApp } from '@forgeax/engine-app/browser';
import { scenePlugin } from '@forgeax/engine-scene';
import { ParticleEffectPlayer } from '@forgeax/engine-vfx';
import { createVfxRuntimeHost } from '@forgeax/engine-vfx-render';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { FIELD_DT, fieldCamera, populateFieldScene } from './field-scene.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (canvas === null || runtimeBinding === undefined) throw new Error('fields: missing canvas/runtime binding');
// Diagnostic access retains only this fixture's real devices. It never
// crashes Chrome's shared GPU process or mutates another consumer's device.
const devices: GPUDevice[] = [];
const lossSignals: Array<{
  readonly generation: number;
  triggered: boolean;
  readonly trigger: () => void;
}> = [];
const fieldBuffers = new Map<GPUBuffer, { device: number; bytes: number; live: boolean }>();
let fieldUploads = 0;
let fieldUploadBytes = 0;
const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
navigator.gpu.requestAdapter = async options => {
  const adapter = await requestAdapter(options);
  if (adapter === null) return adapter;
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async descriptor => {
    const device = await requestDevice(descriptor);
    devices.push(device);
    const generation = devices.length;
    const createBuffer = device.createBuffer.bind(device);
    device.createBuffer = descriptor => {
      const buffer = createBuffer(descriptor);
      if (descriptor.label?.includes('.force-fields.')) {
        const info = { device: generation, bytes: descriptor.size, live: true };
        fieldBuffers.set(buffer, info);
        const destroy = buffer.destroy.bind(buffer);
        buffer.destroy = () => { info.live = false; destroy(); };
      }
      return buffer;
    };
    const writeBuffer = device.queue.writeBuffer.bind(device.queue);
    device.queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
      if (fieldBuffers.has(buffer)) {
        fieldUploads++;
        fieldUploadBytes += size ?? data.byteLength;
      }
      writeBuffer(buffer, offset, data, dataOffset, size);
    };
    return device;
  };
  return adapter;
};
// The WebGPU contract classifies GPUDevice.destroy() as an intentional,
// terminal loss. Recovery coverage therefore injects the same unexpected-loss
// signal used by Render's deterministic browser fixtures, then exercises
// recovery against a newly created real WebGPU device. It never labels an
// intentional destroy as a driver fault.
const rhiInstrumentation: NonNullable<CreateAppOptions['rhiInstrumentation']> = {
  deviceLost: () => new Promise((resolve) => {
    const generation = lossSignals.length + 1;
    const signal = {
      generation,
      triggered: false,
      trigger: () => {
        if (signal.triggered) throw new Error(`fields: loss signal ${generation} already triggered`);
        signal.triggered = true;
        resolve({ reason: 'unknown', message: `ROI21 deterministic WebGPU loss injection ${generation}` });
      },
    };
    lossSignals.push(signal);
  }),
};
const host = createVfxRuntimeHost({ camera: fieldCamera });
const result = await createBrowserApp(
  canvas,
  {
    features: [host.feature],
    plugins: [scenePlugin()],
    assetRuntimeBinding: runtimeBinding,
    rhiInstrumentation,
  },
  {
    ...forgeaxBundlerAdapter(),
    importTransport: createRuntimeAssetImportTransport(runtimeBinding),
  },
);
if (!result.ok) throw result.error;
let app = result.value;
const initialApp = app;
const assets = app.assets;
if (assets === undefined) throw new Error('fields: missing ordinary AssetRegistry');
configureRuntimeAssetCatalog(assets, runtimeBinding);
const errors: unknown[] = [];
app.renderer.subscribe(event => { if (event.kind === 'error') errors.push(event.error); });
app.onError(error => errors.push(error));
const attached = await host.attachWorld({ world: app.world, assets });
if (!attached.ok) throw attached.error;
const key = new URLSearchParams(location.search).get('field') ?? 'vortex/16/trilinear';
const scene = await populateFieldScene(app.world, assets, key);
const world = app.world;
const renderer = app.renderer;
const started = app.start();
if (!started.ok) throw started.error;
const paused = app.pause();
if (!paused.ok) throw paused.error;
let frames = 0;
const step = async (count = 1, deltaSeconds = FIELD_DT) => {
  for (let i = 0; i < count; i++) {
    const target = app.execution.report().frame.completed + 1;
    const advanced = app.stepFrame(deltaSeconds);
    if (!advanced.ok) throw advanced.error;
    while(app.execution.report().frame.completed < target) {
      if(errors.length !== 0) throw new Error(JSON.stringify(errors));
      await new Promise(resolve => setTimeout(resolve,0));
    }
    frames++;
  }
  if (errors.length !== 0) throw new Error(JSON.stringify(errors));
  return { frames, completion: app.execution.report().frame, host: host.inspect(app.world) };
};
// Manual completed-frame stepping gives DEV and build consumers identical clocks.
const recoveryErrors: unknown[] = [];
const errorRecord = (value: unknown): unknown => {
  if (!(value instanceof Error)) return { message: String(value) };
  const fields = value as Error & Record<string, unknown>;
  return {
    name: value.name,
    message: value.message,
    ...(typeof fields.code === 'string' ? { code: fields.code } : {}),
    ...(typeof fields.expected === 'string' ? { expected: fields.expected } : {}),
    ...(typeof fields.hint === 'string' ? { hint: fields.hint } : {}),
    ...(fields.detail === undefined ? {} : { detail: fields.detail }),
    ...(fields.cause === undefined ? {} : { cause: errorRecord(fields.cause) }),
  };
};
const recover = async () => {
  recoveryErrors.push(...errors);
  const recovered = await renderer.recover();
  if (!recovered.ok) throw recovered.error;
  // Device loss terminates the old frame loop. Assemble a new public App
  // around the recovered Renderer and retained World, as the App contract asks.
  const platform = createBrowserPlatform(canvas).unwrap();
  const rebuilt = await createApp({ platform, renderer, world, assets, plugins: [{ name: 'browser-platform', apply(ctx) { ctx.effect(() => () => platform.dispose()); } }] });
  if (!rebuilt.ok) throw rebuilt.error;
  app = rebuilt.value;
  app.onError(error => errors.push(error));
  errors.length = 0;
  const started = app.start();
  if (!started.ok) throw started.error;
  const paused = app.pause();
  if (!paused.ok) throw paused.error;
  frames = 0;
  // First restore the retained GPU state without introducing a fixed tick.
  return step(1, 0);
};
const dispose = async () => {
  const detached = await host.detachWorld({ world });
  if (!detached.ok) throw detached.error;
  await app.dispose();
  if (initialApp !== app) await initialApp.dispose();
};
Object.assign(window, { __fields: {
  step, recover, dispose,
  setPlaying: (playing: boolean) => world.set(scene.player, ParticleEffectPlayer, { playing }),
  removePlayer: () => world.despawn(scene.player),
  injectDeviceLoss: () => {
    const signal = lossSignals.at(-1);
    if (signal === undefined) throw new Error('fields: no live RHI loss signal to inject');
    signal.trigger();
  },
  inspect: () => ({
    frames,
    errors: errors.map(errorRecord),
    recoveryErrors: recoveryErrors.map(errorRecord),
    devices: devices.length,
    lossSignals: lossSignals.map(({ generation, triggered }) => ({ generation, triggered })),
    fields: {
      uploads: fieldUploads,
      uploadBytes: fieldUploadBytes,
      liveBytes: [...fieldBuffers.values()]
        .filter((info) => info.live)
        .reduce((sum, info) => sum + info.bytes, 0),
      buffers: [...fieldBuffers.values()],
    },
    rendererState: renderer.state(),
    completion: app.execution.report().frame,
    host: host.inspect(world),
  }),
  get app() { return app; }, host, scene,
} });
await step(60);
document.querySelector('#status')?.replaceChildren(document.createTextNode(`Managed ${key}: ${frames} completed frames`));
