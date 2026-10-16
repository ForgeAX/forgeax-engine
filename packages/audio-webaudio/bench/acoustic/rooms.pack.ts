import { AcousticRegion, AcousticShapeValue, AudioListener, AudioSource } from '@forgeax/engine/audio';
import { Transform, ChildOf } from '@forgeax/engine/scene';
import { Camera } from '@forgeax/engine/render';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';

// Fixed identity; the producer derives member GUIDs from these stable source keys.
export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('01a11253-2200-7000-8000-000000000000'),
  sceneComponents: [Transform, ChildOf, Camera, AcousticRegion, AudioListener, AudioSource],
  build: () => ok({
    rooms: { kind: 'scene', entities: {
      camera: { components: { Transform: { pos: [0, 0, 5] }, Camera: { aspect: 1 } } },
      anchor: { components: { Transform: { scale: [2, 1, 1] } } },
      room: { components: { ChildOf: { parent: 'anchor' }, Transform: { pos: [0, 0, 0] },
        AcousticRegion: { shape: AcousticShapeValue.box, halfExtents: [1, 1, 1], blendDistance: 0.5,
          sourceBus: 'room', listenerWetBus: 'echo', wet: 1,
          listenerSendBus: 'room', listenerSendTarget: 'echo', sendGain: 0.5 } } },
      sphere: { components: { Transform: { pos: [5, 0, 0] },
        AcousticRegion: { shape: AcousticShapeValue.sphere, radius: 1.5, priority: 2, sourceBus: 'room', blendDistance: 0.5 } } },
      emitter: { components: { Transform: { pos: [3, 0, 0] }, AudioSource: {
        clip: '01a11253-2200-7000-8000-000000000001', playing: true, loop: true, bus: 'sfx' } } },
      listener: { components: { Transform: { pos: [3, 0, 0] }, AudioListener: {} } },
    } },
  }),
});
