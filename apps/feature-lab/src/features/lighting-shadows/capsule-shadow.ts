import type { CreateAppOptions } from '@forgeax/engine/app';
import {
  CapsuleShadow,
  DEFAULT_STANDARD_PROFILE,
  DirectionalLight,
  DirectionalShadowFilterValue,
  MeshRenderer,
  Skylight,
} from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { spawnCamera, spawnGround } from '../../lab/stage';
import { spawnSkinnedCharacter } from './support/scene';

const APP_OPTIONS: CreateAppOptions = {
  standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
};

export default defineFeature({
  title: 'Capsule shadow',
  catalog: 'Capsule shadows',
  kind: 'visual',
  appOptions: APP_OPTIONS,
  summary:
    'A procedural single-joint skinned character tagged with CapsuleShadow leaves the directional cascades; its skeleton shadow capsule is tile-binned and evaluated inline by Deferred lighting.',
  expect:
    'ON: a soft, rounded capsule-shaped shadow falls from the character across the floor. OFF: the tag is removed and the material drops its ShadowCaster pass, so the character casts nothing. Checks: while ON 1 entity requested and admitted, 1 capsule; after OFF no entity requested.',
  setup({ world, app }) {
    spawnGround(world, [0.6, 0.6, 0.6, 1]);
    spawnCamera(world, { eye: [0, 2.2, 4.5], target: [0.3, 0.6, 0] });
    world
      .spawn({ component: Skylight, data: { color: [0.4, 0.45, 0.5], intensity: 0.15 } as never })
      .unwrap();
    world
      .spawn({
        component: DirectionalLight,
        data: {
          direction: [0.6, -0.7, 0.3],
          intensity: 3,
          castShadow: true,
          shadowFilter: DirectionalShadowFilterValue.pcssHigh,
          shadowAngularRadius: 0.02,
        } as never,
      })
      .unwrap();
    const character = spawnSkinnedCharacter(world, [0, 0, 0], [0.9, 0.15, 0.1, 1]);
    world.addComponent(character.entity, { component: CapsuleShadow, data: {} } as never).unwrap();
    let enabled = true;
    let onSample = app.renderer.inspect().capsuleShadow;
    return {
      toggle(on) {
        if (!on && enabled) onSample = app.renderer.inspect().capsuleShadow;
        enabled = on;
        world.set(character.entity, MeshRenderer, {
          materials: [on ? character.casterMaterial : character.hiddenMaterial],
        } as never);
        if (on)
          world
            .addComponent(character.entity, { component: CapsuleShadow, data: {} } as never)
            .unwrap();
        else world.removeComponent(character.entity, CapsuleShadow).unwrap();
      },
      checks() {
        const live = app.renderer.inspect().capsuleShadow;
        // After an OFF toggle the live inspection is empty; judge the ON state by its last sample.
        const capsule = enabled ? live : onSample;
        return [
          {
            name: 'OFF state requests no capsule entity',
            ok: enabled || (live?.requested ?? 0) === 0,
            detail: JSON.stringify(live),
          },
          { name: 'capsule inspection present', ok: capsule !== undefined },
          {
            name: 'one entity requested',
            ok: capsule?.requested === 1,
            detail: JSON.stringify(capsule),
          },
          {
            name: 'one entity admitted',
            ok: capsule?.admitted === 1,
            detail: `admitted=${capsule?.admitted}`,
          },
          {
            name: 'one capsule posed',
            ok: capsule?.capsuleCount === 1,
            detail: `capsuleCount=${capsule?.capsuleCount}`,
          },
          {
            name: 'no dropped capsules',
            ok: capsule?.droppedCapsules === 0,
            detail: `dropped=${capsule?.droppedCapsules}`,
          },
        ];
      },
    };
  },
});
