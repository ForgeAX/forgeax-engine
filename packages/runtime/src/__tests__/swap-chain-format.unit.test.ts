// --- from swap-chain-format.unit.test.ts ---

// bug-20260612 M1: unit tests for selectSwapChainFormat helper
// (4 branches + AC-08 srgb pairing).
//
// TDD red phase: selectSwapChainFormat is not yet implemented in the
// render-system surface owner; these assertions describe the expected contract.
// They will turn green in M2 when the helper lands.

// The helper is exported from render-system.ts module scope (not from the
// public package index — module-private to the runtime, marked @internal).
import { describe, expect, it, vi } from 'vitest';
import { selectSwapChainFormat } from '../../../render/src/render-system';

describe('bug-20260612: selectSwapChainFormat', () => {
  describe('Channel 2 (storageBufferCapable = true)', () => {
    it('returns bgra8unorm / bgra8unorm-srgb when getPreferredCanvasFormat returns bgra8unorm', () => {
      // Simulate Chromium / Edge / Safari UA preference.
      const mockNavigator = {
        gpu: { getPreferredCanvasFormat: () => 'bgra8unorm' as unknown as GPUTextureFormat },
      } as unknown as Navigator;
      vi.stubGlobal('navigator', mockNavigator);
      try {
        const result = selectSwapChainFormat(true);
        expect(result.storage).toBe('bgra8unorm');
        expect(result.view).toBe('bgra8unorm-srgb');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('returns rgba8unorm / rgba8unorm-srgb when getPreferredCanvasFormat returns rgba8unorm', () => {
      // Simulate a UA or configuration that prefers rgba8unorm.
      const mockNavigator = {
        gpu: { getPreferredCanvasFormat: () => 'rgba8unorm' as unknown as GPUTextureFormat },
      } as unknown as Navigator;
      vi.stubGlobal('navigator', mockNavigator);
      try {
        const result = selectSwapChainFormat(true);
        expect(result.storage).toBe('rgba8unorm');
        expect(result.view).toBe('rgba8unorm-srgb');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // AC-08: storage / view pairing sanity — each branch must pair
    // storage-srgb as view format.
    it('AC-08: view format is always storage + "-srgb" (Channel 2)', () => {
      const formats = ['bgra8unorm', 'rgba8unorm'] as unknown as GPUTextureFormat[];
      for (const fmt of formats) {
        const mockNavigator = {
          gpu: { getPreferredCanvasFormat: () => fmt },
        } as unknown as Navigator;
        vi.stubGlobal('navigator', mockNavigator);
        try {
          const result = selectSwapChainFormat(true);
          expect(result.view).toBe(`${result.storage}-srgb`);
        } finally {
          vi.unstubAllGlobals();
        }
      }
    });

    it('falls back to rgba8unorm when getPreferredCanvasFormat function is missing', () => {
      // Plan D-2: navigator.gpu exists but getPreferredCanvasFormat
      // is not a function (very old UA).
      const mockNavigator = {
        gpu: {} as unknown,
      } as unknown as Navigator;
      vi.stubGlobal('navigator', mockNavigator);
      try {
        const result = selectSwapChainFormat(true);
        expect(result.storage).toBe('rgba8unorm');
        expect(result.view).toBe('rgba8unorm-srgb');
        // AC-08: view = storage + '-srgb'
        expect(result.view).toBe(`${result.storage}-srgb`);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('Channel 3 (storageBufferCapable = false)', () => {
    it('returns rgba8unorm / rgba8unorm-srgb (wgpu GLES hard constraint)', () => {
      // Channel 3 GLES fallback path — navigator.gpu presence is
      // irrelevant; the boolean flag alone drives the choice.
      const result = selectSwapChainFormat(false);
      expect(result.storage).toBe('rgba8unorm');
      expect(result.view).toBe('rgba8unorm-srgb');
      // AC-08: view = storage + '-srgb'
      expect(result.view).toBe(`${result.storage}-srgb`);
    });
  });

  describe('fallback: navigator.gpu undefined', () => {
    it('returns rgba8unorm when navigator.gpu is undefined', () => {
      // Plan D-4: simulate WebGPU-unavailable environment.
      // even with storageBufferCapable=true, missing navigator.gpu
      // should fall back to the safe Channel-3-compatible value.
      const origGpu = (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;
      try {
        delete (globalThis as { navigator?: { gpu?: unknown } }).navigator?.gpu;
        const result = selectSwapChainFormat(true);
        expect(result.storage).toBe('rgba8unorm');
        expect(result.view).toBe('rgba8unorm-srgb');
        expect(result.view).toBe(`${result.storage}-srgb`);
      } finally {
        if (origGpu !== undefined) {
          (globalThis as { navigator: { gpu: unknown } }).navigator.gpu = origGpu;
        }
      }
    });
  });
});
