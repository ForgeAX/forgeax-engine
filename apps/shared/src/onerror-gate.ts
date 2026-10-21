/// <reference path="./vite-env.d.ts" />

import { afterEach, describe, expect, it } from 'vitest';
import {
  beginLearnRenderTestLifecycle,
  disposeLearnRenderTestApp,
  learnRenderTestBootstrapStage,
  markLearnRenderTestBootstrapStage,
  waitForLearnRenderTestBootstrap,
} from './learn-render-test-lifecycle';

export const SUT_ATTRIBUTABLE_CODES: ReadonlySet<string> = new Set([
  // Renderer.ready failure surface (renderer.ts).
  'manifest-malformed',
  'shader-not-found',
  'shader-compile-failed',
  'feature-not-enabled',
  'limit-exceeded',
  'webgpu-runtime-error',

  // Renderer.draw failure surface (renderer.ts).
  'rhi-not-available',
  'queue-submit-failed',
  'queue-write-buffer-out-of-bounds',
  'render-system-empty-worlds',
  'render-system-owner-out-of-range',
  'render-system-no-camera',
  'render-system-multi-camera',
  'render-system-multi-light',

  // Wave 2 RenderFeature failures emitted through Renderer.onError.
  'render-feature-registration-conflict',
  'render-feature-stage-failed',
  'render-feature-capability-missing',
  'render-feature-pass-order-conflict',
  'render-feature-preparation-failed',
  'render-feature-prepared-state-mismatch',
  'render-feature-draw-recording-failed',

  // Render-loop / runtime onError surface.
  'asset-not-registered',
  'hierarchy-broken',
  // Bootstrap-time AssetError codes routed into __learnRenderErrors by
  // the demo SUT itself (added 2026-06-08 after `asset-not-imported`
  // bypassed the gate by being filtered out as not-a-runtime-error).
  // The four-verb redesign (2026-06-06) made `loadByGuid<TextureAsset>`
  // a hard dependency on either build-time `.bin` import or a wired
  // ImportTransport — when neither is in place the runtime fails fast
  // with one of these codes, and a missing bus push from the SUT used
  // to leave the gate green. Demos must mirror their `console.warn` /
  // `console.error` resource-load paths into the bus for this to fire.
  'asset-not-imported',
  'texture-source-not-imported',
  'asset-not-found',
  'asset-fetch-failed',
  'loader-not-registered',
]);

// Material-owner namespaces fail closed, including newly added contract errors.
// Apps consume the error code; they never import a package's private source tree.
export function isSutAttributableCode(code: string): boolean {
  return (
    SUT_ATTRIBUTABLE_CODES.has(code) ||
    code.startsWith('material-') ||
    code.startsWith('shader-module-') ||
    code.startsWith('gltf-material-')
  );
}

const settleQuietWindowMs = import.meta.env.FORGEAX_BROWSER_CI_LIGHTWEIGHT === '1' ? 300 : 500;

export function onerrorGate(
  sectionName: string,
  importSut: () => Promise<unknown>,
  timeoutMs = 30_000,
): void {
  describe(`${sectionName} onerror-gate`, () => {
    let canvas: HTMLCanvasElement | undefined;

    afterEach(async ({ task }) => {
      try {
        if (canvas !== undefined) {
          if (task.result?.state === 'fail') {
            try {
              const stage = learnRenderTestBootstrapStage(canvas);
              console.error(
                '[learn-render.onerror-failure]',
                JSON.stringify({
                  sectionName,
                  stage: stage?.name ?? null,
                  stageElapsedMs: stage === undefined ? null : Date.now() - stage.startedAt,
                }),
              );
            } catch {
              // Diagnostic transport must not replace the test or skip native cleanup.
            }
          }
          await disposeLearnRenderTestApp(canvas, 5_000);
        }
      } finally {
        if (canvas !== undefined && canvas.parentNode !== null) {
          canvas.parentNode.removeChild(canvas);
        }
        canvas = undefined;
        delete (globalThis as unknown as { __learnRenderErrors?: unknown }).__learnRenderErrors;
        delete (globalThis as unknown as { __forgeaxAssetLoadTrace?: unknown })
          .__forgeaxAssetLoadTrace;
      }
    });

    // Headed Chrome Beta on lavapipe can spend several seconds creating the
    // first WebGPU device after neighboring browser groups close. The ordinary
    // gate stays at 30s; multi-pass callers can pass a larger explicit budget
    // for an isolated cold process while retaining a bounded failure rather
    // than inheriting Vitest's 15s default.
    it(
      'SUT bootstrap fires no SUT-attributable renderer.onError',
      async () => {
        if (typeof navigator.gpu === 'undefined') {
          throw new Error(
            `[${sectionName}.onerror-gate] code: 'webgpu-unavailable'; vitest.config.ts launches chrome-beta with WebGPU flags`,
          );
        }
        canvas = document.createElement('canvas');
        canvas.id = 'app';
        canvas.width = 256;
        canvas.height = 256;
        document.body.appendChild(canvas);
        markLearnRenderTestBootstrapStage(canvas, 'beginLearnRenderTestLifecycle');
        await beginLearnRenderTestLifecycle(canvas);

        const errors: Array<{ code: string; hint?: string }> = [];
        (globalThis as unknown as { __learnRenderErrors: typeof errors }).__learnRenderErrors =
          errors;

        markLearnRenderTestBootstrapStage(canvas, 'importSut');
        const gateMarker = globalThis as typeof globalThis & {
          __forgeaxBrowserOnerrorGate?: string;
        };
        // The gate only proves that a SUT can boot without publishing a
        // renderer error. Let an evidence-heavy SUT opt into its ordinary
        // scene while keeping the real capture smokes on their full path.
        // Set it unconditionally: keyed to the CI flag, local runs booted the
        // full evidence fixture and outran the bootstrap budget.
        gateMarker.__forgeaxBrowserOnerrorGate = sectionName;
        try {
          await importSut();
        } finally {
          delete gateMarker.__forgeaxBrowserOnerrorGate;
        }
        markLearnRenderTestBootstrapStage(canvas, 'waitForLearnRenderTestBootstrap');
        await waitForLearnRenderTestBootstrap(canvas, Math.max(5_000, timeoutMs - 5_000));
        markLearnRenderTestBootstrapStage(canvas, 'settleRendererErrors');
        let prev = errors.length;
        let quietSince = performance.now();
        const settleDeadline = quietSince + 5_000;
        while (performance.now() < settleDeadline) {
          await new Promise((r) => setTimeout(r, 50));
          const now = performance.now();
          if (errors.length === prev) {
            if (now - quietSince >= settleQuietWindowMs) break;
          } else {
            prev = errors.length;
            quietSince = now;
          }
        }

        const sutErrors = errors.filter((e) => isSutAttributableCode(e.code));
        expect(sutErrors).toEqual([]);
      },
      timeoutMs,
    );
  });
}
