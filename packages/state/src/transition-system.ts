// @forgeax/engine-state -- transitionStatesSystem (M3 / m3w4)
//
// 8-step per-token transition logic executed every frame by the
// 'transitionStates' system registered in registerStatesPlugin.
//
// Per token:
//   1. Read NextState Resource; if undefined -> continue (zero-cost skip)
//   2. Read State Resource; if prev===next && !force -> clear NextState, continue (same-state no-op)
//   3. Write PreviousState = prev, flip State = next
//   4. Collect exit-scoped entities -> world.despawn each
//   5. OnExit placeholder (M4)
//   6. Collect enter-scoped entities -> world.despawn each
//   7. OnEnter placeholder (M4)
//   8. Clear NextState = undefined
//
// Decision anchors:
// - plan-strategy sec 3.2: 8-step flowchart + OnEnter/OnExit dispatch between flip and despawn
// - plan-strategy D-2: unified world.despawn via linkedSpawn cascade
// - plan-strategy D-5: fn[] registry + transition body dispatch, zero ECS change
// - research F-6: row iteration + world.despawn is sufficient
// - requirements sec 7: despawn tolerance (entity already dead = no error)

import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { worldDespawnScene } from '@forgeax/engine-scene';
import { getRegisteredTokens } from './define-state';
import { getCallbacks, OnEnter, OnExit } from './on-enter-on-exit';
import { type StatePayload, stateResourceKey } from './resources';
import { getScopedComponent, SCOPED_MODE_VALUE } from './scoped-component';

/**
 * Collect entities whose ScopedTo component matches a given mode and value,
 * then despawn all of them. Single despawn fault (already-dead entity) does
 * not abort the batch — despawn tolerance per requirements sec 7.
 *
 * A scoped entity that is a SceneInstance root is torn down with `despawnScene`
 * (cascade over its instantiated members), NOT plain `world.despawn`. Plain
 * despawn does not cascade through `ChildOf` (which ships `linkedSpawn=false`),
 * so a scoped scene root would orphan every member entity it instantiated. On a
 * state replay (e.g. Title->Play->Title->Play) those orphans linger, their index
 * slots are reused at a new generation, and a surviving member's stale
 * `ChildOf -> (oldRoot, oldGen)` makes `propagateTransforms` throw
 * `hierarchy-broken` every frame. Cascading via `despawnScene` removes the whole
 * instantiated subtree so nothing is left pointing at the dead root.
 */
function scopeDespawn(
  world: World,
  scopedComponent: ReturnType<typeof getScopedComponent>,
  mode: number,
  value: number,
): void {
  const query = world.query({ read: [scopedComponent] }).unwrap();
  const despawns: EntityHandle[] = [];
  for (const row of query) {
    const scoped = row.get(scopedComponent);
    if (scoped.mode === mode && scoped.value === value) despawns.push(row.entity);
  }
  // SceneInstance is resolved by name through the global registry so the state
  // package stays free of a runtime dependency (layering: state -> ecs only).
  const sceneInstance = world.components.resolve('SceneInstance');
  // Tear down SceneInstance roots FIRST, via despawnScene (cascade over their
  // instantiated members). This must precede the plain despawns: a scoped scene
  // root is often ChildOf a scoped non-scene entity (e.g. a character rig parented
  // under a KCC body), and despawning that parent first invalidates the root
  // handle before we can cascade it -- leaving the scene's members orphaned with a
  // stale ChildOf -> dead-root ref. Doing the cascades up front guarantees each
  // SceneInstance subtree is fully removed while its root is still live.
  if (sceneInstance !== undefined) {
    for (const e of despawns) {
      if (world.get(e, sceneInstance).ok) worldDespawnScene(world, e);
    }
  }
  for (const e of despawns) {
    // Scene roots already torn down above are now dead -> world.despawn is a
    // tolerated no-op (requirements sec 7); every other scoped entity despawns here.
    world.despawn(e);
  }
}

export function transitionStatesSystem(world: World): void {
  for (const token of getRegisteredTokens().values()) {
    const key = stateResourceKey(token);
    if (!world.hasResource(key)) continue;
    const state = world.getResource<StatePayload>(key);
    const ns = state.next;
    if (ns === undefined) continue;
    const prevIdx = state.current;
    const nextIdx = ns.value;
    const force = ns.force;

    // (2) Same-state no-op (unless force flag overrides)
    if (prevIdx === nextIdx && !force) {
      world.insertResource<StatePayload>(key, { ...state, next: undefined });
      continue;
    }

    // (3) Write PreviousState = prev, flip State = next
    world.insertResource<StatePayload>(key, { ...state, previous: prevIdx, current: nextIdx });

    const scopedComponent = getScopedComponent(token);
    if (world.components.resolve(scopedComponent.name) === scopedComponent) {
      // (4) Despawn exit-scoped entities (value=prev)
      scopeDespawn(world, scopedComponent, SCOPED_MODE_VALUE.exit, prevIdx);

      // (5) OnExit dispatch: fire registered callbacks for prev variant.
      // Errors bubble to the transitionStatesSystem call stack per req §7.
      const prevVariant = token.variants[prevIdx];
      if (prevVariant !== undefined) {
        const exitLabel = OnExit(token, prevVariant);
        for (const fn of getCallbacks(exitLabel)) {
          fn(world);
        }
      }

      // (6) Despawn enter-scoped entities (value=next)
      scopeDespawn(world, scopedComponent, SCOPED_MODE_VALUE.enter, nextIdx);

      // (7) OnEnter dispatch: fire registered callbacks for next variant.
      // Errors bubble to the transitionStatesSystem call stack per req §7.
      const nextVariant = token.variants[nextIdx];
      if (nextVariant !== undefined) {
        const enterLabel = OnEnter(token, nextVariant);
        for (const fn of getCallbacks(enterLabel)) {
          fn(world);
        }
      }
    }

    // A callback can enqueue the same value/force again. Request identity,
    // rather than equality of its fields, determines whether it was consumed.
    const afterCallbacks = world.getResource<StatePayload>(key);
    if (afterCallbacks.next === ns) {
      world.insertResource<StatePayload>(key, { ...afterCallbacks, next: undefined });
    }
  }
}
