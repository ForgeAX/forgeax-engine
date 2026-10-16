import type { OutputColorSpace, Renderer } from '@forgeax/engine-render';
import { attachRecorder, type RecorderAttachment } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { constructRuntimeRendererHost } from '../renderer-host';
import {
  captureDisplayP3,
  DISPLAY_P3_SIZE,
  falsifyDisplayP3,
  runDisplayP3Journey,
  switchOutputColorSpace,
} from './display-p3.fixture';

const root = 'artifacts/pr-evidence/display-p3/browser';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/** Evidence writer: RGBA frames become PNGs; tapes stay out of the evidence tree. */
const save = (dir: string) => async (name: string, bytes: Uint8Array) => {
  if (name.endsWith('.rhitape')) return;
  if (name.endsWith('.rgba')) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = DISPLAY_P3_SIZE;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('2d context unavailable');
    context.putImageData(
      new ImageData(new Uint8ClampedArray(bytes), DISPLAY_P3_SIZE, DISPLAY_P3_SIZE),
      0,
      0,
    );
    const png = canvas.toDataURL('image/png').split(',')[1] ?? '';
    await commands.writeFile(`${dir}/${name.replace(/\.rgba$/, '.png')}`, png, 'base64');
    return;
  }
  await commands.writeFile(`${dir}/${name}`, base64(bytes), 'base64');
};

async function withCanvasRenderer(
  outputColorSpace: OutputColorSpace | undefined,
  body: (renderer: Renderer, canvas: HTMLCanvasElement) => Promise<void>,
  recorder?: RecorderAttachment,
) {
  const created = await createOnCanvas(outputColorSpace, recorder);
  try {
    await body(created.renderer, created.canvas);
  } finally {
    await created.renderer.dispose();
    created.canvas.remove();
  }
}

async function createOnCanvas(
  outputColorSpace: OutputColorSpace | undefined,
  recorder?: RecorderAttachment,
) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = DISPLAY_P3_SIZE;
  document.body.append(canvas);
  const result = await constructRuntimeRendererHost(canvas, {
    ...(recorder === undefined ? {} : { rhi: recorder.backend.rhi }),
    ...(outputColorSpace === undefined ? {} : { outputColorSpace }),
  });
  if (!result.ok) throw result.error;
  return { renderer: result.value.renderer, canvas };
}

function canvasConfiguration(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('webgpu');
  const configuration = (
    context as { getConfiguration?: () => GPUCanvasConfiguration | null } | null
  )?.getConfiguration?.();
  return configuration === undefined || configuration === null
    ? undefined
    : { format: configuration.format, colorSpace: configuration.colorSpace };
}

it('presents a real display-p3 WebGPU canvas for 60 frames with P3-encoded bytes', {
  timeout: 240_000,
}, async () => {
  await withCanvasRenderer('display-p3', async (renderer, canvas) => {
    const journey = await runDisplayP3Journey(
      renderer,
      'display-p3',
      save(`${root}/p3`),
      'final-display',
    );
    expect(journey.report).toEqual({
      status: 'applied',
      requested: 'display-p3',
      effective: 'display-p3',
    });
    const configuration = canvasConfiguration(canvas);
    expect(configuration?.colorSpace).toBe('display-p3');
    const falsifier = falsifyDisplayP3(journey.rgba);
    const steps = await switchOutputColorSpace(renderer, 'display-p3', save(`${root}/p3`));
    expect(steps.map((step) => step.report.effective)).toEqual(['srgb', 'display-p3']);
    expect(canvasConfiguration(canvas)?.colorSpace).toBe('display-p3');
    await save(root)(
      'summary.json',
      new TextEncoder().encode(
        JSON.stringify(
          {
            userAgent: navigator.userAgent,
            completedFrames: 60,
            canvasConfiguration: configuration,
            report: journey.report,
            checks: journey.checks,
            falsifier,
            switch: steps.map((step) => ({ target: step.target, report: step.report })),
          },
          null,
          2,
        ),
      ),
    );
  });
});

it('keeps the default sRGB canvas byte-exact', { timeout: 180_000 }, async () => {
  await withCanvasRenderer(undefined, async (renderer, canvas) => {
    const journey = await runDisplayP3Journey(
      renderer,
      'srgb',
      save(`${root}/srgb`),
      'final-display',
    );
    expect(journey.report).toEqual({ status: 'applied', requested: 'srgb', effective: 'srgb' });
    expect(canvasConfiguration(canvas)?.colorSpace ?? 'srgb').toBe('srgb');
  });
});

it('records the browser surface colour space in an RHI Debug tape and replays it', {
  timeout: 240_000,
}, async () => {
  const recorder = attachRecorder(webgpu).unwrap();
  const replayDevices: GPUDevice[] = [];
  try {
    await withCanvasRenderer(
      'display-p3',
      async (renderer) => {
        const { report } = await captureDisplayP3(
          renderer,
          recorder,
          save(`${root}/rhi-debug`),
          replayDevices,
        );
        expect(report.canvasColorSpace).toBe('display-p3');
        expect(report.maxPixelError).toBeLessThanOrEqual(1);
      },
      recorder,
    );
  } finally {
    try {
      (await recorder.dispose()).unwrap();
    } finally {
      for (const device of replayDevices) device.destroy();
    }
  }
});
