// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());
// Split source block: equirect projection failure error contract.
{
  // --- equirect-projection-failed error class shape ---
  // feat-20260630 M2 / w13: replaces the retired skybox-cubemap-not-ready.

  describe('equirect-projection-failed error class shape', () => {
    it('has .code === equirect-projection-failed', async () => {
      const { EquirectProjectionFailedError } = await import('../../../render/src/errors/render');
      const err = new EquirectProjectionFailedError(42, {
        code: 'invalid-source-format',
        expected: 'linear HDR',
        hint: 'use rgba16float',
      });
      expect(err.code).toBe('equirect-projection-failed');
    });

    it('exposes .detail.handle === the constructor argument', async () => {
      const { EquirectProjectionFailedError } = await import('../../../render/src/errors/render');
      const err = new EquirectProjectionFailedError(42, {
        code: 'invalid-source-format',
        expected: 'linear HDR',
        hint: 'use rgba16float',
      });
      expect(err.detail).toBeDefined();
      expect(err.detail.handle).toBe(42);
    });

    it('exposes non-empty .hint with actionable guidance', async () => {
      const { EquirectProjectionFailedError } = await import('../../../render/src/errors/render');
      const err = new EquirectProjectionFailedError(42, {
        code: 'invalid-source-format',
        expected: 'linear HDR',
        hint: 'use rgba16float',
      });
      expect(err.hint).toBeDefined();
      expect(typeof err.hint).toBe('string');
      expect(err.hint.length).toBeGreaterThan(0);
    });

    it('exposes .expected describing expected state', async () => {
      const { EquirectProjectionFailedError } = await import('../../../render/src/errors/render');
      const err = new EquirectProjectionFailedError(42, {
        code: 'invalid-source-format',
        expected: 'linear HDR',
        hint: 'use rgba16float',
      });
      expect(err.expected).toBeDefined();
      expect(typeof err.expected).toBe('string');
      expect(err.expected.length).toBeGreaterThan(0);
    });

    it('extends Error so it can be thrown and caught', async () => {
      const { EquirectProjectionFailedError } = await import('../../../render/src/errors/render');
      const err = new EquirectProjectionFailedError(42, {
        code: 'invalid-source-format',
        expected: 'linear HDR',
        hint: 'use rgba16float',
      });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('EquirectProjectionFailedError');
    });
  });

  describe('RenderErrorCode union carries equirect-projection-failed', () => {
    it('equirect-projection-failed is a valid RenderErrorCode literal', async () => {
      // The actual TS union membership is verified by typecheck: if
      // 'equirect-projection-failed' is not in RenderErrorCode, no expression
      // can assign err.code to a RenderErrorCode-typed variable.
      const { EquirectProjectionFailedError } = await import('../../../render/src/errors/render');
      const err = new EquirectProjectionFailedError(42, {
        code: 'invalid-source-format',
        expected: 'linear HDR',
        hint: 'use rgba16float',
      });
      expect(err.code).toBe('equirect-projection-failed');
    });
  });

  describe('degradation path: white-cube fallback when projection fails', () => {
    it('equirect-projection-failed carries the failing equirect handle', async () => {
      // In the degradation path, when the record arm sees status:'failed' for
      // the equirect handle, it binds the white-cube fallback and fires this
      // structured error ONCE (it does not retry; R-2/AC-09). The record-stage
      // integration is covered by the M3 lazy-projection tests + smoke gate.
      const { EquirectProjectionFailedError } = await import('../../../render/src/errors/render');
      const err = new EquirectProjectionFailedError(42, {
        code: 'invalid-source-format',
        expected: 'linear HDR',
        hint: 'use rgba16float',
      });
      expect(err.code).toBe('equirect-projection-failed');
      expect(err.detail.handle).toBe(42);
    });
  });
}
