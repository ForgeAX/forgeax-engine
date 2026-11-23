// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { RenderPipelineAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { clusterViewLayoutEntries } from '../../../render/src/environment/bindings';
import { createHdrpBindGroupLayoutDescriptor } from '../../../render/src/pipeline-spec';

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
  // --- from hdrp-pipeline-asset-config.test.ts ---
  describe('hdrp pipeline asset config', () => {
    it('creates a RenderPipelineAsset with HDRP pipelineId and clusterGrid config', () => {
      const asset: RenderPipelineAsset = {
        kind: 'render-pipeline',
        pipelineId: 'forgeax::hdrp',
        config: {
          clusterGrid: { x: 16, y: 9, z: 24 },
        },
      };

      expect(asset.pipelineId).toBe('forgeax::hdrp');
      expect(asset.kind).toBe('render-pipeline');
      expect(asset.config?.clusterGrid).toBeDefined();
      expect(asset.config?.clusterGrid?.x).toBe(16);
      expect(asset.config?.clusterGrid?.y).toBe(9);
      expect(asset.config?.clusterGrid?.z).toBe(24);
    });

    it('creates a RenderPipelineAsset with URP pipelineId and no clusterGrid', () => {
      const asset: RenderPipelineAsset = {
        kind: 'render-pipeline',
        pipelineId: 'forgeax::urp',
      };

      expect(asset.pipelineId).toBe('forgeax::urp');
      expect(asset.config?.clusterGrid).toBeUndefined();
    });

    it('passCount field is still supported alongside clusterGrid', () => {
      const asset: RenderPipelineAsset = {
        kind: 'render-pipeline',
        pipelineId: 'forgeax::hdrp',
        config: {
          passCount: 3,
          clusterGrid: { x: 16, y: 9, z: 24 },
        },
      };

      expect(asset.config?.passCount).toBe(3);
      expect(asset.config?.clusterGrid).toBeDefined();
    });
  });
  describe('HDRP Primitive and View layout ownership', () => {
    it('keeps only the dynamic geometry buffer in the base Primitive layout', () => {
      expect(createHdrpBindGroupLayoutDescriptor().entries).toEqual([
        expect.objectContaining({
          binding: 0,
          buffer: expect.objectContaining({ type: 'read-only-storage', hasDynamicOffset: true }),
        }),
      ]);
    });

    it('separates Cluster storage and parameters in the View layout', () => {
      const entries = clusterViewLayoutEntries(true);
      expect(entries.map(({ binding }) => binding)).toEqual([30, 31, 32, 33]);
      expect(entries.map(({ buffer }) => buffer?.type)).toEqual([
        'read-only-storage',
        'read-only-storage',
        'read-only-storage',
        'uniform',
      ]);
      expect(entries.every(({ buffer }) => buffer?.hasDynamicOffset !== true)).toBe(true);
    });
  });
}
