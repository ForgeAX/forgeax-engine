// @forgeax/engine-runtime - glyphTextLayoutSystem
// (feat-20260531-world-space-msdf-text-rendering M4 / w18).
//
// The named ECS system that turns `GlyphText` authoring data into a rendered
// world-space label (plan-strategy D-2). A Renderer attaches it to World's
// internal render-derived phase,
// so a freshly-spawned `GlyphText` entity gains its `MeshFilter` +
// `MeshRenderer` before final publication resolves transforms and the same frame's
// read-only render walk reaches it. Per `GlyphText` entity:
//
//   1. First observation (entity has no `MeshFilter`): resolve the FontAsset,
//      run `layoutGlyphText` (w15) + `bakeGlyphMesh` (w17), then attach
//      `MeshFilter` + `MeshRenderer` (AC-07). The attach uses the same
//      immediate `world.addComponent` path as `spriteAnimationTickSystem`'s
//      auto-add (the system runs ahead of the render walk in the same frame).
//   2. Dirty (text / fontSize / color changed since last bake): re-layout and
//      `updateMesh` IN PLACE (plan-strategy D-1) -- never re-`register`, never
//      re-attach. The AssetRegistry size stays constant (AC-08; avoids the
//      unbounded growth R-1 would otherwise cause).
//
// D-8 concurrency: at most 8 distinct FontAsset handles may be active in one
// frame. The system resets the per-frame tracker (resetFontConcurrency) at the
// top and tracks each distinct font; the 9th distinct font surfaces a
// structured `TextError('font-concurrency-exceeded')` (it does NOT silently
// evict the oldest font).
//
// The system does NOT modify `pick.ts` (D-5): the baked mesh carries a local
// AABB and the entity carries MeshFilter + MeshRenderer + Transform, so the
// existing `pick()` raycast walk catches it for free.

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  bakeGlyphMesh,
  buildGlyphMeshAsset,
  layoutGlyphText,
  resetFontConcurrency,
  trackFontConcurrency,
} from '@forgeax/engine-graphics-extras';
import type { FontAsset, Handle, MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { err, ok, type Result, TextError, toShared, unpackSlot } from '@forgeax/engine-types';
import { MeshFilter, MeshRenderer } from './components';
import { GlyphText } from './components/glyph-text';
import type { GpuResidencyCache } from './device/gpu-residency';

// Per-entity bake bookkeeping: the baked mesh handle id + the authoring
// signature it was baked from. A WeakMap owns one cache per World and each
// entry is bounded by entity slot while retaining the full generation-bearing
// EntityHandle, so slot reuse replaces stale state instead of aliasing it or
// growing one historical entry per generation.
interface BakeRecord {
  readonly meshHandle: Handle<'MeshAsset', 'shared'>;
  signature: string;
  /** The MeshRenderer.material handle assigned on first observation. */
  readonly materialHandle: Handle<'MaterialAsset', 'shared'>;
}
interface BakeCacheEntry {
  readonly handle: EntityHandle;
  readonly record: BakeRecord;
}
let bakeCache = new WeakMap<World, Map<number, BakeCacheEntry>>();

// One current material producer handle per GlyphText entity slot. Continuous
// tint edits replace and release the previous producer instead of growing a
// historical color-key cache.
let materialCache = new WeakMap<World, Map<number, Handle<'MaterialAsset', 'shared'>>>();
let liveGlyphSlots = new WeakMap<World, Set<number>>();

function entitySlot(entity: EntityHandle): number {
  return unpackSlot(entity as number);
}

/** Clear the per-entity bake + per-font material caches (test isolation). */
export function resetGlyphBakeCache(): void {
  bakeCache = new WeakMap();
  materialCache = new WeakMap();
  liveGlyphSlots = new WeakMap();
}

function worldBakeCache(world: World): Map<number, BakeCacheEntry> {
  let cache = bakeCache.get(world);
  if (cache === undefined) {
    cache = new Map();
    bakeCache.set(world, cache);
  }
  return cache;
}

function worldMaterialCache(world: World): Map<number, Handle<'MaterialAsset', 'shared'>> {
  let cache = materialCache.get(world);
  if (cache === undefined) {
    cache = new Map();
    materialCache.set(world, cache);
  }
  return cache;
}

/** Release renderer-derived producer refs at GlyphText removal time. */
function releaseGlyphProducers(world: World, entity: EntityHandle): void {
  const slot = entitySlot(entity);
  const bake = bakeCache.get(world)?.get(slot);
  if (bake?.handle === entity) {
    world.sharedRefs.release(bake.record.meshHandle);
    bakeCache.get(world)?.delete(slot);
  }
  const material = materialCache.get(world)?.get(slot);
  if (material !== undefined) {
    world.sharedRefs.release(material);
    materialCache.get(world)?.delete(slot);
  }
}

/** Remove stale renderer-derived state when a previously baked font is rejected. */
function clearRejectedGlyphState(world: World, entity: EntityHandle): void {
  const slot = entitySlot(entity);
  const bake = bakeCache.get(world)?.get(slot);
  if (bake?.handle !== entity) return;

  // These components are owned by this system only when the matching bake
  // record exists. Removing them before releasing the producer refs leaves no
  // stale draw/material handles and lets the next valid frame take the normal
  // first-observation path.
  if (world.get(entity, MeshFilter).ok) world.removeComponent(entity, MeshFilter);
  if (world.get(entity, MeshRenderer).ok) world.removeComponent(entity, MeshRenderer);
  releaseGlyphProducers(world, entity);
}

// Premultiplied-alpha blend (mirrors the sprite path, plan D-7). The
// `forgeax::msdf-text` fragment emits premultiplied RGB so the over-composite
// math (`dst' = src + dst * (1 - src.a)`) is direct. The pass rides the
// Transparent queue (3000) so text composites after opaque geometry while
// honoring depth occlusion (depthCompare less-equal, depthWrite off via the
// material-shader pipeline render state).
const MSDF_TEXT_BLEND = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
} as const;

interface GlyphTextData {
  readonly fontHandle: number;
  readonly text: string;
  readonly fontSize: number;
  // feat-20260709 M3: color collapsed into one inline array<f32,4>; the
  // world.get read path materialises it as a Float32Array (color[0..3] = rgba).
  readonly color: ArrayLike<number>;
}

/** @internal archetype-walk view (same shape reached for in render-system-extract). */
/**
 * Lay out + bake every `GlyphText` entity, attaching MeshFilter + MeshRenderer
 * on first observation and re-baking in place on a text / size / color change.
 *
 * @param world The ECS world holding the GlyphText entities.
 * @returns `ok(void)` on a clean pass, or `err(TextError)` carrying the FIRST
 *   structured failure (currently only `font-concurrency-exceeded`). Healthy
 *   entities observed before the failing one are still baked.
 */
export function glyphTextLayoutSystem(
  world: World,
  gpuStore: Pick<GpuResidencyCache, 'updateMesh'>,
): Result<void, TextError> {
  resetFontConcurrency();

  // No GlyphText entity in this World -> empty query -> no-op pass. The
  // ECS query is the single owner of component presence and entity iteration;
  // the renderer does not reach into archetype storage internals.
  const entities = collectGlyphEntities(world);
  const live = liveGlyphSlots.get(world) ?? new Set<number>();
  live.clear();
  for (const entity of entities) live.add(entitySlot(entity));
  liveGlyphSlots.set(world, live);
  for (const entry of worldBakeCache(world).values()) {
    if (!live.has(entitySlot(entry.handle))) releaseGlyphProducers(world, entry.handle);
  }

  let firstError: TextError | null = null;
  for (const entity of entities) {
    const error = processEntity(world, gpuStore, entity);
    if (error !== null && firstError === null) firstError = error;
  }

  if (firstError !== null) return err(firstError);
  return ok(undefined);
}

/** Collect every Entity handle carrying GlyphText (single archetype walk). */
function collectGlyphEntities(world: World): EntityHandle[] {
  const entities: EntityHandle[] = [];
  const query = world.query({ read: [GlyphText] }).unwrap();
  for (const row of query) {
    entities.push(row.entity);
  }
  return entities;
}

/**
 * Process one GlyphText entity. Returns a TextError when the concurrency limit
 * is exceeded after clearing stale derived state; returns null otherwise.
 */
function processEntity(
  world: World,
  gpuStore: Pick<GpuResidencyCache, 'updateMesh'>,
  entity: EntityHandle,
): TextError | null {
  const gtRes = world.get(entity, GlyphText);
  if (!gtRes.ok) return null;
  const gt = gtRes.value;

  // Unresolved font handle (zero sentinel) -> skip (entity not yet wired).
  if (gt.fontHandle === 0) return null;

  // D-8 concurrency: track this distinct font; the 9th throws a TextError.
  try {
    trackFontConcurrency(gt.fontHandle);
  } catch (e) {
    if (e instanceof TextError) {
      clearRejectedGlyphState(world, entity);
      return e;
    }
    throw e;
  }

  const fontRes = resolveAssetHandle<FontAsset>(world, asFontHandle(gt.fontHandle));
  if (!fontRes.ok) return null; // font not registered yet -> skip silently
  const font = fontRes.value;

  const signature = signatureOf(gt);
  const entityCache = worldBakeCache(world);
  const slot = entitySlot(entity);
  const cachedEntry = entityCache.get(slot);
  if (cachedEntry !== undefined && cachedEntry.handle !== entity) {
    world.sharedRefs.release(cachedEntry.record.meshHandle);
    const staleMaterial = worldMaterialCache(world).get(slot);
    if (staleMaterial !== undefined) {
      world.sharedRefs.release(staleMaterial);
      worldMaterialCache(world).delete(slot);
    }
    entityCache.delete(slot);
  }
  const cached = cachedEntry?.handle === entity ? cachedEntry.record : undefined;

  // Dirty path: same entity already baked, but the authoring signature changed.
  if (cached !== undefined) {
    ensureGlyphMeshMaterialSlots(world, cached.meshHandle);
    if (cached.signature === signature) return null; // clean -> nothing to do
    const layout = layoutGlyphText(font, gt.text, gt.fontSize);
    // feat-20260601-device/gpu-residency-extraction M1: in-place GPU mesh update
    // moved to the store. The mesh became GPU-resident on the first render
    // frame's `ensureResident` pull; the dirty re-layout overwrites those
    // buffers in place (a no-op if not yet resident -- the next render's
    // ensureResident then uploads the latest registered POD).
    const meshHandle = cached.meshHandle;
    const updated = buildGlyphMeshAsset(layout);
    // Publish the same payload used for the initial bake before updating residency.
    // This also refreshes CPU attributes for exact picking after the text changes.
    const mesh = world.sharedRefs.resolve<'MeshAsset', MeshAsset>(meshHandle);
    if (mesh.ok) Object.assign(mesh.value, updated);
    gpuStore.updateMesh(
      meshHandle,
      updated.vertices,
      updated.indices as Uint16Array,
      0,
      updated.submeshes,
    );
    // A color change replaces the material payload at this entity's stable
    // derived slot and re-binds the new producer handle in place.
    const materialId = resolveTextMaterial(world, gt, font, slot);
    if (materialId !== cached.materialHandle) {
      world.set(entity, MeshRenderer, {
        materials: [materialId],
      });
    }
    entityCache.set(slot, {
      handle: entity,
      record: {
        meshHandle: cached.meshHandle,
        signature,
        materialHandle: materialId,
      },
    });
    return null;
  }

  // First-observation path. If this entity already carries a MeshFilter (e.g.
  // the bake cache was reset between frames), skip without re-baking. `world.get`
  // returns err(component-not-present) (never throws) when the column is absent,
  // so the column probe needs no registration guard (feat-20260602).
  const existingFilter = world.get(entity, MeshFilter);
  if (existingFilter.ok) {
    ensureGlyphMeshMaterialSlots(world, existingFilter.value.assetHandle);
    return null;
  }

  const layout = layoutGlyphText(font, gt.text, gt.fontSize);
  const bake = bakeGlyphMesh(world, layout);
  if (!bake.ok) return null; // register fail-fast (should not happen for w15 output)

  // F-1: resolve the entity-owned MSDF MaterialAsset so the
  // `forgeax::msdf-text` shader + atlas texture + sampler are bound to this
  // text entity (plan D-7). Without this the MeshRenderer would carry material
  // handle 0 -> default mid-grey unlit, and the atlas would never be sampled.
  const materialId = resolveTextMaterial(world, gt, font, slot);

  world.addComponent(entity, {
    component: MeshFilter,
    data: { assetHandle: bake.value.handle },
  });
  world.addComponent(entity, {
    component: MeshRenderer,
    data: { materials: [materialId] },
  });
  entityCache.set(slot, {
    handle: entity,
    record: {
      meshHandle: bake.value.handle,
      signature,
      materialHandle: materialId,
    },
  });
  return null;
}

export function ensureGlyphMeshMaterialSlots(
  world: World,
  meshHandle: Handle<'MeshAsset', 'shared'>,
): void {
  const mesh = world.sharedRefs.resolve<'MeshAsset', MeshAsset>(meshHandle);
  if (mesh.ok && !Array.isArray(mesh.value.materialSlots)) {
    Object.assign(mesh.value, { materialSlots: [{ slotName: 'Default' }] });
  }
}

/**
 * Build the MSDF text MaterialAsset for one World/entity slot and
 * return its raw unmanaged handle id. The material carries a single
 * Transparent-queue pass on the `forgeax::msdf-text` shader with premultiplied
 * blend, and values binding the tint color, packed atlas distance data, and an
 * embedded atlas texture reference (the record stage supplies the sampler).
 * HDR tint components (>1) flow through unchanged so bloom-enabled cameras
 * pick up bright text (AC-12).
 */
function resolveTextMaterial(
  world: World,
  gt: GlyphTextData,
  font: FontAsset,
  slot: number,
): Handle<'MaterialAsset', 'shared'> {
  const cache = worldMaterialCache(world);
  const material = {
    kind: 'material',
    passes: [
      {
        name: 'text',
        program: { module: 'forgeax::msdf-text' },
        renderState: {
          ...{
            blend: MSDF_TEXT_BLEND as never,
            cullMode: 'none',
            depthWriteEnabled: false,
            depthCompare: 'less-equal',
          },
          tags: { LightMode: 'Forward' },
          queue: 3000,
        },
      },
    ],
    values: {
      tintColor: [gt.color[0] ?? 1, gt.color[1] ?? 1, gt.color[2] ?? 1, gt.color[3] ?? 1],
      distanceRange: [
        font.common.distanceRange,
        font.common.atlasWidth,
        font.common.atlasHeight,
        0,
      ],
      baseColorTexture: { texture: font.atlas },
    },
    parameters: [
      { name: 'tintColor', type: 'color', default: [1, 1, 1, 1] },
      { name: 'distanceRange', type: 'vec4', default: [4, 512, 512, 0] },
      { name: 'baseColorTexture', type: 'texture' },
      { name: 'metallicRoughnessTexture', type: 'texture', optional: true },
      { name: 'normalTexture', type: 'texture', optional: true },
    ],
  } satisfies MaterialAsset;
  const id = world.allocSharedRef('MaterialAsset', material);
  const previous = cache.get(slot);
  cache.set(slot, id);
  if (previous !== undefined && previous !== id) {
    world.sharedRefs.release(previous);
  }
  return id;
}

function signatureOf(gt: GlyphTextData): string {
  return `${gt.fontHandle}|${gt.fontSize}|${gt.text}|${gt.color[0]},${gt.color[1]},${gt.color[2]},${gt.color[3]}`;
}

// Handle bridges: GlyphText.fontHandle / cached mesh ids are packed u32 values;
// AssetRegistry expects branded Handles. The brand is a compile-time phantom
// (runtime value is the raw number), so a cast is the canonical bridge
// (mirrors pick.ts toShared).
function asFontHandle(raw: number): Handle<'FontAsset', 'shared'> {
  return toShared<'FontAsset'>(raw);
}
