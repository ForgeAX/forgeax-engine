// Animation playback and code-owned control share one ECS component.
// Direct mode owns clips/times/weights/speeds with equal lengths. masks is empty
// (all unmasked), or has one shared mask handle per slot; 0 is unmasked.
// Graph mode derives these slot arrays from clip nodes. nodeWeights/nodeTimes/
// nodeSpeeds/nodeMasks are indexed by graph node; missing controls use defaults.
// Graph evaluation owns clocks and parks derived speeds at zero to avoid a second
// advance. A mask multiplies target influence before per-channel normalization;
// it does not restore a reference pose or implement absolute alpha blending.

import { defineComponent } from '@forgeax/engine-ecs';

export const AnimationPlayer = defineComponent('AnimationPlayer', {
  // The render/animation owner re-resolves clip assets in the target World;
  // playback clocks and weights remain portable simulation state.
  clips: { type: 'array<shared<AnimationClip>>' },
  times: { type: 'array<f64>' },
  weights: { type: 'array<f32>' },
  speeds: { type: 'array<f32>' },
  // Empty = unmasked; otherwise one World-local mask handle per clip slot (0 = unmasked).
  masks: { type: 'array<shared<AnimationMask>>', transient: true },
  // The graph evaluator owns this compiled runtime binding; portable playback
  // controls and derived slots remain available to the simulation record.
  graph: { type: 'shared<AnimationGraph>' },
  nodeWeights: { type: 'array<f32>' },
  nodeTimes: { type: 'array<f64>' },
  nodeSpeeds: { type: 'array<f32>' },
  // Graph-mode mask controls by node index; missing entries mean unmasked.
  nodeMasks: { type: 'array<shared<AnimationMask>>', transient: true },
  paused: { type: 'bool', default: false },
  looping: { type: 'bool', default: true },
});
