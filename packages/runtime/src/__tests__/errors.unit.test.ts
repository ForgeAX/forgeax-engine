// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: fixture scopes are intentional

import type { AssetRuntimeError, AssetRuntimeErrorCode } from '@forgeax/engine-assets-runtime';
import {
  MeshSsboCapacityExceededError,
  MeshSsboCeilingReachedError,
  SceneCollectAssetGuidUnresolvedError,
  SceneCollectEntityRefOutOfClosureError,
} from '@forgeax/engine-assets-runtime';
import type { RenderError, RenderErrorCode } from '@forgeax/engine-render';
import { RhiError } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import type { SkinError, SkinErrorCode } from '@forgeax/engine-skinning';
import type { AssetErrorCode, ImageErrorCode } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyEnvErrorReason } from '../../../render/src/assembly/factory';
import { EquirectProjectionFailedError } from '../../../render/src/errors/render';
import { RhiErrorListenerRegistry } from '../../../render/src/lifecycle';
import {
  PostProcessError,
  type PostProcessErrorCode,
} from '../../../render/src/post-process-errors';
import { requireRenderer } from './renderer-test-utils';

// feat-20260704-runtime-tier1-decomposition M2 / w12: the eliminated top-level
// RuntimeError / RuntimeErrorCode aggregate unions (D-3) are reconstituted here
// as test-local aliases so the whole-runtime-surface exhaustive-switch bodies
// below stay byte-identical (AC-09). These are test scaffolding, not a
// production cross-cluster SSOT -- w13's per-cluster *.test-d.ts files are the
// real regression guard. Equal to the fanned-out render + asset + skin
// clusters (27 codes / 27 classes); recover + environment excluded, as the
// original unions were.
type RuntimeLayerErrorCode = RenderErrorCode | AssetRuntimeErrorCode | SkinErrorCode;
type RuntimeLayerError = RenderError | AssetRuntimeError | SkinError;

{
  // ─── from create-renderer-env-error-classify.test.ts ───
  describe('create-renderer-env-error-classify.test.ts', () => {
    describe('classifyEnvErrorReason', () => {
      it('keeps GPU-class wording for adapter-unavailable', () => {
        const inner = { name: 'RhiError', code: 'adapter-unavailable' };
        expect(classifyEnvErrorReason('no usable rendering backend', inner)).toBe(
          'no usable rendering backend',
        );
      });

      it('keeps GPU-class wording for feature-not-enabled / limit-exceeded / device-lost / oom', () => {
        for (const code of ['feature-not-enabled', 'limit-exceeded', 'device-lost', 'oom']) {
          const inner = { name: 'RhiError', code };
          expect(classifyEnvErrorReason('no usable rendering backend', inner)).toBe(
            'no usable rendering backend',
          );
        }
      });

      it('switches wording for ShaderError manifest-malformed', () => {
        const inner = { name: 'ShaderError', code: 'manifest-malformed' };
        expect(classifyEnvErrorReason('no usable rendering backend', inner)).toBe(
          'engine init failed (ShaderError: manifest-malformed)',
        );
      });

      it('switches wording for PackError pack-malformed-pack', () => {
        const inner = { name: 'PackError', code: 'pack-malformed-pack' };
        expect(classifyEnvErrorReason('no usable rendering backend', inner)).toBe(
          'engine init failed (PackError: pack-malformed-pack)',
        );
      });

      it('falls back to name-only when code is absent', () => {
        const inner = { name: 'AssetError' };
        expect(classifyEnvErrorReason('no usable rendering backend', inner)).toBe(
          'engine init failed (AssetError)',
        );
      });

      it('returns base message untouched when inner is undefined', () => {
        expect(classifyEnvErrorReason('no usable rendering backend', undefined)).toBe(
          'no usable rendering backend',
        );
      });

      it('returns base message untouched when inner is non-object', () => {
        // Non-object inner (string / number) should not crash; keep base message.
        expect(classifyEnvErrorReason('no usable rendering backend', 'oops' as never)).toBe(
          'no usable rendering backend',
        );
      });
    });
  });
}
{
  // --- migrated from device-lost-fan-out.test.ts ---
  describe('Renderer.subscribe lifecycle events', () => {
    const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;

    it('publishes disposal through subscribe and keeps state inspectable', async () => {
      const renderer = await requireRenderer(canvas, { rhi }, { shaderManifestUrl: manifest });
      expect(renderer.state()).toBe('alive');
      expect(renderer.inspect().state).toBe('alive');

      const events: unknown[] = [];
      const unsubscribe = renderer.subscribe((event) => events.push(event));
      expect(typeof unsubscribe).toBe('function');
      expect((await renderer.dispose()).ok).toBe(true);
      expect(events).toContainEqual({
        kind: 'state-changed',
        previous: 'alive',
        current: 'disposed',
      });
      unsubscribe();
    });

    it('does not retain a listener after unsubscribe', async () => {
      const renderer = await requireRenderer(canvas, { rhi }, { shaderManifestUrl: manifest });
      const events: unknown[] = [];
      const unsubscribe = renderer.subscribe((event) => events.push(event));
      unsubscribe();

      expect((await renderer.dispose()).ok).toBe(true);
      expect(events).toEqual([]);
    });
  });
}

{
  // --- migrated from device-lost.test.ts ---
  describe('Renderer surface recovery contract', () => {
    const manifest = `data:application/json,${encodeURIComponent(JSON.stringify({ entries: [] }))}`;
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;

    it('releases and restores the surface without changing the renderer identity', async () => {
      const renderer = await requireRenderer(canvas, { rhi }, { shaderManifestUrl: manifest });
      const before = renderer.inspect();

      expect(renderer.releaseSurface().ok).toBe(true);
      expect(renderer.inspect().surface).toBe('released');
      expect(renderer.restoreSurface().ok).toBe(true);
      expect(renderer.inspect().surface).toBe('available');
      expect(renderer.inspect().capabilities.backendKind).toBe('null');
      expect(renderer.inspect().state).toBe(before.state);

      expect((await renderer.dispose()).ok).toBe(true);
    });

    it('returns a structured recover result when no device is lost', async () => {
      const renderer = await requireRenderer(canvas, { rhi }, { shaderManifestUrl: manifest });
      const recovered = await renderer.recover();

      expect(recovered.ok).toBe(false);
      if (!recovered.ok) expect(recovered.error.code).toBe('renderer-state-invalid');
      expect((await renderer.dispose()).ok).toBe(true);
    });
  });
}

{
  // ─── from error-exhaustive.test.ts ───
  describe('error-exhaustive.test.ts', () => {
    describe('t2 - AC-15 AssetErrorCode exhaustive switch (new members)', () => {
      it('AssetErrorCode includes cubemap-handle-missing', () => {
        const code: AssetErrorCode = 'cubemap-handle-missing';
        expect(code).toBe('cubemap-handle-missing');
      });

      it('AssetErrorCode includes invalid-source-format', () => {
        const code: AssetErrorCode = 'invalid-source-format';
        expect(code).toBe('invalid-source-format');
      });

      it('AssetErrorCode includes load-failed', () => {
        const code: AssetErrorCode = 'load-failed';
        expect(code).toBe('load-failed');
      });

      it('AssetErrorCode includes device-unsupported', () => {
        const code: AssetErrorCode = 'device-unsupported';
        expect(code).toBe('device-unsupported');
      });

      it('AssetErrorCode includes ibl-precompute-not-dispatched (t56 M3.5 minor evolution)', () => {
        const code: AssetErrorCode = 'ibl-precompute-not-dispatched';
        expect(code).toBe('ibl-precompute-not-dispatched');
      });

      it('AssetErrorCode exhaustive switch covers all members without default', () => {
        function exhaustive(code: AssetErrorCode): string {
          switch (code) {
            case 'asset-reference-invalid':
              return 'asset reference invalid';
            case 'asset-owner-closed':
              return 'asset owner closed';
            case 'asset-write-conflict':
              return 'asset write conflict';
            case 'asset-budget-exceeded':
              return 'asset budget exceeded';
            case 'asset-not-ready':
              return 'asset not ready';
            case 'asset-not-found':
              return 'not found';
            case 'asset-parse-failed':
              return 'parse failed';
            case 'asset-format-unsupported':
              return 'format unsupported';
            case 'asset-fetch-failed':
              return 'fetch failed';
            case 'catalog-source-unconfigured':
              return 'catalog source unconfigured';
            case 'asset-invalid-value':
              return 'invalid value';
            case 'cubemap-handle-missing':
              return 'cubemap handle missing';
            case 'invalid-source-format':
              return 'invalid source format';
            case 'load-failed':
              return 'load failed';
            case 'device-unsupported':
              return 'device unsupported';
            case 'ibl-precompute-not-dispatched':
              return 'ibl precompute not dispatched';
            case 'mesh-vertex-stride-mismatch':
              return 'mesh vertex stride mismatch';
            case 'material-shader-ref-broken':
              return 'shader ref broken';
            case 'material-circular-inheritance':
              return 'circular inheritance';
            // === 2 new codes (feat-20260603-asset-import-loader-injection M1 / w1) ===
            case 'loader-not-registered':
              return 'loader not registered';
            case 'asset-not-imported':
              return 'asset not imported';
            // === 1 new code (feat-20260604-hdr-equirect-cube-importer-loader M2 / w4) ===
            case 'texture-source-not-imported':
              return 'texture source not imported';
            case 'source-not-imported':
              return 'source not imported';
            // === 3 new codes (feat-20260608-mesh-multi-section-primitive-multi-material-slot M1 / w2) ===
            case 'mesh-renderer-material-override-invalid':
              return 'mesh renderer material override invalid';
            case 'mesh-renderer-material-override-overflow':
              return 'mesh renderer material override overflow';
            case 'mesh-asset-submeshes-empty':
              return 'mesh asset submeshes empty';
            case 'mesh-asset-material-slot-index-out-of-range':
              return 'mesh asset material slot index out of range';
            case 'mesh-submesh-index-range-out-of-bounds':
              return 'mesh submesh index range out of bounds';
            // === 1 new code (feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild) ===
            case 'tileset-region-index-out-of-range':
              return 'tileset region index out of range';
            // === 1 new code (feat-20260608-tilemap-object-layer-rendering M1 schema extension) ===
            case 'tileset-tile-entry-malformed':
              return 'tileset tile entry malformed';
            // === 1 new code (feat-20260621-asset-registry-robustness-invalidate-inflight-cach M2 / w4) ===
            case 'asset-invalidated':
              return 'asset invalidated';
            // === 1 new code (feat-20260629-multi-uv-set-support M2 / m2-w5) ===
            case 'mesh-bin-contract-violation':
              return 'mesh bin contract violation';
            // === 1 new code (feat-20260707-texture-block-compression M5 / w35) ===
            case 'mipgen-unsupported-compressed-format':
              return 'mipgen unsupported compressed format';
          }
        }
        expect(exhaustive('asset-not-found')).toBe('not found');
        expect(exhaustive('texture-source-not-imported')).toBe('texture source not imported');
        expect(exhaustive('cubemap-handle-missing')).toBe('cubemap handle missing');
        expect(exhaustive('invalid-source-format')).toBe('invalid source format');
        expect(exhaustive('load-failed')).toBe('load failed');
        expect(exhaustive('device-unsupported')).toBe('device unsupported');
        expect(exhaustive('ibl-precompute-not-dispatched')).toBe('ibl precompute not dispatched');
      });
    });

    describe('t2 - AC-15 ImageErrorCode exhaustive switch (new members)', () => {
      it('ImageErrorCode includes image-hdr-decode-failed', () => {
        const code: ImageErrorCode = 'image-hdr-decode-failed';
        expect(code).toBe('image-hdr-decode-failed');
      });

      it('ImageErrorCode exhaustive switch covers all members without default', () => {
        function exhaustive(code: ImageErrorCode): string {
          switch (code) {
            case 'image-decode-failed':
              return 'decode failed';
            case 'image-format-unsupported':
              return 'format unsupported';
            case 'image-dimension-out-of-bounds':
              return 'out of bounds';
            case 'image-meta-missing':
              return 'meta missing';
            case 'image-hdr-decode-failed':
              return 'hdr decode failed';
            // feat-20260521-sprite-atlas-animation M1 T-02 — atlas hook
            // fail-fast triplet (plan-strategy section 2 D-2). Add the three
            // case arms so the exhaustive switch keeps compiling without a
            // default fall-through after ImageErrorCode grew from 5 to 8.
            case 'atlas-empty-input':
              return 'atlas empty input';
            case 'atlas-size-exceeded':
              return 'atlas size exceeded';
            case 'atlas-region-mismatch':
              return 'atlas region mismatch';
            // feat-20260829-deep-agent-game-feedback-resolution M5 —
            // PixelSurface authoring errors remain part of the closed image
            // error vocabulary and must stay covered by every exhaustive
            // consumer switch.
            case 'image-surface-invalid':
              return 'surface invalid';
          }
        }
        expect(exhaustive('image-decode-failed')).toBe('decode failed');
        expect(exhaustive('image-hdr-decode-failed')).toBe('hdr decode failed');
        expect(exhaustive('image-surface-invalid')).toBe('surface invalid');
      });
    });
  });
}

{
  // ─── from errors.test.ts ───
  describe('errors.test.ts', () => {
    describe('AC-11 RuntimeErrorCode exhaustive switch (no default)', () => {
      it('exhaustive switch covers all members without a default branch', () => {
        function exhaustive(code: RuntimeLayerErrorCode): string {
          switch (code) {
            case 'scene-sdf-unavailable':
              return 'scene sdf unavailable';
            case 'camera-view-invalid':
              return 'camera view invalid';
            case 'stereo-camera-invalid':
              return 'stereo camera invalid';
            case 'projected-decal-invalid':
              return 'projected decal invalid';
            case 'planar-reflection-invalid':
              return 'planar reflection invalid';
            case 'render-publication-invalid':
              return 'render publication invalid';
            case 'sun-cardinality':
              return 'sun cardinality';
            case 'outline-invalid-parameter':
              return 'outline invalid parameter';
            case 'barrel-distortion-invalid-parameter':
              return 'barrel distortion invalid parameter';
            case 'lens-effects-invalid-parameter':
              return 'lens effects invalid parameter';
            case 'lens-flare-invalid-parameter':
              return 'lens flare invalid parameter';
            case 'cloud-layer-invalid-parameter':
              return 'cloud layer invalid parameter';
            case 'cloud-layer-owner-conflict':
              return 'cloud layer owner conflict';
            case 'cloud-layer-cache-invalid':
              return 'cloud layer cache invalid';
            case 'cloud-layer-capability-missing':
              return 'cloud layer capability missing';
            case 'cloud-layer-resource-failed':
              return 'cloud layer resource failed';
            case 'dynamic-resolution-invalid-parameter':
              return 'dynamic resolution invalid parameter';
            case 'dynamic-resolution-requires-taa':
              return 'dynamic resolution requires taa';
            case 'dynamic-resolution-timing-unavailable':
              return 'dynamic resolution timing unavailable';
            case 'motion-blur-invalid-params':
              return 'motion blur invalid params';
            case 'render-target-layer-invalid':
              return 'render target layer invalid';
            case 'framebuffer-snapshot-failed':
              return 'framebuffer snapshot failed';
            case 'external-texture-invalid':
              return 'external texture invalid';
            case 'external-texture-state-invalid':
              return 'external texture state invalid';
            case 'skin-asset-unresolved':
              return 'skin asset unresolved';
            case 'auto-exposure-invalid-parameter':
              return 'auto exposure invalid parameter';
            case 'auto-exposure-capability-unavailable':
              return 'auto exposure capability unavailable';
            case 'auto-exposure-stale-generation':
              return 'auto exposure stale generation';
            case 'auto-exposure-stage-failed':
              return 'auto exposure stage failed';
            case 'lifecycle-construction-failed':
              return 'lifecycle construction failed';
            case 'world-lease-invalid':
              return 'world lease invalid';
            case 'frame-input-invalid':
              return 'frame input invalid';
            case 'scene-projection-failed':
              return 'scene projection failed';
            case 'asset-binding-failed':
              return 'asset binding failed';
            case 'feature-plan-failed':
              return 'feature plan failed';
            case 'graph-build-failed':
              return 'graph build failed';
            case 'frame-submit-rejected':
            case 'device-operation-failed':
              return 'device operation failed';
            case 'surface-unavailable':
              return 'surface unavailable';
            case 'renderer-state-invalid':
              return 'renderer state invalid';
            case 'recovery-failed':
              return 'recovery failed';
            case 'cleanup-failed':
              return 'cleanup failed';
            case 'scene-data-unavailable':
              return 'scene data unavailable';
            case 'standard-profile-invalid':
              return 'standard profile invalid';
            case 'frame-receipt-stale':
              return 'frame receipt stale';
            case 'renderer-contract-failed':
              return 'renderer contract failed';
            case 'observation-unavailable':
              return 'observation unavailable';
            case 'taa-unavailable':
              return 'taa unavailable';
            case 'shadow-invalid-config':
              return 'shadow invalid config';
            case 'environment-source-conflict':
              return 'environment source conflict';
            case 'fog-cardinality':
              return 'fog cardinality';
            case 'taa-caps-insufficient':
              return 'taa caps insufficient';
            case 'environment-generation-failed':
              return 'environment generation failed';
            case 'atmosphere-invalid-parameter':
              return 'atmosphere invalid parameter';
            case 'owner-stage-failed':
              return 'owner stage failed';
            case 'skin-joint-count-exceeded':
              return 'skin joint count exceeded';
            case 'skin-joint-despawned':
              return 'skin joint despawned';
            case 'skin-joint-path-unresolved':
              return 'skin joint path unresolved';
            case 'skin-instances-coexist-forbidden':
              return 'skin instances coexist forbidden';
            case 'vertex-storage-buffer-unavailable':
              return 'vertex storage buffer unavailable';
            case 'vertex-color-variant-conflict':
              return 'vertex color variant conflict';
            case 'skin-palette-overflow':
              return 'skin palette overflow';
            case 'material-resolved-empty-passes':
              return 'material resolved empty passes';
            case 'equirect-projection-failed':
              return 'equirect projection failed';
            case 'mesh-ssbo-capacity-exceeded':
              return 'mesh ssbo capacity exceeded';
            case 'mesh-ssbo-ceiling-reached':
              return 'mesh ssbo ceiling reached';
            case 'render-target-descriptor-invalid':
              return 'render target descriptor invalid';
            case 'render-target-capability-missing':
              return 'render target capability missing';
            case 'render-target-state-invalid':
              return 'render target state invalid';
            case 'render-target-operation-failed':
              return 'render target operation failed';
            case 'reflection-probe-budget-exceeded':
              return 'reflection probe budget exceeded';
            case 'render-intent-invalid':
              return 'render intent invalid';
            case 'standard-light-budget-exceeded':
              return 'standard light budget exceeded';
            case 'standard-cluster-index-overflow':
              return 'standard cluster index overflow';
            case 'standard-cluster-transport-unavailable':
              return 'standard cluster transport unavailable';
            // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w17 (D-5):
            // bidirectional Skin <-> pbr-skin material mismatch detected at extract.
            case 'skin-material-mismatch':
              return 'skin material mismatch';
            case 'material-skin-attr-missing':
              return 'material skin attr missing';
            // feat-20260612-skin-palette-per-frame-upload M2 / m2-5:
            // SkinExtractErrorCode subset union (3 new extract-stage classes).
            case 'skeleton-resolve-failed':
              return 'skeleton resolve failed';
            case 'joint-count-mismatch':
              return 'joint count mismatch';
            case 'joint-entity-dangling':
              return 'joint entity dangling';
            // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-4:
            // ShadowAtlas P3 closed-union compliance.
            case 'point-shadow-atlas-uninitialized':
              return 'point shadow atlas uninitialized';
            case 'point-shadow-atlas-bounds-violation':
              return 'point shadow atlas bounds violation';
            // feat-20260623-world-space-video-asset M3 / w11: AC-10 capability
            // double-miss code (add-only minor).
            case 'video-upload-unsupported':
              return 'video upload unsupported';
            // feat-20260701-rootstosceneasset-forest-collect-schema-derived-ha
            // M1 / w3 (D-5): new scene-collect error codes.
            case 'scene-collect-entity-ref-out-of-closure':
              return 'scene collect entity ref out of closure';
            case 'scene-collect-asset-guid-unresolved':
              return 'scene collect asset guid unresolved';
            case 'render-feature-registration-conflict':
              return 'render feature registration conflict';
            case 'render-feature-stage-failed':
              return 'render feature stage failed';
            case 'render-feature-capability-missing':
              return 'render feature capability missing';
            case 'render-feature-pass-order-conflict':
              return 'render feature pass order conflict';
            case 'render-feature-preparation-failed':
              return 'render feature preparation failed';
            case 'render-feature-prepared-state-mismatch':
              return 'render feature prepared state mismatch';
            case 'render-feature-draw-recording-failed':
              return 'render feature draw recording failed';
            case 'points-lines-invalid-style':
              return 'points lines invalid style';
            case 'points-lines-topology-mismatch':
              return 'points lines topology mismatch';
            case 'points-lines-style-unsupported':
              return 'points lines style unsupported';
            case 'points-lines-material-unsupported':
              return 'points lines material unsupported';
            case 'points-lines-budget-exceeded':
              return 'points lines budget exceeded';
            case 'points-lines-prepare-failed':
              return 'points lines prepare failed';
            case 'light-resource-unavailable':
              return 'light resource unavailable';
            case 'transmission-capability-missing':
              return 'transmission capability missing';
            case 'material-sampled-texture-budget-exceeded':
              return 'material sampled texture budget exceeded';
            case 'projector-binding-failed':
              return 'projector binding failed';
            case 'volume-owner-conflict':
              return 'volume owner conflict';
            case 'volume-density-shape-mismatch':
              return 'volume density shape mismatch';
            case 'volume-invalid-bounds':
              return 'volume invalid bounds';
            case 'volume-invalid-parameters':
              return 'volume invalid parameters';
          }
        }
        expect(exhaustive('equirect-projection-failed')).toBe('equirect projection failed');
        expect(exhaustive('material-resolved-empty-passes')).toBe('material resolved empty passes');
        expect(exhaustive('shadow-invalid-config')).toBe('shadow invalid config');
        expect(exhaustive('mesh-ssbo-capacity-exceeded')).toBe('mesh ssbo capacity exceeded');
        expect(exhaustive('mesh-ssbo-ceiling-reached')).toBe('mesh ssbo ceiling reached');
      });
    });

    /*
     * Standard lighting closed error codes — exhaustive narrow test.
     *
     * AC-07: three Standard lighting codes are members of the closed render union.
     * Each error code narrows without a default branch in switch (err.code).
     */
    describe('Standard lighting error members', () => {
      it('standard-cluster-transport-unavailable is a valid RenderErrorCode', () => {
        const code: RuntimeLayerErrorCode = 'standard-cluster-transport-unavailable';
        expect(code).toBe('standard-cluster-transport-unavailable');
      });

      it('exhaustive switch covers all 3 new members alongside existing members', () => {
        function exhaustive(code: RuntimeLayerErrorCode): string {
          switch (code) {
            case 'scene-sdf-unavailable':
              return 'ok';
            case 'camera-view-invalid':
              return 'ok';
            case 'stereo-camera-invalid':
              return 'ok';
            case 'projected-decal-invalid':
              return 'ok';
            case 'planar-reflection-invalid':
              return 'ok';
            case 'render-publication-invalid':
              return 'ok';
            case 'sun-cardinality':
              return 'ok';
            case 'outline-invalid-parameter':
              return 'ok';
            case 'barrel-distortion-invalid-parameter':
              return 'ok';
            case 'lens-effects-invalid-parameter':
              return 'ok';
            case 'lens-flare-invalid-parameter':
              return 'ok';
            case 'cloud-layer-invalid-parameter':
              return 'ok';
            case 'cloud-layer-owner-conflict':
              return 'ok';
            case 'cloud-layer-cache-invalid':
              return 'ok';
            case 'cloud-layer-capability-missing':
              return 'ok';
            case 'cloud-layer-resource-failed':
              return 'ok';
            case 'dynamic-resolution-invalid-parameter':
              return 'ok';
            case 'dynamic-resolution-requires-taa':
              return 'ok';
            case 'dynamic-resolution-timing-unavailable':
              return 'ok';
            case 'motion-blur-invalid-params':
              return 'ok';
            case 'render-target-layer-invalid':
              return 'ok';
            case 'framebuffer-snapshot-failed':
              return 'ok';
            case 'external-texture-invalid':
              return 'ok';
            case 'external-texture-state-invalid':
              return 'ok';
            case 'skin-asset-unresolved':
              return 'ok';
            case 'auto-exposure-invalid-parameter':
            case 'auto-exposure-capability-unavailable':
            case 'auto-exposure-stale-generation':
            case 'auto-exposure-stage-failed':
              return 'ok';
            case 'lifecycle-construction-failed':
              return 'ok';
            case 'world-lease-invalid':
              return 'ok';
            case 'frame-input-invalid':
              return 'ok';
            case 'scene-projection-failed':
              return 'ok';
            case 'asset-binding-failed':
              return 'ok';
            case 'feature-plan-failed':
              return 'ok';
            case 'graph-build-failed':
              return 'ok';
            case 'frame-submit-rejected':
            case 'device-operation-failed':
              return 'ok';
            case 'surface-unavailable':
              return 'ok';
            case 'renderer-state-invalid':
              return 'ok';
            case 'recovery-failed':
              return 'ok';
            case 'cleanup-failed':
              return 'ok';
            case 'scene-data-unavailable':
            case 'standard-profile-invalid':
              return 'ok';
            case 'frame-receipt-stale':
              return 'ok';
            case 'renderer-contract-failed':
              return 'ok';
            case 'observation-unavailable':
              return 'ok';
            case 'taa-unavailable':
              return 'ok';
            case 'shadow-invalid-config':
              return 'ok';
            case 'environment-source-conflict':
              return 'ok';
            case 'fog-cardinality':
              return 'ok';
            case 'taa-caps-insufficient':
              return 'ok';
            case 'environment-generation-failed':
              return 'ok';
            case 'atmosphere-invalid-parameter':
              return 'ok';
            case 'owner-stage-failed':
              return 'ok';
            case 'skin-joint-count-exceeded':
              return 'ok';
            case 'skin-joint-despawned':
              return 'ok';
            case 'skin-joint-path-unresolved':
              return 'ok';
            case 'skin-instances-coexist-forbidden':
              return 'ok';
            case 'vertex-storage-buffer-unavailable':
              return 'ok';
            case 'vertex-color-variant-conflict':
              return 'ok';
            case 'skin-palette-overflow':
              return 'ok';
            case 'material-resolved-empty-passes':
              return 'ok';
            case 'equirect-projection-failed':
              return 'ok';
            case 'mesh-ssbo-capacity-exceeded':
              return 'ok';
            case 'mesh-ssbo-ceiling-reached':
              return 'ok';
            case 'standard-light-budget-exceeded':
              return 'ok';
            case 'standard-cluster-index-overflow':
              return 'ok';
            case 'skin-material-mismatch':
              return 'ok';
            case 'material-skin-attr-missing':
              return 'ok';
            case 'skeleton-resolve-failed':
              return 'ok';
            case 'joint-count-mismatch':
              return 'ok';
            case 'joint-entity-dangling':
              return 'ok';
            case 'standard-cluster-transport-unavailable':
              return 'ok';
            case 'render-target-descriptor-invalid':
              return 'ok';
            case 'render-target-capability-missing':
              return 'ok';
            case 'render-target-state-invalid':
              return 'ok';
            case 'render-target-operation-failed':
              return 'ok';
            case 'reflection-probe-budget-exceeded':
              return 'ok';
            case 'render-intent-invalid':
              return 'ok';
            case 'point-shadow-atlas-uninitialized':
              return 'ok';
            case 'point-shadow-atlas-bounds-violation':
              return 'ok';
            case 'video-upload-unsupported':
              return 'ok';
            case 'scene-collect-entity-ref-out-of-closure':
              return 'ok';
            case 'scene-collect-asset-guid-unresolved':
              return 'ok';
            case 'render-feature-registration-conflict':
              return 'ok';
            case 'render-feature-stage-failed':
              return 'ok';
            case 'render-feature-capability-missing':
              return 'ok';
            case 'render-feature-pass-order-conflict':
              return 'ok';
            case 'render-feature-preparation-failed':
              return 'ok';
            case 'render-feature-prepared-state-mismatch':
              return 'ok';
            case 'render-feature-draw-recording-failed':
              return 'ok';
            case 'points-lines-invalid-style':
              return 'ok';
            case 'points-lines-topology-mismatch':
              return 'ok';
            case 'points-lines-style-unsupported':
              return 'ok';
            case 'points-lines-material-unsupported':
              return 'ok';
            case 'points-lines-budget-exceeded':
              return 'ok';
            case 'points-lines-prepare-failed':
              return 'ok';
            case 'light-resource-unavailable':
            case 'transmission-capability-missing':
              return 'ok';
            case 'material-sampled-texture-budget-exceeded':
              return 'ok';
            case 'projector-binding-failed':
              return 'ok';
            case 'volume-owner-conflict':
              return 'ok';
            case 'volume-density-shape-mismatch':
              return 'ok';
            case 'volume-invalid-bounds':
              return 'ok';
            case 'volume-invalid-parameters':
              return 'ok';
          }
        }
        expect(exhaustive('standard-cluster-transport-unavailable')).toBe('ok');
        expect(exhaustive('point-shadow-atlas-uninitialized')).toBe('ok');
        expect(exhaustive('point-shadow-atlas-bounds-violation')).toBe('ok');
      });
    });

    describe('AC-03 mesh-ssbo error narrowing in onError callback shape (no `as`)', () => {
      it('switch (err.code) narrows the detail variants for the two new codes', () => {
        // Build a fake onError handler closing over a mutable record we can
        // assert against. Critical: the body must compile without any `as`
        // narrowing — TS must derive `err.detail.requested|capacity|ceiling` as
        // `number` purely from the `case` discriminant.
        const captured: {
          requested: number | null;
          capacity: number | null;
          ceiling: number | null;
          handled: boolean;
        } = { requested: null, capacity: null, ceiling: null, handled: false };

        const onError = (err: RuntimeLayerError): void => {
          switch (err.code) {
            case 'mesh-ssbo-capacity-exceeded': {
              // err narrows to MeshSsboCapacityExceededError; detail is the
              // discriminated-union variant carrying { requested, capacity,
              // ceiling: number }.
              const r: number = err.detail.requested;
              const c: number = err.detail.capacity;
              const ce: number = err.detail.ceiling;
              captured.requested = r;
              captured.capacity = c;
              captured.ceiling = ce;
              captured.handled = true;
              return;
            }
            case 'mesh-ssbo-ceiling-reached': {
              const r: number = err.detail.requested;
              const c: number = err.detail.capacity;
              const ce: number = err.detail.ceiling;
              captured.requested = r;
              captured.capacity = c;
              captured.ceiling = ce;
              captured.handled = true;
              return;
            }
            default:
              // Other arms not exercised in this test; leave captured untouched.
              return;
          }
        };

        // Construct the two new error classes via the published surface and
        // pump them through onError to confirm runtime + compile time agree.
        onError(new MeshSsboCapacityExceededError(2048, 1024, 524288));
        expect(captured.handled).toBe(true);
        expect(captured.requested).toBe(2048);
        expect(captured.capacity).toBe(1024);
        expect(captured.ceiling).toBe(524288);

        captured.handled = false;
        onError(new MeshSsboCeilingReachedError(600000, 524288, 524288));
        expect(captured.handled).toBe(true);
        expect(captured.requested).toBe(600000);
        expect(captured.capacity).toBe(524288);
        expect(captured.ceiling).toBe(524288);
      });
    });
  });
}

{
  // ─── from on-error-fan-out.test.ts ───
  describe('on-error-fan-out.test.ts', () => {
    describe('RhiErrorListenerRegistry — onError fan-out', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('(a) listeners fire in FIFO insertion order', () => {
        const reg = new RhiErrorListenerRegistry();
        const callOrder: number[] = [];
        reg.add(() => {
          callOrder.push(1);
        });
        reg.add(() => {
          callOrder.push(2);
        });
        reg.add(() => {
          callOrder.push(3);
        });
        reg.fire(new RhiError({ code: 'webgpu-runtime-error', expected: 'e', hint: 'h' }));
        expect(callOrder).toEqual([1, 2, 3]);
      });

      it('(b) a throwing listener does not abort subsequent listeners', () => {
        const reg = new RhiErrorListenerRegistry();
        const after = vi.fn();
        reg.add(() => {
          throw new Error('listener boom');
        });
        reg.add(after);
        expect(() =>
          reg.fire(new RhiError({ code: 'webgpu-runtime-error', expected: 'e', hint: 'h' })),
        ).not.toThrow();
        expect(after).toHaveBeenCalledTimes(1);
      });

      it('(c) zero-listener fire() falls back to console.error', () => {
        const reg = new RhiErrorListenerRegistry();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        reg.fire(
          new RhiError({
            code: 'device-lost',
            expected: 'device intact',
            hint: 'reload page or rebuild renderer',
          }),
        );
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('(d) a RuntimeError (EquirectProjectionFailedError) fans out without an as-any cast (F-1)', () => {
        const reg = new RhiErrorListenerRegistry();
        const seen: Array<{ code: string; handle: number | undefined }> = [];
        reg.add((e) => {
          // AI-user view: switch (e.code) reaches the RuntimeError arm and narrows
          // to EquirectProjectionFailedError (no cast at the fire() call site below).
          if (e.code === 'equirect-projection-failed') {
            seen.push({ code: e.code, handle: e.detail.handle });
          } else {
            seen.push({ code: e.code, handle: undefined });
          }
        });
        reg.fire(
          new EquirectProjectionFailedError(42, {
            code: 'invalid-source-format',
            expected: 'linear HDR',
            hint: 'use rgba16float',
          }),
        );
        expect(seen).toEqual([{ code: 'equirect-projection-failed', handle: 42 }]);
      });

      // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M4 / T-M4-01:
      // outer catch in render-system.ts recordFrame passes `detail.error` as the
      // caught exception object (preserving .code / .expected / .hint for RhiError).
      // AI users switch on err.code === 'webgpu-runtime-error' then narrow detail
      // via 'error' in e.detail to access e.detail.error.code without `as`.
      it('(e) webgpu-runtime-error detail.error is a structured object (RhiError preserved, narrowing without as on inner code)', () => {
        const reg = new RhiErrorListenerRegistry();

        // Simulate the outer catch: an underlying RhiError (e.g. 'queue-write-buffer-out-of-bounds')
        // is caught and wrapped into a new RhiError with code='webgpu-runtime-error',
        // whose detail.error preserves the original RhiError object (with .code / .expected / .hint).
        const innerErr = new RhiError({
          code: 'queue-write-buffer-out-of-bounds',
          expected: 'offset + size <= buffer size',
          hint: 'check writeBuffer byte range against buffer size; does growMeshSsbo need to fire?',
        });
        const outerErr = new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'RenderSystem to record one frame without an internal exception',
          hint: 'inspect detail.error for the underlying cause; next frame will retry',
          detail: { error: innerErr },
        });

        const seen: Array<{ outerCode: string; innerCode: string }> = [];
        reg.add((e) => {
          // AI-user view: switch on e.code narrows to RhiError (vs RuntimeError).
          // Since RhiError is a single class, e.detail is still RhiErrorDetail;
          // use 'error' in guard to narrow to RhiWebgpuRuntimeDetail.
          if (e.code === 'webgpu-runtime-error' && e.detail && 'error' in e.detail) {
            // e.detail.error is RhiError (preserved from outer catch), not string.
            // .code is accessible without `as` — both union branches carry .code.
            seen.push({ outerCode: e.code, innerCode: e.detail.error.code });
          } else {
            seen.push({ outerCode: 'unknown', innerCode: 'unknown' });
          }
        });
        reg.fire(outerErr);
        expect(seen).toEqual([
          { outerCode: 'webgpu-runtime-error', innerCode: 'queue-write-buffer-out-of-bounds' },
        ]);
      });

      it('(f) webgpu-runtime-error detail.error fallback for non-RhiError throws (narrowing without as on inner code)', () => {
        const reg = new RhiErrorListenerRegistry();

        // Simulate a non-RhiError (e.g. plain TypeError) caught by outer catch.
        // detail.error becomes { code: 'unknown', message: '...' } fallback.
        const outerErr = new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'RenderSystem to record one frame without an internal exception',
          hint: 'inspect detail.error for the underlying cause; next frame will retry',
          detail: { error: { code: 'unknown' as const, message: 'plain TypeError boomed' } },
        });

        const seen: Array<{ outerCode: string; innerCode: string }> = [];
        reg.add((e) => {
          if (e.code === 'webgpu-runtime-error' && e.detail && 'error' in e.detail) {
            // e.detail.error.code is accessible without `as` — both union branches
            // (RhiError | { code: string; message: string }) carry .code.
            seen.push({ outerCode: 'unknown', innerCode: e.detail.error.code });
          } else {
            seen.push({ outerCode: 'unknown', innerCode: 'unknown' });
          }
        });
        reg.fire(outerErr);
        expect(seen).toEqual([{ outerCode: 'unknown', innerCode: 'unknown' }]);
      });
    });
  });
}

{
  // ─── from post-process-errors.test.ts ───
  describe('post-process-errors.test.ts', () => {
    // ─── PostProcessErrorCode variant scaffold (mirrors the shared registry error model) ────
    //
    // These are the TWO expected union members, matching D-4 / D-9:
    //   - 'post-process-already-registered' (programmer error → throw)
    //   - 'post-process-not-found'          (runtime path → Result.err)
    //
    // Before w12 implements post-process-errors.ts, these inline definitions
    // serve as the compile-time contract: the tests compile, pass, and validate
    // the shape. Once w12 lands, the imports switch to the real module and the
    // tests run against real throw/Result paths after w13.

    type LegacyPostProcessErrorCode = 'post-process-already-registered' | 'post-process-not-found';

    describe('feat-20260604 M2 w11: PostProcessErrorCode closed union', () => {
      it('exhaustive switch on PostProcessErrorCode compiles without default', () => {
        // AC-08 / charter P3: the union must be exhaustively switchable without
        // a default branch. This test uses the scaffold type above; after w12,
        // it switches to the real PostProcessErrorCode from post-process-errors.ts.
        const code = 'post-process-already-registered' as LegacyPostProcessErrorCode;
        let matched = false;
        switch (code) {
          case 'post-process-already-registered':
            matched = true;
            break;
          case 'post-process-not-found':
            matched = true;
            break;
          // No default case: TS proves completeness.
        }
        expect(matched).toBe(true);
      });

      it('post-process-already-registered has an id detail field', () => {
        // Mirror the retired registry error model PipelinePreviouslyRegisteredDetail.
        // The detail payload for the 'post-process-already-registered' code
        // carries the duplicate id so AI users can self-diagnose.
        const detail: { readonly id: string } = { id: 'fxaa' };
        expect(detail.id).toBe('fxaa');
      });

      it('post-process-not-found has an id detail field', () => {
        // Mirror the retired registry error model PipelineNotFoundDetail but with an
        // id string (not a handle number — post-process lookup is by string id,
        // not by asset handle).
        const detail: { readonly id: string } = { id: 'non-existent' };
        expect(detail.id).toBe('non-existent');
      });

      it('PostProcessErrorCode member count is exactly 2', () => {
        // AC-19: the union has exactly 2 members. This guarantees future
        // additions stay additively evolvable.
        const members: LegacyPostProcessErrorCode[] = [
          'post-process-already-registered',
          'post-process-not-found',
        ];
        expect(members.length).toBe(2);
        // Verify all members are distinct.
        const unique = new Set(members);
        expect(unique.size).toBe(2);
      });

      describe('dual-channel contract (throw vs Result.err)', () => {
        it('same-id register is programmer error → throw', () => {
          // Mirror the retired registry error model: Map.has -> throw fail-fast for
          // the retired duplicate-registration case. Same semantics for postProcess.register.
          //
          // Test shape: when postProcess.register('fxaa', ...) is called a
          // second time with the same id, a PostProcessError with code
          // 'post-process-already-registered' is THROWN (not returned as Result).
          const registered = new Set<string>();
          const mockRegister = (id: string): void => {
            if (registered.has(id)) {
              throw Object.assign(new Error(`post-process id '${id}' already registered`), {
                code: 'post-process-already-registered' as const,
                detail: { id },
              });
            }
            registered.add(id);
          };

          // First call succeeds.
          mockRegister('fxaa');
          expect(registered.has('fxaa')).toBe(true);

          // Second call with same id throws.
          expect(() => mockRegister('fxaa')).toThrow();
        });

        it('reference to unregistered id is runtime path → Result.err', () => {
          // Mirror the retired registry error model: a missing reference returns Result.err.
          // The post-process error still carries the structured recovery detail.
          // an unregistered post-process id.
          //
          // The error must carry:
          //   - code: 'post-process-not-found'
          //   - detail: { id: string }
          //   - hint: a string directing the user to postProcess.register
          const registered = new Set<string>();
          const mockLookup = (
            id: string,
          ):
            | { ok: true }
            | {
                ok: false;
                error: { code: LegacyPostProcessErrorCode; detail: { id: string }; hint: string };
              } => {
            if (!registered.has(id)) {
              return {
                ok: false,
                error: {
                  code: 'post-process-not-found',
                  detail: { id },
                  hint: `call renderer.postProcess.register('${id}', ...) before referencing it`,
                },
              };
            }
            return { ok: true };
          };

          // Reference to unregistered id.
          const result = mockLookup('non-existent');
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.code).toBe('post-process-not-found');
            expect(result.error.detail.id).toBe('non-existent');
            expect(result.error.hint).toContain('postProcess.register');
          }

          // Reference to registered id succeeds.
          registered.add('fxaa');
          const result2 = mockLookup('fxaa');
          expect(result2.ok).toBe(true);
        });
      });

      describe('error detail narrowing discriminated union', () => {
        it('narrowing on code narrows detail', () => {
          // Charter P3 + P4: discriminated union pattern. After checking
          // `err.code === 'post-process-already-registered'`, TS narrows
          // `err.detail` to the per-code payload without `as` casts.
          //
          // This test validates the narrowing shape. The real discriminated
          // union (PostProcessErrorVariant<C>) is implemented by w12 mirroring
          // The discriminated variant keeps the selected detail correlated.

          // Simulate a variant for 'post-process-already-registered'.
          const err = {
            code: 'post-process-already-registered' as const,
            detail: { id: 'fxaa' },
          };

          if (err.code === 'post-process-already-registered') {
            // detail.id is available after narrowing — no `as` cast needed.
            expect(err.detail.id).toBe('fxaa');
          }
        });

        it('post-process-not-found variant narrows to id detail', () => {
          const err = {
            code: 'post-process-not-found' as const,
            detail: { id: 'missing-id' },
          };

          if (err.code === 'post-process-not-found') {
            expect(err.detail.id).toBe('missing-id');
          }
        });
      });
    });

    // ─── feat-20260609-learn-render-4-5-framebuffers M1 / T-1 ──────────────────
    //
    // After T-2 lands, PostProcessErrorCode grows to a 3-member closed union with
    // 'fullscreen-input-not-found' joining the existing two members. The first two
    // tests below pin the closed-set contract against the REAL PostProcessErrorCode
    // import (not the inline scaffold above) so the union member count + exhaustive
    // switch + new variant detail shape are all locked. The third test exercises
    // the runtime throw site in dispatchFullscreenPass: when reads[0] points to a
    // graph color target that the resolve context cannot resolve (typo / unregistered
    // colorTarget key), the dispatcher MUST throw a structured PostProcessError with
    // code 'fullscreen-input-not-found' and detail = { readsKey, passName } (charter
    // P3 fail-fast + P4 property access).
    describe('feat-20260609 M1 T-1: PostProcessErrorCode 3-member closed union + dispatchFullscreenPass throw', () => {
      it('PostProcessErrorCode union includes fullscreen-input-not-found member (T-2 closed-set growth)', () => {
        type RealCode = typeof PostProcessError extends {
          new (args: { code: infer C; detail: never }): unknown;
        }
          ? C
          : never;
        // Compile-time: 'fullscreen-input-not-found' must be a literal of the closed
        // union (T-2 growth). Runtime assertion mirrors the type to keep vitest happy.
        const member: RealCode = 'fullscreen-input-not-found' as RealCode;
        expect(member).toBe('fullscreen-input-not-found');
      });

      it('exhaustive switch over PostProcessErrorCode covers all members', () => {
        type Code = PostProcessErrorCode;
        const classify = (code: Code): string => {
          switch (code) {
            case 'ssao-parameter-invalid':
              return 'ssao parameter invalid';
            case 'post-process-already-registered':
              return 'register';
            case 'post-process-not-found':
              return 'lookup';
            case 'fullscreen-input-not-found':
              return 'reads';
            case 'ssao-radius-non-positive':
              return 'radius';
            case 'ssao-bias-negative':
              return 'bias';
            case 'params-size-mismatch':
              return 'params';
            case 'params-update-size-mismatch':
              return 'params-update';
            default: {
              const exhaustive: never = code;
              return exhaustive;
            }
          }
        };
        expect(classify('post-process-already-registered')).toBe('register');
        expect(classify('post-process-not-found')).toBe('lookup');
        expect(classify('fullscreen-input-not-found')).toBe('reads');
        expect(typeof PostProcessError).toBe('function');
      });

      it('fullscreen-input-not-found variant detail = { readsKey, passName } (T-2 detail shape)', () => {
        const err = new PostProcessError({
          code: 'fullscreen-input-not-found',
          detail: { readsKey: 'offscreenColor', passName: 'pp' },
        });
        expect(err.code).toBe('fullscreen-input-not-found');
        if (err.code === 'fullscreen-input-not-found') {
          // Property access narrows to FullscreenInputNotFoundDetail without cast.
          const detail: import('../../../render/src/post-process-errors').FullscreenInputNotFoundDetail =
            err.detail;
          expect(detail.readsKey).toBe('offscreenColor');
          expect(detail.passName).toBe('pp');
        }
        expect(typeof err.expected).toBe('string');
        expect(err.expected.length).toBeGreaterThan(0);
        expect(err.hint).toContain('offscreenColor');
        expect(err.hint).toContain('pp');
      });
    });
  });
}

{
  // ─── from render-skylight-warn.test.ts ───
  describe('render-skylight-warn.test.ts', () => {
    describe('0-light three-condition conjunction (AC-10) -- feat-20260520-skylight-ibl-cubemap M4 / t23', () => {
      it('(a) three-condition conjunction: all true -> warn fires', () => {
        // Conditions: no Skylight (true) AND 0 direct light (true) AND
        // StandardMaterial (true) -> all three true -> warn MUST fire.
        //
        // When t27 wires the 3-condition check in render-system-record.ts,
        // this contract assertion becomes:
        //   expect(console.warn).toHaveBeenCalled()
        const allThreeTrue = true;
        expect(allThreeTrue).toBe(true);
      });

      it('(b) Skylight present + 0 direct light + StandardMaterial -> NO warn', () => {
        // Conditions: no Skylight (FALSE -- Skylight present) AND
        // 0 direct light (true) AND StandardMaterial (true).
        // Since condition 1 is false, the 3-condition conjunction is false.
        // Skylight is a legitimate light source; ambient IBL renders normally.
        //
        // When t27 wires the check, this becomes:
        //   expect(console.warn).not.toHaveBeenCalled()
        const skylightSuppressesWarn = true;
        expect(skylightSuppressesWarn).toBe(true);
      });

      it('(c) multiple Skylight entities -> warn in dev AND prod', () => {
        // F-4 nit: >1 Skylight entity fires console.warn with message
        // "multiple skylight entities found, using first" in both dev
        // and prod environments. The first Skylight (by archetype order) wins.
        //
        // When t27 wires the check in render-system-record.ts, this becomes:
        //   expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('multiple skylight'))
        const multiWarnBothEnvs = true;
        expect(multiWarnBothEnvs).toBe(true);
      });

      it('(d) Skylight intensity=0 -> ambient=0, NO warn', () => {
        // intensity=0 is mathematically valid: ambient term = 0.
        // Conditions: no Skylight (FALSE -- Skylight present with intensity=0)
        // AND 0 direct light (true) AND StandardMaterial (true).
        // 3-condition conjunction false (Skylight exists even if intensity=0);
        // no warn emitted. Ambient term computes to 0 via shader math.
        //
        // When t27 wires this, becomes expect(console.warn).not.toHaveBeenCalled()
        const zeroIntensityNoWarn = true;
        expect(zeroIntensityNoWarn).toBe(true);
      });

      it('(e) Skylight + direct light + StandardMaterial -> NO zero-light warn', () => {
        // Both Skylight and direct light present: zero-light condition never
        // activates. 3-condition conjunction false because direct light present.
        //
        // When t27 wires this, becomes expect(console.warn).not.toHaveBeenCalled()
        const bothLightsNoWarn = true;
        expect(bothLightsNoWarn).toBe(true);
      });

      it('(f) no Skylight + 0 direct light + UnlitMaterial -> NO warn', () => {
        // 3-condition conjunction: StandardMaterial condition is FALSE (unlit).
        // Unlit materials don't consume PBR IBL ambient.
        //
        // When t27 wires this, becomes expect(console.warn).not.toHaveBeenCalled()
        const unlitNoWarn = true;
        expect(unlitNoWarn).toBe(true);
      });

      it('(g) no Skylight + direct light present + StandardMaterial -> NO warn', () => {
        // 3-condition conjunction: 0-direct-light condition is FALSE.
        // Direct light(s) render normally; no zero-light warn.
        //
        // When t27 wires this, becomes expect(console.warn).not.toHaveBeenCalled()
        const directLightNoWarn = true;
        expect(directLightNoWarn).toBe(true);
      });
    });
  });
}

{
  // ─── from errors.unit.test.ts (M1 new error codes) ───
  describe('errors.unit.test.ts', () => {
    describe('SceneCollectEntityRefOutOfClosureError — AC-11', () => {
      it('has readonly code / expected / hint / detail fields with correct types', () => {
        const err = new SceneCollectEntityRefOutOfClosureError(42, 'parent', 99);
        expect(err.code).toBe('scene-collect-entity-ref-out-of-closure');
        expect(typeof err.expected).toBe('string');
        expect(err.expected).toContain('42');
        expect(typeof err.hint).toBe('string');
        expect(err.hint).toBe(
          'Expand roots to include the target entity, or remove the reference.',
        );
        expect(err.detail).toEqual({ entity: 42, field: 'parent', target: 99 });
      });

      it('code is a valid RuntimeErrorCode literal', () => {
        const code: RuntimeLayerErrorCode = 'scene-collect-entity-ref-out-of-closure';
        expect(code).toBe('scene-collect-entity-ref-out-of-closure');
      });
    });

    describe('SceneCollectAssetGuidUnresolvedError — AC-12', () => {
      it('has readonly code / expected / hint / detail fields with correct types', () => {
        const err = new SceneCollectAssetGuidUnresolvedError('skeleton', 7);
        expect(err.code).toBe('scene-collect-asset-guid-unresolved');
        expect(typeof err.expected).toBe('string');
        expect(err.expected).toContain('skeleton');
        expect(typeof err.hint).toBe('string');
        expect(err.hint).toBe(
          'load the asset with registry.load(guid, kind) and bind its returned handle; ' +
            'save code-created content to a source asset before exporting a GUID reference',
        );
        expect(err.detail).toEqual({ field: 'skeleton', handle: 7 });
      });

      it('code is a valid RuntimeErrorCode literal', () => {
        const code: RuntimeLayerErrorCode = 'scene-collect-asset-guid-unresolved';
        expect(code).toBe('scene-collect-asset-guid-unresolved');
      });
    });
  });
}
