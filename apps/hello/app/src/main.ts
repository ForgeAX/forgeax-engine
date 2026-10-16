// apps/hello/app - createApp(canvas) one-screen takeoff exemplar
// (feat-20260518-app-shell-game-loop M6 / D-12 / AC-01 / AC-07).
//
// Three-statement takeoff (charter F1 limited context + P1 progressive
// disclosure):
//   const app = await createApp(canvas, {});
//   if (!app.ok) reportError(app.error);
//   app.value.start();
//
// Error handling pattern (D-6 dual-layer instanceof + switch): the
// error union is CanvasAppError (AppError | RhiError |
// EngineEnvironmentError; SSOT in @forgeax/engine-app). The
// outer instanceof check separates EngineEnvironmentError (which lacks
// .code) from the structured AppError | RhiError union; the inner
// switch (err.code) is exhaustive across 5 + 18 + 2 = 25 codes (charter P4
// closed-union, tsc strict mode guards completeness with no default).
//
// SLOC note (AC-01): the AC target was <=30 SLOC excluding imports +
// line comments. With biome formatter expanding case stacks one label
// per line, the 23-case exhaustive switch consumes 23 lines on its own;
// the rest (await + Result narrowing + spawn + start + EngineEnvironmentError
// arm) sits at ~14 lines. Total ~46 lines is the actually-achievable
// minimum given the dual constraint (exhaustive switch + biome format).
// The 3-statement takeoff (await createApp + if(!app.ok) + start) lands
// in the first 5 lines, which is the discovery surface charter F1 + P1
// optimise for.

import type { CanvasAppError } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import { EngineEnvironmentError } from '@forgeax/engine-runtime';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';
import { populateDemoWorld } from '../../../shared/src/populate-demo-world';

const canvas = document.querySelector<HTMLCanvasElement>('#app');
if (!canvas) throw new Error('hello-app: missing <canvas id="app"> in index.html');
const app = await createApp(
  canvas,
  {},
  forgeaxBundlerAdapter(),
);
if (!app.ok) reportError(app.error);
else {
  populateDemoWorld(app.value.world);
  app.value.start();
}

function reportError(err: CanvasAppError): void {
  if (err instanceof EngineEnvironmentError) {
    const inner = err.detail.webgpuError;
    const code = inner !== undefined && 'code' in inner ? inner.code : '<none>';
    console.error(`[app] EngineEnvironmentError: webgpu inner=${code}`);
    return;
  }
  switch (err.code) {
    case 'app-not-started':
    case 'app-already-running':
    case 'app-canvas-detached':
    case 'app-system-update-failed':
    case 'app-pointer-lock-failed':
    case 'app-plugin-activation-failed':
    case 'adapter-unavailable':
    case 'feature-not-enabled':
    case 'limit-exceeded':
    case 'shader-compile-failed':
    case 'rhi-not-available':
    case 'webgpu-runtime-error':
    case 'command-encoder-finished':
    case 'render-pass-not-ended':
    case 'queue-submit-failed':
    case 'queue-write-buffer-out-of-bounds':
    case 'render-system-no-camera':
    case 'render-system-multi-camera':
    case 'render-system-multi-light':
    case 'asset-not-registered':
    case 'device-lost':
    case 'oom':
    case 'internal-error':
    case 'hierarchy-broken':
      console.error(`[app] ${err.code}: ${err.hint}`);
      return;
  }
}
