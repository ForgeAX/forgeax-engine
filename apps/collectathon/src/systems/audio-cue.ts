// apps/collectathon -- audio-cue: 3D spatial audio for the four game cues
// (AC-10 footstep / pickup / Guardian / BGM, dual sfx+music bus, F-07
// AudioSource/AudioListener/spatialBlend).
//
// Asset + license posture (AC-19 / D-3 layered compliance):
//   The four cue families live in forgeax-engine-assets/collectathon-audio/ as
//   engine-authored, Apache-2.0, commercial-compatible WAVs (procedurally
//   synthesized -- see that directory's ATTRIBUTION.md + LICENSE). They are
//   PLACEHOLDERS for curated Pixabay/Freesound CC0 cues: the implement sandbox
//   has no network (Pixabay 403), so swapping in hand-picked recordings is a
//   verify/human follow-up. The wiring below is the real audio path either way.
//   None of the cues are CC BY-NC 4.0 (OOS-8): engine-authored originals.
//
// How the cues fire (this system reads game state, no second event bus):
//   - footstep: the player-move signal (moving && grounded) drives a looping
//     footstep AudioSource gated by a ~0.34s cooldown so steps are discrete.
//   - pickup:   a GameProgress.score increase since last frame -> one-shot.
//   - guardian: a GameProgress.health decrease since last frame -> one-shot.
//   - bgm:      a looping AudioSource started on the first Play frame, music bus.
// Reading score/health deltas keeps audio-cue self-contained (it does not
// re-touch core-collect / guardian-hit -- those stay the sole SSOT writers).
//
// 3D spatial (F-07): the footstep + guardian + pickup emitters carry
// spatialBlend=1 (PannerNode distance attenuation); BGM is spatialBlend=0
// (non-positional, music bus). The AudioListener rides the camera entity
// (wired in main.ts); createApp auto-registers the listener-sync system, so
// emitter distance attenuates as the camera/player moves away.
//
// Playing edges: this system writes AudioSource.playing edges; the engine's
// auto-registered audioTickSystem consumes them (false->true starts a node,
// true->false stops). One-shots use the re-arm pattern (write true this frame,
// false next frame). The loops (footstep cadence, BGM) hold playing per their
// own gating.

import { AudioSource } from '@forgeax/engine-audio';
import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { defineSystem } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { AudioClipAsset, Handle } from '@forgeax/engine-types';

import { GAME_PROGRESS_KEY, type GameProgress } from '../resources';
import { readDt } from './frame-time';
import type { PlayerMoveSignal } from './player-move';

/** Footstep cadence: minimum seconds between footstep triggers while moving. */
export const FOOTSTEP_INTERVAL = 0.34;

/** GUIDs of the collectathon-audio cues (SSOT: the .meta.json subAsset guids). */
export const AUDIO_GUIDS = {
  footstep: [
    '201222ef-ccf4-4538-96ce-14a96ecc993d',
    '8f87b826-bcec-4be1-9ea1-caa964b0a9ba',
    '724242e6-5df8-44b8-9b41-0e430d1acc2c',
  ],
  pickup: '2e23f877-a9e3-40cc-ba75-1126aef34cce',
  guardian: '49c2c8b1-8091-4e9e-b782-f658ee4e31b0',
  bgm: '3b298083-a2bc-496f-91fb-80e5bb8cfe48',
} as const;

/** Handles for the spawned cue emitter entities (returned by loadAudioCues). */
export interface AudioCueEntities {
  /** One footstep emitter (round-robins through the loaded variant clips). */
  readonly footstep: EntityHandle;
  readonly footstepClips: ReadonlyArray<Handle<'AudioClipAsset', 'shared'>>;
  readonly pickup: EntityHandle;
  readonly guardian: EntityHandle;
  readonly bgm: EntityHandle;
}

type ClipHandle = Handle<'AudioClipAsset', 'shared'>;
const HANDLE_NONE = 0 as unknown as ClipHandle;

interface AudioRegistry {
  loadByGuid<T>(guid: AssetGuid): Promise<{ ok: true; value: T } | { ok: false }>;
}

/**
 * Resolve an audio GUID through the shared asset registry and mint the World
 * column handle consumed by AudioSource. A failed cue remains silent without
 * making the whole game unplayable.
 */
async function loadClip(world: World, assets: AudioRegistry, guid: string): Promise<ClipHandle> {
  const parsed = AssetGuid.parse(guid);
  if (!parsed.ok) return HANDLE_NONE;
  const result = await assets.loadByGuid<AudioClipAsset>(parsed.value);
  if (!result.ok) return HANDLE_NONE;
  return world.allocSharedRef('AudioClipAsset', result.value);
}

/**
 * Load the four cue families and spawn their emitter entities. footstep / pickup
 * / guardian are spatialBlend=1 (3D positional); bgm is spatialBlend=0 on the
 * music bus. Emitters start with playing=false; the cue system drives the edges.
 *
 */
export async function loadAudioCues(
  world: World,
  assets: AudioRegistry,
): Promise<AudioCueEntities> {
  const footstepClips: ClipHandle[] = [];
  for (const guid of AUDIO_GUIDS.footstep) {
    footstepClips.push(await loadClip(world, assets, guid));
  }
  const pickupClip = await loadClip(world, assets, AUDIO_GUIDS.pickup);
  const guardianClip = await loadClip(world, assets, AUDIO_GUIDS.guardian);
  const bgmClip = await loadClip(world, assets, AUDIO_GUIDS.bgm);

  const footstep = world
    .spawn({
      component: AudioSource,
      data: {
        clip: footstepClips[0] ?? HANDLE_NONE,
        playing: false,
        spatialBlend: 1,
        volume: 0.6,
        bus: 'sfx',
      },
    })
    .unwrap();
  const pickup = world
    .spawn({
      component: AudioSource,
      data: { clip: pickupClip, playing: false, spatialBlend: 1, volume: 0.8, bus: 'sfx' },
    })
    .unwrap();
  const guardian = world
    .spawn({
      component: AudioSource,
      data: { clip: guardianClip, playing: false, spatialBlend: 1, volume: 0.8, bus: 'sfx' },
    })
    .unwrap();
  const bgm = world
    .spawn({
      component: AudioSource,
      data: {
        clip: bgmClip,
        playing: false,
        loop: true,
        spatialBlend: 0,
        volume: 0.4,
        bus: 'music',
      },
    })
    .unwrap();

  return { footstep, footstepClips, pickup, guardian, bgm };
}

/**
 * Per-frame cue state held in the system closure (not ECS columns): the last
 * score/health seen (delta detection), the footstep cadence timer + variant
 * cursor, and the per-emitter "wrote true last frame" flags for one-shot re-arm.
 */
interface CueState {
  prevScore: number;
  prevHealth: number;
  footTimer: number;
  footCursor: number;
  bgmStarted: boolean;
  pickupArmed: boolean;
  guardianArmed: boolean;
  footArmed: boolean;
}

/**
 * Build the audio-cue system bound to the loaded emitter entities + the
 * player-move signal. Per frame:
 *   - re-arm any one-shot whose playing was set true last frame (write false).
 *   - footstep: while moving && grounded, fire on the cooldown cadence (cycling
 *     the loaded variant clips for variety).
 *   - pickup:   score went up -> one-shot.
 *   - guardian: health went down -> one-shot.
 *   - bgm:      start the looping track on the first frame it runs.
 * Guarded against a missing GameProgress (before OnEnter inserts it).
 */
export function createAudioCueSystem(
  cues: AudioCueEntities,
  signal: PlayerMoveSignal,
): SystemHandle<readonly []> {
  const state: CueState = {
    prevScore: 0,
    prevHealth: Number.POSITIVE_INFINITY,
    footTimer: 0,
    footCursor: 0,
    bgmStarted: false,
    pickupArmed: false,
    guardianArmed: false,
    footArmed: false,
  };

  const setPlaying = (world: World, e: EntityHandle, playing: boolean): void => {
    const cur = world.get(e, AudioSource);
    if (!cur.ok) return;
    world.set(e, AudioSource, { ...cur.value, playing });
  };

  return defineSystem({
    name: 'audio-cue',
    after: ['player-move', 'core-collect', 'guardian-hit'],
    queries: [],
    fn: (world: World) => {
      // Re-arm: clear any one-shot that was triggered last frame (false edge so
      // the audioTickSystem stops the node and the cue can fire again).
      if (state.pickupArmed) {
        setPlaying(world, cues.pickup, false);
        state.pickupArmed = false;
      }
      if (state.guardianArmed) {
        setPlaying(world, cues.guardian, false);
        state.guardianArmed = false;
      }
      if (state.footArmed) {
        setPlaying(world, cues.footstep, false);
        state.footArmed = false;
      }

      if (!state.bgmStarted) {
        setPlaying(world, cues.bgm, true);
        state.bgmStarted = true;
      }

      if (!world.hasResource(GAME_PROGRESS_KEY)) return;
      const progress = world.getResource<GameProgress>(GAME_PROGRESS_KEY);

      if (progress.score > state.prevScore) {
        setPlaying(world, cues.pickup, true);
        state.pickupArmed = true;
      }
      state.prevScore = progress.score;

      if (progress.health < state.prevHealth) {
        setPlaying(world, cues.guardian, true);
        state.guardianArmed = true;
      }
      state.prevHealth = progress.health;

      // Footstep cadence: count down while moving on the ground; on each tick,
      // advance the variant clip and re-arm a one-shot step.
      state.footTimer -= readDt(world);
      if (signal.moving && signal.grounded) {
        if (state.footTimer <= 0) {
          state.footCursor = (state.footCursor + 1) % Math.max(1, cues.footstepClips.length);
          const clip = cues.footstepClips[state.footCursor] ?? HANDLE_NONE;
          const cur = world.get(cues.footstep, AudioSource);
          if (cur.ok) world.set(cues.footstep, AudioSource, { ...cur.value, clip, playing: true });
          state.footArmed = true;
          state.footTimer = FOOTSTEP_INTERVAL;
        }
      } else {
        state.footTimer = 0;
      }
    },
  });
}
