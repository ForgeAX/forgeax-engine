// bug-20260610: rhi-wgpu became contractually browser-only WebGL2 fallback
// (wgpu-wasm Cargo.toml drops BROWSER_WEBGPU; adapter.ts removes the
// navigator.gpu fast path). The escape-hatch pattern this test exercised
// (force rhi-wgpu in chromium even when navigator.gpu is available) is
// no longer valid — rhi-wgpu only acquires an adapter via the wgpu wasm
// GL backend now, which the chromium provider on GH-hosted runners does
// not expose. Skipped for this reason; real coverage of rhi-wgpu lives in
// the manual Safari WebKit verify harness:
// scripts/dev-verify/verify-webkit-hello-triangle.mjs.

// renderer-wgpu-wasm.browser.test.ts — feat-20260511-rhi-wgpu-impl M4(b) /
// w27 chromium playwright e2e for the wgpu-wasm dual-impl variant.
//
// Trigger: root vitest.config.ts `browser` project (`*.browser.test.ts` glob).
// Environment: playwright provider chrome-beta channel + ubuntu-latest
// mesa-vulkan-drivers + lavapipe ICD (ci.yml VK_ICD_FILENAMES setup; the
// ONLY public path for WebGPU on a GH-hosted runner per research R-09).
//
// Scope (plan-tasks.json w27 acceptanceCheck):
//   (a) chromium V8 + sandbox + WebGPU + lavapipe ICD + rhi-wgpu shim
//       complete end-to-end chain via the Engine.create({ canvas, rhi })
//       escape hatch (charter proposition 5 + plan-strategy D-P5; the
//       rhi-wgpu shim sits next to rhi-webgpu and exercises the same
//       RhiInstance surface, so the chromium-real-path renderer build
//       through this code path proves the dual-impl boundary works on a
//       real browser V8 engine — not just dawn-node native binding).
//   (b) `renderer.backend === 'webgpu'` on the wgpu-wasm escape hatch
//       (the rhi-wgpu shim surfaces the same backend marker as rhi-webgpu
//       under chromium).
//   (c) AC-11 first-paint contract (wgpu wasm NOT in the default bundle):
//       this contract is enforced via the explicit-injection shape — the
//       only way the wgpu wasm bundle reaches the chromium V8 heap is
//       when the AI user opts in by injecting the rhi-wgpu instance.
//       The auto-select facade (D-P4) detects navigator.gpu and picks
//       rhi-webgpu without ever evaluating `import('@forgeax/engine-rhi-wgpu')`
//       (charter proposition 1 progressive disclosure).
//
// Charter mapping:
//   - proposition 4 (explicit failure): when navigator.gpu / chrome-beta
//     flags are missing, the test throws code: 'webgpu-unavailable' rather
//     than silently dropping to a webgl2 false-green.
//   - proposition 5 (consistent abstraction): the dual-impl boundary
//     produces the same backend contract on both shim implementations,
//     verified at the chromium real-path layer.
//   - proposition 6 (simulation coverage != real usability): dawn-node
//     direct run (smoke-wgpu-wasm.mjs) AND chromium real-path (this test)
//     run in parallel; either failing without the other constitutes a
//     real regression (plan-strategy D-P5 parallel-evidence stance).

import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { rhi as rhiWgpu } from '@forgeax/engine-rhi-wgpu';
import { afterEach, describe, expect, it } from 'vitest';

import { createRenderer } from '../src/createRenderer';

describe.skip('renderer-wgpu-wasm.browser - chromium real path with rhi-wgpu escape hatch (M4(b))', () => {
  let canvas: HTMLCanvasElement | undefined;
  let renderer: Renderer | undefined;

  afterEach(() => {
    renderer = undefined;
    canvas = undefined;
  });

  it('createRenderer({ canvas, rhi: rhiWgpu }) takes the wgpu-wasm escape hatch; backend webgpu', async () => {
    canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    document.body.appendChild(canvas);

    // pre-check: navigator.gpu must be available inside chromium for the
    // wgpu-wasm shim to bridge through its M2 baseline path (the shim's
    // requestAdapter routes through globalThis.navigator.gpu under the M2
    // baseline; the wasm-bindgen path lands in a later loop). If not, the
    // test fails with an explicit reason (charter proposition 4: silent
    // fallback to webgl2 must not turn AC-04 into a false green).
    if (typeof navigator.gpu === 'undefined') {
      throw new Error(
        "[renderer-wgpu-wasm.browser] code: 'webgpu-unavailable'; hint: WebGPU is not enabled in this browser; ci.yml injects via chrome-beta channel + --enable-unsafe-webgpu --enable-features=Vulkan + lavapipe ICD (ubuntu-latest); on local dev use chrome --enable-unsafe-webgpu",
      );
    }

    // Inject the rhi-wgpu instance through the Engine.create escape hatch
    // (D-R5 / D-P4 / plan-strategy section 7.4). The auto-select facade
    // would normally pick rhi-webgpu when navigator.gpu is available; the
    // explicit rhi parameter bypasses that and exercises the rhi-wgpu shim
    // through the chromium real path (charter proposition 5 + 6).
    const created = await createRenderer(canvas, {
            rhi: rhiWgpu,
    }, { shaderManifestUrl: 'data:application/json,{"entries":[]}' });
    if (!created.ok) throw created.error;
    renderer = created.value;

    expect(renderer.inspect().capabilities.backendKind).toBe('webgpu');

    const world = new World();
    // draw(world) must not throw under the wgpu-wasm escape hatch path
    // (charter proposition 6 enforced at the chromium V8 + lavapipe + wgpu
    // wasm boundary). A camera-free World returns a normal clear-only receipt.
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(() =>
      renderer?.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      }),
    ).not.toThrow();
  });
});
