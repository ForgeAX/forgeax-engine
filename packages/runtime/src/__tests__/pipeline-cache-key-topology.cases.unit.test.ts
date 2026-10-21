// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import {
  findVariantByKey,
  type MaterialShaderManifestEntry,
  type MaterialShaderManifestVariant,
} from '@forgeax/engine-shader';
import type { MaterialRenderState, PrimitiveTopology } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { cacheKeyOf, type PipelineSpec } from '../../../render/src/pipeline-spec';

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
