// @forgeax/engine-graphics-extras — VideoPlayer ECS component
// (feat-20260623-world-space-video-asset M3 / w7).
//
// Single-component play-state surface for world-space video textures. An
// entity carries one VideoPlayer referencing a VideoAsset via the `clip`
// handle; the per-entity playing / loop / currentTime live in independent
// archetype column slots so multiple entities share one VideoAsset GUID with
// independent play state (AC-05, research Finding 6).
//
// Schema vocab is the CLOSED ECS set (component.ts:315-333): clip uses
// `shared<VideoAsset>` (a branded u32 handle, NOT a bare GUID string), the
// three play-state fields use `bool` / `f32`. No opaque / object field type is
// introduced — the host HTMLVideoElement reference travels through the
// VideoSourceProvider World Resource (plan-strategy D-1 / w9), never inside an
// ECS field (research Finding 5: schema vocab closed).
//
// Decision anchors:
//   - requirements AC-04 (VideoPlayer registers via defineComponent; reference
//     field is a handle type, not a bare GUID; play-state fields playing/loop/
//     currentTime).
//   - plan-strategy D-4 (clip: Handle<'VideoAsset','shared'>, brand string
//     'VideoAsset' mirrors AudioSource.clip: Handle<'AudioClipAsset','shared'>
//     so AI users carry over the audio naming intuition — charter P4).
//   - charter P1 (progressive disclosure: 4-field minimal surface).

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * VideoPlayer — attaches video play state to an entity.
 *
 * Fields:
 *   - `clip: shared<VideoAsset>` — handle to the VideoAsset describing the
 *     source URL (mirrors `AudioSource.clip`). Resolved into an
 *     HTMLVideoElement at frame time via the host `VideoSourceProvider`
 *     (the engine never decodes video bytes — D-1).
 *   - `playing: bool` — whether the clip advances this frame (default false).
 *   - `loop: bool` — whether the clip restarts at end (default false).
 *   - `currentTime: f32` — playback head in seconds (default 0).
 *
 * Multiple entities may reference the same `clip` GUID with distinct
 * play state — each entity's playing / loop / currentTime occupy independent
 * archetype column slots (AC-05).
 */
export const VideoPlayer = defineComponent('VideoPlayer', {
  // The host HTMLVideoElement owns the live asset/presentation binding; the
  // portable play controls remain in the simulation projection.
  clip: { type: 'shared<VideoAsset>' },
  playing: { type: 'bool', default: false },
  loop: { type: 'bool', default: false },
  currentTime: { type: 'f32', default: 0, transient: true },
});
