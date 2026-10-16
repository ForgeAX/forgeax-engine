import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { Texture } from '@forgeax/engine-rhi';
import { expect, it } from 'vitest';
import { createShaderModule, requestAdapterFrom } from '../../../rhi-webgpu/src/index.js';
import { required } from '../../../ui-blitz/src/__tests__/fixture.js';
import { compareUiRaster } from '../../../ui-blitz/src/__tests__/gpu-parity-fixture.js';
import { createBlitzUi, gpuShaders, type UiWasmHost } from '../../../ui-blitz/src/index.js';
import { createUiCompositor } from '../assembly/ui-compositor.js';

const html = `<style>html,body{margin:0;background:transparent}
main{position:absolute;inset:8px;background:linear-gradient(red,blue);
opacity:.75;overflow:hidden;border-radius:8px;filter:blur(1px)}
div{width:25%;height:100%;background:lime}</style><main><div></div></main>`;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Observes successful native API calls on the real Dawn device. These counts
 * are not driver allocation, physical GPU residency, or JavaScript heap bytes. */
function observeNativeResources(device: GPUDevice) {
  type Row = {
    id: number;
    kind: 'buffer' | 'texture';
    label: string;
    logicalBytes: number | null;
    destroyed: boolean;
  };
  const live = new Map<GPUBuffer | GPUTexture, Row>();
  const rows: Row[] = [];
  const createBuffer = device.createBuffer;
  const createTexture = device.createTexture;
  let peakCount = 0;
  let peakKnownBytes = 0;

  function snapshot() {
    const resources = [...live.values()];
    return {
      liveCount: resources.length,
      liveKnownBytes: resources.reduce((sum, row) => sum + (row.logicalBytes ?? 0), 0),
      unknownByteResources: resources.filter((row) => row.logicalBytes === null).length,
      buffers: resources.filter((row) => row.kind === 'buffer').length,
      textures: resources.filter((row) => row.kind === 'texture').length,
      peakCount,
      peakKnownBytes,
    };
  }

  function track<T extends GPUBuffer | GPUTexture>(
    resource: T,
    facts: Omit<Row, 'id' | 'destroyed'>,
  ): T {
    const row = { id: rows.length + 1, ...facts, destroyed: false };
    rows.push(row);
    live.set(resource, row);
    const state = snapshot();
    peakCount = Math.max(peakCount, state.liveCount);
    peakKnownBytes = Math.max(peakKnownBytes, state.liveKnownBytes);
    const destroy = resource.destroy;
    resource.destroy = () => {
      expect(row.destroyed, `duplicate native destroy: ${row.label}`).toBe(false);
      destroy.call(resource);
      row.destroyed = true;
      live.delete(resource);
    };
    return resource;
  }

  device.createBuffer = (descriptor) =>
    track(createBuffer.call(device, descriptor), {
      kind: 'buffer',
      label: descriptor.label ?? '',
      logicalBytes: descriptor.size,
    });
  device.createTexture = (descriptor) => {
    const texture = createTexture.call(device, descriptor);
    const stride = ({ rgba8unorm: 4, rgba32uint: 16, rgba16float: 8 } as Record<string, number>)[
      texture.format
    ];
    return track(texture, {
      kind: 'texture',
      label: descriptor.label ?? '',
      logicalBytes:
        stride !== undefined && texture.mipLevelCount === 1
          ? texture.width *
            texture.height *
            texture.depthOrArrayLayers *
            texture.sampleCount *
            stride
          : null,
    });
  };
  return {
    rows,
    snapshot,
    startCycle() {
      peakCount = 0;
      peakKnownBytes = 0;
    },
    restore() {
      device.createBuffer = createBuffer;
      device.createTexture = createTexture;
    },
  };
}

it('retires actual GPU UI buffers and textures after completion across ten mount/update/resize/unmount cycles', {
  timeout: 120_000,
}, async () => {
  const wasmUrl = new URL('../../../ui-blitz/pkg/ui_blitz_bg.wasm', import.meta.url);
  const bytes = await readFile(wasmUrl);
  const provenance = JSON.parse(
    await readFile(new URL('../../../ui-blitz/pkg/provenance.json', import.meta.url), 'utf8'),
  );
  const wasm: UiWasmHost = {
    readWasm: async () => bytes,
    instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
  };
  const adapter = required(await navigator.gpu.requestAdapter());
  let nativeDevice: GPUDevice | undefined;
  const rhiAdapter = (
    await requestAdapterFrom({
      requestAdapter: async () => ({
        features: adapter.features,
        limits: adapter.limits,
        async requestDevice(descriptor) {
          nativeDevice = await adapter.requestDevice(descriptor);
          return nativeDevice;
        },
      }),
    })
  ).unwrap();
  const device = (await rhiAdapter.requestDevice()).unwrap();
  const native = required(nativeDevice);
  const resources = observeNativeResources(native);
  const errors: unknown[] = [];
  native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  let submitted = 0;
  let completed = 0;
  const cycles: unknown[] = [];
  let referencePeak: ReturnType<typeof resources.snapshot> | undefined;
  let passed = false;
  let failure: string | undefined;
  let activeStage: { cycle: number; stage: string } | undefined;
  try {
    for (let cycle = 0; cycle < 10; cycle++) {
      expect(resources.snapshot().liveCount).toBe(0);
      resources.startCycle();
      const ui = await createBlitzUi({
        wasm,
        html,
        width: 64,
        height: 64,
        onError: (error) => errors.push(error),
      });
      const reference = await createBlitzUi({
        wasm,
        html,
        width: 64,
        height: 64,
        onError: (error) => errors.push(error),
      });
      let transfers = 0;
      const compositor = await createUiCompositor({
        device,
        format: 'rgba8unorm',
        source: {
          kind: 'sparse-strips',
          shaders: gpuShaders,
          paint(time) {
            const frame = ui.paintGpu(time);
            if (frame !== null) transfers++;
            return frame;
          },
        },
        createShaderModule: async (owner, code) =>
          (await createShaderModule(owner, { code })).unwrap(),
      });
      let surface: Texture | undefined;
      let size = 0;
      let expected: Uint8Array | undefined;
      const stages: unknown[] = [];
      const cycleEvidence = { cycle, stages, after: resources.snapshot() };
      cycles.push(cycleEvidence);
      try {
        for (const [index, stage] of [
          { name: 'mount', size: 64, capture: false, changed: true },
          { name: 'cached', size: 64, capture: false, changed: false },
          { name: 'update-and-observe', size: 64, capture: true, changed: true },
          { name: 'grow', size: 96, capture: true, changed: true },
          { name: 'shrink', size: 48, capture: false, changed: true },
          { name: 'unmount-in-flight', size: 48, capture: false, changed: false },
        ].entries()) {
          activeStage = { cycle, stage: stage.name };
          if (index === 2) {
            for (const owner of [ui, reference])
              required(owner.document.querySelector('main')).style.opacity = '.5';
          }
          if (stage.size !== size) {
            if (surface !== undefined) device.destroyTexture(surface).unwrap();
            if (size !== 0)
              for (const owner of [ui, reference]) owner.resize(stage.size, stage.size);
            size = stage.size;
            surface = device
              .createTexture({
                label: 'lifecycle-caller-surface',
                size: { width: size, height: size },
                format: 'rgba8unorm',
                usage: 0x10 | 0x01,
              })
              .unwrap();
          }
          const oracle = reference.paint(0);
          expect(oracle !== null, stage.name).toBe(stage.changed);
          if (oracle !== null) {
            expected = oracle.slice();
            // The real compositor clears opaque black, then blends premultiplied UI.
            for (let offset = 3; offset < expected.length; offset += 4) expected[offset] = 255;
          }
          const beforeTransfers = transfers;
          compositor.prepare(0, size, size, true, 'srgb', stage.capture);
          expect(transfers - beforeTransfers, stage.name).toBe(stage.changed ? 1 : 0);
          const bytesPerRow = Math.ceil((size * 4) / 256) * 256;
          const staging = device
            .createBuffer({
              label: 'lifecycle-caller-readback',
              size: bytesPerRow * size,
              usage: 0x01 | 0x08,
            })
            .unwrap();
          try {
            const encoder = device.createCommandEncoder().unwrap();
            const begin = encoder.beginRenderPass;
            const passes: string[] = [];
            encoder.beginRenderPass = (descriptor) => {
              passes.push(descriptor.label ?? '');
              return begin.call(encoder, descriptor);
            };
            compositor.encode(encoder, required(surface));
            encoder.beginRenderPass = begin;
            expect(passes.filter((label) => label === 'screen-ui-composite')).toHaveLength(1);
            expect(
              passes.some((label) => label.startsWith('ui-raster-')),
              stage.name,
            ).toBe(stage.changed);
            encoder.copyTextureToBuffer(
              { texture: required(surface) },
              { buffer: staging, bytesPerRow, rowsPerImage: size },
              { width: size, height: size, depthOrArrayLayers: 1 },
            );
            device.queue.submit([encoder.finish().unwrap()]).unwrap();
            const sequence = ++submitted;
            const completion = device.queue.onSubmittedWorkDone().then(() => {
              completed++;
            });
            compositor.submitted(completion);
            const beforeDispose = resources.snapshot();
            expect(beforeDispose.unknownByteResources).toBe(0);
            expect(beforeDispose.liveCount).toBeGreaterThan(2);
            if (index === 5) {
              ui.dispose();
              compositor.dispose();
              compositor.dispose();
              expect(resources.snapshot().liveCount, 'in-flight resources remain leased').toBe(
                beforeDispose.liveCount,
              );
            }
            const afterDispose = resources.snapshot();
            await completion;
            const mapped = (await staging.mapAsync(1)).unwrap();
            const actual = new Uint8Array(size * size * 4);
            try {
              const view = new Uint8Array(mapped.getMappedRange().unwrap());
              for (let y = 0; y < size; y++)
                actual.set(
                  view.subarray(y * bytesPerRow, y * bytesPerRow + size * 4),
                  y * size * 4,
                );
            } finally {
              mapped.unmap();
            }
            const comparison = compareUiRaster(required(expected), actual);
            expect(comparison.channelsOutsideEpsilon, `${cycle}/${stage.name}`).toBe(0);
            expect(comparison.maxError, `${cycle}/${stage.name}`).toBeLessThanOrEqual(0.05);
            expect(
              compareUiRaster(required(expected), new Uint8Array(actual.length)).maxError,
            ).toBeGreaterThan(0.05);
            stages.push({
              ...stage,
              sequence,
              completed,
              transfers,
              passes,
              comparison,
              pixelSha256: sha(actual),
              beforeDispose,
              afterDispose,
              resources: resources.snapshot(),
            });
          } finally {
            device.destroyBuffer(staging).unwrap();
          }
        }
      } finally {
        compositor.dispose();
        ui.dispose();
        reference.dispose();
        if (surface !== undefined) device.destroyTexture(surface).unwrap();
        await native.queue.onSubmittedWorkDone();
      }
      const after = resources.snapshot();
      cycleEvidence.after = after;
      expect(after.liveCount, `cycle ${cycle} has no unreleased native API resources`).toBe(0);
      expect(after.unknownByteResources).toBe(0);
      if (referencePeak === undefined) referencePeak = after;
      else
        expect(after, 'repeating the same lifecycle has a bounded API footprint').toEqual(
          referencePeak,
        );
    }
    expect(submitted).toBe(60);
    expect(completed).toBe(submitted);
    expect(errors).toEqual([]);
    expect(resources.rows.every((row) => row.destroyed)).toBe(true);
    expect(resources.rows.some((row) => row.label.startsWith('ui-'))).toBe(true);
    expect(sha(await readFile(wasmUrl))).toBe(sha(bytes));
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
    throw error;
  } finally {
    const finalResources = resources.snapshot();
    resources.restore();
    native.destroy();
    const deviceLostReason = (await native.lost).reason;
    const directory =
      process.env.FORGEAX_GPU_UI_LIFECYCLE_EVIDENCE ?? 'artifacts/gpu-ui-lifecycle/dawn';
    await mkdir(directory, { recursive: true });
    await writeFile(
      `${directory}/result.json`,
      JSON.stringify(
        {
          passed,
          failure,
          activeStage,
          scope:
            'Real Blitz, production Renderer UI compositor, one persistent Dawn GPUDevice; actual native buffer/texture API creation/destruction and queue completions. No App/OS lifecycle or physical driver-memory/JS-heap/WASM-heap plateau claim.',
          provenance,
          adapter: {
            vendor: adapter.info.vendor,
            architecture: adapter.info.architecture,
            device: adapter.info.device,
            description: adapter.info.description,
          },
          nativeProvider: process.env.FORGEAX_WEBGPU_NODE ?? 'dawn',
          wasmSha256: sha(bytes),
          htmlSha256: sha(html),
          shaderSha256: sha(JSON.stringify(gpuShaders)),
          submitted,
          completed,
          cycles,
          finalResources,
          deviceLostReason,
          resources: resources.rows,
          errors,
          unavailable: [
            'driver allocation/residency',
            'JavaScript heap retention',
            'WASM allocator committed/resident memory',
            'pipeline/bind-group/shader native allocation',
          ],
        },
        null,
        2,
      ),
    );
    expect(deviceLostReason).toBe('destroyed');
  }
});
