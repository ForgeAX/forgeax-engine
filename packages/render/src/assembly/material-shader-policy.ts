import { atmosphereAvailable } from '../environment/capability';
// Material shader policy and async adapter.
// Variant selection, module caching, and manifest material preparation stay
// independent from renderer lifetime and generation-scoped ready state.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { PipelineLayout, Result, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { err, ok, RhiError } from '@forgeax/engine-rhi';
import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  findVariantByKey,
  type MaterialShaderManifestEntry,
  materialShaderUvSetCount,
  type ShaderCatalog,
  type ShaderCatalogDevice,
  STANDARD_PIPELINE_PARAM_SCHEMA,
  standardPhysicalTextureFields,
} from '@forgeax/engine-shader';
import type { AssetGuid as AssetGuidType, ParamSchemaEntry } from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import {
  atmosphereMaterialVisibilityLayoutEntries,
  atmosphereViewLayoutEntries,
} from '../environment/bindings';
import { RENDER_FEATURE_VERTEX_LAYOUTS } from '../features/prepared-graphics';
import { GPU_SHADER_STAGE_FRAGMENT, GPU_SHADER_STAGE_VERTEX } from '../gpu-stage';
import type { RhiErrorListenerRegistry } from '../lifecycle';
import { assertStorageBufferCap } from '../light-buffer-layout';
import { buildPbrMaterialUserRegionEntries } from '../pbr-pipeline';
import {
  deriveExtendedLightingCapability,
  extendedLightingSampledTextureCapacityAvailable,
} from '../prepare/extended-lighting/resources';
import { STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES } from './shader-prewarm-policy';

/**
 * Sync-shaped `ShaderCatalogDevice` adapter wrapping the backend pack's
 * async `createShaderModule(rhiDevice, desc)`.
 *
 * Shape: fire-and-forget pre-bake — the first call for hash X returns
 * `Result.err(RhiError)` (a pending signal) while kicking off the async
 * createShaderModule + cache write; subsequent calls for the same hash hit
 * the cache and return `Result.ok(ShaderModule)` (charter proposition 9
 * graceful degradation).
 *
 * @placeholder M3 scope limit: the full async pre-bake wiring is delivered
 * by the ECS-driven render pipeline (later closure). The current shape is
 * already enough to support MVP-2.2 instance-per-engine + AI consumer
 * onboarding (charter proposition 1 progressive disclosure / proposition 4
 * explicit failure with retry guidance in the error hint).
 */
/**
 * Extended ShaderCatalogDevice contract for engine internals: adds a
 * `seedModule(label, module)` to populate the lazy adapter cache from an
 * already-compiled module, so eager-built modules (PBR / unlit / shadow
 * caster) and the lazy MaterialShader pipeline cache share one cache and
 * the lazy path is hit-on-first-call (no 1-frame warmup) for engine-shipped
 * shaders. Externally still typed as ShaderCatalogDevice (see callers in
 * ShaderCatalog).
 */
export interface ShaderDeviceAdapterInternal extends ShaderCatalogDevice {
  /**
   * feat-20260609 R3-fixup: seed the adapter's moduleCache with an
   * already-compiled ShaderModule under `label`. Used by the eager
   * shadow_caster pre-bake so the lazy PSO build hit on
   * `module-forgeax::default-shadow-caster` returns OK on frame 1.
   */
  seedModule(label: string, module: ShaderModule): void;
  /**
   * Whether this generation drew with the module: a pipeline requested the
   * label and it compiled. Seeding alone (boot prewarm) does not count, so a
   * replacement generation rebuilds only what its predecessor actually used.
   */
  hasModule(label: string): boolean;
  invalidateModule(label: string): void;
}

type ShaderModuleAdapterMode = 'validated' | 'immediate';

export function makeShaderDeviceAdapter(
  rhiDevice: RhiDevice,
  _errorRegistry: RhiErrorListenerRegistry,
  asyncCreateShaderModule:
    | ((
        device: RhiDevice,
        desc: { code: string; label?: string | undefined },
      ) => Promise<Result<ShaderModule, RhiError>>)
    | undefined,
  immediateCreateShaderModule:
    | ((
        device: RhiDevice,
        desc: { code: string; label?: string | undefined },
      ) => Result<ShaderModule, RhiError>)
    | undefined,
  mode: ShaderModuleAdapterMode = 'validated',
): ShaderDeviceAdapterInternal {
  const moduleCache = new Map<string, ShaderModule>();
  const errorCache = new Map<string, RhiError>();
  const pending = new Map<string, number>();
  const epochs = new Map<string, number>();
  const requested = new Set<string>();

  return {
    createShaderModule(desc): Result<ShaderModule, RhiError> {
      const key = desc.label ?? desc.code;
      requested.add(key);
      const cachedModule = moduleCache.get(key);
      if (cachedModule !== undefined) return ok(cachedModule);
      const cachedError = errorCache.get(key);
      if (cachedError !== undefined) return err(cachedError);

      // WebGPU's raw createShaderModule is synchronous. Only the explicitly
      // selected immediate adapter uses that entry: generated feature programs
      // and first-use built-in Standard variants on supporting backends
      // can avoid a slow getCompilationInfo() round trip, while the default
      // validated adapter keeps the compiler-readiness barrier for declared
      // and authored shaders. The public async factory still owns diagnostics;
      // pipeline creation remains the validation point for the fast path.
      if (mode === 'immediate' && immediateCreateShaderModule !== undefined) {
        const immediateResult = immediateCreateShaderModule(rhiDevice, {
          code: desc.code,
          ...(desc.label === undefined ? {} : { label: desc.label }),
        });
        if (immediateResult.ok) {
          moduleCache.set(key, immediateResult.value);
          return immediateResult;
        }
        errorCache.set(key, immediateResult.error);
        return immediateResult;
      }

      // Fire async creation; first sync call returns pending error (the AI consumer retry pattern).
      // M3 D-P4: rhi-webgpu supplies the async factory; rhi-wgpu (no top-level
      // async factory) falls back to the synchronous device.createShaderModule
      // entry which already returns Result<ShaderModule, RhiError>.
      if (!pending.has(key)) {
        const epoch = epochs.get(key) ?? 0;
        pending.set(key, epoch);
        const desc2: { code: string; label?: string | undefined } = { code: desc.code };
        if (desc.label !== undefined) desc2.label = desc.label;
        const asyncResult: Promise<Result<ShaderModule, RhiError>> = asyncCreateShaderModule
          ? asyncCreateShaderModule(rhiDevice, desc2)
          : invokeDeviceCreateShaderModule(rhiDevice, desc2);
        void asyncResult.then((result) => {
          if (pending.get(key) !== epoch || (epochs.get(key) ?? 0) !== epoch) return;
          if (result.ok) {
            moduleCache.set(key, result.value);
          } else {
            errorCache.set(key, result.error);
          }
          pending.delete(key);
        });
      }

      return err(makeRhiNotAvailableError(key));
    },
    seedModule(label: string, module: ShaderModule): void {
      moduleCache.set(label, module);
    },
    hasModule(label: string): boolean {
      return requested.has(label) && moduleCache.has(label);
    },
    invalidateModule(label: string): void {
      epochs.set(label, (epochs.get(label) ?? 0) + 1);
      moduleCache.delete(label);
      errorCache.delete(label);
      pending.delete(label);
    },
  };
}

/**
 * Fallback path for the M3 D-P4 auto-select facade when the backend pack
 * does not supply a top-level async `createShaderModule` (e.g. the rhi-wgpu
 * path which routes through the synchronous `device.createShaderModule`
 * entry, or an explicit escape-hatch instance that omits the async
 * factory). The forgeax `RhiDevice` interface intentionally does not expose
 * a sync `createShaderModule` (fix-f3; see packages/rhi/src/index.ts line
 * 1164), so this helper performs a structural probe + returns a structured
 * error when neither the async factory nor a structural sync entry exists
 * (charter proposition 4 explicit failure baseline).
 */
export function invokeDeviceCreateShaderModule(
  rhiDevice: RhiDevice,
  desc: { code: string; label?: string | undefined },
): Promise<Result<ShaderModule, RhiError>> {
  const candidate = (
    rhiDevice as RhiDevice & {
      createShaderModule?: (d: {
        code: string;
        label?: string | undefined;
      }) => Result<ShaderModule, RhiError>;
    }
  ).createShaderModule;
  if (typeof candidate === 'function') {
    try {
      return Promise.resolve(candidate.call(rhiDevice, desc));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      return Promise.resolve(
        err(
          new RhiError({
            code: 'shader-compile-failed',
            expected: 'device.createShaderModule returns Result<ShaderModule, RhiError>',
            hint: `synchronous fallback threw: ${message}`,
          }),
        ),
      );
    }
  }
  return Promise.resolve(
    err(
      new RhiError({
        code: 'rhi-not-available',
        expected:
          'either RhiBackendPack.createShaderModule (async) or device.createShaderModule (sync) available',
        hint: 'the explicit RhiInstance escape hatch must expose a top-level createShaderModule(device, desc) or RhiDevice.createShaderModule(desc) entry',
      }),
    ),
  );
}

/**
 * Synthesizes a `RhiError` with code 'rhi-not-available' for the
 * sync-adapter pending path. AI-consumer onboarding: consume
 * `.code === 'rhi-not-available'` → after `await loadManifest` retry
 * `registry.get` (charter proposition 4 explicit failure + proposition 9).
 *
 * 'rhi-not-available' is the placeholder member of the 5-member closed
 * union (plan-decisions OQ-P2).
 */
function makeRhiNotAvailableError(key: string): RhiError {
  return new RhiError({
    code: 'rhi-not-available',
    expected: 'shader module pre-bake to complete asynchronously',
    hint: `shader module '${key}' is still pending; await registry.loadManifest() finished and retry registry.get(hash) on next frame`,
  });
}

/**
 * bug-20260601-hello-tonemap-material-register M1: prepare engine-shipped
 * material shaders (cap gate + manifest load + registration) before the
 * renderer is returned so that `register<MaterialAsset>` referencing an
 * engine shader (e.g. `forgeax::default-standard-pbr`) succeeds without
 * waiting for `renderer.initialization` (plan-strategy D-1/D-2/D-5).
 *
 * Failures (cap-gate insufficient, manifest-malformed, shader-not-found)
 * throw structured `RhiError` / `ShaderError` which propagate through
 * `createRenderer`'s synchronous reject path (D-2 structured reject).
 */
export async function prepareMaterialShaders(
  rhiDevice: RhiDevice,
  getShader: () => ShaderCatalog,
  assets: AssetRegistry,
  // feat-20260629 M4: populated with uvSetCount from naga reflection JSON
  // keyed by materialShaderId; consumed by getMaterialShaderPipeline for
  // auto-fill of shaderUvSetCount clamp-to-last alias parameter.
  materialShaderUvSetCounts: Map<string, number>,
): Promise<void> {
  const builtinGuid = (result: ReturnType<typeof AssetGuid.parse>): AssetGuidType => {
    if (!result.ok) throw result.error;
    return result.value;
  };
  // feat-20260528-material-shader-registration-unification M3 / w15:
  // pre-computed UUIDv5 GUIDs for engine-shipped material shaders.
  // Derived from FORGEAX_NAMESPACE (9a09805a-7623-482e-b322-9fc3591f2a38)
  // with SHA-1 per RFC 4122 section 4.3.
  const pbrGuidRes = AssetGuid.parse('94d85ce4-650c-54b1-a86a-eaf22696ecbc');
  const unlitGuidRes = AssetGuid.parse('37f593ea-0c79-528c-b7f7-23d17045d776');
  const spriteGuidRes = AssetGuid.parse('658234f6-a605-5fff-957d-7149b48fd0f4');
  // feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / t7: stable
  // UUID for sprite-lit material shader (matches sprite-lit.material.json
  // subAssets[0].guid; shader-id catalog SSOT).
  const spriteLitGuidRes = AssetGuid.parse('f0ec6a4b-cad1-5a3d-9b4e-6d2b0fa14d8e');
  const pbrSkinGuidRes = AssetGuid.parse('5ad0833e-2f17-56e5-a3d2-dab543afae65');
  // feat-20260531-world-space-msdf-text-rendering M5 / w21: stable UUIDv5 for
  // the world-space MSDF text material shader (deriveBuiltin('forgeax::msdf-text')
  // under FORGEAX_NAMESPACE). Registered via the manifest materialShaders[]
  // loop below alongside sprite / unlit (D-7 -- materialShaderId path).
  const msdfTextGuidRes = AssetGuid.parse('b8f92146-3b24-519b-97a2-271419b53563');
  const shadowCasterGuidRes = AssetGuid.parse('2e167c2a-1747-5bd7-b56d-aea9bc3f436e');
  const pbrGuid = builtinGuid(pbrGuidRes);
  const unlitGuid = builtinGuid(unlitGuidRes);
  const spriteGuid = builtinGuid(spriteGuidRes);
  const spriteLitGuid = builtinGuid(spriteLitGuidRes);
  const pbrSkinGuid = builtinGuid(pbrSkinGuidRes);
  const msdfTextGuid = builtinGuid(msdfTextGuidRes);
  const shadowCasterGuid = builtinGuid(shadowCasterGuidRes);
  const ENGINE_SHADER_GUIDS = new Map<string, AssetGuidType>([
    ['forgeax::default-standard-pbr', pbrGuid],
    ['forgeax::default-unlit', unlitGuid],
    ['forgeax::sprite', spriteGuid],
    ['forgeax::sprite-lit', spriteLitGuid],
    ['forgeax::default-standard-pbr-skin', pbrSkinGuid],
    ['forgeax::msdf-text', msdfTextGuid],
    ['forgeax::default-shadow-caster', shadowCasterGuid],
  ]);

  // ── Step 0: storage-buffer cap gate ───────────────────────────────────────
  const capValue = rhiDevice.limits.maxStorageBuffersPerShaderStage;
  const webgl2Downlevel = rhiDevice.caps.backendKind === 'wgpu-webgl2';
  let storageBufferCapable = !webgl2Downlevel && rhiDevice.caps.storageBuffer;
  if (typeof capValue === 'number') {
    const capCheck = assertStorageBufferCap(capValue);
    if (!capCheck.ok) throw capCheck.error;
    storageBufferCapable = !webgl2Downlevel && rhiDevice.caps.storageBuffer && capCheck.value;
  }
  const extendedLightingShaderAvailable = deriveExtendedLightingCapability(rhiDevice).admitted;
  const projectorAvailable =
    (rhiDevice.limits.maxSampledTexturesPerShaderStage ?? 0) >=
    STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES;
  // ── Step 1: manifest load ─────────────────────────────────────────────────
  const registry = getShader();
  const loaded = await registry.loadManifest();
  if (!loaded.ok) {
    throw loaded.error;
  }

  // ── Step 1b: material shader variant resolution + registration ───────────
  // feat-20260609-hdrp-cluster-fragment-ggx M1 / w7: the boot resolver selects
  // the non-clustered variant; clustered Standard activation resolves its own
  // variant later at record time.
  for (const msEntry of registry.materialShaderManifestEntries()) {
    // bug-20260610: skip synthetic non-material engine entries piggy-backing
    // on the materialShaders channel for variant surfacing (shadow_caster).
    // They use the `forgeax::engine-` prefix and are consumed by Step 2's
    // engine-entry compile path, NOT by installMaterialArtifact.
    if (msEntry.identifier.startsWith('forgeax::engine-')) continue;
    // The same closed resolver drives every manifest axis at boot. This keeps
    // registration aligned with record-time capability/feature selection and
    // supplies explicit defaults for opt-in axes such as shadow alpha-mask and
    // GPU-driven scene-index variants.
    // Build the exact boot key from the capability facts and explicit defaults.
    // Record-time callers use resolveMaterialShaderVariantSet below; keeping
    // the same axes here prevents a physical-material variant from being
    // registered under a key that cannot be selected by the renderer.
    const variantDefines: Record<string, boolean> = {};
    if (msEntry.variants.some((v) => 'STORAGE_BUFFER_AVAILABLE' in v.defines)) {
      variantDefines.STORAGE_BUFFER_AVAILABLE = storageBufferCapable;
    }
    if (msEntry.variants.some((v) => 'WEBGL2_COMPAT' in v.defines)) {
      variantDefines.WEBGL2_COMPAT = webgl2Downlevel;
    }
    if (msEntry.variants.some((v) => 'CLUSTER_FORWARD_AVAILABLE' in v.defines)) {
      variantDefines.CLUSTER_FORWARD_AVAILABLE = false;
    }
    if (msEntry.variants.some((v) => 'GPU_DRIVEN_SCENE_INDEX_AVAILABLE' in v.defines)) {
      variantDefines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE = false;
    }
    if (msEntry.variants.some((v) => 'GPU_DRIVEN_SCENE_INDEX_EXPLICIT' in v.defines)) {
      // The boot material is the compact visible-stream path.  Explicit
      // scene-index dispatches select their own variant at record time; they
      // must never make the default artifact key unsatisfiable.
      variantDefines.GPU_DRIVEN_SCENE_INDEX_EXPLICIT = false;
    }
    if (msEntry.variants.some((v) => 'ALPHA_MASK' in v.defines)) {
      // Alpha-mask admission is a per-draw producer fact.  Keep the boot
      // artifact opaque and resolve ALPHA_MASK=true only for a receipt-owned
      // shadow batch.
      variantDefines.ALPHA_MASK = false;
    }
    if (msEntry.variants.some((v) => 'DIRECTIONAL_PCSS_AVAILABLE' in v.defines)) {
      variantDefines.DIRECTIONAL_PCSS_AVAILABLE = directionalPcssCapable(
        rhiDevice.caps.backendKind,
      );
    }
    if (msEntry.variants.some((v) => 'VERTEX_COLOR_AVAILABLE' in v.defines)) {
      variantDefines.VERTEX_COLOR_AVAILABLE = false;
    }
    if (msEntry.variants.some((v) => 'COVERAGE_ONLY' in v.defines)) {
      // Coverage-only is a producer-owned opt-in for sprite/temporal paths.
      // Keep the ordinary boot material on the opaque variant; record-time
      // coverage batches request the true variant explicitly.
      variantDefines.COVERAGE_ONLY = false;
    }
    if (msEntry.variants.some((v) => 'VISIBLE_SURFACE_AVAILABLE' in v.defines)) {
      variantDefines.VISIBLE_SURFACE_AVAILABLE = false;
    }
    if (msEntry.variants.some((v) => 'PROBE_BLEND_AVAILABLE' in v.defines)) {
      variantDefines.PROBE_BLEND_AVAILABLE = false;
    }
    if (msEntry.variants.some((v) => 'ATMOSPHERE_AVAILABLE' in v.defines)) {
      variantDefines.ATMOSPHERE_AVAILABLE = atmosphereAvailable(
        storageBufferCapable,
        rhiDevice.limits.maxSampledTexturesPerShaderStage,
      );
    }
    if (msEntry.variants.some((v) => 'EXTENDED_LIGHTING_AVAILABLE' in v.defines)) {
      variantDefines.EXTENDED_LIGHTING_AVAILABLE = extendedLightingShaderAvailable;
    }
    // A material shader that declares the projector axis owns the same
    // capability-selected resource pair, regardless of whether it is the
    // engine Standard entry or a VFX particle entry. Omitting this value for
    // particle variants asks the manifest for a partial key and fails before
    // the first frame when the shader does not use the Standard root.
    if (msEntry.variants.some((v) => 'PROJECTOR_AVAILABLE' in v.defines)) {
      variantDefines.PROJECTOR_AVAILABLE = projectorAvailable;
    }
    if (msEntry.variants.some((v) => 'TRANSMISSION_AVAILABLE' in v.defines)) {
      variantDefines.TRANSMISSION_AVAILABLE = false;
    }
    // Record-time fallback MRT is opt-in; boot the ordinary single-target
    // Standard artifact even when the manifest declares this axis.
    if (msEntry.variants.some((v) => 'REFLECTION_FALLBACK_AVAILABLE' in v.defines)) {
      variantDefines.REFLECTION_FALLBACK_AVAILABLE = false;
    }
    // bug-20260708 M2 (a): PER_INSTANCE_REGION axis default = false at boot.
    // Per-entity spritePH path (`main-pass-sprite-draws.ts:511-513`) expects
    // `variantSet=undefined` to resolve to the PIR=false shader source (64B
    // InstanceData) via `lookup.value.source` fallback in
    // `getMaterialShaderPipeline`. The PIR=true canonical variant (80B) is
    // reserved for SpriteInstances batches which explicitly request it via
    // `SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET === ''` (canonical all-
    // true) — resolved through `findVariantByKey(msEntry, '')` in the same
    // `getMaterialShaderPipeline` substitution branch. Mirrors the
    // CLUSTER_FORWARD_AVAILABLE pattern above: axis default false unless
    // explicitly requested by a caller variantSet.
    if (msEntry.variants.some((v) => 'PER_INSTANCE_REGION' in v.defines)) {
      variantDefines.PER_INSTANCE_REGION = false;
    }
    if (msEntry.variants.some((v) => 'SKINNING_DISABLED' in v.defines)) {
      variantDefines.SKINNING_DISABLED = true;
    }
    // Authored axes keep the manifest's all-true default, as in
    // resolveMaterialShaderVariantSet; only Engine admission axes are listed above.
    for (const variant of msEntry.variants) {
      for (const axis of Object.keys(variant.defines)) variantDefines[axis] ??= true;
    }
    const sortedEntries = Object.entries(variantDefines).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const definesKey = sortedEntries.every(([, v]) => v === true)
      ? ''
      : sortedEntries.map(([k, v]) => `${k}=${v}`).join('+');
    const chosen = findVariantByKey(msEntry, definesKey);
    if (msEntry.variants.length > 0 && chosen === undefined) {
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: `material shader '${msEntry.identifier}' declares the exact boot variant '${definesKey}'`,
        hint: 'regenerate the shader manifest with the complete variant Cartesian product',
      });
    }
    const wgsl = chosen?.composedWgsl ?? msEntry.composedWgsl;
    if (wgsl.length > 0) {
      const existing = registry.findMaterialArtifact(msEntry.identifier);
      if (existing.ok) continue;
      const paramSchema = JSON.parse(
        msEntry.paramSchema,
      ) as readonly import('@forgeax/engine-types').ParamSchemaEntry[];
      // feat-20260613-material-paramschema-driven-binding M3 / w12-w13:
      // paramSchema is the SSOT; the BGL is derived on demand via
      // `derive(paramSchema).bglEntries` and consumed by
      // buildPbrPipelineLayouts at pipeline-build time. The historical
      // separate bind-layout sidecar field has been deleted from
      // MaterialShaderEntry / MaterialRuntimeInfo (D-1 / D-2).
      registry.installMaterialArtifact(msEntry.identifier, {
        source: wgsl,
        paramSchema,
        ...(chosen?.receipt === undefined && msEntry.receipt === undefined
          ? {}
          : { receipt: chosen?.receipt ?? msEntry.receipt }),
      });
      // feat-20260629 M4: store uvSetCount from naga reflection for
      // auto-fill in getMaterialShaderPipeline clamp-to-last alias.
      if (msEntry.uvSetCount !== undefined) {
        materialShaderUvSetCounts.set(msEntry.identifier, msEntry.uvSetCount);
      }
      // Sanity check the schema parses through derive — a malformed sidecar
      // schema (e.g. unknown type literal) should fail loud at register time
      // (charter P3 explicit failure). The derived output is discarded; the
      // SSOT consumer is buildPbrPipelineLayouts later.
      derive(paramSchema);

      const shaderGuid = ENGINE_SHADER_GUIDS.get(msEntry.identifier);
      if (shaderGuid !== undefined) {
        const shaderAsset = {
          kind: 'shader' as const,
          name: msEntry.identifier,
          source: wgsl,
          paramSchema,
        };
        // feat-20260614 M8 (D-17): catalogue the shader asset by GUID so it is
        // GUID-addressable; no handle minted. A shader without an engine GUID
        // lives only in the ShaderCatalog (the installMaterialArtifact SSOT
        // above) -- there is no GUID to catalogue it under.
        assets.catalog(shaderGuid, shaderAsset);
      }
    }
  }

  // ── Step 1c: register forgeax::default-shadow-caster from its manifest identity ──
  // feat-20260609-pipeline-driven-pass-selector-shadowcaster-via-mat M3 / T-007:
  // The reserved material-shader identifier is the SSOT. Content heuristics are
  // invalid here: a game-authored vertex-only shader can legitimately expose
  // position without normal (billboards and procedural VFX commonly do), and
  // must never be mistaken for the engine shadow caster merely because it is
  // encountered first in the flat manifest.
  const shadowCasterIdentifier = 'forgeax::default-shadow-caster';
  if (!registry.findMaterialArtifact(shadowCasterIdentifier).ok) {
    const manifestEntry = Array.from(registry.materialShaderManifestEntries()).find(
      (candidate) => candidate.identifier === shadowCasterIdentifier,
    );
    if (manifestEntry !== undefined) {
      // shadow_caster evaluates the same default Surface as Standard. Keep
      // its generated MaterialParameters contract aligned with the Standard
      // pipeline even when a legacy manifest omitted the material entry.
      registry.installMaterialArtifact(shadowCasterIdentifier, {
        source: manifestEntry.composedWgsl,
        paramSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
        ...(manifestEntry.receipt === undefined ? {} : { receipt: manifestEntry.receipt }),
      });
      const shaderGuid = ENGINE_SHADER_GUIDS.get(shadowCasterIdentifier);
      if (shaderGuid !== undefined) {
        const shaderAsset = {
          kind: 'shader' as const,
          name: shadowCasterIdentifier,
          source: manifestEntry.composedWgsl,
          paramSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
        };
        // feat-20260614 M8 (D-17): catalogue by GUID; no handle minted.
        assets.catalog(shaderGuid, shaderAsset);
      }
    }
  }
}

/**
 * Per-variant PipelineLayout selector (M4.5 / D-10 option A).
 *
 * The HDRP variant (`CLUSTER_FORWARD_AVAILABLE=true` or canonical `''`
 * all-true when the shader declares the cluster axis) needs the 7-slot
 * group(2) BGL chain (`hdrpPbrPipelineLayout`); URP variants
 * (`CLUSTER_FORWARD_AVAILABLE=false` / undefined / no axis) keep the
 * 1-slot mesh-array BGL chain (`pbrPipelineLayout`).
 *
 * Returns `null` only when the URP fallback layout itself is null
 * (Camera-only / empty-manifest path). When the HDRP layout is null but
 * URP exists, the HDRP variant gracefully falls back to URP — the WGSL
 * resolved upstream by `findVariantByKey` is the URP variant in that
 * case (manifest entry with all-true definesKey === '' was registered
 * with isHdrpActive=false at boot when storage-buffer caps are absent).
 *
 * Pure function — exported for unit-test access (M4.5 / w35).
 */
/**
 * Closed enum of pipeline-layout kinds the selector can dispatch to.
 *
 * `pbr` — standard PBR (1-entry mesh-array BGL).
 * `pbr-skin` — bug-20260611-skin-pipeline-layout: 2-entry mesh-array BGL
 *   (binding 0 meshes + binding 1 palette) for the `forgeax::pbr-skin`
 *   material shader.
 * `hdrp-pbr` — feat-20260609 HDRP cluster-forward variant (7-slot group(2)
 *   BGL substituted at slot 2).
 * `sprite-urp` — bug-20260708 M2 (c): sprite / sprite-lit shaders reuse
 *   the URP 1-slot mesh-array BGL (they don't declare
 *   CLUSTER_FORWARD_AVAILABLE) but their canonical all-true variant key
 *   `''` (`SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET`) MUST NOT trigger
 *   the `variantSet===''` → HDRP branch of the selector. Callers
 *   (`buildPipelineContext`) resolve `sprite-urp` from the sprite
 *   `materialShaderId` and pass it through; the selector short-circuits
 *   to `pbrPipelineLayout` before the HDRP check.
 *
 * AC-09 grep gate: the selector body (`selectPipelineLayoutForVariant`)
 * **MUST NOT** contain literal `'forgeax::pbr-skin'` (or another
 * shader-id literal). The caller resolves `LayoutKind` upstream and passes
 * the structured value through (charter P4 consistent abstraction). New
 * material-shader layouts add a `LayoutKind` member + a PipelineState slot
 * + a switch arm here in one cut (charter P3 extensibility).
 */
export type LayoutKind =
  | 'pbr'
  | 'pbr-skin'
  | 'gpu-driven-pbr'
  | 'gpu-driven-skin'
  | 'gpu-driven-cluster-pbr'
  | 'gpu-driven-cluster-skin'
  | 'surface-direct-pbr'
  | 'surface-direct-cluster-pbr'
  | 'hdrp-pbr'
  | 'hdrp-skin'
  | 'sprite-urp'
  | 'unlit-urp';

// Prepared material and view-only depth programs share this View ABI.
export function viewAndSceneDepthLayoutEntries(hasAtmosphere: boolean): GPUBindGroupLayoutEntry[] {
  return [
    ...(hasAtmosphere
      ? [...atmosphereViewLayoutEntries(), ...atmosphereMaterialVisibilityLayoutEntries()]
      : []),
    {
      binding: 0,
      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
      buffer: { type: 'uniform' },
    },
    {
      binding: 1,
      // Vertex shaders may query depth dimensions as well as fragment depth samples.
      visibility: GPU_SHADER_STAGE_VERTEX | GPU_SHADER_STAGE_FRAGMENT,
      texture: { sampleType: 'depth', viewDimension: '2d', multisampled: false },
    },
  ];
}

function directionalPcssCapable(backendKind: RhiDevice['caps']['backendKind']): boolean {
  return backendKind === 'webgpu' || backendKind === 'wgpu-native';
}

export function isSharedMaterialUserRegionCompatible(
  paramSchema: readonly ParamSchemaEntry[],
): boolean {
  const withoutPhysicalMaps = (
    schema: readonly ParamSchemaEntry[],
  ): readonly ParamSchemaEntry[] => {
    const excluded = new Set<string>(standardPhysicalTextureFields(schema));
    return schema.filter((entry) => !excluded.has(entry.name) || !entry.type.startsWith('texture'));
  };
  const sharedSchema = withoutPhysicalMaps(DEFAULT_STANDARD_PBR_PARAM_SCHEMA);
  const candidateSchema = withoutPhysicalMaps(paramSchema);
  const shared = buildPbrMaterialUserRegionEntries(sharedSchema);
  const candidate = buildPbrMaterialUserRegionEntries(candidateSchema);
  const sharedTextureNames = [...derive(sharedSchema).textureFieldNames];
  const candidateTextureNames = [...derive(candidateSchema).textureFieldNames];
  if (
    candidateTextureNames.length !== sharedTextureNames.length ||
    candidateTextureNames.some((name, index) => name !== sharedTextureNames[index])
  ) {
    return false;
  }
  if (candidate.length > shared.length) return false;
  return candidate.every((entry, index) => {
    const canonical = shared[index];
    if (canonical === undefined) return false;
    return (
      JSON.stringify({
        binding: entry.binding,
        visibility: entry.visibility,
        buffer: entry.buffer ?? null,
        sampler: entry.sampler ?? null,
        texture: entry.texture ?? null,
        storageTexture: entry.storageTexture ?? null,
        externalTexture: entry.externalTexture ?? null,
      }) ===
      JSON.stringify({
        binding: canonical.binding,
        visibility: canonical.visibility,
        buffer: canonical.buffer ?? null,
        sampler: canonical.sampler ?? null,
        texture: canonical.texture ?? null,
        storageTexture: canonical.storageTexture ?? null,
        externalTexture: canonical.externalTexture ?? null,
      })
    );
  });
}

/**
 * Select the PBR variant that matches a fallback mesh with no COLOR_0 input.
 * Unknown/custom material IDs may still use the legacy PBR fallback, so that
 * path must obey the same geometry-owned vertex-color axis as registered PBR.
 */
export function selectNoColorPbrVariant(
  manifestEntry: MaterialShaderManifestEntry | undefined,
  storageBufferCapable: boolean,
  variantSet: string | undefined,
  extendedLightingShaderAvailable = true,
  directionalPcssAvailable = true,
  projectorAvailable: boolean = true,
): MaterialShaderManifestEntry['variants'][number] | undefined {
  const hdrpRequested = variantSet === '' || requestsClusterVariant(variantSet);
  const probeBlendRequested = requestsProbeBlendVariant(variantSet);
  const coverageOnlyRequested = variantSet?.includes('COVERAGE_ONLY=true') === true;
  const visibleSurfaceRequested = variantSet?.includes('VISIBLE_SURFACE_AVAILABLE=true') === true;
  return manifestEntry?.variants.find(
    (variant) =>
      variant.defines.STORAGE_BUFFER_AVAILABLE === storageBufferCapable &&
      (!('ATMOSPHERE_AVAILABLE' in variant.defines) ||
        variant.defines.ATMOSPHERE_AVAILABLE ===
          variantSet?.includes('ATMOSPHERE_AVAILABLE=true')) &&
      (!('VISIBLE_SURFACE_AVAILABLE' in variant.defines) ||
        variant.defines.VISIBLE_SURFACE_AVAILABLE === visibleSurfaceRequested) &&
      (!('COVERAGE_ONLY' in variant.defines) ||
        variant.defines.COVERAGE_ONLY === coverageOnlyRequested) &&
      (!('EXTENDED_LIGHTING_AVAILABLE' in variant.defines) ||
        variant.defines.EXTENDED_LIGHTING_AVAILABLE === extendedLightingShaderAvailable) &&
      variant.defines.VERTEX_COLOR_AVAILABLE === false &&
      (!('DIRECTIONAL_PCSS_AVAILABLE' in variant.defines) ||
        variant.defines.DIRECTIONAL_PCSS_AVAILABLE === directionalPcssAvailable) &&
      (!('PROJECTOR_AVAILABLE' in variant.defines) ||
        variant.defines.PROJECTOR_AVAILABLE === projectorAvailable) &&
      (!('PROBE_BLEND_AVAILABLE' in variant.defines) ||
        variant.defines.PROBE_BLEND_AVAILABLE === probeBlendRequested) &&
      (!('CLUSTER_FORWARD_AVAILABLE' in variant.defines) ||
        variant.defines.CLUSTER_FORWARD_AVAILABLE === hdrpRequested),
  );
}

function requestsClusterVariant(variantSet: string | undefined): boolean {
  return variantSet?.includes('CLUSTER_FORWARD_AVAILABLE=true') === true;
}

function requestsProbeBlendVariant(variantSet: string | undefined): boolean {
  return variantSet?.includes('PROBE_BLEND_AVAILABLE=true') === true;
}

export type MaterialShaderBindingContract =
  import('../features/plan').RenderFeatureMaterialShaderContract;
export type MaterialShaderVertexInputContract = 'none' | 'render-material';

export function resolveMaterialShaderBindingContract(
  receipt:
    | Pick<import('@forgeax/engine-types').MaterialProgramAbi, 'bindings' | 'sceneDepth'>
    | undefined,
): MaterialShaderBindingContract {
  return {
    bindings: receipt?.bindings ?? 'render-material',
    ...(receipt?.sceneDepth === undefined ? {} : { sceneDepth: receipt.sceneDepth }),
  };
}

export function resolveMaterialShaderVertexInputContract(
  source: string,
): MaterialShaderVertexInputContract {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
  const inputStructs = [...withoutComments.matchAll(/struct\s+([A-Za-z_]\w*)\s*\{([^}]*)\}/gu)]
    .filter((match) => /@location\s*\(/u.test(match[2] ?? ''))
    .map((match) => match[1]);
  // WGSL vertex inputs are commonly declared in a named struct before the
  // `@vertex` function (the engine uses `VsIn`, while package shaders often
  // use `VertexInput`). Match the type actually passed as the first vertex
  // parameter so fragment/output structs do not accidentally enable a
  // vertex buffer layout for fullscreen shaders.
  for (const inputStruct of inputStructs) {
    if (inputStruct === undefined) continue;
    const firstParameter = new RegExp(
      `@vertex\\s*fn\\s+\\w+\\s*\\(\\s*\\w+\\s*:\\s*${inputStruct}\\b`,
      'u',
    );
    if (firstParameter.test(withoutComments)) return 'render-material';
  }
  // A shader may declare a location directly on a vertex parameter rather
  // than through a struct. Keep that contract explicit as well.
  return /@vertex\s*fn[^{]*\([^)]*@location\s*\(/u.test(withoutComments)
    ? 'render-material'
    : 'none';
}

/**
 * Resolve the number of UV sets declared by one material artifact.
 *
 * Runtime-published Surface programs do not necessarily have a manifest
 * reflection row, so the authored vertex input is the fallback source of
 * truth. The renderer then feeds this count into the geometry alias
 * projection, which clamps missing mesh UV sets to the last available set.
 */
export function resolveMaterialShaderUvSetCount(
  source: string | undefined,
  reflectedCount?: number,
): number | undefined {
  return reflectedCount ?? (source === undefined ? undefined : materialShaderUvSetCount(source));
}

/**
 * Select a published material artifact that matches a downlevel backend.
 *
 * Cooked Surface publications carry immutable backend variants in their
 * metadata. WebGL2 must select the uniform-fallback specialization before
 * pipeline construction so its shader, bind-group layout, and cache key stay
 * capability-consistent.
 */
export function resolveMaterialShaderBackendArtifactKey(
  materialShaderId: string,
  backendKind: 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null',
  artifact:
    | {
        readonly metadata?: Readonly<Record<string, unknown>>;
      }
    | undefined,
): string {
  if (backendKind !== 'wgpu-webgl2') return materialShaderId;
  const variants = artifact?.metadata?.variants;
  if (!Array.isArray(variants)) return materialShaderId;
  const fallback = variants.find((variant): variant is { specializationKey: string } => {
    if (typeof variant !== 'object' || variant === null) return false;
    const candidate = variant as Record<string, unknown>;
    return (
      candidate.backend === 'webgl2' &&
      candidate.capability === 'uniform-fallback' &&
      typeof candidate.specializationKey === 'string' &&
      candidate.specializationKey.length > 0
    );
  });
  return fallback?.specializationKey ?? materialShaderId;
}

/**
 * Remove the optional cloud-shadow sampler pair from a cooked material when
 * the active device has no spare sampled-texture lanes. Pack-cooked material
 * programs are immutable artifacts and therefore do not carry the engine
 * manifest's capability Cartesian product. The low-limit renderer contract is
 * still explicit: direct solar remains fully lit, while the view BGL stays at
 * its 16-texture limit. Only the cloud sampler declarations and their sample
 * are rewritten; the material's surface, parameters, and lighting remain
 * unchanged.
 */
export function stripCloudShadowBindingsForLowLimit(source: string): string {
  const textureDeclaration =
    /@group\s*\(\s*0\s*\)\s*@binding\s*\(\s*16\s*\)\s*var\s+(\w+)\s*:\s*texture_2d<f32>\s*;\s*/u;
  const samplerDeclaration =
    /@group\s*\(\s*0\s*\)\s*@binding\s*\(\s*17\s*\)\s*var\s+(\w+)\s*:\s*sampler\s*;\s*/u;
  const textureMatch = textureDeclaration.exec(source);
  const samplerMatch = samplerDeclaration.exec(source);
  if (textureMatch === null || samplerMatch === null) return source;
  const textureName = textureMatch[1];
  const samplerName = samplerMatch[1];
  if (textureName === undefined || samplerName === undefined) return source;

  let rewritten = source.replace(textureDeclaration, '').replace(samplerDeclaration, '');
  const escapedTexture = textureName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const escapedSampler = samplerName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const cloudSample = new RegExp(
    `textureSampleLevel\\(\\s*${escapedTexture}\\s*,\\s*${escapedSampler}\\s*,[^;\\n]*\\)`,
    'gu',
  );
  rewritten = rewritten.replace(cloudSample, 'vec4<f32>(1.0)');
  return rewritten;
}

export function prepareLowLimitMaterialShaderEntry<T extends { readonly source: string }>(
  entry: T,
  sampledTextureLimit: number | undefined,
): T {
  if ((sampledTextureLimit ?? 0) >= STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES) return entry;
  const source = stripCloudShadowBindingsForLowLimit(entry.source);
  return source === entry.source ? entry : ({ ...entry, source } as T);
}

export function allowsUnlitPreparedFallback(
  depthFormatOverride: GPUTextureFormat | null | undefined,
  vertexLayout: string | undefined,
  materialShaderId?: string,
): boolean {
  return (
    depthFormatOverride === null &&
    (vertexLayout === undefined || !materialShaderId?.startsWith('forgeax::'))
  );
}

/** Prepared instance layouts require their exact shader; a mesh fallback has a different ABI. */
export function requiresPreparedMaterialShader(vertexLayout: string | undefined): boolean {
  return (
    vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInstance ||
    vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.billboardMaterialInputInstance ||
    vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentInstance ||
    vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.topologySegmentMaterialInputInstance ||
    vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInstance ||
    vertexLayout === RENDER_FEATURE_VERTEX_LAYOUTS.meshGeometryMaterialInputInstance
  );
}

export function selectPipelineLayoutForVariant(
  state: {
    readonly pbrPipelineLayout: PipelineLayout | null;
    readonly pbrProbePipelineLayout?: PipelineLayout | null;
    readonly hdrpPbrPipelineLayout: PipelineLayout | null;
    readonly hdrpProbePbrPipelineLayout?: PipelineLayout | null;
    readonly pbrSkinPipelineLayout: PipelineLayout | null;
    readonly pbrSkinProbePipelineLayout?: PipelineLayout | null;
    readonly gpuDrivenPbrPipelineLayout?: PipelineLayout | null;
    readonly gpuDrivenPbrSkinPipelineLayout?: PipelineLayout | null;
    readonly gpuDrivenClusterPbrPipelineLayout?: PipelineLayout | null;
    readonly gpuDrivenClusterPbrSkinPipelineLayout?: PipelineLayout | null;
    readonly hdrpSkinPipelineLayout?: PipelineLayout | null;
    readonly hdrpSkinProbePipelineLayout?: PipelineLayout | null;
  } | null,
  variantSet: string | undefined,
  layoutKind?: LayoutKind,
): PipelineLayout | null {
  if (state === null) return null;
  const probeBlendVariant = variantSet?.includes('PROBE_BLEND_AVAILABLE=true') === true;
  if (layoutKind === 'gpu-driven-pbr') {
    return state.gpuDrivenPbrPipelineLayout ?? null;
  }
  if (layoutKind === 'gpu-driven-skin') {
    return state.gpuDrivenPbrSkinPipelineLayout ?? null;
  }
  if (layoutKind === 'gpu-driven-cluster-pbr') {
    return state.gpuDrivenClusterPbrPipelineLayout ?? null;
  }
  if (layoutKind === 'gpu-driven-cluster-skin') {
    return state.gpuDrivenClusterPbrSkinPipelineLayout ?? null;
  }
  // Deformation and probe bindings are independent layout dimensions.
  if (layoutKind === 'pbr-skin') {
    return probeBlendVariant
      ? (state.pbrSkinProbePipelineLayout ?? null)
      : state.pbrSkinPipelineLayout;
  }
  if (layoutKind === 'hdrp-skin') {
    return (
      (probeBlendVariant ? state.hdrpSkinProbePipelineLayout : state.hdrpSkinPipelineLayout) ?? null
    );
  }
  // bug-20260708 M2 (c): sprite / sprite-lit shaders reuse the URP 1-slot
  // mesh-array pipeline layout but their canonical all-true variant key
  // `''` (SPRITE_PASS_PER_INSTANCE_REGION_VARIANT_SET) must NOT trigger
  // the `variantSet===''` → HDRP branch below. Caller-side
  // (`buildPipelineContext`) resolves LayoutKind='sprite-urp' from the
  // sprite `materialShaderId`; the selector short-circuits here before
  // the HDRP variant check reads `variantSet`. Prevents R-1'
  // device-lost when a SpriteInstances batch requests the PIR=true
  // canonical variant.
  if (layoutKind === 'sprite-urp') {
    return state.pbrPipelineLayout;
  }
  if (layoutKind === 'unlit-urp') {
    return state.pbrPipelineLayout;
  }
  // Static PBR callers can use the canonical all-true variant key (`''`)
  // without becoming HDRP. Keep the shader variant identity independent from
  // the pipeline-layout identity; shadow-caster static draws use this explicit
  // kind so their ordinary mesh bind group remains compatible with the PSO.
  if (layoutKind === 'pbr') {
    return probeBlendVariant ? (state.pbrProbePipelineLayout ?? null) : state.pbrPipelineLayout;
  }
  // HDRP variant matches when:
  //   - layoutKind === 'hdrp-pbr' (caller-driven, future-proof), OR
  //   - variantSet is the canonical all-true key '' (boot-time HDRP
  //     registration produces '' when both axes resolve to true), OR
  //   - variantSet contains `CLUSTER_FORWARD_AVAILABLE=true` substring
  //     (record-stage caller emits the expanded form).
  // URP variants have CLUSTER_FORWARD_AVAILABLE=false explicitly, or omit
  // the axis altogether, or pass undefined (no variant routing).
  // G-14 (D-11): empty-string is the canonical all-true HDRP key, so we
  // explicitly distinguish '' vs undefined rather than using an optional-chain
  // (charter P3: explicit failure / no implicit empty-vs-missing collapse).
  const isHdrpVariant = layoutKind === 'hdrp-pbr';
  if (isHdrpVariant) {
    return probeBlendVariant
      ? (state.hdrpProbePbrPipelineLayout ?? null)
      : state.hdrpPbrPipelineLayout;
  }
  return probeBlendVariant ? (state.pbrProbePipelineLayout ?? null) : state.pbrPipelineLayout;
}

/**
 * Resolve a requested material variant against the actual backend capabilities.
 * Record callers use the native-capability request; the backend-owned axes
 * must be rewritten before the request reaches shader lookup and PSO layout
 * selection.
 */
export function resolveMaterialShaderVariantSet(
  requestedVariantSet: string | undefined,
  variants: ReadonlyArray<{
    readonly defines: Readonly<Record<string, boolean>>;
  }>,
  backendKind: RhiDevice['caps']['backendKind'],
  storageBuffer: boolean,
  maxSampledTexturesPerShaderStageOrProjectorAvailable?: number | boolean,
): string | undefined {
  const declaredAxes = new Set(variants.flatMap((variant) => Object.keys(variant.defines)));
  const declaresCapabilityVariants =
    declaredAxes.has('ATMOSPHERE_AVAILABLE') ||
    declaredAxes.has('COVERAGE_ONLY') ||
    declaredAxes.has('WEBGL2_COMPAT') ||
    declaredAxes.has('STORAGE_BUFFER_AVAILABLE') ||
    declaredAxes.has('EXTENDED_LIGHTING_AVAILABLE') ||
    declaredAxes.has('DIRECTIONAL_PCSS_AVAILABLE') ||
    declaredAxes.has('PROJECTOR_AVAILABLE');
  if (!declaresCapabilityVariants) return requestedVariantSet;

  const requested: Record<string, boolean> = {};
  for (const part of requestedVariantSet?.split('+') ?? []) {
    const separator = part.indexOf('=');
    if (separator > 0) requested[part.slice(0, separator)] = part.slice(separator + 1) === 'true';
  }
  const sampledTextureLimit =
    typeof maxSampledTexturesPerShaderStageOrProjectorAvailable === 'number'
      ? maxSampledTexturesPerShaderStageOrProjectorAvailable
      : undefined;
  const extendedLightingAvailable =
    sampledTextureLimit === undefined
      ? true
      : backendKind !== 'wgpu-webgl2' &&
        storageBuffer &&
        extendedLightingSampledTextureCapacityAvailable(sampledTextureLimit);
  const projectorAvailable =
    typeof maxSampledTexturesPerShaderStageOrProjectorAvailable === 'boolean'
      ? maxSampledTexturesPerShaderStageOrProjectorAvailable
      : sampledTextureLimit === undefined
        ? true
        : sampledTextureLimit >= STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES;
  const filtered: Record<string, boolean> = {};
  for (const axis of declaredAxes) {
    filtered[axis] =
      axis === 'ATMOSPHERE_AVAILABLE'
        ? atmosphereAvailable(storageBuffer && backendKind !== 'wgpu-webgl2', sampledTextureLimit)
        : axis === 'WEBGL2_COMPAT'
          ? backendKind === 'wgpu-webgl2'
          : axis === 'STORAGE_BUFFER_AVAILABLE'
            ? backendKind !== 'wgpu-webgl2' && storageBuffer
            : axis === 'SKINNING_DISABLED'
              ? (requested[axis] ?? true)
              : axis === 'ALPHA_MASK' ||
                  axis === 'GPU_DRIVEN_SCENE_INDEX_AVAILABLE' ||
                  axis === 'GPU_DRIVEN_SCENE_INDEX_EXPLICIT' ||
                  axis === 'COVERAGE_ONLY' ||
                  axis === 'VISIBLE_SURFACE_AVAILABLE'
                ? (requested[axis] ?? false)
                : axis === 'CLUSTER_FORWARD_AVAILABLE'
                  ? (requested[axis] ?? false)
                  : axis === 'PER_INSTANCE_REGION'
                    ? requestedVariantSet === '' || (requested[axis] ?? false)
                    : axis === 'VERTEX_COLOR_AVAILABLE'
                      ? requestedVariantSet === '' || (requested[axis] ?? false)
                      : axis === 'EXTENDED_LIGHTING_AVAILABLE'
                        ? extendedLightingAvailable
                        : axis === 'PROBE_BLEND_AVAILABLE'
                          ? storageBuffer && (requested[axis] ?? false)
                          : axis === 'TRANSMISSION_AVAILABLE' ||
                              axis === 'REFLECTION_FALLBACK_AVAILABLE'
                            ? (requested[axis] ?? false)
                            : axis === 'DIRECTIONAL_PCSS_AVAILABLE'
                              ? directionalPcssCapable(backendKind)
                              : axis === 'PROJECTOR_AVAILABLE'
                                ? projectorAvailable
                                : // Authored axes keep the manifest's all-true default.
                                  // Only Engine-owned admission axes default to disabled.
                                  (requested[axis] ?? true);
  }
  const sorted = Object.entries(filtered).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.every(([, value]) => value)
    ? requestedVariantSet === undefined
      ? undefined
      : ''
    : sorted.map(([name, value]) => `${name}=${value}`).join('+');
}

/**
 * Keep a single-source material on its canonical module identity. A manifest
 * entry with no variants cannot consume a synthesized capability or geometry
 * axis, so carrying one into the pipeline cache only creates an uncached lazy
 * compile beside the prewarmed source module.
 */
export function normalizeMaterialShaderVariantSet(
  requestedVariantSet: string | undefined,
  manifestEntry: MaterialShaderManifestEntry | undefined,
): string | undefined {
  return manifestEntry !== undefined && manifestEntry.variants.length === 0
    ? undefined
    : requestedVariantSet;
}

/** Feature-owned graphics use the same device admission as ordinary materials. */
export function resolveFeatureShaderSource(
  catalog: ShaderCatalog,
  device: RhiDevice,
  identifier: string,
): string | undefined {
  const entry = Array.from(catalog.materialShaderManifestEntries()).find(
    (entry) => entry.identifier === identifier,
  );
  if (entry === undefined) return undefined;
  const variantSet = resolveMaterialShaderVariantSet(
    undefined,
    entry.variants,
    device.caps.backendKind,
    device.caps.storageBuffer,
    device.limits.maxSampledTexturesPerShaderStage,
  );
  return variantSet === undefined
    ? entry.composedWgsl
    : entry.variants.find((variant) => variant.definesKey === variantSet)?.composedWgsl;
}
