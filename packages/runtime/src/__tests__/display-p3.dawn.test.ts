import { mkdirSync, writeFileSync } from 'node:fs';
import type { OutputColorSpace, Renderer } from '@forgeax/engine-render';
import { attachRecorder, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  captureDisplayP3,
  DISPLAY_P3_SIZE,
  falsifyDisplayP3,
  runDisplayP3Journey,
  switchOutputColorSpace,
} from './display-p3.fixture';
import { encodeRgbaPng } from './hdr-evidence.fixture';
import { shaderManifestUrl } from './shader-manifest-url.fixture';

const manifestUrl = shaderManifestUrl(await buildEngineShaderManifest());
const root = 'artifacts/pr-evidence/display-p3/dawn';

/**
 * Offscreen canvas double. `reportsConfiguration` models a presentation
 * surface that answers `getConfiguration()` with what it honoured (the real
 * browser contract); without it the host cannot prove a colour space and the
 * renderer must fall back to sRGB.
 */
function fakeCanvas(size: number, reportsConfiguration: boolean) {
  let target: GPUTexture | undefined;
  let configured: GPUCanvasConfiguration | undefined;
  const configurations: GPUCanvasConfiguration[] = [];
  const context = {
    configure(options: GPUCanvasConfiguration) {
      configured = options;
      configurations.push(options);
      target?.destroy();
      target = options.device.createTexture({
        size: [size, size],
        format: options.format,
        usage: 0x11,
        viewFormats: [options.format === 'bgra8unorm' ? 'bgra8unorm-srgb' : 'rgba8unorm-srgb'],
      });
    },
    unconfigure() {
      configured = undefined;
    },
    getCurrentTexture: () => target,
    ...(reportsConfiguration ? { getConfiguration: () => configured ?? null } : {}),
  };
  return {
    canvas: { width: size, height: size, getContext: () => context },
    configurations,
    destroy: () => target?.destroy(),
  };
}

const save = (dir: string) => (name: string, bytes: Uint8Array) => {
  mkdirSync(dir, { recursive: true });
  if (name.endsWith('.rgba')) {
    writeFileSync(
      `${dir}/${name.replace(/\.rgba$/, '.png')}`,
      encodeRgbaPng(bytes, DISPLAY_P3_SIZE),
    );
    return;
  }
  writeFileSync(`${dir}/${name}`, bytes);
};

async function withRenderer<T>(
  options: {
    readonly outputColorSpace?: OutputColorSpace;
    readonly reportsConfiguration: boolean;
    readonly recorder?: RecorderAttachment;
  },
  body: (renderer: Renderer, surface: ReturnType<typeof fakeCanvas>) => Promise<T>,
): Promise<T> {
  const surface = fakeCanvas(DISPLAY_P3_SIZE, options.reportsConfiguration);
  const result = await constructRuntimeRendererHost(
    surface.canvas,
    {
      ...(options.recorder === undefined ? {} : { rhi: options.recorder.backend.rhi }),
      ...(options.outputColorSpace === undefined
        ? {}
        : { outputColorSpace: options.outputColorSpace }),
    },
    { shaderManifestUrl: manifestUrl },
  );
  if (!result.ok) throw result.error;
  try {
    return await body(result.value.renderer, surface);
  } finally {
    await result.value.renderer.dispose();
    surface.destroy();
  }
}

describe('Display-P3 output (dawn)', () => {
  it('configures display-p3, encodes P3 bytes and falsifies the sRGB reference', {
    timeout: 180_000,
  }, async () => {
    const dir = `${root}/p3-applied`;
    await withRenderer(
      { outputColorSpace: 'display-p3', reportsConfiguration: true },
      async (renderer, surface) => {
        const journey = await runDisplayP3Journey(
          renderer,
          'display-p3',
          save(dir),
          'final-display',
        );
        expect(journey.report).toEqual({
          status: 'applied',
          requested: 'display-p3',
          effective: 'display-p3',
        });
        expect(surface.configurations.at(-1)?.colorSpace).toBe('display-p3');
        const falsifier = falsifyDisplayP3(journey.rgba);
        save(dir)('falsifier.json', new TextEncoder().encode(JSON.stringify(falsifier, null, 2)));
        const steps = await switchOutputColorSpace(renderer, 'display-p3', save(dir));
        expect(steps.map((step) => step.report.effective)).toEqual(['srgb', 'display-p3']);
        expect(surface.configurations.some((c) => c.colorSpace === undefined)).toBe(true);
        expect(surface.configurations.at(-1)?.colorSpace).toBe('display-p3');
      },
    );
  });

  it('keeps the default sRGB output byte-exact and without a colorSpace request', {
    timeout: 120_000,
  }, async () => {
    await withRenderer({ reportsConfiguration: true }, async (renderer, surface) => {
      const journey = await runDisplayP3Journey(
        renderer,
        'srgb',
        save(`${root}/srgb`),
        'final-display',
      );
      expect(journey.report).toEqual({ status: 'applied', requested: 'srgb', effective: 'srgb' });
      expect(surface.configurations.every((c) => c.colorSpace === undefined)).toBe(true);
    });
  });

  it('reports a structured fallback and renders sRGB when the surface cannot prove P3', {
    timeout: 120_000,
  }, async () => {
    await withRenderer(
      { outputColorSpace: 'display-p3', reportsConfiguration: false },
      async (renderer, surface) => {
        const journey = await runDisplayP3Journey(
          renderer,
          'srgb',
          save(`${root}/fallback`),
          'final-display',
        );
        expect(journey.report).toMatchObject({
          status: 'fallback',
          requested: 'display-p3',
          effective: 'srgb',
          fallback: {
            code: 'canvas-color-space-unsupported',
            detail: { requested: 'display-p3', observed: 'configuration-absent' },
          },
        });
        expect(surface.configurations.at(-1)?.colorSpace).toBeUndefined();
      },
    );
  });

  it('captures a P3 frame whose tape carries the surface colour space and replays exactly', {
    timeout: 180_000,
  }, async () => {
    const recorder = attachRecorder(webgpu).unwrap();
    const replayDevices: GPUDevice[] = [];
    try {
      await withRenderer(
        { outputColorSpace: 'display-p3', reportsConfiguration: true, recorder },
        async (renderer) => {
          const { report } = await captureDisplayP3(
            renderer,
            recorder,
            save(`${root}/rhi-debug`),
            replayDevices,
          );
          expect(report.canvasColorSpace).toBe('display-p3');
        },
      );
    } finally {
      try {
        (await recorder.dispose()).unwrap();
      } finally {
        for (const device of replayDevices) device.destroy();
      }
    }
  });
});
