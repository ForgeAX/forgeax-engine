// create-renderer-smoke-ac02.browser-no-webgpu.test.ts — AC-02 browser test for
// bug-20260528-rhi-wgpu-webgl-fallback-broken-when-navigator-gpu-i.
//
// This browser test validates AC-02: when navigator.gpu is absent (chromium
// launched without --enable-unsafe-webgpu), createRenderer either succeeds via
// Channel 3 (rhi-wgpu wasm with internal WebGL2 backend) OR throws a loud
// EngineEnvironmentError. Both outcomes are acceptable; the test's primary
// assertion is "no silent no-op" (the deleted Channel 4 WebGL2 stub behavior).
//
// AC-02 smoke deferral note (RK-4): A dawn-node smoke variant cannot exercise
// the real WebGL2 rendering surface because CI's lavapipe driver provides
// Vulkan, not GL. This browser test runs in Chrome Beta (real browser engine)
// and covers the createRenderer resolution path without navigator.gpu. A full
// 60-frame navigator.gpu-absent smoke script is deferred-to-PR per
// plan-strategy RK-4.

import { createRenderer, EngineEnvironmentError } from '@forgeax/engine-runtime';
import { describe, expect, it } from 'vitest';

describe('createRenderer smoke AC-02 — navigator.gpu absent browser integration', () => {
  it('navigator.gpu is absent or non-functional in this browser environment (pre-check)', async () => {
    const nav = globalThis.navigator as { gpu?: GPU };
    if (nav.gpu === undefined) return;
    const adapter = await nav.gpu.requestAdapter();
    expect(adapter).toBeNull();
  });

  it('AC-02: createRenderer either succeeds (Channel 3) or returns EngineEnvironmentError — never returns a no-op renderer', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;

    const result = await createRenderer(canvas);
    if (result.ok) {
      // Channel 3 succeeded (rhi-wgpu wasm with internal webgl backend).
      // Verify it is a real renderer, not a no-op stub.
      expect(result.value.inspect().capabilities.backendKind).toBe('webgpu');
      expect(typeof result.value.draw).toBe('function');
      // The old channel 4 stub would have set rhiAvailable=false on the
      // renderer — verify that property does not exist or is not false.
      const rendererAny = result.value as unknown as Record<string, unknown>;
      expect(rendererAny.rhiAvailable).not.toBe(false);
      result.value.dispose();
      return;
    }
    // Channel 3 failed — acceptable in headless CI without a real GPU
    // context. The critical assertion: the error MUST be an
    // EngineEnvironmentError (loud, structured failure), not a silent
    // swallow that returns a no-op renderer.
    expect(result.error).toBeInstanceOf(EngineEnvironmentError);
    if (result.error instanceof EngineEnvironmentError) {
      // Verify the structured detail is populated so AI consumers can
      // diagnose the failure (charter P4 explicit failure).
      expect(result.error.reason).toBeTruthy();
      const hasWebgpu = result.error.detail.webgpuError !== undefined;
      const hasWgpu = result.error.detail.wgpuError !== undefined;
      expect(hasWebgpu || hasWgpu).toBe(true);
    }
  });
});
