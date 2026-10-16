import {
  AnimationPlayer,
  bindComponentProperty,
  bindObjectProperty,
  deriveAnimationTargetId,
} from '@forgeax/engine/animation';
import { DirectionalLight } from '@forgeax/engine/render';
import type { AnimationClip } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Object property animation',
  catalog: 'Object property animation',
  kind: 'visual',
  summary:
    'An ordinary AnimationPlayer drives a DirectionalLight intensity field and a nested native object property with one shared clock.',
  expect:
    'ON samples t=1 s at light intensity 5. OFF samples t=0 s at intensity 1, keeping the orange sphere and floor visible. Both are paused samples of the same animation, not enabled/disabled playback. Native opacity and STEP text/boolean values appear in the checks; they do not control the sphere material.',
  setup({ world, hud }) {
    const { sun } = spawnStage(world, { eye: [0, 1.5, 5], target: [0, 0.8, 0] });
    spawnMesh(
      world,
      MESH.sphere,
      standard(world, { baseColor: [1, 0.3, 0.05, 1], roughness: 0.45 }),
      { pos: [0, 0.9, 0], scale: [0.8, 0.8, 0.8] },
    );
    const targetId = deriveAnimationTargetId(['Properties']);
    const clip: AnimationClip = {
      kind: 'animation-clip',
      duration: 1,
      channels: [
        {
          targetId,
          property: 'property',
          binding: 'intensity',
          sampler: {
            input: new Float32Array([0, 1]),
            output: new Float32Array([1, 5]),
            interpolation: 'LINEAR',
          },
        },
        {
          targetId,
          property: 'property',
          binding: 'opacity',
          sampler: {
            input: new Float32Array([0, 1]),
            output: new Float32Array([0.2, 0.9]),
            interpolation: 'LINEAR',
          },
        },
        {
          targetId,
          property: 'property',
          binding: 'label',
          sampler: {
            input: new Float32Array([0, 1]),
            output: ['off', 'on'],
            interpolation: 'STEP',
          },
        },
        {
          targetId,
          property: 'property',
          binding: 'visible',
          sampler: {
            input: new Float32Array([0, 1]),
            output: [false, true],
            interpolation: 'STEP',
          },
        },
      ],
    };
    const player = world
      .spawn({
        component: AnimationPlayer,
        data: {
          clips: [world.allocSharedRef('AnimationClip', clip)],
          times: [1],
          weights: [1],
          speeds: [0],
          paused: true,
          looping: false,
        },
      })
      .unwrap();
    const object = { material: { opacity: 0 }, label: '', visible: false };
    bindComponentProperty(world, player, targetId, 'intensity', {
      entity: sun,
      component: DirectionalLight,
      field: 'intensity',
    }).unwrap();
    bindObjectProperty(world, player, targetId, 'opacity', {
      object,
      path: ['material', 'opacity'],
    }).unwrap();
    bindObjectProperty(world, player, targetId, 'label', { object, path: ['label'] }).unwrap();
    bindObjectProperty(world, player, targetId, 'visible', { object, path: ['visible'] }).unwrap();
    let enabled = true;
    hud.status('Sample t=1 s (bright endpoint)');
    return {
      toggle(on) {
        enabled = on;
        world.set(player, AnimationPlayer, { times: [on ? 1 : 0] }).unwrap();
        hud.status(`Sample t=${on ? 1 : 0} s (${on ? 'bright endpoint' : 'lit baseline'})`);
      },
      checks() {
        const checks = new CheckList();
        checks.near(
          'rendered light intensity',
          world.get(sun, DirectionalLight).unwrap().intensity,
          enabled ? 5 : 1,
        );
        checks.near('nested object property', object.material.opacity, enabled ? 0.9 : 0.2);
        checks.equal('STEP string', object.label, enabled ? 'on' : 'off');
        checks.equal('STEP boolean', object.visible, enabled);
        return checks.items;
      },
    };
  },
});
