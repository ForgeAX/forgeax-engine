import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  attachRecorder,
  buildFrameModel,
  decodeTape,
  type FrameModel,
  openReplay,
  replayDeviceRequest,
  summarizeFrame,
} from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { propagateTransforms } from '@forgeax/engine-scene';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { expect, it } from 'vitest';
import { required } from '../../../ui-blitz/src/__tests__/fixture.js';
import { compareUiRaster } from '../../../ui-blitz/src/__tests__/gpu-parity-fixture.js';
import { createBlitzUi, gpuShaders, type UiWasmHost } from '../../../ui-blitz/src/index.js';
import { constructRuntimeRendererHost } from '../renderer-host';
import { readUiFrame } from './cpu-ui.fixture';
import { createDisplayP3Scene } from './display-p3.fixture';
import { encodeRgbaPng, offscreenCanvas } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const size = 64;
const output = process.env.FORGEAX_GPU_UI_RHI_EVIDENCE ?? 'artifacts/gpu-ui/rhi-debug';
const bytes = readFile(new URL('../../../ui-blitz/pkg/ui_blitz_bg.wasm', import.meta.url));
const wasm: UiWasmHost = {
  readWasm: () => bytes,
  instantiate: async (imports) =>
    WebAssembly.instantiate(await bytes, imports as WebAssembly.Imports),
};
const html = `<style>html,body{margin:0;background:transparent}
main{position:absolute;left:8px;top:8px;width:48px;height:48px;
background:linear-gradient(red,blue);opacity:.75;overflow:hidden;border-radius:8px;filter:blur(1px)}
div{width:24px;height:48px;background:lime}</style><main><div></div></main>`;

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function label(descriptor: unknown): string | undefined {
  const name = record(record(descriptor).desc).label;
  return typeof name === 'string' ? name : undefined;
}

function texture(model: FrameModel, id: string) {
  const resource = required(model.resources.find((item) => item.resourceId === id));
  if (resource.kind === 'texture') return resource;
  const parent = record(resource.descriptor).sourceHandleId;
  if (typeof parent !== 'string') throw new Error(`Texture view ${id} has no owning texture`);
  return required(model.resources.find((item) => item.resourceId === parent));
}

async function save(name: string, data: unknown) {
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/${name}`, `${JSON.stringify(data, null, 2)}\n`);
}

it('captures actual Blitz GPU UI draws and replays dynamic and retained composition on fresh devices', {
  timeout: 180_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const surface = offscreenCanvas(size);
  const errors: unknown[] = [];
  const ui = await createBlitzUi({
    wasm,
    html,
    width: size,
    height: size,
    onError: (error) => errors.push(error),
  });
  let transferred = 0;
  const host = value(
    await constructRuntimeRendererHost(
      surface.canvas,
      {
        rhi: recorder.backend.rhi,
        ui: {
          kind: 'sparse-strips',
          shaders: gpuShaders,
          paint(time) {
            const frame = ui.paintGpu(time);
            if (frame) transferred++;
            return frame;
          },
        },
      },
      { shaderManifestUrl: shaderManifestUrl(await buildEngineShaderManifest()) },
    ),
  );
  value(await host.initialization);
  const renderer = host.renderer;
  const scene = createDisplayP3Scene(renderer, errors);
  const replayDevices: GPUDevice[] = [];
  try {
    propagateTransforms(scene.world);
    const before = await readUiFrame(renderer, scene.world);
    expect(transferred).toBe(1);
    let dynamicPixels: Uint8Array | undefined;
    for (const mode of ['dynamic', 'unchanged'] as const) {
      const pending = recorder.captureFrame();
      (await recorder.frameBoundary()).unwrap();
      if (mode === 'dynamic') required(ui.document.querySelector('main')).style.opacity = '.5';
      const live = await readUiFrame(renderer, scene.world);
      (await recorder.frameBoundary()).unwrap();
      const capture = (await pending).unwrap();
      await mkdir(output, { recursive: true });
      await writeFile(`${output}/${mode}.rhitape`, capture.bytes);
      await writeFile(`${output}/${mode}-live.png`, encodeRgbaPng(live.rgba, size));
      const tape = decodeTape(capture.bytes).unwrap();
      const model = buildFrameModel(tape);
      await save(`${mode}-summary.json`, summarizeFrame(model));
      await save(`${mode}-model.json`, model);
      const uiWorks = model.works.filter((work) => {
        const name = label(work.pipeline.descriptor);
        return name?.startsWith('ui-raster-') || name?.startsWith('screen-ui-');
      });
      const raster = uiWorks.filter((work) =>
        label(work.pipeline.descriptor)?.startsWith('ui-raster-'),
      );
      const composite = required(
        uiWorks.find((work) => label(work.pipeline.descriptor) === 'screen-ui-composite'),
      );
      const final = required(uiWorks.at(-1));
      expect(transferred).toBe(2);
      if (mode === 'dynamic') {
        expect(raster.length).toBeGreaterThan(0);
        expect(raster.some((work) => label(work.pipeline.descriptor) === 'ui-raster-filter')).toBe(
          true,
        );
        expect(compareUiRaster(before.rgba, live.rgba).maxError).toBeGreaterThan(0.05);
        dynamicPixels = live.rgba;
      } else {
        expect(raster).toHaveLength(0);
        expect(live.rgba).toEqual(dynamicPixels);
      }
      const uiBinding = required(
        composite.bindings.find(
          (binding) =>
            binding.resourceKind === 'textureView' &&
            binding.resourceId !== null &&
            label(texture(model, binding.resourceId).descriptor) === 'ui-target:0',
        ),
      );
      const uiTarget = texture(model, required(uiBinding.resourceId));
      if (mode === 'unchanged') {
        expect(uiTarget.origin).toBe('bootstrap');
        expect(
          model.unseededResources.some((resource) => resource.resourceId === uiTarget.resourceId),
        ).toBe(false);
        expect(
          required(tape.bootstrap.find((resource) => resource.handleId === uiTarget.resourceId))
            .initialData.length,
        ).toBeGreaterThan(0);
      }
      const nativeAdapter = required(await navigator.gpu.requestAdapter());
      const adapter = (
        await webgpu.requestAdapterFrom({
          requestAdapter: async () => ({
            features: nativeAdapter.features,
            limits: nativeAdapter.limits,
            async requestDevice(descriptor) {
              const device = await nativeAdapter.requestDevice(descriptor);
              replayDevices.push(device);
              return device;
            },
          }),
        })
      ).unwrap();
      const device = (
        await adapter.requestDevice(replayDeviceRequest(tape, adapter.features, adapter.limits))
      ).unwrap();
      const replay = (
        await openReplay(tape, { device, createShaderModule: webgpu.createShaderModule })
      ).unwrap();
      try {
        const inspected = [];
        for (const work of uiWorks) {
          const result = (
            await replay.inspectWork(work.workIndex, ['pipeline', 'bindings'])
          ).unwrap();
          expect(result.pipeline?.status).toBe('available');
          expect(result.pipeline?.shaders.map((shader) => shader.stage)).toEqual([
            'vertex',
            'fragment',
          ]);
          for (const shader of result.pipeline?.shaders ?? []) {
            expect(shader.source?.length).toBeGreaterThan(20);
            expect(shader.entryPoint).toBeTruthy();
          }
          for (const binding of result.bindings ?? []) {
            expect(binding.resourceId).not.toBeNull();
            expect(
              model.resources.some((resource) => resource.resourceId === binding.resourceId),
            ).toBe(true);
          }
          const writes = work.attachments?.colorViewHandleIds.map((id) => texture(model, id)) ?? [];
          const reads = work.bindings
            .filter((binding) => binding.resourceKind === 'textureView')
            .map((binding) => texture(model, required(binding.resourceId)));
          expect(
            writes.every(
              (target) => !reads.some((source) => source.resourceId === target.resourceId),
            ),
          ).toBe(true);
          inspected.push({
            ...result,
            label: label(work.pipeline.descriptor),
            reads: reads.map((resource) => ({
              resourceId: resource.resourceId,
              label: label(resource.descriptor),
            })),
            writes: writes.map((resource) => ({
              resourceId: resource.resourceId,
              label: label(resource.descriptor),
            })),
            debugGroups: model.commands[work.commandIndex]?.group,
          });
        }
        await save(`${mode}-inspect.json`, inspected);
        const replayed = (await replay.inspectWork(final.workIndex, ['pixels'])).unwrap();
        const attachment = required(replayed.attachment);
        const rgba = new Uint8Array(size * size * 4);
        const rowStride = attachment.bytes.byteLength / size;
        for (let y = 0; y < size; y++) {
          rgba.set(
            attachment.bytes.subarray(y * rowStride, y * rowStride + size * 4),
            y * size * 4,
          );
        }
        if (attachment.format?.startsWith('bgra'))
          for (let offset = 0; offset < rgba.length; offset += 4)
            [rgba[offset], rgba[offset + 2]] = [required(rgba[offset + 2]), required(rgba[offset])];
        const comparison = compareUiRaster(live.rgba, rgba);
        await writeFile(`${output}/${mode}-replay.png`, encodeRgbaPng(rgba, size));
        await save(`${mode}-result.json`, {
          digest: capture.digest,
          byteLength: capture.byteLength,
          workCount: model.works.length,
          uiWorkCount: uiWorks.length,
          rasterWorkCount: raster.length,
          finalWorkIndex: final.workIndex,
          retainedTarget: uiTarget.resourceId,
          comparison,
          unseededResources: model.unseededResources,
        });
        expect(comparison.maxError).toBeLessThanOrEqual(0.05);
        expect(compareUiRaster(new Uint8Array(rgba.length), live.rgba).maxError).toBeGreaterThan(
          0.05,
        );
      } finally {
        (await replay.dispose()).unwrap();
      }
    }
    expect(new Set(replayDevices).size).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    scene.dispose();
    value(await renderer.dispose());
    ui.dispose();
    surface.destroy();
    (await recorder.dispose()).unwrap();
    for (const device of replayDevices) device.destroy();
    for (const device of replayDevices) expect((await device.lost).reason).toBe('destroyed');
  }
});
