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
import { HANDLE_CUBE, HANDLE_TRIANGLE, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { World as WorldType } from '@forgeax/engine-ecs';
import { defineComponent, World } from '@forgeax/engine-ecs';
import {
  buildMeshAttributeMapForUvSets,
  createBoxGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createPlaneGeometry,
  createSphereGeometry,
  createTorusGeometry,
  PROCEDURAL_FLOATS_PER_VERTEX,
} from '@forgeax/engine-geometry';
import { type Mat4, mat4, type Vec3, vec3 } from '@forgeax/engine-math';
import type { Renderer as RendererType } from '@forgeax/engine-render';
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import {
  err,
  ok,
  type PipelineLayout,
  type RenderPipeline,
  type Result,
  type RhiCaps,
  type RhiDevice,
  RhiError,
  ok as rhiOk,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import {
  acquireCanvasContext as acquireNullCanvasContext,
  createShaderModule as createNullShaderModule,
  RhiNullAdapter,
} from '@forgeax/engine-rhi-null';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import {
  findVariantByKey,
  type MaterialShaderEntry,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
} from '@forgeax/engine-shader';
import {
  type AssetError,
  type EquirectAsset,
  type Handle,
  type MaterialRenderState,
  type MeshAsset,
  type PassSelector,
  type PrimitiveTopology,
  type RenderPipelineAsset,
  type TextureAsset,
  toShared,
} from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bin,
  type ClusterBinError,
  calculateSphereClusterBounds,
  clusterSpaceObjectAabb,
  deriveCullingRadius,
  ndcPositionToCluster,
  viewZToZSlice,
} from '../../../render/src/cluster-binner';
import { GpuResidencyCache } from '../../../render/src/device/gpu-residency';
import { createEngineMetrics } from '../../../render/src/engine-metrics';
import { assertStorageBufferCap } from '../../../render/src/light-buffer-layout';
import {
  buildPbrPipelineLayouts,
  buildPbrViewBglEntries,
  type PbrCaps,
} from '../../../render/src/pbr-pipeline';
import {
  HdrpInstallError,
  validateClusterGrid,
} from '../../../render/src/pipeline/standard-pipeline';
import {
  buildPipelineForMaterialShader,
  type PipelineBuilderContext,
  type PipelineBuilderShaderModuleFactory,
} from '../../../render/src/pipeline-builder';
import {
  cacheKeyOf,
  createHdrpBindGroupLayoutDescriptor,
  type PipelineSpec,
} from '../../../render/src/pipeline-spec';
import {
  deriveRenderDataCubemap,
  deriveRenderDataMesh,
  deriveRenderDataTexture,
} from '../../../render/src/render-data';
import { prepareExtractContext } from '../../../render/src/render-system-extract';
import { extractFrame } from '../../../render/src/render-system-extract-tail';
import { matchPass } from '../../../render/src/systems/pass-selector';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';
import { standardMaterialShaderVariants } from './helpers/standard-material-manifest';

function makeExplicitNullRhi(spies: {
  setIndexBuffer: ReturnType<typeof vi.fn>;
  setVertexBuffer: ReturnType<typeof vi.fn>;
  draw: ReturnType<typeof vi.fn>;
  drawIndexed: ReturnType<typeof vi.fn>;
}): unknown {
  const adapter = new RhiNullAdapter();
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = async () => {
    const result = await requestDevice();
    if (result.ok) {
      const device = result.value;
      const createCommandEncoder = device.createCommandEncoder.bind(device);
      device.createCommandEncoder = (desc) => {
        const encoderResult = createCommandEncoder(desc);
        if (!encoderResult.ok) return encoderResult;
        const encoder = encoderResult.value;
        const beginRenderPass = encoder.beginRenderPass.bind(encoder);
        encoder.beginRenderPass = (passDesc) => {
          const pass = beginRenderPass(passDesc);
          const draw = pass.draw.bind(pass);
          const drawIndexed = pass.drawIndexed.bind(pass);
          const setIndexBuffer = pass.setIndexBuffer.bind(pass);
          const setVertexBuffer = pass.setVertexBuffer.bind(pass);
          pass.draw = (...args) => {
            spies.draw(...args);
            draw(...args);
          };
          pass.drawIndexed = (...args) => {
            spies.drawIndexed(...args);
            drawIndexed(...args);
          };
          pass.setIndexBuffer = (...args) => {
            spies.setIndexBuffer(...args);
            setIndexBuffer(...args);
          };
          pass.setVertexBuffer = (...args) => {
            spies.setVertexBuffer(...args);
            setVertexBuffer(...args);
          };
          return pass;
        };
        return { ok: true, value: encoder };
      };
    }
    return result;
  };
  return {
    requestAdapter: async () => ({ ok: true, value: adapter }),
    acquireCanvasContext: acquireNullCanvasContext,
    createShaderModule: (device: unknown, desc: { code: string; label?: string }) =>
      createNullShaderModule(device as never, desc),
  };
}

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

void [
  Camera,
  ChildOf,
  GpuResidencyCache,
  HANDLE_CUBE,
  HANDLE_TRIANGLE,
  HdrpInstallError,
  MeshFilter,
  MeshRenderer,
  PROCEDURAL_FLOATS_PER_VERTEX,
  RhiError,
  RhiNullAdapter,
  Transform,
  World,
  acquireNullCanvasContext,
  afterEach,
  assertStorageBufferCap,
  beforeEach,
  bin,
  buildMeshAttributeMapForUvSets,
  buildPbrPipelineLayouts,
  buildPbrViewBglEntries,
  buildPipelineForMaterialShader,
  cacheKeyOf,
  calculateSphereClusterBounds,
  clusterSpaceObjectAabb,
  createBoxGeometry,
  createConeGeometry,
  createCylinderGeometry,
  createEngineMetrics,
  createHdrpBindGroupLayoutDescriptor,
  createNullShaderModule,
  createPlaneGeometry,
  createSphereGeometry,
  createTorusGeometry,
  defineComponent,
  deriveCullingRadius,
  deriveRenderDataCubemap,
  deriveRenderDataMesh,
  deriveRenderDataTexture,
  describe,
  dirname,
  err,
  existsSync,
  expect,
  extractFrame,
  fileURLToPath,
  findVariantByKey,
  it,
  makeExplicitNullRhi,
  makeMockShaderRegistry,
  mat4,
  matchPass,
  ndcPositionToCluster,
  ok,
  prepareExtractContext,
  readFileSync,
  resolve,
  resolveAssetHandle,
  rhiOk,
  standardMaterialShaderVariants,
  toShared,
  validateClusterGrid,
  vec3,
  vi,
  viewZToZSlice,
];
type __MergedKeep =
  | AssetError
  | ClusterBinError
  | EquirectAsset
  | Handle
  | Mat4
  | MaterialRenderState
  | MaterialShaderEntry
  | MaterialShaderManifestEntry
  | MaterialShaderManifestVariant
  | MeshAsset
  | PassSelector
  | PbrCaps
  | PipelineBuilderContext
  | PipelineBuilderShaderModuleFactory
  | PipelineLayout
  | PipelineSpec
  | PrimitiveTopology
  | RenderPipeline
  | RenderPipelineAsset
  | RendererType
  | Result
  | RhiCaps
  | RhiDevice
  | ShaderModule
  | TextureAsset
  | Vec3
  | WorldType;

{
  // --- from pipeline-cache-key-topology.test.ts ---
  const ID = 'my-game::pulse-material';

  // Helper: construct PipelineSpec for cache-key unit tests (M2-T2 migration).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function mkSpec(
    id: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
    topology?: PrimitiveTopology,
    indexFormat?: 'uint16' | 'uint32',
    variantSet?: string,
    passKind: string = 'forward',
    sampleCount: 1 | 4 = 1,
  ): PipelineSpec {
    const colorFormat: GPUTextureFormat = isHdr
      ? ('rgba16float' as unknown as GPUTextureFormat)
      : ('bgra8unorm-srgb' as unknown as GPUTextureFormat);
    return {
      shader: { id, passKind, variantSet },
      attachments: {
        colorFormats: passKind === 'shadow-caster' ? [] : [colorFormat],
        depthFormat:
          passKind === 'shadow-caster'
            ? ('depth32float' as unknown as GPUTextureFormat)
            : ('depth24plus-stencil8' as unknown as GPUTextureFormat),
        sampleCount,
      },
      geometry: {
        topology: topology ?? 'triangle-list',
        stripIndexFormat: indexFormat,
        vertexLayout: {
          position: new Float32Array(0),
          normal: new Float32Array(0),
          uv: new Float32Array(0),
          tangent: new Float32Array(0),
        },
      },
      renderState,
    };
  }

  describe('per-spec pipeline cache key — topology dimension (AC-03/05/06)', () => {
    it('(a) AC-05: different topology -> different cache key (distinct PSO slots)', () => {
      const line = cacheKeyOf(mkSpec(ID, false, undefined, 'line-list'));
      const tri = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-list'));

      expect(line).not.toBe(tri);
    });

    it('(a) AC-05: topology difference holds with a renderState present', () => {
      const rs: MaterialRenderState = { cullMode: 'none' };
      const line = cacheKeyOf(mkSpec(ID, false, rs, 'line-list'));
      const tri = cacheKeyOf(mkSpec(ID, false, rs, 'triangle-list'));

      expect(line).not.toBe(tri);
    });

    it('(b) AC-03: omitted topology == explicit triangle-list (byte-identical key)', () => {
      const omitted = cacheKeyOf(mkSpec(ID, false, undefined, undefined));
      const explicit = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-list'));

      expect(omitted).toBe(explicit);
    });

    it('(b) AC-03: omitted topology key contains the :triangle-list segment', () => {
      const omitted = cacheKeyOf(mkSpec(ID, false, undefined, undefined));

      // M2-T4: key format is id:passKind:variantSet:colorFormat:depthFormat:
      // sampleCount:topology[:stripSegment]:vl:digest[:renderStateHash].
      // Strip segment is '' for non-strip topo → topology: followed by :vl:.
      expect(omitted.includes(':triangle-list:')).toBe(true);
      expect(omitted.includes(':vl:')).toBe(true);
    });

    it('(b) AC-03: omitted-topology + undefined-renderState key contains legacy shape prefix', () => {
      // M2-T4: key format changed — passKind:variantSet:colorFormats replaces
      // the pre-M2 :ldr segment. The prefix carries the full 4-axis structure;
      // vl:<hash> follows the topology segment.
      // bug-20260708 M2 (b): variantSet=undefined now serializes as sentinel
      // `~` (was empty segment `::`) to decouple undefined from canonical `''`.
      const key = cacheKeyOf(mkSpec('forgeax::default-pbr', false, undefined, undefined));

      expect(
        key.startsWith(
          'forgeax::default-pbr:forward:~:bgra8unorm-srgb:depth24plus-stencil8:1:triangle-list',
        ),
      ).toBe(true);
      // vl:<digest> segment present (vertex layout hash); may have trailing : from
      // renderStateHash('') at end of join
      expect(key).toMatch(/:vl:[^:]+/);
    });

    it('(c) AC-06: same tuple -> identical key (idempotent, cache hit)', () => {
      const rs: MaterialRenderState = { cullMode: 'front' };
      const k1 = cacheKeyOf(mkSpec(ID, true, rs, 'line-list'));
      const k2 = cacheKeyOf(mkSpec(ID, true, { ...rs }, 'line-list'));

      expect(k1).toBe(k2);
    });

    it('(d) topology is an independent segment, not folded into the renderState hash', () => {
      // Moving topology while holding renderState fixed must change the key, and
      // moving renderState while holding topology fixed must also change it --
      // proving the two dimensions are orthogonal (D-2 / D-A3).
      const base = cacheKeyOf(mkSpec(ID, false, { cullMode: 'none' }, 'triangle-list'));
      const topoMoved = cacheKeyOf(mkSpec(ID, false, { cullMode: 'none' }, 'line-list'));
      const rsMoved = cacheKeyOf(mkSpec(ID, false, { cullMode: 'front' }, 'triangle-list'));

      expect(base).not.toBe(topoMoved);
      expect(base).not.toBe(rsMoved);
      expect(topoMoved).not.toBe(rsMoved);
    });

    it('(d) every strip / list topology yields a distinct key segment', () => {
      const topologies: PrimitiveTopology[] = [
        'point-list',
        'line-list',
        'line-strip',
        'triangle-list',
        'triangle-strip',
      ];
      const keys = topologies.map((t) => cacheKeyOf(mkSpec(ID, false, undefined, t)));

      expect(new Set(keys).size).toBe(topologies.length);
    });
  });
  // ============================================================================
  // feat-20260609-hdrp-cluster-fragment-ggx M1 / w2
  // PSO cache key -- variantSet dimension (TDD red phase).
  // ============================================================================

  describe('per-spec pipeline cache key -- variantSet dimension (feat-20260609 M1)', () => {
    it('(a) different variantSet -> different cache key (distinct PSO slots)', () => {
      const k1 = cacheKeyOf(
        mkSpec(ID, false, undefined, 'triangle-list', undefined, 'STORAGE_BUFFER_AVAILABLE=true'),
      );
      const k2 = cacheKeyOf(
        mkSpec(
          ID,
          false,
          undefined,
          'triangle-list',
          undefined,
          'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true',
        ),
      );
      expect(k1).not.toBe(k2);
    });

    it('(b) same variantSet -> identical cache key (idempotent, cache hit)', () => {
      const vs = 'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true';
      const k1 = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-list', undefined, vs));
      const k2 = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-list', undefined, vs));
      expect(k1).toBe(k2);
    });

    it("(c) bug-20260708 M2 (b): variantSet '' (canonical all-true) and undefined produce DISTINCT keys via sentinel", () => {
      // bug-20260708 M2 (b) REVERSES the prior M4.5 D-11 normalize-to-same
      // behavior. `cacheKeyOf` now uses sentinel `~` for `variantSet=undefined`
      // and preserves `''` verbatim, so undefined vs canonical `''` land in
      // separate cache slots. This decoupling closes the R-11 collision that
      // let boot-seeded PIR=true modules leak into character sprite pipeline
      // requests (variantSet=undefined). See sentinel gate in
      // pipeline-cache-keying.unit.test.ts §'variantSet sentinel' as SSOT.
      const withUndefined = cacheKeyOf(
        mkSpec(ID, false, undefined, 'triangle-list', undefined, undefined),
      );
      const withEmpty = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-list', undefined, ''));
      expect(withUndefined).not.toBe(withEmpty);
      // Undefined key contains the `~` sentinel segment (position: after
      // shader.id + passKind, before colorFormats).
      expect(withUndefined).toContain(':~:');
      // Canonical `''` key contains an empty variantSet segment `::`.
      expect(withEmpty).toContain('::');
      expect(withUndefined.length).toBeGreaterThan(0);
      expect(withEmpty.length).toBeGreaterThan(0);
    });

    it("(e) M4.5 / D-11: canonical '' and expanded 'AXIS=true+...' all-true produce DIFFERENT keys", () => {
      const withEmpty = cacheKeyOf(mkSpec(ID, false, undefined, 'triangle-list', undefined, ''));
      const withExpandedAllTrue = cacheKeyOf(
        mkSpec(
          ID,
          false,
          undefined,
          'triangle-list',
          undefined,
          'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true',
        ),
      );
      expect(withEmpty).not.toBe(withExpandedAllTrue);
    });

    it('(d) variantSet is orthogonal to topology dimension', () => {
      const base = cacheKeyOf(
        mkSpec(ID, false, undefined, 'triangle-list', undefined, 'CLUSTER_FORWARD_AVAILABLE=true'),
      );
      const topoMoved = cacheKeyOf(
        mkSpec(ID, false, undefined, 'line-list', undefined, 'CLUSTER_FORWARD_AVAILABLE=true'),
      );
      const variantMoved = cacheKeyOf(
        mkSpec(ID, false, undefined, 'triangle-list', undefined, 'STORAGE_BUFFER_AVAILABLE=true'),
      );
      expect(base).not.toBe(topoMoved);
      expect(base).not.toBe(variantMoved);
      expect(topoMoved).not.toBe(variantMoved);
    });
  });

  // ============================================================================
  // feat-20260609-hdrp-cluster-fragment-ggx M4 / w30
  // runtime variant WGSL resolution -- variantSet -> correct variant WGSL (TDD red phase).
  // ============================================================================

  describe('runtime variant WGSL resolution from manifest (feat-20260609 M4 / w30)', () => {
    function makeEntry(
      identifier: string,
      defaultBindings: string,
      variants: readonly { definesKey: string; source: string; bindings: string }[],
    ): MaterialShaderManifestEntry {
      // M3 / w13: the binding-layout sidecar is gone from MaterialShader{Entry,ManifestEntry}
      // — paramSchema is the SSOT. The fixture below sets the per-variant
      // BGL hint into the composedWgsl as a comment marker so the
      // variant-resolution assertions can still distinguish HDRP-vs-URP
      // variants without the deleted binding-layout JSON-string.
      return {
        identifier,
        sourcePath: `${identifier}.wgsl`,
        composedWgsl: `// default wgsl for ${identifier} ${defaultBindings}`,
        paramSchema: '[]',
        variants: variants.map((v) => ({
          definesKey: v.definesKey,
          defines: Object.fromEntries(
            v.definesKey
              ? v.definesKey.split('+').map((kv) => {
                  const [k, val] = kv.split('=');
                  return [k, val === 'true'] as [string, boolean];
                })
              : [],
          ),
          composedWgsl: `${v.source} ${v.bindings}`,
        })) as readonly MaterialShaderManifestVariant[],
      };
    }

    const BGL_WITH_CLUSTER = JSON.stringify([
      { entries: [{ binding: 0, buffer: { hasDynamicOffset: true } }] },
      { entries: [] },
      {
        entries: [
          { binding: 0, buffer: { hasDynamicOffset: true } },
          { binding: 3, buffer: { type: 'read-only-storage' } },
          { binding: 4, buffer: { type: 'read-only-storage' } },
          { binding: 5, buffer: { type: 'read-only-storage' } },
          { binding: 6, buffer: { type: 'uniform' } },
        ],
      },
    ]);

    const BGL_WITHOUT_CLUSTER = JSON.stringify([
      { entries: [{ binding: 0, buffer: { hasDynamicOffset: true } }] },
      { entries: [] },
      {
        entries: [{ binding: 0, buffer: { hasDynamicOffset: true } }],
      },
    ]);

    const PBR_ID = 'forgeax::default-standard-pbr';
    const HDRP_DSK = 'CLUSTER_FORWARD_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true';
    const URP_DSK = 'STORAGE_BUFFER_AVAILABLE=true';

    // Helper to extract the per-variant BGL JSON the fixture appended to
    // composedWgsl. The test fixture (makeEntry) embeds the BGL JSON
    // string after the WGSL source body so variant resolution can be
    // asserted without the deleted MaterialShaderManifestVariant binding-layout sidecar
    // sidecar field (M3 / w13 grep gate).
    const extractBglJson = (composedWgsl: string | undefined): string | undefined => {
      if (composedWgsl === undefined) return undefined;
      const idx = composedWgsl.indexOf('[');
      return idx >= 0 ? composedWgsl.slice(idx) : undefined;
    };

    it('(a) HDRP variant resolves to WGSL with cluster bindings (binding 3..6 present)', () => {
      const entry = makeEntry(PBR_ID, BGL_WITHOUT_CLUSTER, [
        { definesKey: HDRP_DSK, source: '// HDRP variant WGSL', bindings: BGL_WITH_CLUSTER },
        { definesKey: URP_DSK, source: '// URP variant WGSL', bindings: BGL_WITHOUT_CLUSTER },
      ]);

      const variant = findVariantByKey(entry, HDRP_DSK);
      expect(variant).toBeDefined();
      expect(variant?.composedWgsl).toContain('// HDRP variant WGSL');

      const bglJson = extractBglJson(variant?.composedWgsl);
      expect(bglJson).toBeDefined();
      const bgl = JSON.parse(bglJson as string) as ReadonlyArray<{
        entries: ReadonlyArray<{ binding: number }>;
      }>;
      const group2 = bgl[2];
      expect(group2).toBeDefined();
      const bindings = group2?.entries.map((e) => e.binding);
      expect(bindings).toContain(3);
      expect(bindings).toContain(4);
      expect(bindings).toContain(5);
      expect(bindings).toContain(6);
    });

    it('(b) URP variant resolves to WGSL without cluster bindings (binding 3..6 absent)', () => {
      const entry = makeEntry(PBR_ID, BGL_WITH_CLUSTER, [
        { definesKey: HDRP_DSK, source: '// HDRP variant WGSL', bindings: BGL_WITH_CLUSTER },
        { definesKey: URP_DSK, source: '// URP variant WGSL', bindings: BGL_WITHOUT_CLUSTER },
      ]);

      const variant = findVariantByKey(entry, URP_DSK);
      expect(variant).toBeDefined();
      expect(variant?.composedWgsl).toContain('// URP variant WGSL');

      const bglJson = extractBglJson(variant?.composedWgsl);
      expect(bglJson).toBeDefined();
      const bgl = JSON.parse(bglJson as string) as ReadonlyArray<{
        entries: ReadonlyArray<{ binding: number }>;
      }>;
      const group2 = bgl[2];
      expect(group2).toBeDefined();
      const bindings = group2?.entries.map((e) => e.binding);
      expect(bindings).not.toContain(3);
      expect(bindings).not.toContain(4);
      expect(bindings).not.toContain(5);
      expect(bindings).not.toContain(6);
    });

    it('(c) empty variantSet (definesKey="") falls back to entry default composedWgsl', () => {
      const entry = makeEntry(PBR_ID, BGL_WITHOUT_CLUSTER, [
        { definesKey: HDRP_DSK, source: '// HDRP variant WGSL', bindings: BGL_WITH_CLUSTER },
        { definesKey: URP_DSK, source: '// URP variant WGSL', bindings: BGL_WITHOUT_CLUSTER },
      ]);

      const variant = findVariantByKey(entry, '');
      expect(variant).toBeUndefined();
    });

    it('(d) unknown variantSet returns undefined (fail-soft)', () => {
      const entry = makeEntry(PBR_ID, BGL_WITHOUT_CLUSTER, [
        { definesKey: URP_DSK, source: '// URP variant WGSL', bindings: BGL_WITHOUT_CLUSTER },
      ]);

      const variant4 = findVariantByKey(entry, 'NONEXISTENT_KEY=true');
      expect(variant4).toBeUndefined();
    });
  });

  // ============================================================================
  // bug-20260708 M2 (a) AC-03 / AC-04: sprite boot variant resolution.
  // Simulates the createRenderer boot-time material-shader registration
  // pattern (extended at line ~3687 to include PER_INSTANCE_REGION=false in
  // variantDefines). Asserts that a sprite-like manifest entry (with the PIR
  // axis) resolves to the PIR=false variant at boot, so per-entity spritePH
  // path (variantSet=undefined) sees PIR=false shader source via
  // installMaterialArtifact → lookup.value.source fallback.
  // ============================================================================
  describe('sprite boot variant resolution (bug-20260708 AC-03/AC-04)', () => {
    const SPRITE_ID = 'forgeax::sprite';

    function makeSpriteEntry(): MaterialShaderManifestEntry {
      // Sprite manifest emits a 2-axis Cartesian: PER_INSTANCE_REGION x
      // STORAGE_BUFFER_AVAILABLE. Canonical all-true `''` = PIR=true+SBA=true;
      // other 3 combinations get sorted-key definesKey strings.
      return {
        identifier: SPRITE_ID,
        sourcePath: 'sprite.wgsl',
        composedWgsl: '// sprite all-true (PIR=true+SBA=true, 5653B) default composedWgsl',
        paramSchema: '[]',
        variants: [
          {
            definesKey: '',
            defines: { PER_INSTANCE_REGION: true, STORAGE_BUFFER_AVAILABLE: true },
            composedWgsl: '// sprite PIR=true SBA=true 5653B instances[idx].region',
          },
          {
            definesKey: 'PER_INSTANCE_REGION=false+STORAGE_BUFFER_AVAILABLE=true',
            defines: { PER_INSTANCE_REGION: false, STORAGE_BUFFER_AVAILABLE: true },
            composedWgsl: '// sprite PIR=false SBA=true 5575B material.region',
          },
          {
            definesKey: 'PER_INSTANCE_REGION=true+STORAGE_BUFFER_AVAILABLE=false',
            defines: { PER_INSTANCE_REGION: true, STORAGE_BUFFER_AVAILABLE: false },
            composedWgsl:
              '// sprite PIR=true SBA=false 5653B (WebGL2 fallback) instances[idx].region',
          },
          {
            definesKey: 'PER_INSTANCE_REGION=false+STORAGE_BUFFER_AVAILABLE=false',
            defines: { PER_INSTANCE_REGION: false, STORAGE_BUFFER_AVAILABLE: false },
            composedWgsl: '// sprite PIR=false SBA=false 5575B (WebGL2 fallback) material.region',
          },
        ] as readonly MaterialShaderManifestVariant[],
      };
    }

    // Mirrors the createRenderer boot resolution at line ~3680-3696 (with the
    // bug-20260708 M2 (a) PER_INSTANCE_REGION=false extension). Extracted here
    // for testability — the actual createRenderer implementation is inline.
    // AC-03/AC-04 depend on this logic picking the PIR=false variant for
    // sprite; the test locks the outcome so an inline-logic drift is caught.
    function resolveBootDefinesKey(
      msEntry: MaterialShaderManifestEntry,
      opts: { readonly storageBufferCapable: boolean; readonly isHdrpActive: boolean },
    ): string {
      const variantDefines: Record<string, boolean> = {
        STORAGE_BUFFER_AVAILABLE: opts.storageBufferCapable,
      };
      if (msEntry.variants.some((v) => 'CLUSTER_FORWARD_AVAILABLE' in v.defines)) {
        variantDefines.CLUSTER_FORWARD_AVAILABLE = opts.isHdrpActive;
      }
      if (msEntry.variants.some((v) => 'PER_INSTANCE_REGION' in v.defines)) {
        variantDefines.PER_INSTANCE_REGION = false;
      }
      const sortedEntries = Object.entries(variantDefines).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return sortedEntries.every(([, v]) => v === true)
        ? ''
        : sortedEntries.map(([k, v]) => `${k}=${v}`).join('+');
    }

    it('(a) boot resolves sprite to PIR=false variant when storageBufferCapable=true (AC-03)', () => {
      const spriteEntry = makeSpriteEntry();
      const definesKey = resolveBootDefinesKey(spriteEntry, {
        storageBufferCapable: true,
        isHdrpActive: false,
      });
      expect(definesKey).toBe('PER_INSTANCE_REGION=false+STORAGE_BUFFER_AVAILABLE=true');
      const variant = findVariantByKey(spriteEntry, definesKey);
      expect(variant).toBeDefined();
      expect(variant?.defines.PER_INSTANCE_REGION).toBe(false);
      expect(variant?.defines.STORAGE_BUFFER_AVAILABLE).toBe(true);
      // The variant WGSL corresponds to the PIR=false 5575B variant that
      // reads region from material.region (M1 anchor).
      expect(variant?.composedWgsl).toContain('material.region');
      expect(variant?.composedWgsl).not.toContain('instances[idx].region');
    });

    it('(b) boot resolves sprite to PIR=false+SBA=false variant on WebGL2 fallback (AC-03)', () => {
      const spriteEntry = makeSpriteEntry();
      const definesKey = resolveBootDefinesKey(spriteEntry, {
        storageBufferCapable: false,
        isHdrpActive: false,
      });
      expect(definesKey).toBe('PER_INSTANCE_REGION=false+STORAGE_BUFFER_AVAILABLE=false');
      const variant = findVariantByKey(spriteEntry, definesKey);
      expect(variant).toBeDefined();
      expect(variant?.defines.PER_INSTANCE_REGION).toBe(false);
      expect(variant?.defines.STORAGE_BUFFER_AVAILABLE).toBe(false);
    });

    it('(c) SpriteInstances canonical PIR=true variant resolvable via findVariantByKey("") (AC-04)', () => {
      // SpriteInstances batches request `variantSet=''` via
      // SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET (bug-20260708 M2 (c)).
      // The runtime substitution branch in `getMaterialShaderPipeline`
      // (`createRenderer.ts:1730`) resolves this via findVariantByKey with
      // the canonical empty key — returning the PIR=true+SBA=true variant.
      const spriteEntry = makeSpriteEntry();
      const variant = findVariantByKey(spriteEntry, '');
      expect(variant).toBeDefined();
      expect(variant?.defines.PER_INSTANCE_REGION).toBe(true);
      expect(variant?.defines.STORAGE_BUFFER_AVAILABLE).toBe(true);
      // The variant WGSL corresponds to the PIR=true 5653B variant that
      // reads region from instances[idx].region (M1 anchor).
      expect(variant?.composedWgsl).toContain('instances[idx].region');
    });

    it('(d) boot PIR=false variant and canonical `""` PIR=true variant have distinct source (AC-04 module identity)', () => {
      // AC-04: sprite entities with no SpriteInstances (variantSet=undefined,
      // resolves via lookup.value to PIR=false source) and SpriteInstances
      // batches (variantSet='', resolves via findVariantByKey to PIR=true
      // source) MUST get different shader source strings — which in turn
      // produce different compiled shader modules (5575B vs 5653B). Same
      // materialShaderId, distinct module handles.
      const spriteEntry = makeSpriteEntry();
      const bootDefinesKey = resolveBootDefinesKey(spriteEntry, {
        storageBufferCapable: true,
        isHdrpActive: false,
      });
      const bootVariant = findVariantByKey(spriteEntry, bootDefinesKey);
      const spriteInstancesVariant = findVariantByKey(spriteEntry, '');
      expect(bootVariant?.composedWgsl).not.toBe(spriteInstancesVariant?.composedWgsl);
    });
  });
}
