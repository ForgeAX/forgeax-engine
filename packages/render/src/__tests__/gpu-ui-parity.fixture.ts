import type { RhiCommandEncoder, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { expect } from 'vitest';
import { required } from '../../../ui-blitz/src/__tests__/fixture.js';
import {
  compareUiRaster,
  pixelAt,
  type UiRasterCase,
  uiRasterCases,
  uiRasterImage,
} from '../../../ui-blitz/src/__tests__/gpu-parity-fixture.js';
import {
  type BlitzUi,
  createBlitzUi,
  gpuShaders,
  type UiWasmHost,
} from '../../../ui-blitz/src/index.js';
import { createGpuUiRaster } from '../assembly/gpu-ui-raster.js';

/** Real RHI execution and readback, shared by Dawn and Chromium. No fabricated
 * pass list or Renderer mock substitutes for the actual Blitz GPU preparation. */
export async function verifyGpuUiParity(options: {
  readonly device: RhiDevice;
  readonly createReplacementDevice: () => Promise<RhiDevice>;
  readonly wasm: UiWasmHost;
  readonly font: Uint8Array;
  readonly fontFamily?: string;
  readonly cases?: readonly UiRasterCase[];
  readonly createShaderModule: (device: RhiDevice, source: string) => Promise<ShaderModule>;
  readonly save?: (
    name: string,
    width: number,
    expected: Uint8Array,
    actual: Uint8Array,
  ) => void | Promise<void>;
}) {
  let { device } = options;
  const raster = await createGpuUiRaster({
    device,
    shaders: gpuShaders,
    createShaderModule: options.createShaderModule,
  });
  const results: {
    name: string;
    difference: ReturnType<typeof compareUiRaster>;
    passes: number;
    encodedPasses: number;
  }[] = [];

  function encode(encoder: RhiCommandEncoder): number {
    // Observe the real command stream; every recorded pass still executes on
    // the actual backend and contributes to the same readback below.
    const begin = encoder.beginRenderPass;
    let passes = 0;
    encoder.beginRenderPass = (descriptor) => {
      passes++;
      return begin.call(encoder, descriptor);
    };
    try {
      raster.encode(encoder);
      return passes;
    } finally {
      encoder.beginRenderPass = begin;
    }
  }

  async function readback(name: string, width: number, expected: Uint8Array, passes: number) {
    const height = expected.length / width / 4;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const staging = device
      .createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 })
      .unwrap();
    try {
      const encoder = device.createCommandEncoder().unwrap();
      const encodedPasses = encode(encoder);
      if (passes === 0) expect(encodedPasses, `${name}: no repeated raster work`).toBe(0);
      else expect(encodedPasses, `${name}: actual raster work`).toBeGreaterThan(0);
      encoder.copyTextureToBuffer(
        { texture: required(raster.texture) },
        { buffer: staging, bytesPerRow, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 },
      );
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const completed = device.queue.onSubmittedWorkDone();
      raster.submitted(completed);
      await completed;
      const mapped = (await staging.mapAsync(1)).unwrap();
      const actual = new Uint8Array(expected.length);
      try {
        const bytes = new Uint8Array(mapped.getMappedRange().unwrap());
        for (let y = 0; y < height; y++)
          actual.set(bytes.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
      } finally {
        mapped.unmap();
      }
      await options.save?.(name, width, expected, actual);
      const difference = compareUiRaster(expected, actual);
      results.push({ name, difference, passes, encodedPasses });
      expect(difference.maxError, `${name}: ${JSON.stringify(difference)}`).toBeLessThanOrEqual(
        0.05,
      );
      expect(difference.channelsOutsideEpsilon, name).toBe(0);
      // FALSIFY a blank target with the exact same comparison path.
      expect(
        compareUiRaster(expected, new Uint8Array(actual.length)).maxError,
        name,
      ).toBeGreaterThan(0.05);
      return actual;
    } finally {
      device.destroyBuffer(staging).unwrap();
    }
  }
  try {
    for (const scene of options.cases ?? uiRasterCases) {
      const live: BlitzUi[] = [];
      const create = async () => {
        const ui = await createBlitzUi({
          wasm: options.wasm,
          font: options.font,
          ...(options.fontFamily === undefined ? {} : { fontFamily: options.fontFamily }),
          html: scene.html,
          width: scene.width,
          height: scene.height,
          pixelRatio: scene.pixelRatio ?? 1,
          resources: {
            baseUrl: 'https://ui-raster.test/',
            read: async (url) => {
              if (url !== 'https://ui-raster.test/red.png')
                throw new Error(`Unexpected parity resource: ${url}`);
              return uiRasterImage;
            },
          },
          onError: (cause) => {
            throw cause;
          },
        });
        live.push(ui);
        return ui;
      };
      try {
        const gpu = await create();
        const cpu = scene.reference ? undefined : await create();
        for (const [index, state] of scene.states.entries()) {
          const name = `${scene.name}-${state.name}`;
          for (const ui of live) state.apply?.(ui);
          const expected = scene.reference?.() ?? required(cpu?.paint(state.time));
          const frame = required(gpu.paintGpu(state.time));
          expect([frame.width, frame.height], name).toEqual([scene.width, scene.height]);
          expect(frame.passes.length, name).toBeGreaterThan(0);
          raster.prepare(frame);
          const actual = await readback(name, scene.width, expected, frame.passes.length);
          if (state.inspect) {
            expect(state.inspect(gpu), name).toEqual(state.expected);
            if (cpu) expect(state.inspect(cpu), name).toEqual(state.expected);
          }
          if (index === 0)
            for (const probe of scene.probes ?? []) {
              const pixel = pixelAt(actual, scene.width, probe.x, probe.y);
              for (const [channel, value] of probe.rgba.entries())
                expect(
                  Math.abs(required(pixel[channel]) - value),
                  `${name} anchor ${probe.x},${probe.y}`,
                ).toBeLessThanOrEqual(1);
            }
          expect(
            gpu.paintGpu(state.time),
            `${name}: unchanged UI must transfer no new frame`,
          ).toBeNull();

          if (scene.name === 'gradient-alpha-mask-and-image') {
            const retained = required(raster.texture);
            await readback(`${name}-unchanged`, scene.width, expected, 0);
            expect(raster.texture).toBe(retained);

            const replacement = await options.createReplacementDevice();
            expect(Object.is(replacement, device)).toBe(false);
            await raster.recover(replacement);
            device = replacement;
            expect(Object.is(raster.texture, retained)).toBe(false);
            expect(gpu.paintGpu(state.time), 'recovery must use the retained scene').toBeNull();
            await readback(`${name}-recovered`, scene.width, expected, frame.passes.length);

            const beforeResize = required(raster.texture);
            for (const ui of live) ui.resize(96, 64, 1);
            const shrunkExpected = required(required(cpu).paint(state.time + 1));
            const shrunk = required(gpu.paintGpu(state.time + 1));
            expect([shrunk.width, shrunk.height]).toEqual([96, 64]);
            raster.prepare(shrunk);
            expect(Object.is(raster.texture, beforeResize)).toBe(false);
            await readback(`${name}-shrunk`, 96, shrunkExpected, shrunk.passes.length);

            // Grow after retiring the image, gradient and mask layers. Every
            // pixel outside this new rectangle must be transparent, including
            // the old image's region that was outside the shrunken viewport.
            for (const ui of live) {
              ui.document.body.innerHTML =
                '<div style="position:absolute;left:4px;top:8px;width:16px;height:16px;background:lime"></div>';
              ui.resize(256, 128, 1);
            }
            const replacedExpected = required(required(cpu).paint(state.time + 2));
            const replaced = required(gpu.paintGpu(state.time + 2));
            expect([replaced.width, replaced.height]).toEqual([256, 128]);
            raster.prepare(replaced);
            const replacedActual = await readback(
              `${name}-resized-without-old-layers`,
              256,
              replacedExpected,
              replaced.passes.length,
            );
            expect(pixelAt(replacedActual, 256, 8, 12)).toEqual([0, 255, 0, 255]);
            expect(pixelAt(replacedActual, 256, 192, 40)).toEqual([0, 0, 0, 0]);
          }
        }
      } finally {
        for (const ui of live.reverse()) ui.dispose();
      }
    }
  } finally {
    raster.dispose();
    raster.dispose();
    expect(raster.texture, 'disposed raster releases its retained output').toBeUndefined();
    const encoder = device.createCommandEncoder().unwrap();
    expect(encode(encoder), 'disposed raster encodes no work').toBe(0);
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    await device.queue.onSubmittedWorkDone();
  }
  return results;
}
