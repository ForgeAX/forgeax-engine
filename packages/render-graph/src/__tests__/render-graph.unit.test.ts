// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=7):
//   - packages/render-graph/src/__tests__/pass-order.test.ts
//   - packages/render-graph/src/__tests__/bloom-topo.test.ts
//   - packages/render-graph/src/__tests__/compile-fail-fast.test.ts
//   - packages/render-graph/src/__tests__/errors.test.ts
//   - packages/render-graph/src/__tests__/list-passes-resources.test.ts
//   - packages/render-graph/src/__tests__/resource-allocation.test.ts
//   - packages/render-graph/src/__tests__/uniform-fallback.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { RAY_QUERY_BACKEND_UNSUPPORTED } from '@forgeax/engine-rhi';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { describe, expect, it, vi } from 'vitest';
import type { CapMissingDetail, DanglingReadDetail, DuplicateResourceDetail } from '../errors.js';
import { err, ok, RenderGraphError, type RenderGraphErrorCode } from '../errors.js';
import { RenderGraph } from '../graph.js';

{
  describe('color domain compile contract', () => {
    const caps = { compute: true, storageBuffer: true } as never;

    function graphWithTargets(sourceDomain: unknown, destinationDomain: unknown): RenderGraph {
      const graph = new RenderGraph();
      graph.addColorTarget('source', {
        format: 'rgba16float',
        size: { w: 1, h: 1 },
        domain: sourceDomain,
      } as never);
      graph.addColorTarget('destination', {
        format: 'rgba8unorm',
        size: { w: 1, h: 1 },
        domain: destinationDomain,
      } as never);
      graph.addPass('source-seed', { reads: [], writes: ['source'] });
      return graph;
    }

    it('rejects a domain connection when the source domain is unknown', () => {
      const graph = graphWithTargets('gamma-magic', 'linear-ldr');
      graph.addPass('blend', {
        reads: ['source'],
        writes: ['destination'],
        colorConnections: [{ source: 'source', destination: 'destination' }],
      } as never);

      const result = graph.compile({ backendKind: 'null', caps });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected invalid color domain');
      expect(result.error.code).toBe('invalid-color-domain');
    });

    it('rejects a connection whose destination domain is missing', () => {
      const graph = graphWithTargets('linear-ldr', undefined);
      graph.addPass('blend', {
        reads: ['source'],
        writes: ['destination'],
        colorConnections: [{ source: 'source', destination: 'destination' }],
      } as never);

      const result = graph.compile({ backendKind: 'null', caps });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected missing color domain');
      expect(result.error.code).toBe('missing-color-domain');
      expect(result.error.hint).toContain('domain');
    });

    it('rejects an implicit linear-to-encoded connection', () => {
      const graph = graphWithTargets('linear-ldr', 'display-encoded');
      graph.addPass('blend', {
        reads: ['source'],
        writes: ['destination'],
        colorConnections: [{ source: 'source', destination: 'destination' }],
      } as never);

      const result = graph.compile({ backendKind: 'null', caps });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a domain mismatch');
      expect(result.error.code).toBe('color-domain-mismatch');
      expect(result.error.expected).toContain('explicit');
    });

    it('accepts an explicit output encoding connection', () => {
      const graph = graphWithTargets('linear-ldr', 'display-encoded');
      graph.addPass('encode', {
        reads: ['source'],
        writes: ['destination'],
        colorConnections: [
          {
            source: 'source',
            destination: 'destination',
            conversion: { kind: 'encode-srgb' },
          },
        ],
      } as never);

      const result = graph.compile({ backendKind: 'null', caps });
      expect(result.ok).toBe(true);
    });

    it('preserves explicit domain separately from format and view metadata', () => {
      const graph = graphWithTargets('display-encoded', 'display-encoded');
      graph.addPass('present', {
        reads: ['source'],
        writes: ['destination'],
        colorConnections: [{ source: 'source', destination: 'destination' }],
      } as never);
      const result = graph.compile({ backendKind: 'null', caps });
      expect(result.ok).toBe(true);
      expect(graph.listResources().map((resource) => resource.key)).toEqual([
        'source',
        'destination',
      ]);
    });
  });

  describe('whole-graph retirement', () => {
    it('relinquishes transient and persistent targets before GPU completion, then reclaims both', async () => {
      const destroyed: object[] = [];
      let resolveSubmittedWork: (() => void) | undefined;
      const submittedWork = new Promise<void>((resolve) => {
        resolveSubmittedWork = resolve;
      });
      const device = {
        createTexture: () => ({ ok: true as const, value: { id: 'transient' } }),
        createTextureView: () => ({ ok: true as const, value: { id: 'view' } }),
        destroyTexture: (texture: object) => {
          destroyed.push(texture);
          return { ok: true as const, value: undefined };
        },
        queue: { onSubmittedWorkDone: () => submittedWork },
      };
      const g = new RenderGraph();
      g.addColorTarget('transient', {
        format: 'rgba16float',
        size: 'swapchain',
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['transient'] });
      const compiled = g.compile({
        backendKind: 'webgpu',
        caps: {
          backendKind: 'webgpu',
          compute: true,
          storageBuffer: true,
          storageTexture: false,
          timestampQuery: false,
          timestampPeriodNanoseconds: null,
          indirectDrawing: false,
          textureCompressionBc: false,
          textureCompressionEtc2: false,
          textureCompressionAstc: false,
          multiDrawIndirect: false,
          pushConstants: false,
          textureBindingArray: false,
          samplerAliasing: true,
          firstInstanceIndirect: false,
          rgba16floatRenderable: false,
          rg11b10ufloatRenderable: false,
          float32Filterable: false,
          textureImport: false,
          externalTexture: false,
          maxColorAttachments: 8,
          rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
        },
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: device as any,
      });
      expect(compiled.ok).toBe(true);

      const persistentTexture = { id: 'persistent' };
      const graphInternals = g as unknown as {
        persistentTextures: Map<string, { texture: object; view: object }>;
        transientPool: Map<string, { texture: object; view: object }>;
        retire?: () => void;
      };
      graphInternals.persistentTextures.set('persistent', {
        texture: persistentTexture,
        view: { id: 'persistent-view' },
      });

      expect(graphInternals.retire).toBeTypeOf('function');
      if (graphInternals.retire === undefined) return;
      graphInternals.retire();

      expect(graphInternals.transientPool).toHaveLength(0);
      expect(graphInternals.persistentTextures).toHaveLength(0);
      expect(destroyed).toEqual([]);

      const reclaimed = g.reclaimRetiredTransients();
      await Promise.resolve();
      expect(destroyed).toEqual([]);
      resolveSubmittedWork?.();
      await reclaimed;

      expect(destroyed).toHaveLength(2);
      expect(destroyed).toContain(persistentTexture);
    });
  });
}

{
  // --- from pass-order.test.ts ---
  // ── Helpers ──────────────────────────────────────────────────────

  function mockCaps() {
    return {
      backendKind: 'webgpu' as const,
      compute: true,
      storageBuffer: true,
      storageTexture: false,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      indirectDrawing: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      rgba16floatRenderable: false,
      rg11b10ufloatRenderable: false,
      float32Filterable: false,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
    };
  }

  // ── Per-frame pass order ─────────────────────────────────────────
  //
  // feat-20260529-rendergraph-pass-abstraction M4 / w14. Mirrors the EXACT
  // reads/writes the runtime declares for the per-frame passes so the
  // integration-level declaration order is asserted on the real shape:
  //   shadow  : reads []                 writes ['shadowDepth']
  //   main    : reads ['shadowDepth']    writes ['hdrColor', 'depth']
  //   tonemap : reads ['hdrColor']       writes []
  //   fxaa    : reads []                 writes ['fxaaIntermediate']

  function buildPerFrameGraph() {
    const g = new RenderGraph();
    g.addResource('depth', { kind: 'texture', lifetime: 'persistent' });
    g.addResource('shadowDepth', { kind: 'texture', lifetime: 'persistent' });
    g.addResource('fxaaIntermediate', { kind: 'texture', lifetime: 'transient' });
    g.addResource('hdrColor', { kind: 'texture', lifetime: 'transient' });
    g.addPass('shadow', { reads: [], writes: ['shadowDepth'] });
    g.addPass('main', { reads: ['shadowDepth'], writes: ['hdrColor', 'depth'] });
    g.addPass('tonemap', { reads: ['hdrColor'], writes: [] });
    g.addPass('fxaa', { reads: [], writes: ['fxaaIntermediate'] });
    return g;
  }

  describe('per-frame pass order', () => {
    it('executes compiled pass closures in declaration order', () => {
      const calls: string[] = [];
      const g = new RenderGraph<{ readonly frame: number }>();
      g.addResource('X', { kind: 'texture', lifetime: 'transient' });
      g.addPass('producer', {
        reads: [],
        writes: ['X'],
        execute: () => calls.push('producer'),
      });
      g.addPass('consumer', {
        reads: ['X'],
        writes: [],
        execute: () => calls.push('consumer'),
      });

      const compiled = g.compile({ backendKind: 'webgpu', caps: mockCaps() });
      expect(compiled.ok).toBe(true);
      const executedPasses: string[] = [];
      g.execute({ frame: 1 }, (name, run) => {
        executedPasses.push(name);
        run();
      });

      expect(calls).toEqual(['producer', 'consumer']);
      expect(executedPasses).toEqual(['producer', 'consumer']);
    });

    it('preserves shadow -> main pass ordering (shadow before main in compiled order)', () => {
      const r = buildPerFrameGraph().compile({ backendKind: 'wgpu-native', caps: mockCaps() });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const order = r.value.passes.map((p) => p.name);
      expect(order.indexOf('shadow')).toBeLessThan(order.indexOf('main'));
      expect(order.indexOf('main')).toBeLessThan(order.indexOf('tonemap'));
    });
  });
}

{
  // --- from bloom-topo.test.ts ---
  // ── Helpers ──────────────────────────────────────────────────────

  function mockCaps() {
    return {
      backendKind: 'webgpu' as const,
      compute: true,
      storageBuffer: true,
      storageTexture: false,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      indirectDrawing: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      rgba16floatRenderable: false,
      rg11b10ufloatRenderable: false,
      float32Filterable: false,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
    };
  }

  // ── Bloom declaration-order assertion ────────────────────────────

  describe('bloom graph topology (feat-20260531-bloom)', () => {
    it('compiles an 8-pass graph with bloom resources without error', () => {
      const g = new RenderGraph();
      g.addResource('depth', { kind: 'texture', lifetime: 'persistent' });
      g.addResource('shadowDepth', { kind: 'texture', lifetime: 'persistent' });
      g.addResource('fxaaIntermediate', { kind: 'texture', lifetime: 'transient' });
      g.addResource('hdrColor', { kind: 'texture', lifetime: 'transient' });
      g.addResource('hdrComposited', { kind: 'texture', lifetime: 'transient' });
      g.addResource('bloomDownsample0', { kind: 'texture', lifetime: 'transient' });
      g.addResource('bloomDownsample1', { kind: 'texture', lifetime: 'transient' });
      g.addResource('bloomUpsample0', { kind: 'texture', lifetime: 'transient' });
      g.addPass('shadow', { reads: [], writes: ['shadowDepth'] });
      g.addPass('main', { reads: ['shadowDepth'], writes: ['hdrColor', 'depth'] });
      g.addPass('bloom-downsample-0', { reads: ['hdrColor'], writes: ['bloomDownsample0'] });
      g.addPass('bloom-downsample-1', {
        reads: ['bloomDownsample0'],
        writes: ['bloomDownsample1'],
      });
      g.addPass('bloom-upsample-0', { reads: ['bloomDownsample1'], writes: ['bloomUpsample0'] });
      g.addPass('bloom-composite', {
        reads: ['hdrColor', 'bloomUpsample0'],
        writes: ['hdrComposited'],
      });
      g.addPass('tonemap', { reads: ['hdrComposited'], writes: [] });
      g.addPass('fxaa', { reads: [], writes: ['fxaaIntermediate'] });

      const r = g.compile({ backendKind: 'webgpu', caps: mockCaps() });
      expect(r.ok).toBe(true);
    });

    it('places composite before tonemap (writes hdrComposited -> tonemap reads hdrComposited)', () => {
      const g = new RenderGraph();
      g.addResource('hdrColor', { kind: 'texture', lifetime: 'transient' });
      g.addResource('hdrComposited', { kind: 'texture', lifetime: 'transient' });
      g.addResource('bloomUpsample0', { kind: 'texture', lifetime: 'transient' });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });
      g.addPass('bloom-upsample-0', { reads: [], writes: ['bloomUpsample0'] });
      g.addPass('bloom-composite', {
        reads: ['hdrColor', 'bloomUpsample0'],
        writes: ['hdrComposited'],
      });
      g.addPass('tonemap', { reads: ['hdrComposited'], writes: [] });

      const r = g.compile({ backendKind: 'webgpu', caps: mockCaps() });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const order = r.value.passes.map((p) => p.name);
      const compIdx = order.indexOf('bloom-composite');
      const tonemapIdx = order.indexOf('tonemap');
      expect(compIdx).toBeLessThan(tonemapIdx);
    });

    it('preserves bloom chain order: downsample-0 < downsample-1 < upsample-0 < composite', () => {
      const g = new RenderGraph();
      g.addResource('hdrColor', { kind: 'texture', lifetime: 'transient' });
      g.addResource('hdrComposited', { kind: 'texture', lifetime: 'transient' });
      g.addResource('bloomDownsample0', { kind: 'texture', lifetime: 'transient' });
      g.addResource('bloomDownsample1', { kind: 'texture', lifetime: 'transient' });
      g.addResource('bloomUpsample0', { kind: 'texture', lifetime: 'transient' });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });
      g.addPass('bloom-downsample-0', { reads: ['hdrColor'], writes: ['bloomDownsample0'] });
      g.addPass('bloom-downsample-1', {
        reads: ['bloomDownsample0'],
        writes: ['bloomDownsample1'],
      });
      g.addPass('bloom-upsample-0', { reads: ['bloomDownsample1'], writes: ['bloomUpsample0'] });
      g.addPass('bloom-composite', {
        reads: ['hdrColor', 'bloomUpsample0'],
        writes: ['hdrComposited'],
      });

      const r = g.compile({ backendKind: 'webgpu', caps: mockCaps() });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const order = r.value.passes.map((p) => p.name);
      const downsample0Idx = order.indexOf('bloom-downsample-0');
      const downsample1Idx = order.indexOf('bloom-downsample-1');
      const upsample0Idx = order.indexOf('bloom-upsample-0');
      const compIdx = order.indexOf('bloom-composite');
      expect(downsample0Idx).toBeLessThan(downsample1Idx);
      expect(downsample1Idx).toBeLessThan(upsample0Idx);
      expect(upsample0Idx).toBeLessThan(compIdx);
    });

    it('uses hdrComposited to make the temporal version explicit', () => {
      // bloom-downsample-0 reads the hdrColor version written by main.
      // bloom-composite reads hdrColor + bloomUpsample0, writes hdrComposited.
      // tonemap reads hdrComposited.
      // The chain: main -> downsample-0 -> downsample-1 -> upsample-0 -> composite -> tonemap.
      // The hdrComposited resource name makes the post-composite version explicit while keeping the real
      // GPU texture the same hdrColor slot (composite writes in-place, tonemap
      // reads from it).
      const g = new RenderGraph();
      g.addResource('hdrColor', { kind: 'texture', lifetime: 'transient' });
      g.addResource('hdrComposited', { kind: 'texture', lifetime: 'transient' });
      g.addResource('bloomDownsample0', { kind: 'texture', lifetime: 'transient' });
      g.addResource('bloomDownsample1', { kind: 'texture', lifetime: 'transient' });
      g.addResource('bloomUpsample0', { kind: 'texture', lifetime: 'transient' });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });
      g.addPass('bloom-downsample-0', { reads: ['hdrColor'], writes: ['bloomDownsample0'] });
      g.addPass('bloom-downsample-1', {
        reads: ['bloomDownsample0'],
        writes: ['bloomDownsample1'],
      });
      g.addPass('bloom-upsample-0', { reads: ['bloomDownsample1'], writes: ['bloomUpsample0'] });
      g.addPass('bloom-composite', {
        reads: ['hdrColor', 'bloomUpsample0'],
        writes: ['hdrComposited'],
      });
      g.addPass('tonemap', { reads: ['hdrComposited'], writes: [] });

      const r = g.compile({ backendKind: 'webgpu', caps: mockCaps() });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const order = r.value.passes.map((p) => p.name);
      const downsample0Idx = order.indexOf('bloom-downsample-0');
      const downsample1Idx = order.indexOf('bloom-downsample-1');
      const upsample0Idx = order.indexOf('bloom-upsample-0');
      const compIdx = order.indexOf('bloom-composite');
      const tmapIdx = order.indexOf('tonemap');
      expect(downsample0Idx).toBeLessThan(downsample1Idx);
      expect(downsample1Idx).toBeLessThan(upsample0Idx);
      expect(upsample0Idx).toBeLessThan(compIdx);
      expect(compIdx).toBeLessThan(tmapIdx);
    });
  });
}

{
  // --- from compile-fail-fast.test.ts ---
  // ── Helpers ──────────────────────────────────────────────────────

  function mockCaps(
    overrides: { compute?: boolean; storageBuffer?: boolean },
    backendKind: 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null' = 'webgpu',
  ) {
    return {
      backendKind,
      compute: overrides.compute ?? true,
      storageBuffer: overrides.storageBuffer ?? true,
      storageTexture: false,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      indirectDrawing: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      rgba16floatRenderable: false,
      rg11b10ufloatRenderable: false,
      float32Filterable: false,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
    };
  }

  // ── dangling-read ────────────────────────────────────────────────

  describe('compile fail-fast: dangling-read', () => {
    it('returns err with code dangling-read and detail { resourceKey, passName }', () => {
      const g = new RenderGraph();
      // orphanKey is a registered resource (so it is not unknown-resource), but
      // no pass writes it -> dangling-read.
      g.addResource('orphanKey', { kind: 'texture', lifetime: 'transient' });
      g.addPass('passA', { reads: ['orphanKey'], writes: [] });

      const r = g.compile({
        backendKind: 'webgpu',
        caps: mockCaps({}),
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        const e = r.error as RenderGraphError;
        expect(e.code).toBe('dangling-read');
        const detail = e.detail as DanglingReadDetail;
        expect(detail.resourceKey).toBe('orphanKey');
        expect(detail.passName).toBe('passA');
      }
    });
  });

  // ── unknown-resource ─────────────────────────────────────────────

  describe('compile fail-fast: unknown-resource', () => {
    it('returns err with code unknown-resource when a pass reads an unregistered key', () => {
      const g = new RenderGraph();
      // 'ghost' is never registered via addResource -> unknown-resource.
      g.addPass('passA', { reads: ['ghost'], writes: [] });

      const r = g.compile({
        backendKind: 'webgpu',
        caps: mockCaps({}),
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        const e = r.error as RenderGraphError;
        expect(e.code).toBe('unknown-resource');
        const detail = e.detail as DanglingReadDetail;
        expect(detail.resourceKey).toBe('ghost');
        expect(detail.passName).toBe('passA');
      }
    });

    it('returns err with code unknown-resource when a pass writes an unregistered key', () => {
      const g = new RenderGraph();
      g.addPass('writer', { reads: [], writes: ['unregisteredOut'] });

      const r = g.compile({
        backendKind: 'webgpu',
        caps: mockCaps({}),
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        const e = r.error as RenderGraphError;
        expect(e.code).toBe('unknown-resource');
        const detail = e.detail as DanglingReadDetail;
        expect(detail.resourceKey).toBe('unregisteredOut');
        expect(detail.passName).toBe('writer');
      }
    });
  });

  // ── cap-missing (compute) ────────────────────────────────────────

  describe('compile fail-fast: cap-missing', () => {
    it('returns err with code cap-missing when compute pass on caps.compute=false backend', () => {
      const g = new RenderGraph();
      g.addPass('computePass', {
        reads: [],
        writes: ['outBuf'],
        compute: true,
      });

      const r = g.compile({
        backendKind: 'webgpu',
        caps: mockCaps({ compute: false }),
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        const e = r.error as RenderGraphError;
        expect(e.code).toBe('cap-missing');
        const detail = e.detail as CapMissingDetail;
        expect(detail.cap).toBe('compute');
        expect(detail.passName).toBe('computePass');
      }
    });

    it('returns err with code cap-missing when storage buffer pass on caps.storageBuffer=false backend', () => {
      const g = new RenderGraph();
      g.addPass('storagePass', {
        reads: [],
        writes: ['buf'],
        storageBuffer: true,
      });

      const r = g.compile({
        backendKind: 'webgpu',
        caps: mockCaps({ storageBuffer: false }),
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        const e = r.error as RenderGraphError;
        expect(e.code).toBe('cap-missing');
        const detail = e.detail as CapMissingDetail;
        expect(detail.cap).toBe('storageBuffer');
        expect(detail.passName).toBe('storagePass');
      }
    });
  });

  describe('declaration-order temporal validation', () => {
    it('rejects a read whose writer appears only in the future', () => {
      const g = new RenderGraph();
      g.addResource('X', { kind: 'texture', lifetime: 'transient' });
      g.addResource('Y', { kind: 'texture', lifetime: 'transient' });
      g.addResource('Z', { kind: 'texture', lifetime: 'transient' });
      // A reads Y before any prior writer; later declarations cannot initialize it retroactively.
      g.addPass('A', { reads: ['Y'], writes: ['X'] });
      g.addPass('B', { reads: ['X'], writes: ['Y'] });
      g.addPass('C', { reads: [], writes: ['Z'] });
      const r = g.compile({
        backendKind: 'webgpu',
        caps: mockCaps({}),
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        const e = r.error as RenderGraphError;
        expect(e.code).toBe('dangling-read');
        expect(e.detail).toMatchObject({ resourceKey: 'Y', passName: 'A' });
      }
    });
  });

  // ── duplicate-resource ───────────────────────────────────────────

  describe('compile fail-fast: duplicate-resource', () => {
    it('returns err with code duplicate-resource and detail { resourceKey }', () => {
      const g = new RenderGraph();
      g.addResource('dupKey', { kind: 'texture', lifetime: 'transient' });

      const r = g.addResource('dupKey', {
        kind: 'texture',
        lifetime: 'persistent',
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        const e = r.error as RenderGraphError;
        expect(e.code).toBe('duplicate-resource');
        const detail = e.detail as DuplicateResourceDetail;
        expect(detail.resourceKey).toBe('dupKey');
      }
    });
  });
}

{
  // --- from errors.test.ts ---
  // ── Closed union exhaustiveness ──────────────────────────────────

  describe('RenderGraphErrorCode exhaustive switch', () => {
    it('lists the complete closed error union', () => {
      const allCodes: RenderGraphErrorCode[] = [
        'dangling-read',
        'cap-missing',
        'duplicate-resource',
        'alias-source-missing',
        'unknown-resource',
        'resource-alloc-failed',
        'invalid-format',
        'invalid-color-domain',
        'missing-color-domain',
        'color-domain-mismatch',
        'observation-absent',
        'observation-invalid-format',
        'observation-invalid-size',
        'observation-missing-copy-src',
        'observation-stale',
        'observation-retired',
        'duplicate-pass-name',
        'duplicate-resource-label',
        'builder-sealed',
        'foreign-resource-handle',
        'resource-not-declared-by-pass',
        'uninitialized-read',
        'access-conflict',
        'capability-missing',
        'resource-descriptor-invalid',
        'import-usage-mismatch',
        'resource-allocation-failed',
        'resource-resolution-failed',
        'pass-encode-failed',
        'compiled-graph-retired',
        'resource-retire-failed',
      ];
      expect(allCodes).toHaveLength(31);
    });

    it('allows exhaustive switch without default covering every member', () => {
      function handle(code: RenderGraphErrorCode): string {
        switch (code) {
          case 'dangling-read':
            return 'dangling';
          case 'cap-missing':
            return 'cap';
          case 'duplicate-resource':
            return 'dup';
          case 'alias-source-missing':
            return 'alias-source-missing';
          case 'unknown-resource':
            return 'unknown';
          case 'resource-alloc-failed':
            return 'alloc';
          case 'invalid-format':
            return 'format';
          case 'invalid-color-domain':
            return 'invalid-domain';
          case 'missing-color-domain':
            return 'missing-domain';
          case 'color-domain-mismatch':
            return 'domain-mismatch';
          case 'observation-absent':
            return 'observation-absent';
          case 'observation-invalid-format':
            return 'observation-invalid-format';
          case 'observation-invalid-size':
            return 'observation-invalid-size';
          case 'observation-missing-copy-src':
            return 'observation-missing-copy-src';
          case 'observation-stale':
            return 'observation-stale';
          case 'observation-retired':
            return 'observation-retired';
          case 'duplicate-pass-name':
          case 'duplicate-resource-label':
          case 'builder-sealed':
          case 'foreign-resource-handle':
          case 'resource-not-declared-by-pass':
          case 'uninitialized-read':
          case 'access-conflict':
          case 'capability-missing':
          case 'resource-descriptor-invalid':
          case 'import-usage-mismatch':
          case 'resource-allocation-failed':
          case 'resource-resolution-failed':
          case 'pass-encode-failed':
          case 'compiled-graph-retired':
          case 'resource-retire-failed':
            return code;
        }
      }

      expect(handle('dangling-read')).toBe('dangling');
      expect(handle('cap-missing')).toBe('cap');
      expect(handle('duplicate-resource')).toBe('dup');
      expect(handle('alias-source-missing')).toBe('alias-source-missing');
      expect(handle('unknown-resource')).toBe('unknown');
      expect(handle('resource-alloc-failed')).toBe('alloc');
      expect(handle('invalid-format')).toBe('format');
      expect(handle('invalid-color-domain')).toBe('invalid-domain');
      expect(handle('missing-color-domain')).toBe('missing-domain');
      expect(handle('color-domain-mismatch')).toBe('domain-mismatch');
    });
  });

  // ── M1 new error detail variants ──────────────────────────────────

  describe('RenderGraphError new detail variants (resource-alloc-failed + invalid-format)', () => {
    it('resource-alloc-failed error has code, expected, hint, and detail with { resourceKey, passName?, rhiCode? }', () => {
      const e = new RenderGraphError({
        code: 'resource-alloc-failed',
        expected: 'device.createTexture must succeed',
        hint: 'check the device state and recreate if lost',
        detail: { resourceKey: 'hdrColor', passName: 'main', rhiCode: 'limit-exceeded' },
      });

      expect(e.code).toBe('resource-alloc-failed');
      expect(e.expected).toBe('device.createTexture must succeed');
      expect(e.hint).toBe('check the device state and recreate if lost');
      const d = e.detail as { resourceKey: string; passName?: string; rhiCode?: string };
      expect(d.resourceKey).toBe('hdrColor');
      expect(d.passName).toBe('main');
      expect(d.rhiCode).toBe('limit-exceeded');
    });

    it('invalid-format error has code, expected, hint, and detail with { resourceKey, format, expected: string[] }', () => {
      const e = new RenderGraphError({
        code: 'invalid-format',
        expected: "format must be a valid GPU texture format, got 'rgb9e5ufloat'",
        hint: 'use a standard format like rgba16float or bgra8unorm',
        detail: {
          resourceKey: 'myTarget',
          format: 'rgb9e5ufloat',
          expected: ['rgba16float', 'rgba8unorm', 'bgra8unorm'],
        },
      });

      expect(e.code).toBe('invalid-format');
      expect(e.expected).toContain('rgb9e5ufloat');
      const d = e.detail as { resourceKey: string; format: string; expected: readonly string[] };
      expect(d.resourceKey).toBe('myTarget');
      expect(d.format).toBe('rgb9e5ufloat');
      expect(d.expected).toContain('rgba16float');
    });
  });

  // ── RenderGraphError four fields ─────────────────────────────────

  describe('RenderGraphError structured error', () => {
    it('has all four fields: .code, .expected, .hint, .detail', () => {
      const e = new RenderGraphError({
        code: 'dangling-read',
        expected: 'key registered',
        hint: 'add a write',
        detail: { resourceKey: 'K', passName: 'P' },
      });

      expect(e.code).toBe('dangling-read');
      expect(e.expected).toBe('key registered');
      expect(e.hint).toBe('add a write');
      expect(e.detail).toEqual({ resourceKey: 'K', passName: 'P' });
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('RenderGraphError');
      expect(e.message).toContain('[RenderGraphError dangling-read]');
    });

    it('allows .detail to be undefined', () => {
      const e = new RenderGraphError({
        code: 'dangling-read',
        expected: 'x',
        hint: 'y',
      });
      expect(e.detail).toBeUndefined();
    });
  });

  // ── Detail narrowing per code ────────────────────────────────────

  describe('RenderGraphErrorDetail narrowing', () => {
    it('dangling-read detail has resourceKey and passName', () => {
      const e = new RenderGraphError({
        code: 'dangling-read',
        expected: '',
        hint: '',
        detail: { resourceKey: 'orphan', passName: 'passA' },
      });
      const d = e.detail as { resourceKey: string; passName: string };
      expect(d.resourceKey).toBe('orphan');
      expect(d.passName).toBe('passA');
    });

    it('cap-missing detail has cap and passName', () => {
      const e = new RenderGraphError({
        code: 'cap-missing',
        expected: '',
        hint: '',
        detail: { cap: 'compute', passName: 'computePass' },
      });
      const d = e.detail as { cap: string; passName: string };
      expect(d.cap).toBe('compute');
      expect(d.passName).toBe('computePass');
    });

    it('duplicate-resource detail has resourceKey', () => {
      const e = new RenderGraphError({
        code: 'duplicate-resource',
        expected: '',
        hint: '',
        detail: { resourceKey: 'dupKey' },
      });
      const d = e.detail as { resourceKey: string };
      expect(d.resourceKey).toBe('dupKey');
    });

    it('alias-source-missing detail has aliasKey and sourceKey', () => {
      const e = new RenderGraphError({
        code: 'alias-source-missing',
        expected: '',
        hint: '',
        detail: { aliasKey: 'alias', sourceKey: 'source' },
      });
      const d = e.detail as { aliasKey: string; sourceKey: string };
      expect(d.aliasKey).toBe('alias');
      expect(d.sourceKey).toBe('source');
    });

    it('unknown-resource detail has resourceKey and passName', () => {
      const e = new RenderGraphError({
        code: 'unknown-resource',
        expected: '',
        hint: '',
        detail: { resourceKey: 'orphan', passName: 'passA' },
      });
      const d = e.detail as { resourceKey: string; passName: string };
      expect(d.resourceKey).toBe('orphan');
      expect(d.passName).toBe('passA');
    });
  });

  // ── Result ok/err factories ──────────────────────────────────────

  describe('Result<T, E> ok / err factories', () => {
    it('ok() produces ResultOk with .ok=true and .value', () => {
      const r = ok(42);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toBe(42);
        expect(r.unwrap()).toBe(42);
        expect(r.unwrapOr(0)).toBe(42);
      }
    });

    it('err() produces ResultErr with .ok=false and .error', () => {
      const e = new RenderGraphError({
        code: 'dangling-read',
        expected: 'x',
        hint: 'y',
      });
      const r = err(e);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe(e);
        expect(r.unwrapOr(42)).toBe(42);
        expect(() => r.unwrap()).toThrow(e);
      }
    });

    it('Result type narrows correctly via .ok discriminant', () => {
      const r1 = ok('hello');
      const r2 = err(
        new RenderGraphError({
          code: 'dangling-read',
          expected: '',
          hint: '',
        }),
      );

      if (r1.ok) {
        expect(typeof r1.value).toBe('string');
      }
      if (!r2.ok) {
        expect(r2.error).toBeInstanceOf(RenderGraphError);
      }
    });
  });
}

{
  // --- from list-passes-resources.test.ts ---
  describe('listPasses / listResources query interface (D-5)', () => {
    it('listPasses returns passes in declaration order', () => {
      const g = new RenderGraph();
      g.addPass('shadow', { reads: [], writes: ['depth'] });
      g.addPass('main', { reads: ['depth'], writes: ['color'] });
      g.addPass('tonemap', { reads: ['color'], writes: ['swapchain'] });

      const passes = g.listPasses();
      expect(passes).toHaveLength(3);
      const [p0, p1, p2] = passes;
      expect(p0?.name).toBe('shadow');
      expect(p0?.reads).toEqual([]);
      expect(p0?.writes).toEqual(['depth']);
      expect(p1?.name).toBe('main');
      expect(p1?.reads).toEqual(['depth']);
      expect(p1?.writes).toEqual(['color']);
      expect(p2?.name).toBe('tonemap');
      expect(p2?.reads).toEqual(['color']);
      expect(p2?.writes).toEqual(['swapchain']);
    });

    it('listResources returns registered resources with key/kind/lifetime', () => {
      const g = new RenderGraph();
      g.addResource('depth', { kind: 'texture', lifetime: 'persistent' });
      g.addResource('color', { kind: 'texture', lifetime: 'transient' });
      g.addResource('lightBuf', {
        kind: 'buffer',
        lifetime: 'persistent',
        bufferRole: 'uniform',
      });

      const resources = g.listResources();
      expect(resources).toHaveLength(3);

      const depth = resources.find((r) => r.key === 'depth');
      expect(depth).toBeDefined();
      expect(depth?.kind).toBe('texture');
      expect(depth?.lifetime).toBe('persistent');

      const color = resources.find((r) => r.key === 'color');
      expect(color).toBeDefined();
      expect(color?.kind).toBe('texture');
      expect(color?.lifetime).toBe('transient');

      const buf = resources.find((r) => r.key === 'lightBuf');
      expect(buf).toBeDefined();
      expect(buf?.kind).toBe('buffer');
      expect(buf?.lifetime).toBe('persistent');
    });

    it('listPasses returns readonly (cannot push)', () => {
      const g = new RenderGraph();
      g.addPass('A', { reads: [], writes: ['X'] });
      const passes = g.listPasses();
      expect(Array.isArray(passes)).toBe(true);
    });

    it('dangling writes appear in listPasses silently (D-5: ignore)', () => {
      const g = new RenderGraph();
      g.addPass('producer', { reads: [], writes: ['orphanOutput'] });
      const passes = g.listPasses();
      expect(passes).toHaveLength(1);
      expect(passes[0]?.writes).toContain('orphanOutput');
    });
  });

  // ── w15: per-frame 4-pass graph enumeration ──────────────────────
  //
  // feat-20260529-rendergraph-pass-abstraction M4 / w15. Asserts listPasses /
  // listResources over the EXACT shape the runtime declares in
  // render-system-record.ts so the AI-user discoverability promise (D-5) is
  // pinned to the real per-frame graph: 4 passes (shadow/main/tonemap/fxaa) in
  // declaration order with the migrated reads/writes, and 4 transient/
  // persistent texture resources. IBL convolution + shadow probe (OOS-3/OOS-4)
  // are NOT graph passes -> not enumerated.

  function buildPerFrameGraph() {
    const g = new RenderGraph();
    g.addResource('depth', { kind: 'texture', lifetime: 'persistent' });
    g.addResource('shadowDepth', { kind: 'texture', lifetime: 'persistent' });
    g.addResource('fxaaIntermediate', { kind: 'texture', lifetime: 'transient' });
    g.addResource('hdrColor', { kind: 'texture', lifetime: 'transient' });
    g.addPass('shadow', { reads: [], writes: ['shadowDepth'] });
    g.addPass('main', { reads: ['shadowDepth'], writes: ['hdrColor', 'depth'] });
    g.addPass('tonemap', { reads: ['hdrColor'], writes: [] });
    g.addPass('fxaa', { reads: [], writes: ['fxaaIntermediate'] });
    return g;
  }

  describe('w15: per-frame 4-pass graph enumeration', () => {
    it('listPasses returns the 4 per-frame passes in declaration order', () => {
      const passes = buildPerFrameGraph().listPasses();
      expect(passes.map((p) => p.name)).toEqual(['shadow', 'main', 'tonemap', 'fxaa']);
    });

    it('each pass reads/writes match the runtime declaration', () => {
      const passes = buildPerFrameGraph().listPasses();
      const byName = new Map(passes.map((p) => [p.name, p]));

      expect(byName.get('shadow')?.reads).toEqual([]);
      expect(byName.get('shadow')?.writes).toEqual(['shadowDepth']);

      expect(byName.get('main')?.reads).toEqual(['shadowDepth']);
      expect(byName.get('main')?.writes).toEqual(['hdrColor', 'depth']);

      expect(byName.get('tonemap')?.reads).toEqual(['hdrColor']);
      expect(byName.get('tonemap')?.writes).toEqual([]);

      // FXAA's intermediate is pass-internal (copy target), declared under
      // writes so compile() raises no dangling-read (D-5 dangling-write OK).
      expect(byName.get('fxaa')?.reads).toEqual([]);
      expect(byName.get('fxaa')?.writes).toEqual(['fxaaIntermediate']);
    });

    it('listResources enumerates the 4 texture resources with key/kind/lifetime', () => {
      const resources = buildPerFrameGraph().listResources();
      expect(resources).toHaveLength(4);
      const byKey = new Map(resources.map((r) => [r.key, r]));

      for (const key of ['depth', 'shadowDepth', 'fxaaIntermediate', 'hdrColor']) {
        expect(byKey.get(key)?.kind).toBe('texture');
      }
      // Lifetime split (D-4): depth + shadowDepth persistent (size/mapSize
      // keyed, survive across frames); fxaaIntermediate + hdrColor transient
      // (conditional on camera.antialias / camera.tonemap, resize-invalidated).
      expect(byKey.get('depth')?.lifetime).toBe('persistent');
      expect(byKey.get('shadowDepth')?.lifetime).toBe('persistent');
      expect(byKey.get('fxaaIntermediate')?.lifetime).toBe('transient');
      expect(byKey.get('hdrColor')?.lifetime).toBe('transient');
    });

    it('listResources includes the dangling-write fxaaIntermediate (D-5: not pruned)', () => {
      // fxaaIntermediate is written by 'fxaa' but read by no pass; D-5 keeps it
      // enumerated (dangling write is a legitimate "external consumer" output).
      const resources = buildPerFrameGraph().listResources();
      expect(resources.some((r) => r.key === 'fxaaIntermediate')).toBe(true);
    });
  });
}

{
  // --- from resource-allocation.test.ts ---
  // ── AC-01(a): compile with device calls createTexture ──────────────

  describe('addColorTarget compile allocation', () => {
    it.todo(
      'addColorTarget(name, desc) returns a handle that resolve() gives a TextureView after compile',
    );

    it.todo(
      'compile({device}) calls device.createTexture at least once when the graph has color targets',
    );

    it.todo(
      'pass execute closure receives a context where resolve(name) returns a non-null TextureView',
    );
  });

  // ── AC-02(a): transient resource pooling by descriptor ─────────────

  describe('transient resource pooling', () => {
    it.todo(
      'transient resources with identical descriptor share the same physical texture (pool hit)',
    );

    it.todo('transient resource with changed size triggers drift rebuild (new physical texture)');

    it.todo('transient resource with changed format triggers drift rebuild');

    it.todo(
      'sampleCount in pool key isolates MSAA multi-sampled targets from single-sampled targets',
    );
  });

  // ── AC-02(b): persistent resource behaviour ───────────────────────

  describe('persistent resource lifecycle', () => {
    it('reuses persistent targets until size drift, then replaces only the drifted target once', async () => {
      const created: Array<{
        readonly texture: object;
        readonly width: number;
        readonly height: number;
      }> = [];
      const destroyed: object[] = [];
      const device = {
        createTexture: (descriptor: {
          readonly size: { readonly width: number; readonly height: number };
        }) => {
          const texture = { id: `texture-${created.length + 1}` };
          created.push({ texture, width: descriptor.size.width, height: descriptor.size.height });
          return { ok: true as const, value: texture };
        },
        createTextureView: (texture: object) => ({
          ok: true as const,
          value: { id: `view-${created.length}`, texture },
        }),
        destroyTexture: (texture: object) => {
          destroyed.push(texture);
          return { ok: true as const, value: undefined };
        },
        queue: { onSubmittedWorkDone: () => Promise.resolve(undefined) },
      };
      const caps = { backendKind: 'webgpu', compute: true, storageBuffer: true } as never;
      const graph = new RenderGraph();
      graph.addColorTarget('persistent', {
        format: 'rgba16float',
        size: 'swapchain',
        lifetime: 'persistent',
        usage: 0,
      });
      graph.addColorTarget('sibling', {
        format: 'rgba16float',
        size: { w: 16, h: 16 },
        lifetime: 'persistent',
        usage: 0,
      });
      graph.addPass('main', { reads: [], writes: ['persistent', 'sibling'] });

      graph.setSwapChainSize(64, 32);
      expect(graph.compile({ backendKind: 'webgpu', caps, device: device as never }).ok).toBe(true);
      const persistentTexture = graph.getColorTargetTexture('persistent');
      const persistentView = graph.getColorTargetView('persistent');
      const siblingTexture = graph.getColorTargetTexture('sibling');
      expect(
        graph.listResources().find((resource) => resource.key === 'persistent')?.lifetime,
      ).toBe('persistent');
      expect(created.map(({ width, height }) => [width, height])).toEqual([
        [64, 32],
        [16, 16],
      ]);

      graph.setSwapChainSize(64, 32);
      expect(graph.compile({ backendKind: 'webgpu', caps, device: device as never }).ok).toBe(true);
      expect(graph.getColorTargetTexture('persistent')).toBe(persistentTexture);
      expect(graph.getColorTargetView('persistent')).toBe(persistentView);
      expect(graph.getColorTargetTexture('sibling')).toBe(siblingTexture);
      expect(created).toHaveLength(2);

      graph.setSwapChainSize(128, 32);
      expect(graph.compile({ backendKind: 'webgpu', caps, device: device as never }).ok).toBe(true);
      const replacementTexture = graph.getColorTargetTexture('persistent');
      const replacementView = graph.getColorTargetView('persistent');
      expect(replacementTexture).not.toBe(persistentTexture);
      expect(replacementView).not.toBe(persistentView);
      expect(graph.getColorTargetTexture('sibling')).toBe(siblingTexture);
      expect(graph.getColorTargetDescriptor('persistent')?.size).toEqual({
        width: 128,
        height: 32,
      });
      expect(created.map(({ width, height }) => [width, height])).toEqual([
        [64, 32],
        [16, 16],
        [128, 32],
      ]);
      expect(destroyed).toEqual([]);

      await graph.reclaimRetiredTransients();
      expect(destroyed).toEqual([persistentTexture]);

      graph.setSwapChainSize(128, 32);
      expect(graph.compile({ backendKind: 'webgpu', caps, device: device as never }).ok).toBe(true);
      expect(graph.getColorTargetTexture('persistent')).toBe(replacementTexture);
      expect(graph.getColorTargetView('persistent')).toBe(replacementView);
      expect(created).toHaveLength(3);

      graph.drain();
      graph.drain();
      expect(destroyed).toEqual([persistentTexture, replacementTexture, siblingTexture]);
    });
  });

  // ── AC-02(c): alias folding (D-2 / KB-1) ─────────────────────────

  describe('alias folding (hdrComposited -> physical texture)', () => {
    it('owns one texture/view pair per name and reuses the same pair through an alias', async () => {
      const device = (await new RhiNullAdapter().requestDevice()).unwrap();
      const created = vi.spyOn(device, 'createTexture');
      const graph = new RenderGraph();
      graph.addColorTarget('source', { format: 'rgba16float', size: { w: 4, h: 4 } }).unwrap();
      graph.addColorTargetAlias('alias', 'source').unwrap();
      const resolved: unknown[] = [];
      graph.addPass('seed', {
        reads: [],
        writes: ['source'],
        execute: (_, resources) => {
          resolved.push(
            resources.resolve('source'),
            resources.resolve('source::tex'),
            resources.resolve('alias'),
          );
        },
      });
      const options = { backendKind: device.caps.backendKind, caps: device.caps, device };
      const compiled = graph.compile(options).unwrap();
      const pair = compiled.colorTargets.get('source');
      expect(pair).toBeDefined();
      expect(compiled.colorTargets.size).toBe(2);
      expect(compiled.colorTargets.get('alias')).toBe(pair);
      expect(graph.getColorTargetTexture('source')).toBe(pair?.texture);
      expect(graph.getColorTargetView('alias')).toBe(pair?.view);
      graph.execute(undefined);
      expect(resolved).toEqual([pair?.view, pair?.texture, pair?.view]);
      expect(graph.compile(options).unwrap().colorTargets.get('source')).toBe(pair);
      expect(created).toHaveBeenCalledTimes(1);
      graph.drain();
    });
  });

  // ── compile fail-fast with device errors ───────────────────────────

  describe('compile fail-fast with device errors (w6)', () => {
    it('refuses allocation atomically and preserves the active graph for clean retry', () => {
      const created: object[] = [];
      const destroyed: object[] = [];
      let createCalls = 0;
      let failOnCreateCall: number | undefined;
      const device = {
        createTexture: () => {
          createCalls += 1;
          if (createCalls === failOnCreateCall) {
            return { ok: false as const, error: { code: 'oom' } };
          }
          const texture = { id: `texture-${createCalls}` };
          created.push(texture);
          return { ok: true as const, value: texture };
        },
        createTextureView: (texture: object) => ({
          ok: true as const,
          value: { texture },
        }),
        destroyTexture: (texture: object) => {
          destroyed.push(texture);
          return { ok: true as const, value: undefined };
        },
        queue: { onSubmittedWorkDone: () => Promise.resolve(undefined) },
      };
      const caps = {
        backendKind: 'webgpu',
        compute: true,
        storageBuffer: true,
      } as never;

      const graph = new RenderGraph();
      graph.addColorTarget('healthy', {
        format: 'rgba16float',
        size: { w: 32, h: 32 },
        usage: 0,
      });
      graph.addPass('healthy-pass', { reads: [], writes: ['healthy'] });

      const initial = graph.compile({ backendKind: 'webgpu', caps, device: device as never });
      expect(initial.ok).toBe(true);
      const healthyTexture = graph.getColorTargetTexture('healthy');
      const healthyView = graph.getColorTargetView('healthy');
      expect(healthyTexture).toBeDefined();
      expect(healthyView).toBeDefined();

      graph.addColorTarget('new-target', {
        format: 'rgba16float',
        size: { w: 32, h: 32 },
        usage: 0,
      });
      graph.addColorTarget('faulty-target', {
        format: 'rgba16float',
        size: { w: 32, h: 32 },
        usage: 0,
      });
      graph.addPass('new-pass', { reads: [], writes: ['new-target'] });
      graph.addPass('faulty-pass', { reads: [], writes: ['faulty-target'] });
      failOnCreateCall = createCalls + 2;

      const refused = graph.compile({ backendKind: 'webgpu', caps, device: device as never });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.code).toBe('resource-alloc-failed');
      expect(refused.error.detail).toEqual({
        resourceKey: 'faulty-target',
        rhiCode: 'oom',
      });
      expect(destroyed).toEqual([created[1]]);
      expect(graph.getColorTargetTexture('healthy')).toBe(healthyTexture);
      expect(graph.getColorTargetView('healthy')).toBe(healthyView);
      expect(graph.getColorTargetTexture('new-target')).toBeUndefined();
      expect(graph.getColorTargetTexture('faulty-target')).toBeUndefined();

      failOnCreateCall = undefined;
      const recovered = graph.compile({ backendKind: 'webgpu', caps, device: device as never });
      expect(recovered.ok).toBe(true);
      expect(graph.getColorTargetTexture('new-target')).not.toBe(created[1]);
      expect(graph.getColorTargetTexture('faulty-target')).toBeDefined();

      graph.drain();
      graph.drain();
      expect(new Set(destroyed)).toEqual(new Set(created));
      expect(destroyed).toHaveLength(created.length);
    });

    it('returns invalid-format before allocation and preserves the active graph', () => {
      let createTextureCalls = 0;
      let createTextureViewCalls = 0;
      const device = {
        createTexture: () => {
          createTextureCalls += 1;
          return { ok: true as const, value: { id: `texture-${createTextureCalls}` } };
        },
        createTextureView: () => {
          createTextureViewCalls += 1;
          return { ok: true as const, value: { id: `view-${createTextureViewCalls}` } };
        },
        destroyTexture: () => ({ ok: true as const, value: undefined }),
        queue: { onSubmittedWorkDone: () => Promise.resolve(undefined) },
      };
      const caps = {
        backendKind: 'webgpu',
        compute: true,
        storageBuffer: true,
      } as never;

      const graph = new RenderGraph();
      graph.addColorTarget('healthy', {
        format: 'rgba8unorm',
        size: { w: 1, h: 1 },
        usage: 0,
      });
      graph.addPass('healthy-pass', { reads: [], writes: ['healthy'] });
      const initial = graph.compile({ backendKind: 'webgpu', caps, device: device as never });
      expect(initial.ok).toBe(true);
      const healthyTexture = graph.getColorTargetTexture('healthy');
      const healthyView = graph.getColorTargetView('healthy');
      expect(createTextureCalls).toBe(1);
      expect(createTextureViewCalls).toBe(1);

      graph.addColorTarget('candidate', {
        // Runtime malformed input is intentionally injected past the closed
        // declaration type so the validation error remains covered.
        format: 'not-a-gpu-texture-format' as never,
        size: { w: 1, h: 1 },
        usage: 0,
      });
      graph.addPass('candidate-pass', { reads: [], writes: ['candidate'] });

      const refused = graph.compile({ backendKind: 'webgpu', caps, device: device as never });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.code).toBe('invalid-format');
      expect(refused.error.detail).toMatchObject({
        resourceKey: 'candidate',
        format: 'not-a-gpu-texture-format',
      });
      const detail = refused.error.detail as {
        readonly resourceKey: string;
        readonly format: string;
        readonly expected: readonly string[];
      };
      expect(detail.expected).toContain('rgba8unorm');
      expect(createTextureCalls).toBe(1);
      expect(createTextureViewCalls).toBe(1);
      expect(graph.getColorTargetTexture('healthy')).toBe(healthyTexture);
      expect(graph.getColorTargetView('healthy')).toBe(healthyView);
      expect(graph.getColorTargetTexture('candidate')).toBeUndefined();

      const duplicateCandidate = graph.addColorTarget('candidate', {
        format: 'rgba8unorm',
        size: { w: 1, h: 1 },
        usage: 0,
      });
      expect(duplicateCandidate.ok).toBe(false);
      if (duplicateCandidate.ok) return;
      expect(duplicateCandidate.error.code).toBe('duplicate-resource');
      expect(duplicateCandidate.error.detail).toEqual({ resourceKey: 'candidate' });
      expect(createTextureCalls).toBe(1);
      expect(createTextureViewCalls).toBe(1);
      expect(graph.getColorTargetTexture('healthy')).toBe(healthyTexture);
      expect(graph.getColorTargetView('healthy')).toBe(healthyView);
      expect(graph.getColorTargetTexture('candidate')).toBeUndefined();
    });
  });
}

{
  // --- feat-20260612 M4 / w13: RenderGraph.drain unit test ---
  //
  // Coverage matrix (plan-strategy D-7 + OOS-7):
  //   1. drain() walks transientPool and calls device.destroyTexture for each
  //      pooled texture handle.
  //   2. drain() walks persistentTextures and calls device.destroyTexture for
  //      each persistent texture handle.
  //   3. After drain(), both pools are empty (size === 0).
  //   4. drain() is idempotent: a second call after the pools were cleared
  //      is a no-op (zero further destroyTexture invocations).
  //
  // Mock shape: a minimal RhiDevice stub with createTexture / createTextureView
  // / destroyTexture (the only surface the allocate + drain paths touch).

  function drainMockCaps() {
    return {
      backendKind: 'webgpu' as const,
      compute: true,
      storageBuffer: true,
      storageTexture: false,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      indirectDrawing: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      rgba16floatRenderable: false,
      rg11b10ufloatRenderable: false,
      float32Filterable: false,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
    };
  }

  interface DrainProbe {
    created: number;
    destroyed: number;
    destroyedHandles: object[];
  }

  function makeDrainDevice(probe: DrainProbe): {
    // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
    [k: string]: any;
  } {
    return {
      createTexture: (_desc: unknown) => {
        probe.created += 1;
        const handle = { __mock: `tex-${probe.created}` };
        return { ok: true as const, value: handle };
      },
      createTextureView: (_tex: unknown, _desc: unknown) => {
        return { ok: true as const, value: { __mock: 'view' } };
      },
      destroyTexture: (tex: object) => {
        probe.destroyed += 1;
        probe.destroyedHandles.push(tex);
        return { ok: true as const, value: undefined };
      },
      queue: {
        onSubmittedWorkDone: () => Promise.resolve(undefined),
      },
    };
  }

  describe('RenderGraph.drain (feat-20260612 M4 / w13)', () => {
    it('drain destroys every transient pool entry and clears the pool', () => {
      const probe: DrainProbe = { created: 0, destroyed: 0, destroyedHandles: [] };
      const g = new RenderGraph();
      g.addColorTarget('hdrColor', {
        format: 'rgba16float',
        size: { w: 64, h: 64 },
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });

      const r = g.compile({
        backendKind: 'webgpu',
        caps: drainMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeDrainDevice(probe) as any,
      });
      expect(r.ok).toBe(true);
      expect(probe.created).toBeGreaterThanOrEqual(1);

      const baselineDestroyed = probe.destroyed;
      g.drain();

      // Every pool entry got a destroyTexture call.
      expect(probe.destroyed - baselineDestroyed).toBe(probe.created);
    });

    it('drain destroys every persistent texture entry and clears the map', () => {
      const probe: DrainProbe = { created: 0, destroyed: 0, destroyedHandles: [] };
      const g = new RenderGraph();
      g.addColorTarget('shadowDepth', {
        format: 'depth32float',
        size: { w: 64, h: 64 },
        lifetime: 'persistent',
        usage: 0,
      });
      g.addPass('shadow', { reads: [], writes: ['shadowDepth'] });
      const r = g.compile({
        backendKind: 'webgpu',
        caps: drainMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeDrainDevice(probe) as any,
      });
      expect(r.ok).toBe(true);
      expect(probe.created).toBe(1);

      g.drain();
      expect(probe.destroyed).toBe(1);
      expect(() => g.drain()).not.toThrow();
      expect(probe.destroyed).toBe(1);
    });

    it('drain is idempotent: a second drain after a cleared pool is a no-op', () => {
      const probe: DrainProbe = { created: 0, destroyed: 0, destroyedHandles: [] };
      const g = new RenderGraph();
      g.addColorTarget('hdrColor', {
        format: 'rgba16float',
        size: { w: 32, h: 32 },
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });

      const r = g.compile({
        backendKind: 'webgpu',
        caps: drainMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeDrainDevice(probe) as any,
      });
      expect(r.ok).toBe(true);

      g.drain();
      const afterFirst = probe.destroyed;

      // Second drain: pools already cleared, no further destroyTexture fires.
      expect(() => g.drain()).not.toThrow();
      expect(probe.destroyed).toBe(afterFirst);
    });

    it('drain on a never-compiled graph is a safe no-op', () => {
      const g = new RenderGraph();
      expect(() => g.drain()).not.toThrow();
    });
  });
}

{
  // --- from uniform-fallback.test.ts ---
  // ── Helpers ──────────────────────────────────────────────────────

  function mockCaps(overrides: { storageBuffer?: boolean }) {
    return {
      backendKind: 'webgpu' as const,
      compute: true,
      storageBuffer: overrides.storageBuffer ?? true,
      storageTexture: false,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      indirectDrawing: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      rgba16floatRenderable: false,
      rg11b10ufloatRenderable: false,
      float32Filterable: false,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
    };
  }

  function resolvedTypeOf(
    graph: { resolvedBuffers: readonly { key: string; resolvedBufferType: string }[] },
    key: string,
  ): string | undefined {
    return graph.resolvedBuffers.find((b) => b.key === key)?.resolvedBufferType;
  }

  // ── uniform fallback (AC-09 / D-6.1) ─────────────────────────────
  //
  // compile() resolves a `kind:'buffer'` resource declared with
  // `bufferRole='auto-storage-or-uniform'` to a concrete RHI binding type by
  // reading `caps.storageBuffer` -- mirroring the runtime pbr-pipeline cap
  // switch (research Finding 7), expressed in the RHI-pure graph layer. The two
  // branches MUST resolve to different types; if the resolution logic is
  // deleted, `resolvedBuffers` goes empty and these assertions fail.

  describe('uniform fallback (AC-09 / D-6.1)', () => {
    it('resolves auto-storage-or-uniform to uniform when storageBuffer=false', () => {
      const g = new RenderGraph();
      g.addResource('lightBuf', {
        kind: 'buffer',
        lifetime: 'persistent',
        bufferRole: 'auto-storage-or-uniform',
      });
      g.addPass('mainPass', { reads: [], writes: ['lightBuf'] });

      const r = g.compile({ backendKind: 'webgpu', caps: mockCaps({ storageBuffer: false }) });

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(resolvedTypeOf(r.value, 'lightBuf')).toBe('uniform');
      }
    });

    it('resolves auto-storage-or-uniform to read-only-storage when storageBuffer=true', () => {
      const g = new RenderGraph();
      g.addResource('lightBuf', {
        kind: 'buffer',
        lifetime: 'persistent',
        bufferRole: 'auto-storage-or-uniform',
      });
      g.addPass('mainPass', { reads: [], writes: ['lightBuf'] });

      const r = g.compile({ backendKind: 'webgpu', caps: mockCaps({ storageBuffer: true }) });

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(resolvedTypeOf(r.value, 'lightBuf')).toBe('read-only-storage');
      }
    });

    it('the two branches resolve to different types (catches a removed cap switch)', () => {
      const build = () => {
        const g = new RenderGraph();
        g.addResource('lightBuf', {
          kind: 'buffer',
          lifetime: 'persistent',
          bufferRole: 'auto-storage-or-uniform',
        });
        g.addPass('mainPass', { reads: [], writes: ['lightBuf'] });
        return g;
      };

      const noStorage = build().compile({
        backendKind: 'webgpu',
        caps: mockCaps({ storageBuffer: false }),
      });
      const withStorage = build().compile({
        backendKind: 'webgpu',
        caps: mockCaps({ storageBuffer: true }),
      });

      expect(noStorage.ok && withStorage.ok).toBe(true);
      if (noStorage.ok && withStorage.ok) {
        const a = resolvedTypeOf(noStorage.value, 'lightBuf');
        const b = resolvedTypeOf(withStorage.value, 'lightBuf');
        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect(a).not.toBe(b);
      }
    });

    it('bufferRole=uniform always resolves to uniform regardless of caps', () => {
      const build = () => {
        const g = new RenderGraph();
        g.addResource('camBuf', { kind: 'buffer', lifetime: 'persistent', bufferRole: 'uniform' });
        g.addPass('mainPass', { reads: [], writes: ['camBuf'] });
        return g;
      };

      const withStorage = build().compile({
        backendKind: 'webgpu',
        caps: mockCaps({ storageBuffer: true }),
      });
      const noStorage = build().compile({
        backendKind: 'webgpu',
        caps: mockCaps({ storageBuffer: false }),
      });

      expect(withStorage.ok && noStorage.ok).toBe(true);
      if (withStorage.ok && noStorage.ok) {
        expect(resolvedTypeOf(withStorage.value, 'camBuf')).toBe('uniform');
        expect(resolvedTypeOf(noStorage.value, 'camBuf')).toBe('uniform');
      }
    });

    it('defaults an unset bufferRole to the auto cap switch', () => {
      const g = new RenderGraph();
      g.addResource('plainBuf', { kind: 'buffer', lifetime: 'persistent' });
      g.addPass('mainPass', { reads: [], writes: ['plainBuf'] });

      const r = g.compile({ backendKind: 'webgpu', caps: mockCaps({ storageBuffer: false }) });

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(resolvedTypeOf(r.value, 'plainBuf')).toBe('uniform');
      }
    });

    it('omits texture resources from resolvedBuffers', () => {
      const g = new RenderGraph();
      g.addResource('hdrColor', { kind: 'texture', lifetime: 'transient' });
      g.addPass('mainPass', { reads: [], writes: ['hdrColor'] });

      const r = g.compile({ backendKind: 'webgpu', caps: mockCaps({ storageBuffer: true }) });

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.resolvedBuffers).toEqual([]);
      }
    });
  });
}

{
  // --- feat-20260619-gpu-resource-ownership-symmetric-release-primitive M3 / w9: AC-09 resize drain ---
  //
  // Transient pool key includes dimensions (name:format:WxH:usage:sample). When
  // swap-chain size changes, old-dimension entries become stranded because the
  // new compile creates entries with new-dimension keys and the old ones are
  // never accessed again. drainTransient() must release all transient pool
  // textures on resize before reallocation.
  //
  // Coverage:
  //   1. Resize triggers drain of old transient entries (destroyTexture called per old entry).
  //   2. After resize drain, old keys are gone from the pool; new keys for new
  //      dimensions exist.
  //   3. Non-resize recompile does NOT drain (pool entries survive when dimensions unchanged).
  //   4. drainTransient only touches transientPool, not persistentTextures.

  function resizeDrainMockCaps() {
    return {
      backendKind: 'webgpu' as const,
      compute: true,
      storageBuffer: true,
      storageTexture: false,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      indirectDrawing: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      rgba16floatRenderable: false,
      rg11b10ufloatRenderable: false,
      float32Filterable: false,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
    };
  }

  interface ResizeDrainProbe {
    created: number;
    destroyed: number;
    destroyedHandles: object[];
  }

  function makeResizeDrainDevice(probe: ResizeDrainProbe): Record<string, unknown> {
    return {
      createTexture: (_desc: unknown) => {
        probe.created += 1;
        return { ok: true as const, value: { __mock: `tex-${probe.created}` } };
      },
      createTextureView: (_tex: unknown, _desc: unknown) => {
        return { ok: true as const, value: { __mock: 'view' } };
      },
      destroyTexture: (tex: object) => {
        probe.destroyed += 1;
        probe.destroyedHandles.push(tex);
        return { ok: true as const, value: undefined };
      },
      queue: {
        onSubmittedWorkDone: () => Promise.resolve(undefined),
      },
    };
  }

  describe('transient pool resize drain (AC-09)', () => {
    it('resize enqueues old transient entries to pendingDestroy and reclaim destroys them', async () => {
      const probe: ResizeDrainProbe = { created: 0, destroyed: 0, destroyedHandles: [] };
      const g = new RenderGraph();
      g.addColorTarget('hdrColor', {
        format: 'rgba16float',
        size: 'swapchain',
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });

      // Compile at 64x64.
      g.setSwapChainSize(64, 64);
      const r1 = g.compile({
        backendKind: 'webgpu',
        caps: resizeDrainMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeResizeDrainDevice(probe) as any,
      });
      expect(r1.ok).toBe(true);
      const createdAfterFirst = probe.created;
      expect(createdAfterFirst).toBeGreaterThanOrEqual(1);
      const destroyedBeforeResize = probe.destroyed;

      // Resize to 128x128 triggers recompile signal.
      const resizeDetected = g.setSwapChainSize(128, 128);
      expect(resizeDetected).toBe(true);

      const r2 = g.compile({
        backendKind: 'webgpu',
        caps: resizeDrainMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeResizeDrainDevice(probe) as any,
      });
      expect(r2.ok).toBe(true);

      // bug-20260622 D-1: old textures pushed to pendingDestroy, not
      // destroyed immediately. Resize compile should NOT call destroyTexture.
      const destroyedAtResize = probe.destroyed - destroyedBeforeResize;
      expect(destroyedAtResize).toBe(0);

      // New textures were created for the new size.
      expect(probe.created).toBe(createdAfterFirst * 2);

      // After reclaim, old textures are destroyed.
      await g.reclaimRetiredTransients();
      expect(probe.destroyed - destroyedBeforeResize).toBe(createdAfterFirst);
    });

    it('non-resize recompile leaves transient pool intact (no spurious drain)', () => {
      const probe: ResizeDrainProbe = { created: 0, destroyed: 0, destroyedHandles: [] };
      const g = new RenderGraph();
      g.addColorTarget('hdrColor', {
        format: 'rgba16float',
        size: 'swapchain',
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });

      // Compile at 64x64 — no prior size set, so setSwapChainSize(64,64) returns true.
      g.setSwapChainSize(64, 64);
      const r1 = g.compile({
        backendKind: 'webgpu',
        caps: resizeDrainMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeResizeDrainDevice(probe) as any,
      });
      expect(r1.ok).toBe(true);

      const destroyedAfterFirst = probe.destroyed;
      const createdAfterFirst = probe.created;

      // Recompile without resize — setSwapChainSize(64,64) returns false.
      const resizeDetected = g.setSwapChainSize(64, 64);
      expect(resizeDetected).toBe(false);

      const r2 = g.compile({
        backendKind: 'webgpu',
        caps: resizeDrainMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeResizeDrainDevice(probe) as any,
      });
      expect(r2.ok).toBe(true);

      // No drain on non-resize: destroyTexture count unchanged, pool hit reused
      // the existing texture (no new createTexture calls).
      expect(probe.destroyed).toBe(destroyedAfterFirst);
      expect(probe.created).toBe(createdAfterFirst);
    });

    it('drainTransient only clears transientPool, not persistentTextures', () => {
      const probe: ResizeDrainProbe = { created: 0, destroyed: 0, destroyedHandles: [] };
      const g = new RenderGraph();
      g.addColorTarget('hdrColor', {
        format: 'rgba16float',
        size: 'swapchain',
        sample: 1,
        usage: 0,
      });
      g.addColorTarget('history', {
        format: 'rgba16float',
        size: { w: 32, h: 32 },
        lifetime: 'persistent',
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['hdrColor', 'history'] });

      g.setSwapChainSize(64, 64);
      const r1 = g.compile({
        backendKind: 'webgpu',
        caps: resizeDrainMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeResizeDrainDevice(probe) as any,
      });
      expect(r1.ok).toBe(true);

      // Snapshot persistentTextures before resize.
      // biome-ignore lint/suspicious/noExplicitAny: internal pool access in unit test
      const ptexBefore = (g as any).persistentTextures as Map<string, unknown>;
      const ptexSizeBefore = ptexBefore.size;
      const historyBefore = g.getColorTargetTexture('history');

      // Resize.
      g.setSwapChainSize(128, 128);
      const r2 = g.compile({
        backendKind: 'webgpu',
        caps: resizeDrainMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeResizeDrainDevice(probe) as any,
      });
      expect(r2.ok).toBe(true);

      // Persistent textures untouched by drainTransient.
      expect(ptexBefore.size).toBe(ptexSizeBefore);
      expect(g.getColorTargetTexture('history')).toBe(historyBefore);
      expect(probe.created).toBe(3);
    });
  });
}

{
  // --- bug-20260622-hdrcolor-transient-pool-destroy-in-flight M1: red baseline — deferred-destroy fence ---
  //
  // The existing AC-09 test asserts "resize triggers drainTransient which
  // destroys old textures immediately". This is the bug: those textures are
  // still referenced by the previous frame's in-flight command buffer.
  //
  // The fix adds a pendingDestroy queue (D-1) and a reclaimRetiredTransients
  // method (D-2) that defers actual destroyTexture until
  // device.queue.onSubmittedWorkDone() resolves.
  //
  // This test (M1 RED baseline) asserts the NEW expected behaviour:
  //   1. Resize compile pushes old textures into pendingDestroy, does NOT
  //      call destroyTexture immediately.
  //   2. reclaimRetiredTransients() triggers onSubmittedWorkDone then
  //      destroys the pending items.
  //
  // Currently RED — drainTransient destroys synchronously, so
  // destroyedAtResize > 0 (this test asserts destroyedAtResize === 0).

  function deferredMockCaps() {
    return {
      backendKind: 'webgpu' as const,
      compute: true,
      storageBuffer: true,
      storageTexture: false,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      indirectDrawing: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      rgba16floatRenderable: false,
      rg11b10ufloatRenderable: false,
      float32Filterable: false,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
    };
  }

  interface DeferredProbe {
    created: number;
    destroyed: number;
    destroyedHandles: object[];
  }

  function makeDeferredDevice(probe: DeferredProbe): Record<string, unknown> {
    return {
      createTexture: (_desc: unknown) => {
        probe.created += 1;
        return { ok: true as const, value: { __mock: `tex-${probe.created}` } };
      },
      createTextureView: (_tex: unknown, _desc: unknown) => {
        return { ok: true as const, value: { __mock: 'view' } };
      },
      destroyTexture: (tex: object) => {
        probe.destroyed += 1;
        probe.destroyedHandles.push(tex);
        return { ok: true as const, value: undefined };
      },
      queue: {
        onSubmittedWorkDone: () => Promise.resolve(undefined),
      },
    };
  }

  describe('deferred-destroy: resize enqueues pendingDestroy, not immediate destroy (AC-03 RED)', () => {
    it('resize compile pushes old transient textures into pendingDestroy (destroy count = 0 at resize)', () => {
      const probe: DeferredProbe = { created: 0, destroyed: 0, destroyedHandles: [] };
      const g = new RenderGraph();
      g.addColorTarget('hdrColor', {
        format: 'rgba16float',
        size: 'swapchain',
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });

      // Compile at 64x64.
      g.setSwapChainSize(64, 64);
      const r1 = g.compile({
        backendKind: 'webgpu',
        caps: deferredMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeDeferredDevice(probe) as any,
      });
      expect(r1.ok).toBe(true);
      const createdAfterFirst = probe.created;
      expect(createdAfterFirst).toBeGreaterThanOrEqual(1);

      const destroyedBeforeResize = probe.destroyed;

      // Resize to 128x128.
      const resizeDetected = g.setSwapChainSize(128, 128);
      expect(resizeDetected).toBe(true);

      const r2 = g.compile({
        backendKind: 'webgpu',
        caps: deferredMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeDeferredDevice(probe) as any,
      });
      expect(r2.ok).toBe(true);

      // AC-03 RED: after resize compile, old textures should NOT be destroyed
      // yet — they are in pendingDestroy queue, waiting for GPU retirement.
      // Currently RED because drainTransient destroys synchronously.
      const destroyedAtResize = probe.destroyed - destroyedBeforeResize;
      expect(destroyedAtResize).toBe(0);
    });

    it('pendingDestroy is accessible as internal field after resize', () => {
      const probe: DeferredProbe = { created: 0, destroyed: 0, destroyedHandles: [] };
      const g = new RenderGraph();
      g.addColorTarget('hdrColor', {
        format: 'rgba16float',
        size: 'swapchain',
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });

      g.setSwapChainSize(64, 64);
      g.compile({
        backendKind: 'webgpu',
        caps: deferredMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeDeferredDevice(probe) as any,
      });

      g.setSwapChainSize(128, 128);
      g.compile({
        backendKind: 'webgpu',
        caps: deferredMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeDeferredDevice(probe) as any,
      });

      // After resize, pendingDestroy should contain the old transient textures.
      // biome-ignore lint/suspicious/noExplicitAny: internal field access in unit test
      const pending = (g as any).pendingDestroy as unknown[];
      expect(Array.isArray(pending)).toBe(true);
      expect(pending.length).toBeGreaterThanOrEqual(1);
    });

    it('reclaimRetiredTransients destroys pending items after onSubmittedWorkDone resolves', async () => {
      const probe: DeferredProbe = { created: 0, destroyed: 0, destroyedHandles: [] };
      const g = new RenderGraph();
      g.addColorTarget('hdrColor', {
        format: 'rgba16float',
        size: 'swapchain',
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });

      g.setSwapChainSize(64, 64);
      g.compile({
        backendKind: 'webgpu',
        caps: deferredMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeDeferredDevice(probe) as any,
      });

      const destroyedBeforeResize = probe.destroyed;

      g.setSwapChainSize(128, 128);
      g.compile({
        backendKind: 'webgpu',
        caps: deferredMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: makeDeferredDevice(probe) as any,
      });

      // At resize: no destroy yet.
      expect(probe.destroyed - destroyedBeforeResize).toBe(0);

      // Reclaim: destroys pending items after queue.onSubmittedWorkDone resolves.
      // biome-ignore lint/suspicious/noExplicitAny: method not yet public
      await (g as any).reclaimRetiredTransients();

      // After reclaim, all pending items should be destroyed.
      expect(probe.destroyed - destroyedBeforeResize).toBeGreaterThanOrEqual(1);

      // biome-ignore lint/suspicious/noExplicitAny: internal field access in unit test
      const pending = (g as any).pendingDestroy as unknown[];
      expect(pending.length).toBe(0);
    });
  });
}

{
  // --- feat-20260619-gpu-resource-ownership-symmetric-release-primitive M3 / w10: AC-08 same-key destroy ---
  //
  // Defensive: when transientPool.set(key, pooled) overwrites an existing key,
  // the old PooledTexture.texture must be destroyed first (symmetric release).
  // Currently this code path is unreachable because set() only follows a get()
  // miss; the test exercises the guard through a private helper setTransientEntry
  // that encapsulates the has-check + destroy + set logic (added in w11).
  //
  // The guard (w11, inside allocateColorTargets) is:
  //   this.setTransientEntry(key, pooled)
  // where setTransientEntry does:
  //   if (this.transientPool.has(key)) {
  //     device.destroyTexture(this.transientPool.get(key)!.texture as Texture);
  //   }
  //   this.transientPool.set(key, pooled);
  //
  // This test directly calls setTransientEntry (internal, accessed via 'as any')
  // to verify the guard behavior. In RED phase (w10, no w11 yet), the method
  // does not exist — the test fails. In GREEN phase (w11), the method exists
  // and destroys the old texture before overwriting.

  function sameKeyMockCaps() {
    return {
      backendKind: 'webgpu' as const,
      compute: true,
      storageBuffer: true,
      storageTexture: false,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      indirectDrawing: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      rgba16floatRenderable: false,
      rg11b10ufloatRenderable: false,
      float32Filterable: false,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
    };
  }

  describe('transient pool same-key destroy (AC-08)', () => {
    it('old pooled texture is enqueued to pendingDestroy on same-key set overwrite', () => {
      const destroyedHandles: object[] = [];
      const mockDevice = {
        createTexture: (_desc: unknown) => ({
          ok: true as const,
          value: { __mock: `tex-${Date.now()}` },
        }),
        createTextureView: (_tex: unknown, _desc: unknown) => ({
          ok: true as const,
          value: { __mock: 'view' },
        }),
        destroyTexture: (tex: object) => {
          destroyedHandles.push(tex);
          return { ok: true as const, value: undefined };
        },
        queue: {
          onSubmittedWorkDone: () => Promise.resolve(undefined),
        },
      };

      const g = new RenderGraph();
      g.addColorTarget('hdrColor', {
        format: 'rgba16float',
        size: { w: 64, h: 64 },
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });

      // Compile to set lastDevice and populate transientPool.
      const r = g.compile({
        backendKind: 'webgpu',
        caps: sameKeyMockCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: mockDevice as any,
      });
      expect(r.ok).toBe(true);

      // Access internal transient pool to get an existing entry.
      // biome-ignore lint/suspicious/noExplicitAny: internal pool access in unit test
      const pool = (g as any).transientPool as Map<string, { texture: object; view: object }>;
      const entries = [...pool.entries()];
      expect(entries.length).toBeGreaterThanOrEqual(1);
      // biome-ignore lint/style/noNonNullAssertion: guarded by length check above
      const [key, oldEntry] = entries[0]!;
      const oldTexture = oldEntry.texture;

      const destroyedBeforeSet = destroyedHandles.length;

      // Call setTransientEntry to simulate same-key overwrite.
      // bug-20260622 D-1: old texture pushed to pendingDestroy, not
      // immediately destroyed.
      // biome-ignore lint/suspicious/noExplicitAny: internal method access in unit test
      (g as any).setTransientEntry(key, {
        texture: { __mock: 'replacement-tex' },
        view: { __mock: 'replacement-view' },
      });

      // No immediate destroy — entry is now in pendingDestroy queue.
      expect(destroyedHandles.length).toBe(destroyedBeforeSet);

      // biome-ignore lint/suspicious/noExplicitAny: internal field access in unit test
      const pending = (g as any).pendingDestroy as { texture: object; view: object }[];
      expect(pending.length).toBeGreaterThanOrEqual(1);
      expect(pending.some((p) => p.texture === oldTexture)).toBe(true);
    });
  });
}

{
  // --- w15: B-2 recover() clears pendingDestroy (feat-20260622-s5 M3) ---
  //
  // The recover() rebuild path (createRenderer M3) tears down the old device
  // and requests a fresh one. The render-graph's pendingDestroy queue still
  // holds PooledTexture handles minted against the OLD device; calling
  // destroyTexture on them against the NEW device is meaningless (and may
  // throw). recover() therefore drops the queue via clearPendingDestroy()
  // instead of draining it (B-2 / B-AC-02, plan-strategy D-5). This mirrors
  // the existing null-device fast path (`pendingDestroy.length = 0`) but is a
  // public method recover() can call directly.

  function clearPendingCaps() {
    return {
      backendKind: 'webgpu' as const,
      compute: true,
      storageBuffer: true,
      storageTexture: false,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      indirectDrawing: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      rgba16floatRenderable: false,
      rg11b10ufloatRenderable: false,
      float32Filterable: false,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
    };
  }

  // --- w20: B-1 destroyTexture error tolerance (feat-20260622-s5 M4) ---
  //
  // The render-graph's drain() and reclaimRetiredTransients() docstrings
  // claim per-handle destroy errors are tolerated (swallow-and-continue),
  // but the current implementation uses bare for-loops with no try/catch.
  // B-1 fixes the gap (plan-strategy D-4 / PD3): any single
  // device.destroyTexture failure must not interrupt the destroy chain
  // for subsequent handles. Test coverage (w20, B-AC-01):
  //   1. reclaimRetiredTransients snapshot loop — error on item 0,
  //      items 1..N-1 still destroyed, queue empty after.
  //   2. drain() loops (transient / pendingDestroy / persistent) — same
  //      per-handle tolerance policy via a shared mock device.

  function b1ToleranceCaps() {
    return {
      backendKind: 'webgpu' as const,
      compute: true,
      storageBuffer: true,
      storageTexture: false,
      timestampQuery: false,
      timestampPeriodNanoseconds: null,
      indirectDrawing: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      rgba16floatRenderable: false,
      rg11b10ufloatRenderable: false,
      float32Filterable: false,
      textureImport: false,
      externalTexture: false,
      maxColorAttachments: 8,
      rayQuery: RAY_QUERY_BACKEND_UNSUPPORTED,
    };
  }

  interface B1Probe {
    created: number;
    destroyed: number;
    destroyedHandles: object[];
    /** If non-negative, destroyTexture throws on this 0-based invocation. */
    throwOnCall: number;
    destroyCallCount: number;
  }

  function makeB1Device(probe: B1Probe): {
    // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
    [k: string]: any;
  } {
    return {
      createTexture: (_desc: unknown) => {
        probe.created += 1;
        const handle = { __mock: `tex-${probe.created}` };
        return { ok: true as const, value: handle };
      },
      createTextureView: (_tex: unknown, _desc: unknown) => {
        return { ok: true as const, value: { __mock: 'view' } };
      },
      destroyTexture: (tex: object) => {
        probe.destroyCallCount += 1;
        if (probe.destroyCallCount - 1 === probe.throwOnCall) {
          throw new Error('mock destroyTexture error (simulated)');
        }
        probe.destroyed += 1;
        probe.destroyedHandles.push(tex);
        return { ok: true as const, value: undefined };
      },
      queue: {
        onSubmittedWorkDone: () => Promise.resolve(undefined),
      },
    };
  }

  describe('B-1 destroyTexture error tolerance (w20)', () => {
    it('reclaimRetiredTransients: item-0 error does not stop item 1..N from being destroyed', async () => {
      const probe: B1Probe = {
        created: 0,
        destroyed: 0,
        destroyedHandles: [],
        throwOnCall: 0,
        destroyCallCount: 0,
      };
      const mockDevice = makeB1Device(probe);
      const g = new RenderGraph();
      g.addColorTarget('hdrColor', {
        format: 'rgba16float',
        size: { w: 64, h: 64 },
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });

      const r = g.compile({
        backendKind: 'webgpu',
        caps: b1ToleranceCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: mockDevice as any,
      });
      expect(r.ok).toBe(true);

      // Populate pendingDestroy with >= 3 entries by replacing the
      // transient pool entry three times (setTransientEntry pushes the
      // old one to pendingDestroy each time).
      // biome-ignore lint/suspicious/noExplicitAny: internal pool + pending access in unit test
      const pool = (g as any).transientPool as Map<string, { texture: object; view: object }>;
      for (let i = 0; i < 3; i++) {
        const [key] = [...pool.entries()][0] as [string, { texture: object }];
        // biome-ignore lint/suspicious/noExplicitAny: internal method access
        (g as any).setTransientEntry(key, {
          texture: { __mock: `entry-${i}` },
          view: { __mock: 'view' },
        });
      }

      // biome-ignore lint/suspicious/noExplicitAny: internal field access
      const pending = (g as any).pendingDestroy as { texture: object; view: object }[];
      expect(pending.length).toBe(3);

      // reclaimRetiredTransients takes a snapshot and calls
      // device.destroyTexture on each. Item 0 throws; items 1,2 must
      // still be destroyed (swallow-and-continue). The queue must be
      // empty afterwards.
      await expect(g.reclaimRetiredTransients()).resolves.toBeUndefined();

      // After reclaim: queue drained (items consumed from the snapshot;
      // snapshot was spliced before the loop, so pendingDestroy is empty
      // because the loop consumed the snapshot array in-place).
      expect(pending.length).toBe(0);

      // Item 0 threw, but items 1,2 succeeded -> at least 2 destroyed.
      expect(probe.destroyed).toBe(2);
      // destroyTexture was called 3 times (item 0 threw, items 1,2 succeeded).
      expect(probe.destroyCallCount).toBe(3);
    });

    it('drain: transient-pool destroy error on item 0 does not stop subsequent items from being destroyed', () => {
      const probe: B1Probe = {
        created: 0,
        destroyed: 0,
        destroyedHandles: [],
        throwOnCall: 0,
        destroyCallCount: 0,
      };
      const mockDevice = makeB1Device(probe);
      const g = new RenderGraph();
      g.addColorTarget('a', {
        format: 'rgba16float',
        size: { w: 32, h: 32 },
        sample: 1,
        usage: 0,
      });
      g.addColorTarget('b', {
        format: 'rgba8unorm',
        size: { w: 32, h: 32 },
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['a', 'b'] });

      const r = g.compile({
        backendKind: 'webgpu',
        caps: b1ToleranceCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: mockDevice as any,
      });
      expect(r.ok).toBe(true);

      // Both color targets created transient pool entries.
      // drain() walks transientPool.values(), then pendingDestroy, then
      // persistentTextures. With throwOnCall=0, the very first
      // destroyTexture (for the first transient pool entry) throws.
      // Subsequent entries must still be destroyed.
      //
      // We can't use compile+resize to enqueue pendingDestroy because
      // the recompile with the same device would use the same pool.
      // Instead we exercise the transient pool destroy path directly
      // via drain(), which walks all 3 loops. The transient pool has 2
      // entries (a,b). Item 0 throws, item 1 succeeds.
      const destroyedBefore = probe.destroyed;
      g.drain();

      // Item 1 was still destroyed after item 0 threw.
      // Transient pool has 2 entries -> at least 1 destroyed (item 0
      // threw, item 1 succeeded). pendingDestroy and persistent were
      // empty/cleared so no further calls.
      expect(probe.destroyed - destroyedBefore).toBe(1);
      expect(probe.destroyCallCount - destroyedBefore).toBe(2);
    });

    it('drain: pendingDestroy teardown error on item 0 does not stop subsequent items', () => {
      const probe: B1Probe = {
        created: 0,
        destroyed: 0,
        destroyedHandles: [],
        throwOnCall: 2, // throw on the 3rd destroy call (0-based)
        // transient pool has 2 entries -> calls 0,1
        // pendingDestroy has 3 entries -> calls 2,3,4
        // throwOnCall=2 -> error on pendingDestroy item 0
        destroyCallCount: 0,
      };
      const mockDevice = makeB1Device(probe);
      const g = new RenderGraph();
      g.addColorTarget('a', {
        format: 'rgba16float',
        size: { w: 32, h: 32 },
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['a'] });

      const r = g.compile({
        backendKind: 'webgpu',
        caps: b1ToleranceCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: mockDevice as any,
      });
      expect(r.ok).toBe(true);

      // Push 3 entries into pendingDestroy.
      for (let i = 0; i < 3; i++) {
        // biome-ignore lint/suspicious/noExplicitAny: internal field access
        (g as any).pendingDestroy.push({ texture: { __mock: `pd-${i}` }, view: { __mock: 'v' } });
      }

      const destroyedBefore = probe.destroyed;
      g.drain();

      // transient pool (1 entry) -> calls 0 (ok)
      // pendingDestroy (3 entries) -> call 1 throws (item 0 of pendingDestroy),
      //   calls 2,3 succeed (items 1,2 of pendingDestroy)
      // persistent -> empty, nothing
      // Total: call 0 ok + call 1 throw + call 2 ok + call 3 ok = 3 successes
      expect(probe.destroyed - destroyedBefore).toBe(3);
      // 4 total calls attempted
      expect(probe.destroyCallCount - destroyedBefore).toBe(4);
      // pendingDestroy cleared
      // biome-ignore lint/suspicious/noExplicitAny: internal field access
      expect(((g as any).pendingDestroy as unknown[]).length).toBe(0);
    });
  });

  describe('RenderGraph.clearPendingDestroy (B-2 / B-AC-02)', () => {
    it('clears the pendingDestroy queue without calling destroyTexture on stale handles', () => {
      const destroyedHandles: object[] = [];
      const mockDevice = {
        createTexture: (_desc: unknown) => ({
          ok: true as const,
          value: { __mock: `tex-${Date.now()}-${Math.random()}` },
        }),
        createTextureView: (_tex: unknown, _desc: unknown) => ({
          ok: true as const,
          value: { __mock: 'view' },
        }),
        destroyTexture: (tex: object) => {
          destroyedHandles.push(tex);
          return { ok: true as const, value: undefined };
        },
        queue: {
          onSubmittedWorkDone: () => Promise.resolve(undefined),
        },
      };

      const g = new RenderGraph();
      g.addColorTarget('hdrColor', {
        format: 'rgba16float',
        size: { w: 64, h: 64 },
        sample: 1,
        usage: 0,
      });
      g.addPass('main', { reads: [], writes: ['hdrColor'] });

      const r = g.compile({
        backendKind: 'webgpu',
        caps: clearPendingCaps(),
        // biome-ignore lint/suspicious/noExplicitAny: opaque mock device surface
        device: mockDevice as any,
      });
      expect(r.ok).toBe(true);

      // Populate pendingDestroy with a stale entry (simulating a resize-time
      // transient retirement that has not yet been reclaimed).
      // biome-ignore lint/suspicious/noExplicitAny: internal pool access in unit test
      const pool = (g as any).transientPool as Map<string, { texture: object; view: object }>;
      const [key, oldEntry] = [...pool.entries()][0] as [string, { texture: object; view: object }];
      // biome-ignore lint/suspicious/noExplicitAny: internal method access in unit test
      (g as any).setTransientEntry(key, {
        texture: { __mock: 'replacement-tex' },
        view: { __mock: 'replacement-view' },
      });
      // biome-ignore lint/suspicious/noExplicitAny: internal field access in unit test
      const pending = (g as any).pendingDestroy as { texture: object; view: object }[];
      expect(pending.length).toBeGreaterThanOrEqual(1);
      expect(pending.some((p) => p.texture === oldEntry.texture)).toBe(true);

      const destroyedBefore = destroyedHandles.length;

      // B-2: clearPendingDestroy empties the queue WITHOUT calling
      // destroyTexture (stale handles belong to the lost device).
      (g as { clearPendingDestroy: () => void }).clearPendingDestroy();

      expect(pending.length).toBe(0);
      // No destroyTexture call on the stale device handles.
      expect(destroyedHandles.length).toBe(destroyedBefore);
    });

    it('clearPendingDestroy on an empty queue is a safe no-op', () => {
      const g = new RenderGraph();
      expect(() => (g as { clearPendingDestroy: () => void }).clearPendingDestroy()).not.toThrow();
      // biome-ignore lint/suspicious/noExplicitAny: internal field access in unit test
      const pending = (g as any).pendingDestroy as unknown[];
      expect(pending.length).toBe(0);
    });
  });
}
