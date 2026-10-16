// feat-20260623 M2 w11+w12 — SceneInstance to SceneAsset POD collection + pack
// serialization (plan-strategy D-1: pure-data collector).
//
// feat-20260701-rootstosceneasset-forest-collect-schema-derived-ha:
//   rootsToSceneAsset(registry, world, roots) -> Result<SceneAsset, ...>
//   serializeSceneAssetToPack -> schema-derived refs[] index.
//
// feat-20260703-collect-nested-sceneinstance-to-mount-roundtrip M2 + M3:
//
//   ── mount-collapse (M2) ──
//   rootsToSceneAsset detects entities carrying SceneInstance (anchors) and
//   folds each anchor's subtree into a mounts[] entry — the uplink inverse of
//   instantiateScene which expands mounts[] into live entities.  Member
//   classification filter, not subtree pruning: BFS walks the full subtree
//   (collectSubtree unchanged, D-4), then anchors' members are folded into
//   mount windows, graft entities survive as owned, and cross-window entity
//   references are remapped to window LocalEntityIds.  Two anchor forms:
//   Form 2 (root = instance) strips SceneInstance without self-mount; Form 1
//   (deep anchor) folds at the anchor site with mount.parent pointing to the
//   anchor's ChildOf parent.  Window accounting (totalSlots = entities.length
//   + mounts.length + sum(memberCount)) preserves the child instance's full
//   totalSlots, never shrinking by surviving-member count (AC-03, #495 guard).
//
//   ── serialize mounts (M3) ──
//   serializeSceneAssetToPack maps in-memory mounts[].source GUID strings to
//   refs[] indices, memberFirst/memberCount/localId/parent numeric pass-through.
//   _resolveSceneGuids (asset-registry.ts) carries mounts through the reload
//   chain: recursively resolves child scene GUIDs, registers child copies in
//   the origin reverse-index (D-7), and protects against mount-source cycles
//   (R-9).  registry.instantiate wires an identity resolver so resolved mount
//   handles flow into instantiateScene transparently.
//
//   ── round-trip closure ──
//   The round-trip instantiate -> collect (rootsToSceneAsset) -> serialize
//   (serializeSceneAssetToPack) -> reload (loadByGuid + registry.instantiate)
//   -> instantiate produces a structurally equivalent live subtree (AC-04).
//   The equivalence benchmark is a second collect (fixed-point): after the
//   first reload, the second collect output equals the first (D-9 normalization
//   converges after one cycle).
//
//   ── known limitations ──
//   OOS-1: mount.overrides[] (Layer-0 diffs) are not folded back during collect.
//   D-9: Form 1 mount entity absorption — when the anchor parent cannot be
//   proven to be a mount entity, components is left undefined (one-time
//   normalization on first reload; fixed-point from second collect onward).

import {
  builtinMeshGuid,
  resolveAssetHandle,
  SceneCollectAssetGuidUnresolvedError,
  SceneCollectEntityRefOutOfClosureError,
} from '@forgeax/engine-assets-runtime';
import {
  componentDefinition,
  type Component as EcsComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { classifyEntityField } from '@forgeax/engine-ecs/externalization';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { SceneInstance } from '@forgeax/engine-render';
import { err, ok, type Result } from '@forgeax/engine-rhi';
import type { MountOverride, SceneInstanceMount } from '@forgeax/engine-scene';
import {
  collectSubtree,
  externalizeSceneAsset,
  SCENE_COLLECT_PROFILE,
  sceneEntityAddressKey,
  worldGetSceneAssetForInstance,
  worldGetSceneInstanceState,
} from '@forgeax/engine-scene';
import type { Asset, Handle, LocalEntityId, SceneAsset } from '@forgeax/engine-types';
import { foldMountOverrides } from './scene-utils/mount-override-fold';

/** The collector needs identity lookup, not an authoring registry implementation. */
export interface SceneAssetGuidLookup {
  guidOf(asset: Asset): string | undefined;
}

// Shared helpers
function _isArrayLike(value: unknown): value is ArrayLike<unknown> {
  // SceneAsset values are ordinary JSON arrays at the boundary. Use the
  // platform view predicate so fixed-array component fields such as Fog.color
  // remain generic when their storage element type grows, while DataView (a
  // byte accessor without indexed array semantics) stays scalar.
  return Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView));
}
function _normalizeArray(value: ArrayLike<unknown>): unknown[] {
  return Array.from(value);
}

// Schema-derived field classifier — shared kernel now owns entity classification.
// Keep the local shared<T> classifier because the kernel only handles entity fields.
type SchemaFieldClass =
  | { kind: 'entity'; scalar: true }
  | { kind: 'entity'; scalar: false }
  | { kind: 'shared'; scalar: true }
  | { kind: 'shared'; scalar: false };

function classifyFieldSchema(fieldType: string | undefined): SchemaFieldClass | undefined {
  if (fieldType === undefined) return undefined;
  if (fieldType.startsWith('shared<')) return { kind: 'shared', scalar: true };
  if (fieldType.startsWith('array<shared<')) return { kind: 'shared', scalar: false };
  return undefined;
}

// ── M5 (w21): override-value handle→GUID serialization ──
//
// Reverse-lookup one shared-field handle to its catalogued GUID string. Returns
// `undefined` for the NULL sentinel (handle 0) so the caller applies the two
// distinct sentinel semantics: scalar -> omit the field, array -> placeholder 0.
// Any non-zero handle that fails to resolve is a fail-fast (D-2, no silent drop).
// Shared kernel: both the owned-entity serialization loop (Step 4) and the M5
// override-value serialization call this so the resolve/lookup/fail-fast idiom
// lives in exactly one place; `field` names the failing field in the error.
function _handleToGuid(
  world: World,
  registry: SceneAssetGuidLookup,
  handle: number,
  field: string,
): Result<string | undefined, SceneCollectAssetGuidUnresolvedError> {
  if (handle === 0) return ok(undefined); // NULL sentinel
  const builtinGuid = builtinMeshGuid(handle as unknown as Handle<string, 'shared'>);
  if (builtinGuid !== undefined) return ok(builtinGuid);
  const assetRes = resolveAssetHandle(world, handle as unknown as Handle<string, 'shared'>);
  if (!assetRes.ok) return err(new SceneCollectAssetGuidUnresolvedError(field, handle));
  const guid = registry.guidOf(assetRes.value as Asset);
  if (guid === undefined) return err(new SceneCollectAssetGuidUnresolvedError(field, handle));
  return ok(guid);
}

// Convert one shared field value (scalar handle or array<handle>) from the live
// handle domain to the serialized GUID domain, applying the two-state NULL
// sentinel: scalar handle 0 -> undefined (caller omits the field); array handle
// 0 -> numeric 0 kept in place (positional SoA alignment, #640). Non-shared
// values pass through untouched.
function _serializeSharedFieldValue(
  world: World,
  registry: SceneAssetGuidLookup,
  classification: SchemaFieldClass,
  value: unknown,
  field: string,
): Result<unknown, SceneCollectAssetGuidUnresolvedError> {
  if (classification.scalar) {
    if (typeof value !== 'number') return ok(value);
    return _handleToGuid(world, registry, value, field); // undefined -> caller omits
  }
  if (!Array.isArray(value)) return ok(value);
  const mapped: Array<string | number> = [];
  for (const elem of value as ReadonlyArray<unknown>) {
    if (typeof elem !== 'number') {
      mapped.push(elem as number);
      continue;
    }
    const g = _handleToGuid(world, registry, elem, field);
    if (!g.ok) return g;
    mapped.push(g.value ?? 0); // NULL sentinel keeps positional 0
  }
  return ok(mapped);
}

// Convert an override's value from the live handle domain to the serialized GUID
// domain (w21). Field-patch form (`ov.field` present) carries a single field
// value; component-add form carries a per-field value map. Shared fields are
// reverse-looked-up per {@link _serializeSharedFieldValue}; a scalar NULL
// sentinel drops the key (component-add) or is kept as 0 (field-patch, where the
// override IS that field so it cannot be omitted). Non-shared fields pass through.
function _serializeOverrideValueHandles(
  world: World,
  registry: SceneAssetGuidLookup,
  ov: MountOverride,
): Result<unknown, SceneCollectAssetGuidUnresolvedError> {
  const comp = world.components.resolve(ov.comp);
  const schema = comp === undefined ? undefined : (componentSchema(comp) as Record<string, string>);
  if (ov.field !== undefined) {
    const classification = schema ? classifyFieldSchema(schema[ov.field]) : undefined;
    if (!classification || classification.kind !== 'shared') return ok(ov.value);
    const conv = _serializeSharedFieldValue(world, registry, classification, ov.value, ov.field);
    if (!conv.ok) return conv;
    // Field-patch: keep the field even at NULL sentinel (the override IS the
    // field); undefined only arises for a scalar handle 0 -> emit 0.
    return ok(conv.value ?? 0);
  }
  // component-add: value is a per-field map.
  if (typeof ov.value !== 'object' || ov.value === null || Array.isArray(ov.value)) {
    return ok(ov.value);
  }
  const src = ov.value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const fieldName of Object.keys(src)) {
    const classification = schema ? classifyFieldSchema(schema[fieldName]) : undefined;
    if (!classification || classification.kind !== 'shared') {
      out[fieldName] = src[fieldName];
      continue;
    }
    const conv = _serializeSharedFieldValue(
      world,
      registry,
      classification,
      src[fieldName],
      fieldName,
    );
    if (!conv.ok) return conv;
    if (classification.scalar && conv.value === undefined) continue; // scalar 0 -> omit
    out[fieldName] = conv.value;
  }
  return ok(out);
}

type LegacyCollectedEntity = {
  readonly localId: number;
  readonly components: Record<string, Record<string, unknown>>;
};

type SceneEntityAddress = string | readonly [string, ...string[]];
type SceneInstanceOverride = {
  readonly target: readonly [string, ...string[]];
  readonly components: Record<string, Record<string, unknown>>;
};
type CollectorSceneState = {
  readonly keyByLocalId: Map<number, string>;
  readonly instanceKey?: string;
  readonly bindings: Map<string, EntityHandle>;
  readonly entityToLocalId: Map<EntityHandle, LocalEntityId>;
  readonly overrides: Map<
    LocalEntityId,
    Map<string, { readonly comp: string; readonly field?: string; readonly value: unknown }>
  >;
  readonly mountTimeOverrides: readonly MountOverride[];
};

type CollectedKeyedEntity = {
  readonly components: Record<string, Record<string, unknown>>;
  readonly instance?: {
    readonly source: string;
    readonly overrides?: readonly SceneInstanceOverride[];
  };
};

type SceneStateInfo = {
  readonly root: number;
  readonly state: CollectorSceneState;
  readonly mapping: Uint32Array;
};

type SceneStateRelation = {
  readonly parent: SceneStateInfo;
  readonly child: SceneStateInfo;
  readonly key: string;
  readonly memberFirst: number;
};

type KeyedCollectError =
  | SceneCollectEntityRefOutOfClosureError
  | SceneCollectAssetGuidUnresolvedError;

function isSceneEntityAddress(value: string | readonly string[]): value is SceneEntityAddress {
  return typeof value === 'string' || value.length > 0;
}

/**
 * Convert the old private numeric collector result to the keyed author model.
 * Numeric slots remain an implementation detail of the live SceneInstance;
 * this function uses the retained instance key maps and child mapping windows
 * to reconstruct addresses before the public SceneAsset leaves Engine.
 */
function collectKeyedSceneAsset(
  world: World,
  registry: SceneAssetGuidLookup,
  _roots: readonly EntityHandle[],
  visited: ReadonlySet<number>,
  ownedEntities: readonly number[],
  legacyEntities: readonly LegacyCollectedEntity[],
  mounts: readonly SceneInstanceMount[],
  anchors: ReadonlyArray<{ entityRaw: number; sourceGuid: string; totalSlots: number }>,
  memberOrigin: ReadonlyMap<number, { anchorRaw: number; memberLocalId: number }>,
): Result<SceneAsset, KeyedCollectError> {
  const sceneInstanceToken = world.components.resolve('SceneInstance');
  const childOfToken = world.components.resolve('ChildOf');
  const stateInfos: SceneStateInfo[] = [];
  if (sceneInstanceToken !== undefined) {
    const queryResult = world.query({ read: [SceneInstance] });
    if (queryResult.ok) {
      for (const row of queryResult.value) {
        const stateResult = worldGetSceneInstanceState(world, row.entity);
        if (!stateResult.ok) continue;
        const rowValue = row.get(SceneInstance) as unknown as { mapping: ArrayLike<number> };
        stateInfos.push({
          root: row.entity as number,
          state: stateResult.value as unknown as CollectorSceneState,
          mapping: Uint32Array.from(rowValue.mapping as ArrayLike<number>),
        });
      }
    }
  }
  const stateByRoot = new Map<number, SceneStateInfo>();
  for (const info of stateInfos) stateByRoot.set(info.root, info);

  const parentByChildRoot = new Map<number, SceneStateInfo>();
  const relationCandidates: Array<{ child: SceneStateInfo; parent: SceneStateInfo; key: string }> =
    [];
  for (const child of stateInfos) {
    if (child.state.instanceKey === undefined || childOfToken === undefined) continue;
    const parentResult = world.get(
      child.root as EntityHandle,
      childOfToken as EcsComponent<string>,
    );
    if (!parentResult.ok) continue;
    const carrier = (parentResult.value as Record<string, unknown>).parent as number | undefined;
    if (carrier === undefined) continue;
    for (const parent of stateInfos) {
      const bound = parent.state.bindings.get(sceneEntityAddressKey(child.state.instanceKey));
      if ((bound as number | undefined) === carrier) {
        parentByChildRoot.set(child.root, parent);
        relationCandidates.push({ child, parent, key: child.state.instanceKey });
        break;
      }
    }
  }

  const findSequence = (
    haystack: Uint32Array,
    needle: Uint32Array,
    start: number,
  ): number | undefined => {
    if (needle.length === 0) return start;
    for (let index = Math.max(0, start); index + needle.length <= haystack.length; index += 1) {
      let match = true;
      for (let offset = 0; offset < needle.length; offset += 1) {
        if (haystack[index + offset] !== needle[offset]) {
          match = false;
          break;
        }
      }
      if (match) return index;
    }
    return undefined;
  };

  const relations: SceneStateRelation[] = [];
  for (const candidate of relationCandidates) {
    const slot = [...candidate.parent.state.keyByLocalId.entries()].find(
      ([, value]) => value === candidate.key,
    )?.[0];
    if (slot === undefined) continue;
    const memberFirst = findSequence(candidate.parent.mapping, candidate.child.mapping, slot + 1);
    if (memberFirst === undefined) continue;
    relations.push({ ...candidate, memberFirst });
  }
  const relationsByParent = new Map<number, SceneStateRelation[]>();
  for (const relation of relations) {
    const list = relationsByParent.get(relation.parent.root);
    if (list === undefined) relationsByParent.set(relation.parent.root, [relation]);
    else list.push(relation);
  }

  const statePrefixMemo = new Map<number, readonly string[]>();
  const statePrefix = (info: SceneStateInfo, stack = new Set<number>()): readonly string[] => {
    const prior = statePrefixMemo.get(info.root);
    if (prior !== undefined) return prior;
    if (stack.has(info.root)) return [];
    if (info.state.instanceKey === undefined) {
      statePrefixMemo.set(info.root, []);
      return [];
    }
    const next = new Set(stack);
    next.add(info.root);
    const parent = parentByChildRoot.get(info.root);
    const prefix =
      parent === undefined
        ? [info.state.instanceKey]
        : [...statePrefix(parent, next), info.state.instanceKey];
    statePrefixMemo.set(info.root, prefix);
    return prefix;
  };

  const stateSlotAddress = (
    info: SceneStateInfo,
    slot: number,
    prefix: readonly string[],
    stack = new Set<number>(),
  ): readonly string[] | undefined => {
    if (slot < 0 || stack.has(info.root)) return undefined;
    const key = info.state.keyByLocalId.get(slot);
    if (key !== undefined) return [...prefix, key];
    const next = new Set(stack);
    next.add(info.root);
    for (const relation of relationsByParent.get(info.root) ?? []) {
      const end = relation.memberFirst + relation.child.mapping.length;
      if (slot >= relation.memberFirst && slot < end) {
        return stateSlotAddress(
          relation.child,
          slot - relation.memberFirst,
          [...prefix, relation.key],
          next,
        );
      }
    }
    return undefined;
  };

  const rawToAddress = new Map<number, readonly string[]>();
  const orderedStates = [...stateInfos].sort(
    (a, b) => statePrefix(a).length - statePrefix(b).length,
  );
  for (const info of orderedStates) {
    const prefix = statePrefix(info);
    for (let slot = 0; slot < info.mapping.length; slot += 1) {
      const raw = info.mapping[slot];
      if (raw === undefined || raw === 0xffffffff || !visited.has(raw)) continue;
      const address = stateSlotAddress(info, slot, prefix);
      if (address !== undefined && !rawToAddress.has(raw)) rawToAddress.set(raw, address);
    }
  }
  for (const [raw, origin] of memberOrigin) {
    if (!visited.has(raw) || rawToAddress.has(raw)) continue;
    const child = stateByRoot.get(origin.anchorRaw);
    if (child === undefined) continue;
    const address = stateSlotAddress(child, origin.memberLocalId, statePrefix(child));
    if (address !== undefined) rawToAddress.set(raw, address);
  }

  const generatedKeys = new Set<string>();
  const keyForOwnedRaw = new Map<number, string>();
  for (let index = 0; index < ownedEntities.length; index += 1) {
    const raw = ownedEntities[index] as number;
    const known = rawToAddress.get(raw);
    let key = known?.length === 1 ? known[0] : undefined;
    if (key === undefined || key.length === 0 || generatedKeys.has(key)) {
      const base = `entity-${index}`;
      key = base;
      let suffix = 1;
      while (generatedKeys.has(key)) key = `${base}-${suffix++}`;
    }
    generatedKeys.add(key);
    keyForOwnedRaw.set(raw, key);
    rawToAddress.set(raw, [key]);
  }

  const slotAddress = (slot: number): SceneEntityAddress | undefined => {
    if (slot >= 0 && slot < ownedEntities.length) {
      const raw = ownedEntities[slot];
      const key = raw === undefined ? undefined : keyForOwnedRaw.get(raw);
      return key;
    }
    const mountIndex = mounts.findIndex((mount) => (mount.localId as unknown as number) === slot);
    if (mountIndex >= 0) {
      const anchor = anchors[mountIndex];
      const child = anchor === undefined ? undefined : stateByRoot.get(anchor.entityRaw);
      const key = child?.state.instanceKey;
      if (key !== undefined) return key;
    }
    for (let index = 0; index < mounts.length; index += 1) {
      const mount = mounts[index];
      if (mount === undefined) continue;
      const first = mount.memberFirst as unknown as number;
      if (slot < first || slot >= first + mount.memberCount) continue;
      const anchor = anchors[index];
      const child = anchor === undefined ? undefined : stateByRoot.get(anchor.entityRaw);
      const mountKey = child?.state.instanceKey;
      if (child === undefined || mountKey === undefined) return undefined;
      const address = stateSlotAddress(child, slot - first, []);
      if (address === undefined) return undefined;
      return [mountKey, ...address] as readonly [string, ...string[]];
    }
    const top = orderedStates.find((info) => statePrefix(info).length === 0);
    if (top !== undefined) {
      const address = stateSlotAddress(top, slot, []);
      if (address !== undefined) {
        return address.length === 1 ? address[0] : (address as readonly [string, ...string[]]);
      }
    }
    return undefined;
  };

  const convertComponents = (
    entityRaw: number,
    source: Record<string, Record<string, unknown>>,
  ): Result<Record<string, Record<string, unknown>>, KeyedCollectError> => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [componentName, rawFields] of Object.entries(source)) {
      const token = world.components.resolve(componentName);
      if (token === undefined) {
        out[componentName] = { ...rawFields };
        continue;
      }
      const converted: Record<string, unknown> = {};
      for (const [fieldName, value] of Object.entries(rawFields)) {
        const kind = classifyEntityField(token as EcsComponent, fieldName);
        if (kind === null) {
          converted[fieldName] = value;
          continue;
        }
        const convertSlot = (localSlot: unknown): SceneEntityAddress | undefined => {
          if (typeof localSlot !== 'number') return undefined;
          return slotAddress(localSlot);
        };
        if (kind.isArray) {
          if (!Array.isArray(value)) {
            return err(
              new SceneCollectEntityRefOutOfClosureError(
                entityRaw,
                `${componentName}.${fieldName}`,
                -1,
              ),
            );
          }
          const addresses: SceneEntityAddress[] = [];
          for (const item of value) {
            const address = convertSlot(item);
            if (address === undefined || !isSceneEntityAddress(address)) {
              return err(
                new SceneCollectEntityRefOutOfClosureError(
                  entityRaw,
                  `${componentName}.${fieldName}`,
                  Number(item),
                ),
              );
            }
            addresses.push(address);
          }
          converted[fieldName] = addresses;
        } else if (value === null) {
          converted[fieldName] = null;
        } else {
          const address = convertSlot(value);
          if (address === undefined || !isSceneEntityAddress(address)) {
            return err(
              new SceneCollectEntityRefOutOfClosureError(
                entityRaw,
                `${componentName}.${fieldName}`,
                Number(value),
              ),
            );
          }
          converted[fieldName] = address;
        }
      }
      out[componentName] = converted;
    }
    return ok(out);
  };

  const entities: Record<string, CollectedKeyedEntity> = {};
  for (const legacy of legacyEntities) {
    const raw = ownedEntities[legacy.localId];
    if (raw === undefined) continue;
    const key = keyForOwnedRaw.get(raw) as string;
    const converted = convertComponents(raw, legacy.components);
    if (!converted.ok) return converted;
    entities[key] = { components: converted.value };
  }

  const resolveOverrideTarget = (
    child: SceneStateInfo | undefined,
    memberFirst: number,
    localId: number,
  ): readonly [string, ...string[]] | undefined => {
    if (child === undefined) return undefined;
    const target = stateSlotAddress(child, localId - memberFirst, []);
    if (target === undefined || target.length === 0) return undefined;
    return target as readonly [string, ...string[]];
  };

  const convertOverrideValue = (
    entityRaw: number,
    componentName: string,
    fieldName: string | undefined,
    value: unknown,
  ): Result<unknown, KeyedCollectError> => {
    const token = world.components.resolve(componentName);
    if (token === undefined) return ok(value);
    const schema = componentSchema(token) as Record<string, string>;
    const convertFields = (
      field: string,
      fieldValue: unknown,
    ): Result<unknown, KeyedCollectError> => {
      const kind = classifyEntityField(token as EcsComponent, field);
      if (kind === null) {
        const sharedType = schema[field];
        const shared: SchemaFieldClass | undefined = sharedType?.startsWith('shared<')
          ? { kind: 'shared', scalar: true }
          : sharedType?.startsWith('array<shared<')
            ? { kind: 'shared', scalar: false }
            : undefined;
        if (shared === undefined) return ok(fieldValue);
        return _serializeSharedFieldValue(world, registry, shared, fieldValue, field);
      }
      const resolveLiveOrSlot = (item: unknown): SceneEntityAddress | undefined => {
        if (typeof item !== 'number') return undefined;
        const live = rawToAddress.get(item);
        if (live !== undefined) {
          return live.length === 1 ? live[0] : (live as readonly [string, ...string[]]);
        }
        return slotAddress(item);
      };
      if (kind.isArray) {
        if (!Array.isArray(fieldValue)) return ok(fieldValue);
        const mapped: SceneEntityAddress[] = [];
        for (const item of fieldValue) {
          const address = resolveLiveOrSlot(item);
          if (address === undefined || !isSceneEntityAddress(address)) {
            return err(
              new SceneCollectEntityRefOutOfClosureError(
                entityRaw,
                `${componentName}.${field}`,
                Number(item),
              ),
            );
          }
          mapped.push(address);
        }
        return ok(mapped);
      }
      if (fieldValue === null) return ok(null);
      const address = resolveLiveOrSlot(fieldValue);
      if (address === undefined || !isSceneEntityAddress(address)) {
        return err(
          new SceneCollectEntityRefOutOfClosureError(
            entityRaw,
            `${componentName}.${field}`,
            Number(fieldValue),
          ),
        );
      }
      return ok(address);
    };
    if (fieldName !== undefined) return convertFields(fieldName, value);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return ok(value);
    const result: Record<string, unknown> = {};
    for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      const converted = convertFields(field, fieldValue);
      if (!converted.ok) return converted;
      result[field] = converted.value;
    }
    return ok(result);
  };

  const declarationOverrides = (
    parent: SceneStateInfo | undefined,
    child: SceneStateInfo | undefined,
    mount: SceneInstanceMount,
    anchor: { entityRaw: number },
  ): Result<readonly SceneInstanceOverride[] | undefined, KeyedCollectError> => {
    const memberFirst = mount.memberFirst as unknown as number;
    const candidates: MountOverride[] = [];
    if (parent !== undefined) {
      for (const override of parent.state.mountTimeOverrides) {
        const localId = override.localId as unknown as number;
        if (localId >= memberFirst && localId < memberFirst + mount.memberCount)
          candidates.push(override);
      }
      for (const [localId, records] of parent.state.overrides) {
        const numeric = localId as unknown as number;
        if (numeric < memberFirst || numeric >= memberFirst + mount.memberCount) continue;
        for (const record of records.values()) {
          candidates.push({
            localId,
            comp: record.comp,
            ...(record.field === undefined ? {} : { field: record.field }),
            value: record.value,
          });
        }
      }
    }
    if (candidates.length === 0) candidates.push(...(mount.overrides ?? []));
    if (candidates.length === 0 || child === undefined) return ok(undefined);
    const byTarget = new Map<string, SceneInstanceOverride>();
    for (const override of candidates) {
      const localId = override.localId as unknown as number;
      const target = resolveOverrideTarget(child, memberFirst, localId);
      if (target === undefined) {
        return err(
          new SceneCollectEntityRefOutOfClosureError(
            anchor.entityRaw,
            'instance.override.target',
            localId,
          ),
        );
      }
      const converted = convertOverrideValue(
        anchor.entityRaw,
        override.comp,
        override.field,
        override.value,
      );
      if (!converted.ok) return converted;
      const targetKey = JSON.stringify(target);
      const prior = byTarget.get(targetKey);
      const components: Record<string, Record<string, unknown>> = {};
      if (prior !== undefined) {
        for (const [name, fields] of Object.entries(
          prior.components as Record<string, Record<string, unknown>>,
        )) {
          components[name] = { ...fields };
        }
      }
      const priorFields = components[override.comp] as Record<string, unknown> | undefined;
      const existing: Record<string, unknown> = { ...(priorFields ?? {}) };
      if (
        override.field === undefined &&
        typeof converted.value === 'object' &&
        converted.value !== null
      ) {
        Object.assign(existing, converted.value as Record<string, unknown>);
      } else if (override.field !== undefined) {
        existing[override.field] = converted.value;
      }
      components[override.comp] = existing;
      byTarget.set(targetKey, { target, components });
    }
    return ok([...byTarget.values()]);
  };

  for (let index = 0; index < mounts.length; index += 1) {
    const mount = mounts[index];
    const anchor = anchors[index];
    if (mount === undefined || anchor === undefined) continue;
    const child = stateByRoot.get(anchor.entityRaw);
    const parent = child === undefined ? undefined : parentByChildRoot.get(child.root);
    const instanceKey = child?.state.instanceKey ?? `instance-${index}`;
    const carrierRaw =
      childOfToken === undefined
        ? undefined
        : (() => {
            const parentResult = world.get(
              anchor.entityRaw as EntityHandle,
              childOfToken as EcsComponent<string>,
            );
            return parentResult.ok
              ? ((parentResult.value as Record<string, unknown>).parent as number | undefined)
              : undefined;
          })();
    const converted = convertComponents(
      carrierRaw ?? anchor.entityRaw,
      (mount.components ?? {}) as Record<string, Record<string, unknown>>,
    );
    if (!converted.ok) return converted;
    if (mount.parent !== undefined) {
      const parentAddress = slotAddress(mount.parent as unknown as number);
      if (parentAddress === undefined) {
        return err(
          new SceneCollectEntityRefOutOfClosureError(
            carrierRaw ?? anchor.entityRaw,
            'ChildOf.parent',
            mount.parent as unknown as number,
          ),
        );
      }
      converted.value.ChildOf = { parent: parentAddress };
    }
    const overrides = declarationOverrides(parent, child, mount, anchor);
    if (!overrides.ok) return overrides;
    entities[instanceKey] = {
      components: converted.value,
      instance: {
        source: String(mount.source),
        ...(overrides.value === undefined ? {} : { overrides: overrides.value }),
      },
    };
  }

  return ok({ kind: 'scene', entities });
}

// serializeSceneAssetToPack — emits the current Pack v2/local-artifact envelope.
export function serializeSceneAssetToPack(
  sceneAsset: SceneAsset,
  components: ReadonlyMap<string, EcsComponent>,
  guid?: string,
): Result<Record<string, unknown>, SceneCollectAssetGuidUnresolvedError> {
  const externalized = externalizeSceneAsset(sceneAsset, (componentName) => {
    const component = components.get(componentName);
    return component === undefined ? undefined : componentSchema(component);
  });
  if (!externalized.ok) {
    const value = externalized.error.value;
    return err(
      new SceneCollectAssetGuidUnresolvedError(
        externalized.error.field,
        typeof value === 'string' || typeof value === 'number' ? value : String(value),
      ),
    );
  }
  return ok({
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: guid ?? crypto.randomUUID(),
        kind: 'scene',
        payload: externalized.value.payload,
        refs: externalized.value.refs.map((reference) => reference.guid),
        artifacts: {},
      },
    ],
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// rootsToSceneAsset — with M2 mount-collapse
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Collect a forest of entity subtrees into a self-contained SceneAsset.
 *
 * M2 mount-collapse: entities carrying SceneInstance that are NOT roots
 * are folded into mount entries. Root anchors have their SceneInstance
 * row stripped without producing a self-mount. Member classification
 * filter (not subtree pruning): graft entities under members survive as owned.
 */
export function rootsToSceneAsset(
  registry: SceneAssetGuidLookup,
  world: World,
  roots: EntityHandle[],
): Result<
  SceneAsset,
  SceneCollectEntityRefOutOfClosureError | SceneCollectAssetGuidUnresolvedError
> {
  const collectProfile = SCENE_COLLECT_PROFILE;
  // ── Step 1: BFS closure ──
  const visited = new Set<number>();
  for (const root of roots) collectSubtree(world, root, visited);
  if (visited.size === 0) return ok({ kind: 'scene', entities: {} });

  const rootRawSet = new Set<number>();
  for (const r of roots) rootRawSet.add(r as number);

  // ── Step 1.5: Mount-collapse — identify anchors ──
  const anchorEntities = new Set<number>();
  for (const er of visited) {
    if (world.get(er as EntityHandle, SceneInstance).ok) anchorEntities.add(er);
  }

  // D-7 (feat-20260707) ordering robustness: the first-wins loops below
  // (memberEntities claim + carrier absorption) resolve ties by iteration
  // order. Iterating the anchorEntities Set directly ties the outcome to BFS
  // insertion order — deterministic within one run but fragile to Node/VM
  // changes. Sort by raw handle so "which anchor claims a shared member / a
  // shared carrier" is a deterministic function of the SceneAsset (§3.2
  // fixed-point premise: collect output must be a pure function of the graph).
  const anchorsSorted = [...anchorEntities].sort((a, b) => a - b);

  // Classify members for non-root anchors; the key set is the member set.
  const memberOrigin = new Map<number, { anchorRaw: number; memberLocalId: number }>();
  for (const er of anchorsSorted) {
    if (rootRawSet.has(er)) continue; // root anchor: don't classify members
    const sr = worldGetSceneInstanceState(world, er as EntityHandle);
    if (!sr.ok) continue;
    const retainedState = sr.value as unknown as CollectorSceneState;
    for (const [me, lid] of retainedState.entityToLocalId) {
      const mr = me as number;
      if (visited.has(mr) && !anchorEntities.has(mr) && !memberOrigin.has(mr)) {
        memberOrigin.set(mr, { anchorRaw: er, memberLocalId: lid as unknown as number });
      }
    }
    // Mount carriers are structural and therefore absent from
    // `entityToLocalId`, but the parent instance still exposes them through
    // `bindings` and its keyed slot map. Include those slots so a nested
    // instance is folded into its owning child scene rather than emitted as a
    // second top-level instance.
    for (const [key, member] of retainedState.bindings) {
      const mr = member as number;
      const localId = [...retainedState.keyByLocalId.entries()].find(
        ([, value]) => sceneEntityAddressKey(value) === key,
      )?.[0];
      if (
        localId !== undefined &&
        visited.has(mr) &&
        !anchorEntities.has(mr) &&
        !memberOrigin.has(mr)
      ) {
        memberOrigin.set(mr, { anchorRaw: er, memberLocalId: localId });
      }
    }
  }

  // A nested synthetic SceneInstance root is structural too. Its carrier is
  // already claimed by the parent instance above; fold the anchor into that
  // same member origin before allocating parent mounts.
  const childOf = world.components.resolve('ChildOf');
  const parentRawOf = (raw: number): number | undefined => {
    if (childOf === undefined) return undefined;
    const parent = world.get(raw as EntityHandle, childOf as EcsComponent<string>);
    return parent.ok
      ? ((parent.value as Record<string, unknown>).parent as number | undefined)
      : undefined;
  };
  for (const anchorRaw of [...anchorEntities]) {
    if (rootRawSet.has(anchorRaw) || memberOrigin.has(anchorRaw)) continue;
    const carrierRaw = parentRawOf(anchorRaw);
    const origin = carrierRaw === undefined ? undefined : memberOrigin.get(carrierRaw);
    if (origin !== undefined) memberOrigin.set(anchorRaw, origin);
  }

  // Remove inner anchors (members of outer anchors).
  for (const er of anchorEntities) {
    if (memberOrigin.has(er) && !rootRawSet.has(er)) anchorEntities.delete(er);
  }

  // Inner instance members must use the surviving outer mount's slot window.
  // Their original anchor has just been folded away.
  for (const [raw, origin] of memberOrigin) {
    if (anchorEntities.has(origin.anchorRaw)) continue;
    const original = world.get(origin.anchorRaw as EntityHandle, SceneInstance);
    const mappedRaw = original.ok ? original.value.mapping[origin.memberLocalId] : raw;
    for (const anchor of anchorEntities) {
      if (rootRawSet.has(anchor)) continue;
      const instance = world.get(anchor as EntityHandle, SceneInstance);
      if (!instance.ok || mappedRaw === undefined) continue;
      const slot = Array.from(instance.value.mapping).indexOf(mappedRaw);
      if (slot < 0) continue;
      memberOrigin.set(raw, { anchorRaw: anchor, memberLocalId: slot });
      break;
    }
  }

  // ── Step 1.75: Mount-carrier absorption ──
  //
  // worldInstantiateScene materialises each mounts[] entry as a plain "mount
  // entity" (`_spawnMountEntity` output: mount.components + a default Transform,
  // but NO SceneInstance) whose child is the mounted scene's synthetic root (the
  // real anchor, which DOES carry SceneInstance). So a `mounts[{parent: W}]`
  // whose parent W is an OWNED entity comes back on reload as the live chain
  //     W (owned) -> carrier (plain mount entity) -> anchor (SceneInstance).
  // The carrier IS the re-materialised mount slot. If collect keeps it as an
  // owned entity (it has no SceneInstance, so Step 2 would), the next serialize→
  // reload inserts ANOTHER carrier under it, growing one nameless ghost node per
  // save→reload cycle — unbounded (the editor "Add to Scene → save → reopen →
  // #N" regression). Existing pure-mount round-trips don't hit this because they
  // use `mount.parent === undefined` (mount attaches to the synthetic root,
  // which is stripped, so no owned carrier survives).
  //
  // Fix: recognise a carrier and fold it back into its mount. A carrier is the
  // ChildOf-parent P of a non-root anchor A where P is a pure mount slot: not a
  // root, not itself an anchor/member, carries no authored identity (only the
  // structural Transform/Children/ChildOf/Entity that _spawnMountEntity leaves),
  // and its sole visited child is A. The mount for A then takes P's slot:
  // mount.parent = P's ChildOf parent, and any ref to P resolves to the mount.
  const childrenTk0 = world.components.resolve('Children');
  const carrierAllowed = new Set(['Transform', 'GlobalTransform', 'Children', 'ChildOf', 'Entity']);
  const carrierForAnchor = new Map<number, number>(); // anchorRaw -> carrierRaw
  const carrierToAnchor = new Map<number, number>(); // carrierRaw -> anchorRaw
  const isMountCarrier = (p: number, anchorRaw: number): boolean => {
    if (rootRawSet.has(p)) return false;
    if (anchorEntities.has(p) || memberOrigin.has(p)) return false;
    if (!visited.has(p)) return false;
    for (const [compName, compToken] of world.components.entries()) {
      if (carrierAllowed.has(compName)) continue;
      if (world.get(p as EntityHandle, compToken as EcsComponent<string>).ok) return false;
    }
    if (childrenTk0) {
      const cr = world.get(p as EntityHandle, childrenTk0 as EcsComponent<string>);
      if (cr.ok) {
        const kids = (cr.value as { entities?: ArrayLike<number> }).entities;
        if (kids) {
          let visitedKidCount = 0;
          let sawAnchor = false;
          for (let i = 0; i < kids.length; i++) {
            const k = kids[i] as number;
            if (!visited.has(k)) continue;
            visitedKidCount += 1;
            if (k === anchorRaw) sawAnchor = true;
          }
          if (!sawAnchor || visitedKidCount !== 1) return false;
        }
      }
    }
    return true;
  };
  // Deterministic order (D-7): a carrier shared by two anchors is claimed by
  // the lowest-handle anchor regardless of Set iteration order.
  for (const anchorRaw of anchorsSorted) {
    if (!anchorEntities.has(anchorRaw)) continue; // pruned inner anchor
    if (rootRawSet.has(anchorRaw)) continue;
    const pRaw = parentRawOf(anchorRaw);
    if (pRaw === undefined) continue;
    if (!carrierToAnchor.has(pRaw) && isMountCarrier(pRaw, anchorRaw)) {
      carrierForAnchor.set(anchorRaw, pRaw);
      carrierToAnchor.set(pRaw, anchorRaw);
    }
  }

  // ── Step 2: Filter owned & build mounts for non-root anchors ──
  const orderedEntities = [...visited];
  const ownedEntities: number[] = [];
  for (const er of orderedEntities) {
    if (carrierToAnchor.has(er)) continue; // absorbed into its mount
    // A root SceneInstance is the transient synthetic anchor returned by
    // instantiate(). Its mapped members are authored entities; the anchor
    // itself has no durable declaration and must not be minted as `entity-0`
    // during collect, otherwise each collect/reload cycle adds another root.
    if (rootRawSet.has(er) && anchorEntities.has(er)) continue;
    if (!anchorEntities.has(er) && !memberOrigin.has(er)) {
      ownedEntities.push(er);
    }
  }

  const entityToLocalId = new Map<number, number>();
  for (let i = 0; i < ownedEntities.length; i++) {
    const e = ownedEntities[i];
    if (e !== undefined) entityToLocalId.set(e, i);
  }

  // Build non-root anchor info + resolve GUIDs.
  const nonRootAnchors: Array<{ entityRaw: number; sourceGuid: string; totalSlots: number }> = [];
  for (const er of anchorEntities) {
    if (rootRawSet.has(er)) continue;
    const sh = worldGetSceneAssetForInstance(world, er as EntityHandle);
    if (!sh.ok)
      return err(
        new SceneCollectAssetGuidUnresolvedError(
          'SceneInstance.source',
          sh.error as unknown as number,
        ),
      );
    const pr = resolveAssetHandle<SceneAsset>(
      world,
      sh.value as unknown as Handle<string, 'shared'>,
    );
    if (!pr.ok)
      return err(
        new SceneCollectAssetGuidUnresolvedError(
          'SceneInstance.source',
          sh.value as unknown as number,
        ),
      );
    const g = registry.guidOf(pr.value as Asset);
    if (g === undefined)
      return err(
        new SceneCollectAssetGuidUnresolvedError(
          'SceneInstance.source',
          sh.value as unknown as number,
        ),
      );
    const sr = worldGetSceneInstanceState(world, er as EntityHandle);
    if (!sr.ok)
      return err(new SceneCollectAssetGuidUnresolvedError('SceneInstance.source', 'state'));
    nonRootAnchors.push({ entityRaw: er, sourceGuid: g, totalSlots: sr.value.totalSlots });
  }

  // Sort by BFS order.
  const bfsIdx = new Map<number, number>();
  for (let i = 0; i < orderedEntities.length; i++) {
    if (orderedEntities[i] !== undefined) bfsIdx.set(orderedEntities[i] as number, i);
  }
  nonRootAnchors.sort((a, b) => (bfsIdx.get(a.entityRaw) ?? 0) - (bfsIdx.get(b.entityRaw) ?? 0));
  // Mount i belongs to nonRootAnchors[i]; its localId is ownedCount + i.
  const mountIndexByAnchor = new Map<number, number>();
  for (const [index, anchor] of nonRootAnchors.entries()) {
    mountIndexByAnchor.set(anchor.entityRaw, index);
  }

  // ── Step 3: Allocate mount windows ──
  const ownedCount = ownedEntities.length;
  const outMounts: SceneInstanceMount[] = [];
  let nextMF = ownedCount + nonRootAnchors.length;
  const transformTk = world.components.resolve('Transform');
  for (const a of nonRootAnchors) {
    // When a mount carrier was absorbed (Step 1.75), the mount takes the
    // carrier's slot: resolve the ChildOf parent from the CARRIER (the anchor's
    // own parent IS the carrier, which no longer exists as an owned entity), and
    // carry the carrier's Transform as mount.components so placement round-trips.
    const carrierRaw = carrierForAnchor.get(a.entityRaw);
    const pRaw = parentRawOf(carrierRaw ?? a.entityRaw);
    let mp: number | undefined;
    if (pRaw !== undefined) {
      mp = entityToLocalId.get(pRaw);
      if (mp === undefined) {
        const mo = memberOrigin.get(pRaw);
        const ai = mo === undefined ? undefined : mountIndexByAnchor.get(mo.anchorRaw);
        if (ai !== undefined) mp = ownedCount + ai;
      }
    }
    let mountComponents: SceneInstanceMount['components'] | undefined;
    if (carrierRaw !== undefined && transformTk) {
      const tr = world.get(carrierRaw as EntityHandle, transformTk as EcsComponent<string>);
      if (tr.ok) {
        mountComponents = {
          Transform: Object.fromEntries(
            Object.entries(tr.value as Record<string, unknown>).map(([key, value]) => [
              key,
              _isArrayLike(value) ? _normalizeArray(value) : value,
            ]),
          ),
        } as SceneInstanceMount['components'];
      }
    }
    // ── M5 (w20 + w21): fold runtime-authored overrides into this mount ──
    // foldMountOverrides emits child-namespace localIds in the LIVE handle
    // domain; rebase each into the parent namespace (memberFirst + childLocalId)
    // and reverse-lookup shared-field handles to GUID strings (two-state
    // NULL-sentinel). Unresolvable handle -> SceneCollectAssetGuidUnresolvedError
    // (D-2 fail-fast, no silent drop).
    const memberFirst0 = nextMF;
    let mountOverrides: MountOverride[] | undefined;
    const foldStateRes = worldGetSceneInstanceState(world, a.entityRaw as EntityHandle);
    if (foldStateRes.ok) {
      const rawOverrides = foldMountOverrides(world, foldStateRes.value);
      if (rawOverrides.length > 0) {
        mountOverrides = [];
        for (const ov of rawOverrides) {
          const convRes = _serializeOverrideValueHandles(world, registry, ov);
          if (!convRes.ok) return convRes;
          mountOverrides.push({
            ...ov,
            localId: (memberFirst0 + (ov.localId as unknown as number)) as LocalEntityId,
            value: convRes.value,
          });
        }
      }
    }

    const mount: SceneInstanceMount = {
      localId: (ownedCount + outMounts.length) as LocalEntityId,
      source: a.sourceGuid,
      memberFirst: nextMF as LocalEntityId,
      memberCount: a.totalSlots,
      ...(mp !== undefined ? { parent: mp as LocalEntityId } : {}),
      ...(mountComponents !== undefined ? { components: mountComponents } : {}),
      ...(mountOverrides !== undefined && mountOverrides.length > 0
        ? { overrides: mountOverrides }
        : {}),
    };
    outMounts.push(mount);
    nextMF += a.totalSlots;
  }

  // Entity ref resolution helper.
  function _rlid(t: number): number | undefined {
    const ol = entityToLocalId.get(t);
    if (ol !== undefined) return ol;
    // An absorbed mount carrier resolves to its mount's localId (the mount took
    // the carrier's slot in Step 1.75), so refs to the carrier — e.g. the
    // wrapper's Children list — point at the mount rather than dangle.
    const mountIndex = mountIndexByAnchor.get(carrierToAnchor.get(t) ?? t);
    if (mountIndex !== undefined) return ownedCount + mountIndex;
    const mo = memberOrigin.get(t);
    const owner = mo === undefined ? undefined : mountIndexByAnchor.get(mo.anchorRaw);
    const ownerMount = owner === undefined ? undefined : outMounts[owner];
    return mo === undefined || ownerMount === undefined
      ? undefined
      : (ownerMount.memberFirst as number) + mo.memberLocalId;
  }

  // ── Step 4: Build SceneEntity rows ──
  const registeredComps = world.components.entries();
  const legacyEntities: Array<{
    localId: number;
    components: Record<string, Record<string, unknown>>;
  }> = [];

  for (let lid = 0; lid < ownedEntities.length; lid++) {
    const entityRaw = ownedEntities[lid];
    if (entityRaw === undefined) continue;
    const entity = entityRaw as EntityHandle;
    const components: Record<string, Record<string, unknown>> = {};
    const isRoot = rootRawSet.has(entityRaw);

    for (const [compName, comp] of registeredComps) {
      const definition = componentDefinition(comp);
      if (!collectProfile.includeComponent(compName, definition.policy.transient === true))
        continue;
      if (isRoot && compName === 'ChildOf') continue;

      const valRes = world.get(entity, comp as EcsComponent<string>);
      if (!valRes.ok) continue;

      const val = valRes.value as Record<string, unknown>;

      const schema = componentSchema(comp);
      const schemaKeys = Object.keys(schema);
      // Empty-schema components are authored marker components, not absent
      // state. Preserve their presence through scene-pack round-trips (for
      // example AudioListener); transient markers have already been excluded
      // above and therefore remain derived-only by declaration.
      if (schemaKeys.length === 0) {
        components[compName] = {};
        continue;
      }

      const fieldValues: Record<string, unknown> = {};

      for (const fieldName of schemaKeys) {
        const rawValue = val[fieldName];
        if (rawValue === undefined) continue;

        // Field-level transient skip (D-5): a field declared `transient: true`
        // is derived/reconstructable and excluded from serialization, just as a
        // transient component (L554) is. Generic — reads the reflection flag for
        // any component/field; no hardcoded component or field name.
        if (
          !collectProfile.includeField(
            compName,
            fieldName,
            definition.fields[fieldName]?.transient === true,
          )
        )
          continue;

        const entityKind = classifyEntityField(comp as EcsComponent, fieldName);
        if (entityKind !== null) {
          // The synthetic root anchor is transient and is intentionally omitted
          // from the authored entity map. A member's implicit ChildOf edge to
          // that anchor has no authored counterpart, so omit that one edge
          // before the keyed remap instead of reporting a false out-of-closure
          // reference.
          if (
            !entityKind.isArray &&
            typeof rawValue === 'number' &&
            rootRawSet.has(rawValue) &&
            anchorEntities.has(rawValue)
          ) {
            continue;
          }
          // Entity / array<entity> field — use shared kernel for remap
          if (entityKind.isArray) {
            const arr = _isArrayLike(rawValue)
              ? _normalizeArray(rawValue)
              : (rawValue as unknown[]);
            const mapped: number[] = [];
            for (const elem of arr) {
              const lid2 = _rlid(elem as number);
              if (lid2 === undefined) {
                return err(
                  new SceneCollectEntityRefOutOfClosureError(entityRaw, fieldName, elem as number),
                );
              }
              mapped.push(lid2);
            }
            fieldValues[fieldName] = mapped;
          } else {
            // A nullable entity field uses the ECS null sentinel and is omitted
            // from the scene payload just like a null shared handle. It is not
            // an out-of-closure reference.
            if (rawValue === null) continue;
            const lid2 = _rlid(rawValue as number);
            if (lid2 === undefined) {
              return err(
                new SceneCollectEntityRefOutOfClosureError(
                  entityRaw,
                  fieldName,
                  rawValue as number,
                ),
              );
            }
            fieldValues[fieldName] = lid2;
          }
        } else {
          // Plain or shared<T> field. A shared field reverse-looks-up handle(s) to GUID(s) via the shared
          // kernel (same two-state NULL-sentinel the M5 override serializer uses).
          // scalar handle 0 -> undefined => omit the field (deserialize restores
          // the slot-0 default; emitting 0 would be misread as refs index 0 by
          // parseScenePayload HANDLE_FIELD_NAMES). array handle 0 -> positional 0
          // kept (paired SoA alignment, e.g. AnimationPlayer.clips = [h,0,0,0]).
          // AnimationPlayer.graph (shared<AnimationGraph> scalar, M4/w31) is
          // handled generically here — no special case needed.
          const normalized = _isArrayLike(rawValue) ? _normalizeArray(rawValue) : rawValue;
          const sharedClass = classifyFieldSchema(schema[fieldName]);
          if (sharedClass === undefined) {
            // Plain value field — pass through.
            fieldValues[fieldName] = normalized;
            continue;
          }
          const conv = _serializeSharedFieldValue(
            world,
            registry,
            sharedClass,
            normalized,
            fieldName,
          );
          if (!conv.ok) return conv;
          if (sharedClass.scalar && conv.value === undefined) continue; // NULL sentinel -> omit
          fieldValues[fieldName] = conv.value;
        }
      }

      if (Object.keys(fieldValues).length > 0) components[compName] = fieldValues;
    }

    legacyEntities.push({ localId: lid, components });
  }

  return collectKeyedSceneAsset(
    world,
    registry,
    roots,
    visited,
    ownedEntities,
    legacyEntities,
    outMounts,
    nonRootAnchors,
    memberOrigin,
  );
}
