// @forgeax/engine-audio -- AudioSource + AudioListener ECS components (feat-20260527-audio-system M1 / w9)
//
// Decision anchors:
// - requirements S-3 (AudioSource single-component surface, 6 fields)
// - requirements S-4 (AudioListener independent marker component)
// - plan-strategy D-4 (edge-detection tick system; AudioSource.playing drives play/stop edges)
// - plan-strategy D-5 (AudioSource.bus defaults to 'sfx'; BusName is 'sfx' | 'music')
// - plan-strategy section 3.1 (6-field AudioSource + marker AudioListener)
// - charter P1 (progressive disclosure: 3-symbol core surface)
// - charter P4 (consistent abstraction: same defineComponent pattern as Transform/Camera)

import { defineComponent } from '@forgeax/engine-ecs';

export const AudioSource = defineComponent('AudioSource', {
  clip: { type: 'shared<AudioClipAsset>' },
  playing: { type: 'bool', default: false },
  loop: { type: 'bool', default: false },
  paused: { type: 'bool', default: false },
  playbackRate: { type: 'f32', default: 1 },
  fromPosition: { type: 'f32', default: 0 },
  volume: { type: 'f32', default: 1.0 },
  spatialBlend: { type: 'f32', default: 0 },
  coneInnerAngle: { type: 'f32', default: 360 },
  coneOuterAngle: { type: 'f32', default: 360 },
  coneOuterGain: { type: 'f32', default: 0 },
  bus: { type: 'string', default: 'sfx' },
});

export const AudioListener = defineComponent('AudioListener', {});
