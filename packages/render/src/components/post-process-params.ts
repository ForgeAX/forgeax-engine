// @forgeax/engine-render - PostProcessParams component.
//
// Schema: { shader: 'string', data: 'buffer' }.
//
// `shader` identifies the fullscreen post-process shader (the same id as passed to
// the feature host registers for `id`). `data` carries the per-frame params
// bytes as a variable-byte ECS managed buffer slot. The write side (world.spawn /
// world.set) accepts every AllowSharedBufferSource (Float32Array / ArrayBuffer /
// Uint8Array / typed array) and the ECS normalizes it to Uint8Array bytes
// (feat-20260621 V2 / AC-A4); the read side (world.get) returns Uint8Array, which
// satisfies AllowSharedBufferSource for GPU queue.writeBuffer ingestion.
//
// Single-semantic component — drops the `Component` suffix
// (AGENTS.md §Component naming rule #1). The `data` field uses the ECS 'buffer'
// vocab keyword (plan-strategy D-7) for variable-byte storage.
//
// Data flow (plan-strategy D-1):
//   extract -> iterate PostProcessParams-bearing entities ->
//   collect into Map<shaderId, AllowSharedBufferSource> snapshot ->
//   dispatchFullscreenPass picks up per-shader data -> writeBuffer to eager UBO.
//
// Decision anchors:
//   - requirements AC-A2 (data-driven, no imperative renderer.setParams mutator)
//   - requirements AC-A4 (AllowSharedBufferSource type on the data field)
//   - plan-strategy D-1 (new single-semantic ECS component for params)
//   - plan-strategy D-7 (ECS 'buffer' vocab keyword for variable-byte storage)

import { defineComponent } from '@forgeax/engine-ecs';

const schema = {
  shader: 'string',
  data: 'buffer',
} as const;

export const PostProcessParams = defineComponent('PostProcessParams', schema);
