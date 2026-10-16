// clamp-to-last.e2e.browser.test.ts -- feat-20260629-multi-uv-set-support m3-w6 fixup
//
// Browser e2e test for clamp-to-last: AC-08 + AC-12 combined gate.
//
// AC-08 = PSO builds successfully for any material declaring 1..8 UV sets.
// AC-12 = single-UV mesh + built-in standard PBR renders without regression
// (zero-rhi-errors baseline from pre-feat state).
//
// NEW DESIGN (post user-verdict, implement-review round):
//   Built-in PBR falls back to single UV; multi-UV is consumed only by
//   custom materials. This test exercises the single-UV path with the
//   built-in standard PBR shader — the regression baseline for AC-12 and
//   the single-UV half of AC-08. Multi-UV + custom-material PSO paths are
//   exercised by the dawn e2e tests (multi-uv-8set.e2e.dawn.test.ts,
//   clamp-to-last.e2e.dawn.test.ts).
//
// DEVICE-LOST FILTER: The browser vitest runner teardowns can fire
// `device-lost` / `rhi-not-available` from prior test teardowns
// (known issue-466 — chromium headless + swiftshader timing artifact,
// memory `issue-466-lit-pixels-device-lost-unfiltered-error-bus`).
// This test filters out device-lost family codes and only asserts on
// SUT-attributable render errors (PSO compile / limit / submit).
//
// FIXUP (m3-w6-fixup): Round 2 replaced the hand-rolled mock canvas +
// adapter-capture boot sequence with the same real-canvas + Engine.create
// pattern used by light-casters-9-light.browser.test.ts. The mock canvas
// `getCurrentTexture()` returned a manually-allocated Texture that is not
// a real swap-chain texture; in true chromium (vitest browser mode) the
// draw pipeline rejects non-swap-chain textures and `renderer.draw()` returns
// ok:false. Real canvas + Engine.create boots the full swap-chain pipeline;
// draw succeeds in chromium like every other browser e2e test.
//
// Runs via pnpm test:browser against wgpu-wasm/WebGL2 backend.

import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { afterEach, describe, expect, it } from 'vitest';
import { constructRuntimeRendererHost } from '../renderer-host';

const W = 256;
const H = 256;

// RhiErrorCode / RuntimeErrorCode / PostProcessErrorCode members that are
// SUT-attributable — PSO compile failure, limit exceeded, queue submit
// failure, etc. Errors from device-lost / teardown races are EXCLUDED.
const SUT_ATTRIBUTABLE_RENDER_CODES: ReadonlySet<string> = new Set([
  // RhiErrorCode — compile / resource / submit failures the SUT owns
  'shader-compile-failed',
  'feature-not-enabled',
  'limit-exceeded',
  'queue-submit-failed',
  'queue-write-buffer-out-of-bounds',
  // RuntimeErrorCode — render-system / asset-load failures the SUT owns
  'render-system-no-camera',
  'render-system-multi-camera',
  'render-system-multi-light',
  'asset-not-registered',
  'material-resolved-empty-passes',
  'vertex-storage-buffer-unavailable',
  'mesh-ssbo-capacity-exceeded',
  'mesh-ssbo-ceiling-reached',
  'standard-light-budget-exceeded',
  'standard-cluster-index-overflow',
]);

// Suppress WebGPU teardown race: chromium fires unhandled OperationError
// ("Instance dropped error in getCompilationInfo") when shader compilation
// is in-flight as the device is GC'd after test completion. This is a
// known chromium headless + swiftshader timing artifact (not a test bug).
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason instanceof DOMException && e.reason.message.includes('Instance dropped')) {
      e.preventDefault();
    }
  });
}

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

type EngineRenderer = import('@forgeax/engine-render').Renderer;

async function buildRenderer(canvas: HTMLCanvasElement): Promise<EngineRenderer> {
  const host = await constructRuntimeRendererHost(
    canvas,
    {},
    {
      shaderManifestUrl: '/shaders/manifest.json',
    },
  );
  if (!host.ok) throw host.error;
  if (host.value.renderer.inspect().state !== 'alive') {
    throw new Error('runtime renderer host did not reach alive state');
  }
  return host.value.renderer;
}

describe('clamp-to-last e2e browser (m3-w6)', () => {
  let canvas: HTMLCanvasElement | undefined;
  let renderer: EngineRenderer | undefined;

  afterEach(async () => {
    await renderer?.dispose();
    renderer = undefined;
    if (canvas !== undefined && canvas.parentNode !== null) {
      canvas.parentNode.removeChild(canvas);
    }
    canvas = undefined;
  });

  it.skipIf(!browserReady)(
    "'browser-webgpu-missing' -- browser navigator.gpu not available",
    () => {
      expect(browserReady).toBe(true);
    },
  );

  // AC-08/AC-12: single-UV mesh + built-in standard PBR builds PSO and
  // renders without SUT-attributable errors. This exercises the
  // single-UV half of AC-08 (PSO build success) and the zero-regression
  // contract of AC-12 (no new rhi-errors introduced by the clamp-to-last
  // / multi-UV branch in the single-UV baseline path).
  //
  // Design: built-in PBR falls back to single UV; multi-UV is consumed
  // only by custom materials (per user verdict in implement-review).
  // HANDLE_CUBE carries exactly 1 UV set, which is the default PBR
  // baseline — PSO build must succeed and draw must not fire
  // SUT-attributable errors.
  //
  // device-lost filtering: the browser vitest runner fires device-lost
  // / rhi-not-available from prior test teardowns (chromium headless +
  // swiftshader timing artifact, known issue-466). These are excluded
  // from the error count; only SUT-attributable codes fail the test.
  it('AC-08/AC-12: single-UV mesh + built-in standard PBR builds PSO and renders without SUT-attributable error', async () => {
    canvas = document.createElement('canvas');
    canvas.id = 'clamp-to-last-test-canvas';
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    canvas.style.display = 'block';
    document.body.appendChild(canvas);

    const rendererBuildStartedAt = performance.now();
    renderer = await buildRenderer(canvas);
    console.log(
      `[clamp-to-last-timing] renderer-ready elapsedMs=${(performance.now() - rendererBuildStartedAt).toFixed(1)}`,
    );

    const world = new World();
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: {} },
    );
    world.spawn(
      {
        component: Transform,
        data: {
          pos: [0, 0, 3],
          quat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
      { component: Camera, data: { fov: Math.PI / 4, aspect: 1, near: 0.1, far: 100 } },
    );

    const sutErrors: Array<{ code: string }> = [];
    renderer.subscribe((event) => {
      if (event.kind !== 'error') return;
      sutErrors.push(event.error);
    });

    const attachment = renderer.attach(world);
    expect(attachment.ok).toBe(true);
    if (!attachment.ok) throw attachment.error;
    for (let f = 0; f < 10; f++) {
      const frameStartedAt = performance.now();
      world.update(1 / 60).unwrap();
      const updatedAt = performance.now();
      const drawn = renderer.draw({
        leases: [attachment.value],
        camera: { lease: attachment.value },
        environment: { lease: attachment.value },
      });
      expect(drawn.ok).toBe(true);
      if (!drawn.ok) throw drawn.error;
      const submittedAt = performance.now();
      const completed = await drawn.value.completed;
      const completedAt = performance.now();
      console.log(
        `[clamp-to-last-timing] frame=${f + 1} updateMs=${(updatedAt - frameStartedAt).toFixed(1)} submitMs=${(submittedAt - updatedAt).toFixed(1)} completionMs=${(completedAt - submittedAt).toFixed(1)} elapsedMs=${(completedAt - rendererBuildStartedAt).toFixed(1)}`,
      );
      expect(completed.ok).toBe(true);
    }

    const sutAttributable = sutErrors.filter((e) => SUT_ATTRIBUTABLE_RENDER_CODES.has(e.code));
    expect(sutAttributable).toEqual([]);
  });
});
