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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

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
  // --- from create-renderer-fallback-shader-manifest.test.ts ---
  const CREATE_RENDERER_SRC = fileURLToPath(
    new URL('../../../render/src/assembly/webgpu-renderer.ts', import.meta.url),
  );

  describe('createRenderer fallback shaderManifestUrl literal (AC-08, D-2 q5-A)', () => {
    it("preserves the '/shaders/manifest.json' default in createRenderer.ts", () => {
      const source = readFileSync(CREATE_RENDERER_SRC, 'utf8');
      // The literal fallback expression is the SSOT: when bundler.shaderManifestUrl
      // is absent and the explicit options.shaderManifestUrl key is not present,
      // the fallback resolves to '/shaders/manifest.json'. Locking the literal
      // here means a future drift (e.g. someone moves it into a constant or
      // changes the path) shows up as a clear test failure pointing at this AC.
      expect(source).toContain("'/shaders/manifest.json'");
    });

    it('references the fallback through the bundler third arg, not RendererOptions', () => {
      const source = readFileSync(CREATE_RENDERER_SRC, 'utf8');
      // After M2, the explicit slot is read from the third-arg BundlerOptions.
      // The grep below pins the contract: BundlerOptions carries the field, and
      // the createRenderer body looks up `bundler.shaderManifestUrl` (or the
      // legacy explicit slot via `'shaderManifestUrl' in bundler`).
      expect(source).toMatch(/bundler\??\.shaderManifestUrl/);
    });
  });
}
