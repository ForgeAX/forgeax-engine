import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';
import { waitForLearnRenderTestBootstrap } from '../../../../../shared/src/learn-render-test-lifecycle';

onerrorGate('learn-render SSAO and PCSS room', async () => {
  const originalUrl = location.href;
  const url = new URL(originalUrl);
  url.searchParams.set('scene', 'room');
  history.replaceState(null, '', url);
  try {
    await import('../main.ts');
    const canvas = document.querySelector<HTMLCanvasElement>('#app');
    if (!canvas) throw new Error('Room test canvas is missing');
    await waitForLearnRenderTestBootstrap(canvas, 80_000);
    const scope = globalThis as typeof globalThis & {
      __verifySsao: () => Promise<{ stableFrames?: number }>;
      __captureSsao: () => Promise<Uint8Array>;
      __advanceSsao: () => Promise<void>;
    };
    const capture = scope.__captureSsao;
    const advance = scope.__advanceSsao;
    let settlingFrames = 0;
    scope.__advanceSsao = async () => {
      await advance();
      settlingFrames++;
    };
    const started = performance.now();
    let capturedFrames = 0;
    scope.__captureSsao = async () => {
      const pixels = await capture();
      capturedFrames++;
      if (capturedFrames % 20 === 0)
        console.info(`[ssao-room] capturedFrames=${capturedFrames} elapsedMs=${Math.round(performance.now() - started)}`);
      return pixels;
    };
    try {
      const result = await scope.__verifySsao();
      if (result.stableFrames !== 60) throw new Error('Room journey did not complete 60 stable frames');
      if (capturedFrames !== 76 || settlingFrames !== 64)
        throw new Error(`Room journey changed: captures=${capturedFrames}, settling=${settlingFrames}`);
      console.info(`[ssao-room] settlingFrames=${settlingFrames} stableFrames=${result.stableFrames} capturedFrames=${capturedFrames} elapsedMs=${Math.round(performance.now() - started)}`);
    } finally {
      scope.__captureSsao = capture;
      scope.__advanceSsao = advance;
    }
  } finally {
    history.replaceState(null, '', originalUrl);
  }
// Includes endpoint PSO compilation, four 2048-square cascades and 60 pixel
// readbacks on software WebGPU. This is a completion bound, not a timing gate.
}, 240_000);
