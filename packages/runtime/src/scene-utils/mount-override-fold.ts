// feat-20260713-mount-override-component-add-and-shared-ref-round M5 / w20 —
// collect fold: derive the runtime-authored MountOverride[] for one nested
// SceneInstance anchor (plan-strategy D-3).
//
// ── What it does ──
// Given a nested anchor's SceneInstanceState, walk each live member entity and
// diff its live component columns against the member's authored baseline (the
// source SceneAsset's layer-1 values, filled with schema defaults so the
// comparison is against a fully-populated row). Every difference becomes a
// MountOverride the collect step splices into the parent's `mounts[].overrides`:
//   - a component present live but absent in source  -> component-ADD override
//     ({ localId, comp, value }) whose value is the whole filled component map;
//   - a field whose live value differs from baseline -> field-PATCH override
//     ({ localId, comp, field, value }) for that single field;
//   - a component present in source but absent live   -> NOT emitted (OOS-6:
//     component-remove deltas do not fold back this feat).
//
// ── Value domain ──
// The fold emits values in the LIVE domain: shared<T> fields carry numeric
// handles, not GUID strings. The caller (rootsToSceneAsset / serialize wiring,
// w21) performs the handle->GUID reverse-lookup with the two-state NULL-sentinel
// handling (scalar handle 0 -> omit, array handle 0 -> keep positional 0),
// reusing the same classifier the owned-entity serialization uses. Keeping the
// fold registry-free means it stays a pure World+state read (D-3 / §2.5).
//
// ── localId namespace ──
// Emitted `localId` is in the CHILD scene's namespace (0-based, exactly what
// `state.entityToLocalId` maps to). The collect caller rebases it into the
// parent namespace by adding the mount window's `memberFirst`, so the override
// addresses the same slot the apply path validates against
// (`_validateMountOverrides`: [memberFirst, memberFirst + memberCount)).
//
// ── Idempotency (AC-04) ──
// A parent-authored mount-time override is applied to the child member's LIVE
// column at instantiate time, and the child's source SceneAsset does not carry
// it — so `live - source` re-derives it every round. Emitting it exactly once
// (never separately re-passing state.mountTimeOverrides on top) keeps the
// override entry set stable across save->load->save cycles: lossless without
// doubling. (Runtime fact grounding this: parent-authored overrides on a nested
// member land in the PARENT anchor's state, not the folded child anchor's; the
// child anchor's own mountTimeOverrides is empty. See the M5 implement report.)

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import {
  componentDefinition,
  type Component as EcsComponent,
  type EntityHandle,
  type World,
} from '@forgeax/engine-ecs';
import { componentSchema } from '@forgeax/engine-ecs/internal';
import { fillComponentDefaults } from '@forgeax/engine-ecs/projection';
import type { MountOverride, SceneInstanceState } from '@forgeax/engine-scene';
import type { Handle, LocalEntityId, SceneAsset } from '@forgeax/engine-types';

/** The SceneInstanceState fields the fold reads. */
export type FoldSceneInstanceState = Pick<
  SceneInstanceState,
  'source' | 'keyByLocalId' | 'entityToLocalId'
>;

/** Component names that never participate in an authored baseline diff: the
 * essential row-identity column, and structural hierarchy relationship
 * holders/mirrors (ChildOf/Children) whose live values are re-wired by
 * instantiate, not authored. */
function excludedComponentNames(): Set<string> {
  return new Set<string>(['Entity', 'ChildOf', 'Children']);
}

/** Normalize an array-like (typed array or Array) to a plain array for
 * structural comparison; pass non-array values through unchanged. */
function normalize(value: unknown): unknown {
  if (
    Array.isArray(value) ||
    value instanceof Uint32Array ||
    value instanceof Float32Array ||
    value instanceof Int32Array ||
    value instanceof Float64Array ||
    value instanceof Uint8Array ||
    value instanceof Int16Array ||
    value instanceof Uint16Array
  ) {
    return Array.from(value as ArrayLike<unknown>);
  }
  return value;
}

/** Structural value equality after array normalization (handles Float32Array vs
 * number[] and nested arrays via JSON). Both inputs are column-shape values. */
function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

/** Build the per-field baseline map for a member from its source node, filled
 * with schema defaults so it matches the fully-populated live row. Transient
 * fields are dropped (they are never authored / never serialized, D-5). */
function baselineFields(
  comp: EcsComponent<string>,
  sourceRaw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const filled = fillComponentDefaults(comp, sourceRaw ?? {});
  const out: Record<string, unknown> = {};
  const fields = componentDefinition(comp).fields;
  for (const fieldName of Object.keys(componentSchema(comp))) {
    if (fields[fieldName]?.transient) continue;
    out[fieldName] = filled[fieldName];
  }
  return out;
}

/** Read the live, non-transient, non-entity field values of a component on an
 * entity into a plain map. Entity-type fields are dropped: their live value is a
 * live EntityHandle while the source carries a LocalEntityId, so they cannot be
 * diffed without remap — entity-ref override deltas are out of scope this feat
 * (the AC set centers on shared/asset fields + component-add). */
function liveFields(
  world: World,
  entity: EntityHandle,
  comp: EcsComponent<string>,
): Record<string, unknown> | undefined {
  const res = world.get(entity, comp);
  if (!res.ok) return undefined;
  const val = res.value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const fields = componentDefinition(comp).fields;
  const schema = componentSchema(comp) as Record<string, string>;
  for (const fieldName of Object.keys(schema)) {
    if (fields[fieldName]?.transient) continue;
    const fieldType = schema[fieldName];
    if (fieldType === 'entity' || fieldType === 'array<entity>') continue;
    out[fieldName] = normalize(val[fieldName]);
  }
  return out;
}

/**
 * Fold one nested anchor's live member state into the runtime-authored
 * MountOverride[] (child-namespace localIds, live value domain). See file
 * header for the full contract. Returns [] when nothing differs from source.
 */
export function foldMountOverrides(world: World, state: FoldSceneInstanceState): MountOverride[] {
  const sourceRes = resolveAssetHandle<SceneAsset>(
    world,
    state.source as unknown as Handle<string, 'shared'>,
  );
  if (!sourceRes.ok) return [];
  const source = sourceRes.value as SceneAsset;

  const excluded = excludedComponentNames();
  const registered = world.components.entries();
  const overrides: MountOverride[] = [];

  // Deterministic member order (localId ascending) so collect output is a pure
  // function of the graph (mirrors rootsToSceneAsset D-7 ordering discipline).
  const members: Array<[EntityHandle, number]> = [];
  for (const [entity, lid] of state.entityToLocalId) {
    members.push([entity, lid as unknown as number]);
  }
  members.sort((a, b) => a[1] - b[1]);

  for (const [entity, lid] of members) {
    const sourceKey = state.keyByLocalId.get(lid);
    const sourceNode = sourceKey === undefined ? undefined : source.entities[sourceKey];
    const sourceComps = (sourceNode?.components ?? {}) as Record<string, Record<string, unknown>>;

    for (const [compName, compToken] of registered) {
      if (excluded.has(compName)) continue;
      if (componentDefinition(compToken).policy.transient) continue;
      const comp = compToken as EcsComponent<string>;
      if (Object.keys(componentSchema(comp)).length === 0) continue;

      const live = liveFields(world, entity, comp);
      if (live === undefined) continue; // component absent live

      const sourceRaw = sourceComps[compName];
      if (sourceRaw === undefined) {
        // Component present live but absent in source -> component-ADD override.
        // Emit the whole live component value map (apply upserts with defaults).
        overrides.push({
          localId: lid as unknown as LocalEntityId,
          comp: compName,
          value: live,
        });
        continue;
      }

      // Component present in both -> per-field diff (field-PATCH overrides).
      const baseline = baselineFields(comp, sourceRaw);
      for (const fieldName of Object.keys(live)) {
        if (!valuesEqual(live[fieldName], baseline[fieldName])) {
          overrides.push({
            localId: lid as unknown as LocalEntityId,
            comp: compName,
            field: fieldName,
            value: live[fieldName],
          });
        }
      }
    }
  }

  return overrides;
}
