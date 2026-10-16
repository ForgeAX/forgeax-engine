// apps/collectathon -- pickup-text: MSDF floating "+1" text on Core pickup (AC-12).
//
// Two-phase per frame:
//   (1) Read PickupSignal[] (written by core-collect the same frame). For each
//       signal, spawn a world-space GlyphText "+1" entity at the Core's last-known
//       world position, scoped to the Play state (despawnOnExit). Track it in a
//       closure Map for lifecycle animation.
//   (2) Iterate the tracked text entities: decrement remaining life, raise pos y
//       upward at ~1.5 m/s (bubble animation), despawn when life expires.
//
// The GlyphText entity carries Transform (bubble position), GlyphText ("+1"
// label in golden/orange), and the mesh is auto-baked by glyphTextLayoutSystem
// each frame. No alpha fade -- updating GlyphText.color[3] each frame would
// re-bake the mesh, which is unnecessary overhead for short-lived bubbles.
//
// AC-18: this system NEVER writes GameProgress -- the score is already
// incremented by core-collect before pickup-text runs (`after: ['core-collect']`).
// It reads PickupSignal (one-way) and writes only the spawned entity's Transform
// + despawn lifecycle. The Map tracks remaining life; state-scoped despawn on
// Play exit cleans up stale handles automatically.

import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';
import { GlyphText } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { StateToken } from '@forgeax/engine-state';
import { despawnOnExit } from '@forgeax/engine-state';
import type { Handle } from '@forgeax/engine-types';

import { PICKUP_SIGNAL_KEY, type PickupSignal } from '../resources';
import { readDt } from './frame-time';

/** Bubble rise speed (world units per second). */
const BUBBLE_RISE_SPEED = 1.5;
/** "+1" text lifetime in seconds. */
const TEXT_LIFETIME = 0.8;
/** World-space font size for the "+1" label (metres). */
const FONT_SIZE = 0.15;

/**
 * Build the pickup-text system bound to the MSDF font handle + the Play state
 * token. Factory form mirrors the other gameplay systems -- the closure Map
 * holds active text entity handles and their remaining lifetimes.
 *
 * @param fontHandle shared FontAsset handle (minted by main.ts after
 *   loadByGuid + allocSharedRef). When undefined, the system is a no-op
 *   (no font available -- graceful degradation without crashing).
 * @param gameState the GameState token for Play-scoped despawnOnExit.
 */
export function createPickupTextSystem(
  fontHandle: Handle<'FontAsset', 'shared'>,
  gameState: StateToken,
): SystemHandle<readonly []> {
  const active: Map<EntityHandle, number> = new Map();

  return defineSystem({
    name: 'pickup-text',
    after: ['core-collect'],
    queries: [],
    fn: (world: World, _results, commands) => {
      const dt = readDt(world);

      // Phase 1: spawn "+1" text from the pickup signal written by core-collect.
      if (world.hasResource(PICKUP_SIGNAL_KEY)) {
        const signals = world.getResource<PickupSignal[]>(PICKUP_SIGNAL_KEY);
        for (const s of signals) {
          const e = world
            .spawn(
              {
                component: Transform,
                data: { pos: s.pos, quat: [0, 0, 0, 1] },
              },
              {
                component: GlyphText,
                data: {
                  fontHandle,
                  text: '+1',
                  fontSize: FONT_SIZE,
                  color: [1.0, 0.8, 0.2, 1.0],
                },
              },
            )
            .unwrap();
          despawnOnExit(world, e, gameState, 'Play');
          active.set(e, TEXT_LIFETIME);
        }
        world.insertResource(PICKUP_SIGNAL_KEY, []);
      }

      // Phase 2: animate active text entities upward, despawn expired ones.
      for (const [entity, life] of active) {
        const newLife = life - dt;
        if (newLife <= 0) {
          commands.despawn(entity);
          active.delete(entity);
          continue;
        }
        const t = world.get(entity, Transform);
        if (!t.ok) {
          // Entity was despawned externally (e.g. state-scoped Play exit).
          active.delete(entity);
          continue;
        }
        world.set(entity, Transform, {
          pos: [
            t.value.pos[0] ?? 0,
            (t.value.pos[1] ?? 0) + dt * BUBBLE_RISE_SPEED,
            t.value.pos[2] ?? 0,
          ],
        });
        active.set(entity, newLife);
      }
    },
  });
}
