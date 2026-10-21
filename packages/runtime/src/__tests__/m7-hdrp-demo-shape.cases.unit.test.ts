// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
// @ts-nocheck — merged file: cross-source node:fs/node:path imports outside @types/node coverage in runtime tsconfig
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
//
// Source files (N=33):
//   - packages/runtime/__tests__/create-renderer-fallback.test.ts
//   - packages/runtime/src/__tests__/cluster-binner.test.ts
//   - packages/runtime/src/__tests__/create-renderer-fallback-shader-manifest.test.ts
//   - packages/runtime/src/__tests__/create-renderer-uniform-fallback.test.ts
//   - packages/runtime/src/__tests__/createRenderer.test.ts
//   - packages/runtime/src/__tests__/dispatch-sort.test.ts
//   - packages/runtime/src/__tests__/engine-metrics.test.ts
//   - packages/runtime/src/__tests__/device/gpu-residency-caps-guard.test.ts
//   - packages/runtime/src/__tests__/pass-selector.test.ts
//   - packages/runtime/src/__tests__/pipeline-builder.test.ts
//   - packages/runtime/src/__tests__/pipeline-cache-key-topology.test.ts
//   - packages/runtime/src/__tests__/pipeline-rename-grep-gate.test.ts
//   - packages/runtime/src/__tests__/pipeline-vertex-stride-branch.test.ts
//   - packages/runtime/src/__tests__/post-process-register.test.ts
//   - packages/runtime/src/__tests__/record-all-topology.test.ts
//   - packages/runtime/src/__tests__/record-draw-branch.test.ts
//   - packages/runtime/src/__tests__/record-strip-index-format.test.ts
//   - packages/runtime/src/__tests__/render-query-regression.test.ts
//   - packages/runtime/src/__tests__/renderer-draw-world.test.ts
//   - packages/runtime/src/__tests__/renderer-input-snapshot.test.ts
//   - packages/runtime/src/__tests__/renderer-read-pixels.test.ts
//   - packages/runtime/src/__tests__/renderer-ready.test.ts
//   - packages/runtime/src/__tests__/renderstate-pipeline-cache.test.ts
//   - packages/runtime/src/__tests__/storage-buffer-caps.test.ts
//   - packages/runtime/src/__tests__/device/gpu-residency.test.ts
//   - packages/runtime/src/__tests__/render-data.test.ts
//   - packages/runtime/src/__tests__/hdrp-bgl-slots.test.ts
//   - packages/runtime/src/__tests__/hdrp-caps-gate.test.ts
//   - packages/runtime/src/__tests__/hdrp-grid-invalid.test.ts
//   - packages/runtime/src/__tests__/hdrp-index-list-overflow-once.test.ts
//   - packages/runtime/src/__tests__/hdrp-light-budget.test.ts
//   - packages/runtime/src/__tests__/hdrp-pipeline-asset-config.test.ts
//   - packages/runtime/src/__tests__/m7-hdrp-demo-shape.test.ts
//
// Paradigm: each block-scope wraps a source file. ancestorTitles[0] is the
// source-preserved inner describe (NOT the source filename for these 3 files
// — recovery path: vitest report ancestorTitles -> grep this file -> upstream
// `// ─── from <name>.test.ts ───` block separator -> source filename).
// Top-level imports merged + deduped.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

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
  // --- from m7-hdrp-demo-shape.test.ts ---
  const HERE = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
  const _FIVE_METRIC_KINDS = ['bundle-size', 'fps', 'bench', 'gate', 'spike-report'] as const;

  function _readPkg(rel: string): {
    forgeax?: { metrics?: Record<string, unknown>; smokeInvocation?: string };
    name?: string;
    scripts?: Record<string, string>;
  } {
    const path = resolve(REPO_ROOT, rel);
    expect(existsSync(path), `package.json missing: ${rel}`).toBe(true);
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  function readSource(rel: string): string {
    const path = resolve(REPO_ROOT, rel);
    expect(existsSync(path), `source missing: ${rel}`).toBe(true);
    return readFileSync(path, 'utf8');
  }

  describe('M7 pixel-parity bench wires urp-vs-hdrp target', () => {
    it('scripts/bench/pixel-parity.mjs has urp-vs-hdrp target marker', () => {
      const src = readSource('scripts/bench/pixel-parity.mjs');
      // The bench routes the new fixture through a `parity-urp-vs-hdrp`
      // target literal so the runner spawns the right preview port + URL.
      expect(src).toMatch(/parity-urp-vs-hdrp/);
    });
  });

  describe('M3 T-007 forgeax::default-shadow-caster registration (AC-09)', () => {
    it('findMaterialArtifact returns ok for forgeax::default-shadow-caster after makeMockShaderRegistry', () => {
      const sr = makeMockShaderRegistry();
      const result = sr.findMaterialArtifact('forgeax::default-shadow-caster');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.source).toBe('fn main() {}');
        expect(result.value.paramSchema).toEqual([]);
      }
    });
  });
}
