import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { World } from '@forgeax/engine-ecs';
import { propagateTransforms } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { beforeAll, expect, it } from 'vitest';
import { required } from '../../../ui-blitz/src/__tests__/fixture.js';
import { createBlitzUi, gpuShaders, type UiWasmHost } from '../../../ui-blitz/src/index.js';
import { constructRuntimeRendererHost } from '../renderer-host';
import { readUiFrame } from './cpu-ui.fixture';
import { createDisplayP3Scene, pixelAt } from './display-p3.fixture';
import { offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

const bytes = readFile(new URL('../../../ui-blitz/pkg/ui_blitz_bg.wasm', import.meta.url));
const wasm: UiWasmHost = {
  readWasm: () => bytes,
  instantiate: async (imports) =>
    WebAssembly.instantiate(await bytes, imports as WebAssembly.Imports),
};
const html =
  '<style>html,body{margin:0;background:transparent}div{position:absolute;top:8px;width:16px;height:16px}#color{left:8px;background:red;opacity:.5}#white{left:40px;background:white}</style><div id="color"></div><div id="white"></div>';
const createUi = () =>
  createBlitzUi({
    wasm,
    html,
    width: 64,
    height: 64,
    onError: (cause) => {
      throw cause;
    },
  });
let manifestUrl = '';
beforeAll(async () => {
  manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
}, 300_000);

async function save(name: string, result: unknown) {
  const directory = 'artifacts/gpu-ui/dawn';
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/${name}.json`, `${JSON.stringify(result, null, 2)}\n`);
}

it('keeps real GPU UI on one Renderer through UI-only, 3D composition and scene failure with one submission per frame', {
  timeout: 120_000,
}, async () => {
  const ui = await createUi();
  const surface = offscreenCanvas(64);
  let releaseManifest!: () => void;
  const deferred = new Promise<void>((resolve) => {
    releaseManifest = resolve;
  });
  let submissions = 0;
  let paints = 0;
  let transferred = 0;
  const host = value(
    await constructRuntimeRendererHost(
      surface.canvas,
      {
        ui: {
          kind: 'sparse-strips',
          shaders: gpuShaders,
          paint(time, width, height) {
            expect([width, height]).toEqual([64, 64]);
            paints++;
            const frame = ui.paintGpu(time);
            if (frame) transferred++;
            return frame;
          },
        },
        rhiInstrumentation: {
          beforeSubmit: () => {
            submissions++;
            return undefined;
          },
        },
      },
      {
        shaderManifestUrl: manifestUrl,
        readShaderManifest: async (url) => {
          await deferred;
          return (await fetch(url)).text();
        },
      },
    ),
  );
  const renderer = host.renderer;
  const errors: unknown[] = [];
  const unlisten = renderer.subscribe((event) => {
    if (event.kind === 'error') errors.push(event.error);
  });
  let scene: ReturnType<typeof createDisplayP3Scene> | undefined;
  const boot = new World();
  const draw = async (world: World | null) => {
    const before = submissions;
    const beforePaint = paints;
    const result = await readUiFrame(renderer, world);
    expect(host.renderer).toBe(renderer);
    expect(submissions).toBe(before + 1);
    expect(paints).toBe(beforePaint + 1);
    return result;
  };
  try {
    const loading = await draw(boot);
    expect(loading.receipt.presentation).toBe('pending');
    expect(pixelAt(loading.rgba, [16, 16])).toEqual([128, 0, 0]);
    expect(pixelAt(loading.rgba, [48, 16])).toEqual([255, 255, 255]);
    const cached = await draw(boot);
    expect(cached.rgba).toEqual(loading.rgba);
    expect(transferred).toBe(1);

    releaseManifest();
    value(await host.initialization);
    const activating = await draw(null);
    expect(activating.receipt.presentation).toBe('pending');
    expect(activating.rgba).toEqual(loading.rgba);
    ui.document.body.style.display = 'none';
    scene = createDisplayP3Scene(renderer, []);
    const lease = value(renderer.attach(scene.world));
    for (let i = 0; i < 60; i++) {
      const before = submissions;
      propagateTransforms(scene.world);
      scene.world.update(1 / 60).unwrap();
      // readUiFrame samples this static scene at one second. Use the same
      // Host clock while advancing the World, rather than resetting UI time
      // to the newly created World's elapsed time.
      const receipt = value(
        renderer.draw({
          leases: [lease],
          camera: { lease },
          environment: { lease },
          sampleTimeSeconds: 1,
        }),
      );
      value(await receipt.completed);
      expect(submissions, `3D frame ${i}`).toBe(before + 1);
    }
    const background = await draw(scene.world);
    expect(background.receipt.presentation).toBe('ready');
    ui.document.body.style.display = 'block';
    const composed = await draw(scene.world);
    expect(composed.receipt.presentation).toBe('ready');
    const beforePixel = pixelAt(background.rgba, [16, 16]);
    const afterPixel = pixelAt(composed.rgba, [16, 16]);
    const expected = beforePixel.map((channel, index) =>
      Math.round(channel * (1 - 128 / 255) + (index === 0 ? 128 : 0)),
    );
    for (let index = 0; index < 3; index++)
      expect(Math.abs(required(afterPixel[index]) - required(expected[index]))).toBeLessThanOrEqual(
        1,
      );
    expect(pixelAt(composed.rgba, [48, 16])).toEqual([255, 255, 255]);
    expect(pixelAt(composed.rgba, [48, 48])).toEqual(pixelAt(background.rgba, [48, 48]));
    const transfersBeforeCache = transferred;
    expect((await draw(scene.world)).rgba).toEqual(composed.rgba);
    expect(transferred).toBe(transfersBeforeCache);
    expect(errors).toEqual([]);

    // Camera-free Worlds compose UI normally. Explicit scene retirement still
    // uses this Renderer and its existing surface.
    const cameraFree = await draw(boot);
    expect(cameraFree.receipt.presentation).toBe('ready');
    expect(cameraFree.rgba).toEqual(loading.rgba);
    expect(errors).toEqual([]);
    required(ui.document.querySelector<HTMLElement>('#color')).style.background = 'yellow';
    const fatal = await draw(null);
    expect(fatal.receipt.presentation).toBe('pending');
    expect(pixelAt(fatal.rgba, [16, 16])).toEqual([128, 128, 0]);
    expect(renderer.state()).toBe('alive');
    await save('composition', {
      submissions,
      paints,
      transferred,
      loading: pixelAt(loading.rgba, [16, 16]),
      background: beforePixel,
      composed: afterPixel,
      expected,
      fatal: pixelAt(fatal.rgba, [16, 16]),
    });
  } catch (cause) {
    await save('composition-failure', { cause, errors, submissions, paints, transferred });
    throw cause;
  } finally {
    releaseManifest();
    await host.initialization;
    scene?.dispose();
    unlisten();
    value(await renderer.dispose());
    ui.dispose();
    surface.destroy();
  }
});

it('keeps real GPU UI drawable when scene shader initialization fails', {
  timeout: 60_000,
}, async () => {
  const ui = await createUi();
  const surface = offscreenCanvas(64);
  let rejectManifest!: (cause: unknown) => void;
  const deferred = new Promise<string>((_resolve, reject) => {
    rejectManifest = reject;
  });
  let submissions = 0;
  const host = value(
    await constructRuntimeRendererHost(
      surface.canvas,
      {
        ui: { kind: 'sparse-strips', shaders: gpuShaders, paint: (time) => ui.paintGpu(time) },
        rhiInstrumentation: {
          beforeSubmit: () => {
            submissions++;
            return undefined;
          },
        },
      },
      { shaderManifestUrl: '/gpu-ui-deliberate-failure.json', readShaderManifest: () => deferred },
    ),
  );
  const renderer = host.renderer;
  const world = new World();
  try {
    const loading = await readUiFrame(renderer, world);
    expect(loading.receipt.presentation).toBe('pending');
    expect(pixelAt(loading.rgba, [16, 16])).toEqual([128, 0, 0]);
    expect(submissions).toBe(1);
    rejectManifest(new Error('Deliberate GPU UI scene initialization failure'));
    expect((await host.initialization).ok).toBe(false);
    required(ui.document.querySelector<HTMLElement>('#color')).style.background = 'yellow';
    const fatal = await readUiFrame(renderer, world);
    expect(host.renderer).toBe(renderer);
    expect(fatal.receipt.presentation).toBe('pending');
    expect(pixelAt(fatal.rgba, [16, 16])).toEqual([128, 128, 0]);
    expect(submissions).toBe(2);
    expect(renderer.state()).toBe('alive');
    await save('initialization-failure', {
      submissions,
      loading: pixelAt(loading.rgba, [16, 16]),
      fatal: pixelAt(fatal.rgba, [16, 16]),
    });
  } finally {
    rejectManifest(new Error('GPU UI fixture disposed'));
    await host.initialization;
    value(await renderer.dispose());
    ui.dispose();
    surface.destroy();
  }
});
