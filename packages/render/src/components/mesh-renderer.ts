// @forgeax/engine-render - MeshRenderer (multi-material array slot).
//
// feat-20260608-mesh-multi-section-primitive-multi-material-slot M2 / w7:
// the single `material` field is replaced with `materials` — an
// `array<shared<MaterialAsset>>` indexed by MeshAsset.materialSlots. Entries
// are sparse positional overrides: a missing/zero entry inherits the Mesh
// slot default, while a defaultless slot inherits the neutral engine material.
//
// The schema-vocab keyword `'array<shared<MaterialAsset>>'` (feat-20260614
// M5 -- migrated from `'array<handle<MaterialAsset>>'`) stores as a u32
// column slot array; the brand prevents cross-asset assignment at compile
// time. The `'shared<T>'` arm routes element retain/release through
// SharedRefStore (M4 / w13) on overwrite / archetype migration.
//
// charter mapping: proposition 1 (single import — `MeshRenderer` is the
// only material-binding component AI users see); proposition 3
// (machine-readable schema > prose); proposition 4 (explicit failure: the
// TS brand on `Handle<'MaterialAsset','shared'>` rejects cross-variant
// assignment at compile time); proposition 5 (consistent abstraction:
// shading model classification (`'unlit'` / `'standard'`) lives ONLY on
// the asset discriminant, NOT on the component name).
//
// RenderSystem consumption: `render-system-extract.ts` runs ONE archetype
// query (`world.query(MeshRenderer)`) and routes per entity by
// `mat.materialShaderId` (shader identity) to the unlit.wgsl or pbr.wgsl
// pipeline tag.

import { defineComponent } from '@forgeax/engine-ecs';
import { LIGHTING_CHANNELS_DEFAULT } from './lighting-channels';

/**
 * Mesh renderer (ECS component, multi-material array).
 *
 * Stores `materials: readonly Handle<'MaterialAsset','shared'>[]`
 * (u32-stored array, indexed by MeshAsset.materialSlots). Submeshes point to
 * those stable slots through `Submesh.materialSlot`. The asset's `passes[].shader`
 * identity is the SSOT for which pipeline RenderSystem routes the entity
 * to (record stage dispatches on `materialShaderId`).
 *
 * Defaults map carries `materials: []`: every slot inherits its Mesh-owned
 * default, or the neutral engine material when that slot is intentionally
 * defaultless.
 *
 * @example Spawn while inheriting every Mesh slot default:
 *   world.spawn({ component: MeshRenderer, data: {} });
 *
 * @example Spawn an unlit-targeted entity:
 *   import { MeshRenderer, Materials } from '@forgeax/engine-render';
 *   const matPayload = engine.assets.catalog(matGuid, Materials.unlit([1, 0, 0, 1])).value;
 *   const matHandle = world.allocSharedRef('MaterialAsset', matPayload);
 *   world.spawn({ component: MeshRenderer, data: { materials: [matHandle] } });
 *
 * @example Spawn a standard (PBR) entity:
 *   const matPayload = engine.assets.catalog(matGuid, Materials.standard({
 *     baseColor: [0.5, 0.5, 0.5, 1], metallic: 0, roughness: 0.4,
 *   })).value;
 *   const matHandle = world.allocSharedRef('MaterialAsset', matPayload);
 *   world.spawn({ component: MeshRenderer, data: { materials: [matHandle] } });
 */
export const MeshRenderer = defineComponent('MeshRenderer', {
  // f64 preserves invalid author inputs until render validation (no u32 wrapping).
  lightingChannels: { type: 'f64', default: LIGHTING_CHANNELS_DEFAULT },
  materials: { type: 'array<shared<MaterialAsset>>', default: [] },
  // Current-joint conservative envelopes trade tighter culling for less CPU work.
  conservativeSkinBounds: { type: 'bool', default: false },
});
