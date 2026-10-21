// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { describe, expect, it, vi } from 'vitest';
import { assertStorageBufferCap } from '../../../render/src/light-buffer-layout';
import {
  buildPbrPipelineLayouts,
  buildPbrViewBglEntries,
  type PbrCaps,
} from '../../../render/src/pbr-pipeline';

vi.mock('@forgeax/engine-rhi-wgpu', () => {
  return {
    rhi: {
      requestAdapter: async () => ({
        ok: false,
        error: {
          code: 'adapter-unavailable',
          expected: 'adapter available',
          hint: 'default mock fail',
        },
      }),
      getPreferredCanvasFormat: () => 'bgra8unorm',
      acquireCanvasContext: () => ({
        ok: false,
        error: {
          code: 'webgpu-runtime-error',
          expected: 'context available',
          hint: 'default mock fail',
        },
      }),
    },
    ensureReady: async () => undefined,
  };
});
{
  // --- from create-renderer-uniform-fallback.test.ts ---
  const UNIFORM_CAPS: PbrCaps = { storageBuffer: false };
  const STORAGE_CAPS: PbrCaps = { storageBuffer: true };

  // ─── AC-07: Variant resolution signal ──────────────────────────────────────

  describe('w14 AC-07 — caps.storageBuffer=false variant resolution', () => {
    it('assertStorageBufferCap(0) signals uniform fallback (ok(false))', () => {
      const result = assertStorageBufferCap(0);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toBe(false);
    });

    it('buildPbrViewBglEntries with UNIFORM_CAPS has no local-light bindings', () => {
      const entries = buildPbrViewBglEntries(UNIFORM_CAPS);
      expect(entries.some((entry) => entry.binding === 1 || entry.binding === 2)).toBe(false);
    });

    it('buildPbrViewBglEntries with STORAGE_CAPS has no local-light bindings', () => {
      const entries = buildPbrViewBglEntries(STORAGE_CAPS);
      expect(entries.some((entry) => entry.binding === 1 || entry.binding === 2)).toBe(false);
    });
  });

  // ─── AC-09: createRenderer does not throw on caps===false ──────────────────

  describe('w14 AC-09 — createRenderer uniform fallback path', () => {
    it('assertStorageBufferCap does not throw for cap=0', () => {
      const result = assertStorageBufferCap(0);
      expect(result.ok).toBe(true);
    });

    it('assertStorageBufferCap(4) returns ok(true) — storage capable', () => {
      const result = assertStorageBufferCap(4);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.value).toBe(true);
    });

    it('assertStorageBufferCap(2) returns err — partial storage not valid', () => {
      const result = assertStorageBufferCap(2);
      expect(result.ok).toBe(false);
    });
  });

  // ─── Integration: pipeline layouts under both caps ─────────────────────────

  interface CapturedBgl {
    label: string | undefined;
    entries: readonly GPUBindGroupLayoutEntry[];
  }

  function makeMockDevice(): {
    capturedBgls: CapturedBgl[];
    createBindGroupLayout(desc: { label?: string; entries: readonly GPUBindGroupLayoutEntry[] }): {
      ok: true;
      value: { handleId: number };
    };
    createPipelineLayout(desc: {
      label?: string;
      bindGroupLayouts: readonly { handleId: number }[];
    }): { ok: true; value: { handleId: number } };
  } {
    const capturedBgls: CapturedBgl[] = [];
    let counter = 0;
    return {
      capturedBgls,
      createBindGroupLayout(desc) {
        capturedBgls.push({ label: desc.label, entries: desc.entries });
        return { ok: true, value: { handleId: ++counter } };
      },
      createPipelineLayout() {
        return { ok: true, value: { handleId: ++counter } };
      },
    };
  }

  describe('w14 — pipeline layout shape under uniform fallback vs storage', () => {
    it('uniform fallback: mesh-array BGL entry type is uniform', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildPbrPipelineLayouts(device as any, UNIFORM_CAPS);
      const meshBgl = device.capturedBgls.find((b) => b.label === 'pbr-mesh-array-bgl');
      expect(meshBgl).toBeDefined();
      expect(meshBgl?.entries[0]?.buffer?.type).toBe('uniform');
      expect(meshBgl?.entries[0]?.buffer?.hasDynamicOffset).toBe(true);
    });

    it('uniform fallback: instances BGL entry type is uniform', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildPbrPipelineLayouts(device as any, UNIFORM_CAPS);
      const instBgl = device.capturedBgls.find((b) => b.label === 'pbr-instances-bgl');
      expect(instBgl).toBeDefined();
      expect(instBgl?.entries[0]?.buffer?.type).toBe('uniform');
    });

    it('uniform fallback: view BGL has no local-light bindings', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildPbrPipelineLayouts(device as any, UNIFORM_CAPS);
      const viewBgl = device.capturedBgls.find((b) => b.label === 'pbr-view-bgl');
      expect(viewBgl).toBeDefined();
      expect(viewBgl?.entries.some((entry) => entry.binding === 1 || entry.binding === 2)).toBe(
        false,
      );
    });

    it('storage path: mesh-array BGL entry type is read-only-storage (regression guard)', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      const meshBgl = device.capturedBgls.find((b) => b.label === 'pbr-mesh-array-bgl');
      expect(meshBgl?.entries[0]?.buffer?.type).toBe('read-only-storage');
    });

    it('storage path: instances BGL entry type is read-only-storage (regression guard)', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      const instBgl = device.capturedBgls.find((b) => b.label === 'pbr-instances-bgl');
      expect(instBgl?.entries[0]?.buffer?.type).toBe('read-only-storage');
    });
  });
}
