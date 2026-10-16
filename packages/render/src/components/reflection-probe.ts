// @forgeax/engine-render - local reflection probe vocabulary.
//
// A ReflectionProbe is an ECS authoring fact. The renderer owns its six-face
// capture, PMREM output, box selection, and Skylight fallback; this component
// never carries a GPU handle or an authored material reference.

import { defineComponent, type SchemaOf, type ShapeOf } from '@forgeax/engine-ecs';
import { RenderIntentInvalidError } from '../errors/render';

export const REFLECTION_PROBE_UPDATE_ONCE = 0;
export const REFLECTION_PROBE_UPDATE_ON_CHANGE = 1;
export const REFLECTION_PROBE_UPDATE_CONTINUOUS = 2;

export type ReflectionProbeUpdateIntent = 'once' | 'on-change' | 'continuous';

export function reflectionProbeUpdateIntentFromF32(value: number): ReflectionProbeUpdateIntent {
  switch (value) {
    case REFLECTION_PROBE_UPDATE_ONCE:
      return 'once';
    case REFLECTION_PROBE_UPDATE_ON_CHANGE:
      return 'on-change';
    case REFLECTION_PROBE_UPDATE_CONTINUOUS:
      return 'continuous';
    default:
      throw new RenderIntentInvalidError('ReflectionProbe', value);
  }
}

export function reflectionProbeUpdateIntentToF32(intent: ReflectionProbeUpdateIntent): number {
  switch (intent) {
    case 'once':
      return REFLECTION_PROBE_UPDATE_ONCE;
    case 'on-change':
      return REFLECTION_PROBE_UPDATE_ON_CHANGE;
    case 'continuous':
      return REFLECTION_PROBE_UPDATE_CONTINUOUS;
  }
}

export const ReflectionProbe = defineComponent('ReflectionProbe', {
  halfExtents: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
  priority: { type: 'f32', default: 0 },
  boxProjection: { type: 'bool', default: false },
  intensity: { type: 'f32', default: 1 },
  resolution: { type: 'u32', default: 256 },
  updateIntent: { type: 'f32', default: REFLECTION_PROBE_UPDATE_ONCE },
  invalidationVersion: { type: 'u32', default: 0 },
});

export type ReflectionProbeData = ShapeOf<SchemaOf<typeof ReflectionProbe>>;
