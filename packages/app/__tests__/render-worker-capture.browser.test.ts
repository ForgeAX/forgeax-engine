import { createApp } from '@forgeax/engine-app/browser';
import { buildFrameModel, decodeTape } from '@forgeax/engine-rhi-debug';
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import type { ExecutionInspectResultMessage } from '../src/execution/protocol';

it('captures actual child Renderer work through the source inspection channel', async () => {
  await page.viewport(800, 600);
  const NativeWorker = globalThis.Worker;
  let engineWorker: Worker | undefined;
  let delayedCapabilityProbe = false;
  globalThis.Worker = class extends NativeWorker {
    private delayedMessage: ReturnType<typeof setTimeout> | undefined;

    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      if (options?.name === 'forgeax-engine') engineWorker = this;
      if (options === undefined && String(url).startsWith('blob:')) {
        // A slow native probe still belongs to the explicitly configured startup budget.
        this.addEventListener(
          'message',
          (event) => {
            event.stopImmediatePropagation();
            delayedCapabilityProbe = true;
            this.delayedMessage = setTimeout(() => {
              this.dispatchEvent(new MessageEvent('message', { data: event.data }));
            }, 2_500);
          },
          { once: true },
        );
      }
    }

    override terminate(): void {
      clearTimeout(this.delayedMessage);
      super.terminate();
    }
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  document.body.append(canvas);
  try {
    const created = await createApp(
      canvas,
      {
        execution: {
          workers: { engine: true, render: true, kernels: false },
          bootstrap: new URL('./render-worker-geometry-bootstrap.ts', import.meta.url),
          bootstrapData: 'instances',
          diagnostics: { rhiCapture: true },
          startupTimeoutMs: 90_000,
        },
      },
      { shaderManifestUrl: new URL('/shaders/manifest.json', location.href).href },
    );
    if (!created.ok) throw created.error;
    expect(delayedCapabilityProbe).toBe(true);
    const running = created.value;
    try {
      running.start().unwrap();
      await expect
        .poll(() => running.execution?.report().render?.completedFrame ?? 0, { timeout: 60_000 })
        .toBeGreaterThan(2);
      const worker = engineWorker;
      const identity = running.execution?.report().world.identity;
      if (worker === undefined || identity == null) throw new Error('Missing source Worker');
      const response = await new Promise<ExecutionInspectResultMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.removeEventListener('message', receive);
          reject(new Error('Native capture timed out'));
        }, 60_000);
        const receive = (event: MessageEvent<ExecutionInspectResultMessage>) => {
          if (event.data.kind !== 'inspect-result' || event.data.requestId !== 901) return;
          clearTimeout(timer);
          worker.removeEventListener('message', receive);
          resolve(event.data);
        };
        worker.addEventListener('message', receive);
        worker.postMessage({
          kind: 'inspect',
          requestId: 901,
          worldIdentity: identity,
          // Structured clone carries the bytes; a JS number array exceeds V8's
          // element limit once retained static shadow layers double the tape.
          code: 'const result = await rhiCapture.captureFrame(); if (!result.ok) throw result.error; return result.value.bytes;',
        });
      });
      if (!response.result.ok) throw response.result.error;
      expect(response.result.value).toBeInstanceOf(Uint8Array);
      const tape = decodeTape(response.result.value as Uint8Array);
      if (!tape.ok) throw tape.error;
      const model = buildFrameModel(tape.value);
      expect(model.works.length).toBeGreaterThan(0);
      expect(tape.value.events.some((event) => event.kind === 'submit')).toBe(true);
      expect(running.execution?.report().fault).toBeNull();
    } finally {
      await running.dispose();
    }
  } finally {
    globalThis.Worker = NativeWorker;
    canvas.remove();
  }
}, 180_000);
