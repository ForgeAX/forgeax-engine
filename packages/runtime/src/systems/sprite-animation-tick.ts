// @forgeax/engine-runtime - sprite-animation tick system (M4 / T-23).
//
// Walks every entity that carries `SpriteAnimation`, advances its dt
// accumulator clock per Time.delta, and writes the current frame's UV slice
// into the entity's `SpriteRegionOverride` column (auto-adding the
// component on first observation when the entity does not yet carry it).
// Designed to sit between `input` / `time` and `RenderSystem.extract` in
// the schedule (plan-strategy section 2 D-7); the M3 sprite-bucket
// extract branch (`render-system-extract.ts:861-870`) reads the override
// column to materialise per-entity UV in the sprite snapshot.
//
// Why a stand-alone tick system instead of folding the dt accumulator
// into the renderer? Charter P5 producer/consumer separation: the
// renderer is a consumer of presentation state and never writes ECS
// columns; the tick system owns the per-entity write so the
// `SpriteRegionOverride.region` slot has exactly one writer (the tick
// system) and zero readers in the writer tree (the extract branch is a
// disjoint consumer). Plan-strategy section 1 + section 5 constraint #1
// pin the boundary; this file is the producer half.
//
// Schedule positioning (informational; the App schedule is wired by the
// host, not this file): input / time -> spriteAnimationTickSystem ->
// RenderSystem.extract. The tick is `void`-returning under the
// `Result<void, SpriteAnimationInvalidError>` shape so the schedule's
// Layer-3 ErrorHandler observes a structured first-error signal without
// the system aborting mid-pass on healthy entities (charter P3 explicit
// failure + P4 consistent abstraction with `setTransparentSortConfig`'s
// `Result<void, ResourceInvalidValueError>` shape).
//
// Invariants checked per-entity (AC-09 fail-fast paths; M1 T-05 added
// `SpriteAnimationInvalidError`):
//   - `regions.length === frameCount * 4` -> detail.field='regions-length'
//   - `frameDuration > 0`                  -> detail.field='frame-duration'
// First error wins; subsequent invalid entities still skip advance but
// only the first surfaces in the returned Result.err. Healthy entities
// continue to advance regardless of an invalid sibling (T-19 second
// it() block locks this).
//
// Time.delta sourcing: `world.getResource(Time).delta`. When
// the resource is missing (e.g. the tick system is invoked outside an
// `App` rAF loop), dt defaults to 0 and the system runs as a no-op
// schedule pass. Time.delta is already frame-loop clamped to a sane
// ceiling by `@forgeax/engine-app frame-loop.ts`; the tick system MUST
// NOT second-clamp (research F-3 + plan-strategy R-TIME-1). T-22 case
// (1) feeds dt=30s directly to lock that contract.
//
// playbackMode dispatch: the per-entity `playbackMode: u32` column is
// translated through `spritePlaybackModeFromU32` (M1 SSOT) into the
// closed `'loop' | 'clamp'` literal union. The advance arm is selected
// per-tick per-entity so AI users can mutate playbackMode at runtime
// (e.g. swap LOOP for CLAMP on a death animation) and observe the
// behavioural switch on the very next tick.
//
// Anchors: plan-strategy section 2 D-1 + D-5 + D-6 + D-7 + section 3.1
// TICK + section 3.2 sequence diagram Tick->Ovr block + section 4 risk
// R-TIME-1; plan-tasks.json T-23; requirements section 2.1 C system
// surface + section AC-04 / AC-05 / AC-09 + section 7 boundary table;
// charter P3 + P4 + P5 + F1.

import { type EntityHandle, Time, type World } from '@forgeax/engine-ecs';
import { SpriteAnimationInvalidError } from '@forgeax/engine-ecs/projection';
import {
  SpriteAnimation,
  SpriteRegionOverride,
  spritePlaybackModeFromU32,
} from '@forgeax/engine-render/authoring';
import { err, ok, type Result } from '@forgeax/engine-types';

/**
 * Walk every entity carrying `SpriteAnimation`, advance its dt
 * accumulator, and write the current frame's UV slice to the entity's
 * `SpriteRegionOverride` column.
 *
 * Returns `Result<void, SpriteAnimationInvalidError>`:
 *
 * - `ok(void)` when every observed entity satisfies both invariants
 *   (`regions.length === frameCount * 4` and `frameDuration > 0`) — the
 *   pass advanced every entity normally.
 * - `err(SpriteAnimationInvalidError)` carrying the FIRST entity-level
 *   invariant violation observed during the pass. The offending entity
 *   does not advance (its `currentFrame` / `accumDt` columns stay
 *   untouched); every other healthy entity in the same pass still
 *   advances normally so AI users observe a "fail one, advance the
 *   rest" semantics rather than an all-or-nothing abort.
 *
 * The returned error is the canonical 4-field structured payload
 * (`.code` / `.expected` / `.hint` / `.detail`) — narrow on
 * `err.detail.field` (`'regions-length'` | `'frame-duration'`) to reach
 * the per-arm recovery hint without parsing the message string
 * (charter P3 + P4).
 *
 * @example Wire into an App schedule between input/time and the renderer:
 * ```ts
 * import { createApp } from '@forgeax/engine-app';
 * import { spriteAnimationTickSystem } from '@forgeax/engine-runtime';
 *
 * const app = createApp({ canvas, schedule: { update: [
 *   spriteAnimationTickSystem,
 *   // ... other systems
 * ] } });
 * ```
 *
 * @example Handle the first-error-wins surface:
 * ```ts
 * const r = spriteAnimationTickSystem(world);
 * if (!r.ok) {
 *   // r.error.code === 'sprite-animation-invalid'
 *   if (r.error.detail.field === 'regions-length') {
 *     console.warn(`fix regions buffer length to ${r.error.detail.frameCount * 4}`);
 *   }
 * }
 * ```
 */
export function spriteAnimationTickSystem(world: World): Result<void, SpriteAnimationInvalidError> {
  const dt = world.getResource(Time).delta;

  // Query filters entities carrying SpriteAnimation, so a World that never
  // spawned the component naturally yields an empty entity set (the pass is a
  // no-op).
  // Two-pass to avoid mid-iteration archetype migration. The auto-add
  // of `SpriteRegionOverride` migrates the entity into a new archetype
  // (SA + SRO) which a single-pass query would re-visit later in the same
  // pass — yielding double-advance
  // for any entity that did not yet carry the override. Collecting
  // every Entity handle first gives each entity a single tick.
  const entities = collectAnimEntities(world);

  let firstError: SpriteAnimationInvalidError | null = null;
  for (const entity of entities) {
    const entryError = tickEntity(world, entity, dt);
    if (entryError !== null && firstError === null) {
      firstError = entryError;
    }
  }

  if (firstError !== null) {
    return err(firstError);
  }
  return ok(undefined);
}

/**
 * First pass: collect every Entity handle from the ECS Query projection.
 * Handles remain valid across subsequent migrations because they are stable
 * index+generation identities, not archetype-row pointers.
 */
function collectAnimEntities(world: World): EntityHandle[] {
  const queryResult = world.query({ with: [SpriteAnimation] });
  if (!queryResult.ok) return [];
  const entities: EntityHandle[] = [];
  for (const row of queryResult.value) entities.push(row.entity);
  return entities;
}

/**
 * Second pass: validate one entity's `SpriteAnimation` invariants,
 * advance its dt accumulator, and write the per-frame UV slice into
 * `SpriteRegionOverride`. Returns `null` when the entity advanced
 * normally; returns a structured `SpriteAnimationInvalidError` instance
 * when the entity's row violates an invariant (the caller stitches the
 * first such error into the system's Result.err).
 */
function tickEntity(
  world: World,
  entity: EntityHandle,
  dt: number,
): SpriteAnimationInvalidError | null {
  const snapRes = world.get(entity, SpriteAnimation);
  if (!snapRes.ok) {
    // Defensive: the alive-record check inside world.get already guards
    // stale handles; reaching here means something racier (component
    // sweep removed the column mid-pass). Skip silently — the route is
    // engine-internal, not an AI-user-visible failure mode.
    return null;
  }
  const snap = snapRes.value;
  const frameCount = snap.frameCount;
  const frameDuration = snap.frameDuration;
  const regions = snap.regions;

  // Invariant: regions.length === frameCount * 4 (D-1 fail-fast,
  // T-19 covers).
  if (regions.length !== frameCount * 4) {
    return new SpriteAnimationInvalidError({
      field: 'regions-length',
      regionsLength: regions.length,
      frameCount,
    });
  }
  // Invariant: frameDuration > 0 (covers both === 0 and < 0; T-20 +
  // T-21 lock both arms to the same .detail.field='frame-duration'
  // branch — charter P4 consistent abstraction).
  if (!(frameDuration > 0)) {
    return new SpriteAnimationInvalidError({
      field: 'frame-duration',
      frameDuration,
    });
  }

  const advanced = advanceFrame(
    snap.currentFrame,
    snap.accumDt + dt,
    frameDuration,
    frameCount,
    snap.playbackMode,
  );

  // Write the new clock state. Partial set leaves regions / frameCount
  // / frameDuration / playbackMode untouched (world.set iterates
  // Object.keys(value)).
  const writeAnim = world.set(entity, SpriteAnimation, {
    currentFrame: advanced.currentFrame,
    accumDt: advanced.accumDt,
  });
  if (!writeAnim.ok) return null;

  // Materialise the per-frame UV slice into SpriteRegionOverride.
  // The slice is guaranteed to be 4 floats by the regions-length
  // invariant above. A fresh Float32Array is allocated per write so
  // the column owner's BufferPool slot does not alias the
  // SpriteAnimation.regions backing array (charter P5 producer
  // boundary: the override slot is a snapshot, not a view).
  const sliceStart = advanced.currentFrame * 4;
  const region = new Float32Array([
    regions[sliceStart] ?? 0,
    regions[sliceStart + 1] ?? 0,
    regions[sliceStart + 2] ?? 0,
    regions[sliceStart + 3] ?? 0,
  ]);
  writeOverride(world, entity, region);
  return null;
}

/**
 * Advance `currentFrame` / `accumDt` per the dt accumulator clock model
 * (research F-3 + plan-strategy section 2 D-5). `dt` is the
 * already-frame-loop-clamped Time.delta; the inner while-loop drains
 * frameDuration units one at a time. The playbackMode discriminator
 * picks LOOP (wrap) vs CLAMP (halt at last frame) per-tick per-entity
 * (D-5).
 */
function advanceFrame(
  currentFrameIn: number,
  accumDtIn: number,
  frameDuration: number,
  frameCount: number,
  playbackModeRaw: number,
): { currentFrame: number; accumDt: number } {
  let currentFrame = currentFrameIn;
  let accumDt = accumDtIn;
  const playback = spritePlaybackModeFromU32(playbackModeRaw);
  while (accumDt >= frameDuration) {
    accumDt -= frameDuration;
    switch (playback) {
      case 'loop': {
        currentFrame = (currentFrame + 1) % frameCount;
        break;
      }
      case 'clamp': {
        // `min(currentFrame + 1, frameCount - 1)`; once at the last
        // frame the index stops advancing. The accumDt subtraction
        // continues so the residue does not pile up across ticks (T-18
        // second it() block + T-22 case (2b) lock the halt).
        if (currentFrame < frameCount - 1) {
          currentFrame += 1;
        }
        break;
      }
    }
  }
  return { currentFrame, accumDt };
}

/**
 * Write the per-entity UV region into `SpriteRegionOverride`,
 * add-or-set with no registration-concept probe.
 *
 * `addComponent` is the registration-agnostic entry point: it auto-adds
 * the `SpriteRegionOverride` column on first use, so a World that only ever
 * spawned `SpriteAnimation` reaches the override column through this single
 * call (requirements section 7 boundary table row 2 / charter P3). When the
 * entity already carries the column, `addComponent` returns
 * `err(component-already-present)` — the steady-state signal — and we
 * `set` the region in place. `SpriteRegionOverride` declares no
 * relationship, so the exclusive auto-reparent arm of `addComponent`
 * never fires and `component-already-present` is the only present-case
 * outcome.
 *
 * This replaces the former `_getComponentByName` registration gate: the
 * "is it registered" question is no longer asked at all — `addComponent`
 * owns registration, and column presence is read from its structured
 * `Result` rather than a per-World registry lookup.
 */
function writeOverride(world: World, entity: EntityHandle, region: Float32Array): void {
  const added = world.addComponent(entity, {
    component: SpriteRegionOverride,
    data: { region },
  });
  if (!added.ok && added.error.code === 'component-already-present') {
    world.set(entity, SpriteRegionOverride, { region });
  }
}
