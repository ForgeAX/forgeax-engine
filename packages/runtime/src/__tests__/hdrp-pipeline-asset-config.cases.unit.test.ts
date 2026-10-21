// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import type { RenderPipelineAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
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
  // ── M3 / w12 (round-1) + M7 / w28+w31 (round-2)
  //   + scope-amend-webgl2-ubo (intensity folded into binding 6 .w lane,
  //     dedicated @binding(9) UBO removed) ────────────────────────────────
  //
  // BGL 7-entry descriptor: 5 cluster slots (binding 0 + 3..6) + 2 SSAO
  // slots (binding 7..8, plan-strategy D-B). Intensity flows via
  // cluster_uniform.near_far_log.w (binding 6). Round-2 absorbs fixture
  // into the SSAO bind-group test file — see __tests__/ssao-bgl.test.ts;
  // the assertions below remain for cluster-side regression coverage.

  describe('HDRP unified BGL 7-slot descriptor (w12 + w28)', () => {
    it('entries.length === 7 (binding 0 + 3..6 + 7..8; 1, 2, 9 absent)', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      expect(desc.entries?.length).toBe(7);
    });

    it('binding 0 is mesh SSBO with dynamic offset', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const b0 = desc.entries?.find((e) => e.binding === 0);
      expect(b0).toBeDefined();
      expect(b0?.visibility).toBeDefined();
      expect(b0?.buffer?.type).toBe('read-only-storage');
      expect(b0?.buffer?.hasDynamicOffset).toBe(true);
    });

    it('binding 3 is light_data storage', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const b3 = desc.entries?.find((e) => e.binding === 3);
      expect(b3).toBeDefined();
      expect(b3?.buffer?.type).toBe('read-only-storage');
      expect(b3?.buffer?.hasDynamicOffset).toBe(false);
    });

    it('binding 4 is cluster_grid storage', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const b4 = desc.entries?.find((e) => e.binding === 4);
      expect(b4).toBeDefined();
      expect(b4?.buffer?.type).toBe('read-only-storage');
      expect(b4?.buffer?.hasDynamicOffset).toBe(false);
    });

    it('binding 5 is light_index_list storage', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const b5 = desc.entries?.find((e) => e.binding === 5);
      expect(b5).toBeDefined();
      expect(b5?.buffer?.type).toBe('read-only-storage');
      expect(b5?.buffer?.hasDynamicOffset).toBe(false);
    });

    it('binding 6 is cluster_uniform uniform', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const b6 = desc.entries?.find((e) => e.binding === 6);
      expect(b6).toBeDefined();
      expect(b6?.buffer?.type).toBe('uniform');
      expect(b6?.buffer?.hasDynamicOffset).toBe(false);
    });

    it('binding 1 and 2 are absent', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const bindings = desc.entries?.map((e) => e.binding);
      expect(bindings).not.toContain(1);
      expect(bindings).not.toContain(2);
    });

    it('all bindings are in group 2 (shader group)', () => {
      const desc = createHdrpBindGroupLayoutDescriptor();
      expect(desc.entries).toBeDefined();
      const bindings = new Set(desc.entries?.map((e) => e.binding));
      expect(bindings).toEqual(new Set([0, 3, 4, 5, 6, 7, 8]));
    });
  });
}
