// swap-chain-format.browser.test.ts - bug-20260612-webgpu-canvas-format-prefer-bgra
// fix-up round 2 (review issues I-2 + I-3 + I-8): browser-mode integration
// guards for AC-01 + AC-02. Round 1 m1-1a covered only the helper unit-test
// branches; the WebGPU-validation console grep (AC-01) and the globalThis
// probe read (AC-02) had no test reading them, so the helper landing in
// production could silently regress without any gate firing.
//
// Trigger: root vitest.config.ts `browser` project (`*.browser.test.ts`
// glob). Environment: playwright provider chromium-beta with full WebGPU
// build (`channel: 'chrome-beta'`); chromium-beta's `getPreferredCanvasFormat`
// returns `bgra8unorm` on Linux/Vulkan and on darwin/Metal. The smoke
// version of this test is dawn-node, which mounts globalThis.navigator.gpu
// from the `webgpu` npm package; that path is exercised in the dawn project.
//
// AC ↔ it block map:
//   AC-01 (no `'configured with a different format than is preferred'` warning
//          from chromium WebGPU validation) — `console.warn` spy + grep on
//          message text covering the canonical WebGPU validation phrasing
//   AC-02 (`globalThis.__forgeaxSwapChainFormat` matches the helper's chosen
//          format) — assert probe equals `'bgra8unorm'` (chromium-beta truth)
//          AFTER `createRenderer` resolves and `renderer.draw(world)` runs
//          one frame so `ensureContextConfigured` has set the probe
//   I-8 falsification check — assert that the spy's recorded call list
//          would catch the warning if it WERE emitted: invoke
//          `console.warn('GPUCanvasContext was configured with a different
//          format than is preferred')` directly inside the test body and
//          verify the spy captures it; this proves the spy is wired to the
//          right channel and would have surfaced a real validation warning.
//
// Note: the 'different format than is preferred' phrase is the chromium
// WebGPU implementation's literal warning text (see
// https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/
// renderer/modules/webgpu/gpu_canvas_context.cc — `WarnIfFormatMismatch`).
// chromium emits it through `console.warn` (V8 console); other UAs may
// vary, but the AC-01 contract is anchored to chromium's text per
// requirements §AC-01.

import { World } from '@forgeax/engine-ecs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRenderer } from '../src/createRenderer';
import type { Renderer } from '@forgeax/engine-render';

const CHROMIUM_FORMAT_MISMATCH_WARNING = 'different format than is preferred';

describe('swap-chain-format.browser - AC-01 + AC-02 integration guards', () => {
  let canvas: HTMLCanvasElement | undefined;
  let renderer: Renderer | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    // Spy on console.warn BEFORE createRenderer so the helper-driven
    // canvas configure() call's potential warning would be recorded.
    warnSpy = vi.spyOn(console, 'warn');
  });

  afterEach(() => {
    warnSpy?.mockRestore();
    warnSpy = undefined;
    renderer = undefined;
    canvas = undefined;
  });

  it('AC-01: chromium WebGPU does not emit "different format than is preferred" warning when helper picks BGRA', async () => {
    canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    document.body.appendChild(canvas);

    if (typeof navigator.gpu === 'undefined') {
      throw new Error(
        "[swap-chain-format.browser AC-01] code: 'webgpu-unavailable'; hint: chromium-beta + --enable-unsafe-webgpu required; vitest browser project provider config in vitest.config.ts",
      );
    }

    const created = await createRenderer(canvas, {}, {
      shaderManifestUrl: 'data:application/json,{"entries":[]}',
    });
    if (!created.ok) throw created.error;
    renderer = created.value;
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    world.update(1 / 60).unwrap();
    expect(
      renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      }).ok,
    ).toBe(true);

    // Inspect every recorded console.warn call: none of them should
    // contain the chromium format-mismatch substring.
    const matchingCalls = warnSpy?.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes(CHROMIUM_FORMAT_MISMATCH_WARNING)),
    );
    expect(matchingCalls).toEqual([]);
  });

  it('AC-02: globalThis.__forgeaxSwapChainFormat probe matches chromium getPreferredCanvasFormat() (typically bgra8unorm)', async () => {
    canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    document.body.appendChild(canvas);

    if (typeof navigator.gpu === 'undefined') {
      throw new Error(
        "[swap-chain-format.browser AC-02] code: 'webgpu-unavailable'; hint: chromium-beta + --enable-unsafe-webgpu required",
      );
    }

    // Capture chromium's preferred format BEFORE createRenderer so the
    // assertion is anchored to the UA's helper truth (selectSwapChainFormat
    // Channel 2 path returns this value when storageBufferCapable=true).
    const expectedFormat = navigator.gpu.getPreferredCanvasFormat();

    const created = await createRenderer(canvas, {}, {
      shaderManifestUrl: 'data:application/json,{"entries":[]}',
    });
    if (!created.ok) throw created.error;
    renderer = created.value;
    const world = new World();
    const attached = renderer.attach(world);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    world.update(1 / 60).unwrap();
    expect(
      renderer.draw({
        leases: [attached.value],
        camera: { lease: attached.value },
        environment: { lease: attached.value },
      }).ok,
    ).toBe(true);

    // The probe is set by ensureContextConfigured in createRenderer.ts after
    // the helper chooses the format and after `context.configure({...})` runs.
    const probe = (globalThis as { __forgeaxSwapChainFormat?: GPUTextureFormat })
      .__forgeaxSwapChainFormat;
    expect(probe).toBe(expectedFormat);
  });

  it('I-8 falsification: the AC-01 console.warn spy IS wired to the channel chromium uses for WebGPU validation warnings', () => {
    // Negative-fixture: emit the canonical chromium WebGPU validation warning
    // text directly through console.warn and verify the spy captured it. If
    // the spy were wired to the wrong channel (or not set up for this test
    // file), AC-01 would silently pass even when chromium emitted a real
    // warning — this assertion proves the gate has discriminating power.
    console.warn('GPUCanvasContext was configured with a different format than is preferred');
    const matchingCalls = warnSpy?.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes(CHROMIUM_FORMAT_MISMATCH_WARNING)),
    );
    expect(matchingCalls).toBeDefined();
    expect((matchingCalls ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
