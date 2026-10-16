import { ShadowParticipation, Visibility, VisibilityStateValue } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { serial } from './support/serial';

export default defineFeature({
  title: 'Shadow participation',
  catalog: 'Shadow participation',
  kind: 'visual',
  summary:
    'Caster eligibility comes from per-entity ShadowParticipation.cast and effective Visibility; a hidden entity neither draws nor casts.',
  expect:
    'ON: the tall purple pillar casts a long shadow across the floor. OFF: its ShadowParticipation has cast: false, the pillar still renders but its shadow is gone.',
  setup({ app, world, frames }) {
    spawnStage(world, { eye: [0, 4, 7], target: [0, 0.5, 0] });
    const casting = standard(world, { baseColor: [0.6, 0.2, 0.9, 1] });
    const pillar = spawnMesh(
      world,
      MESH.cube,
      casting,
      { pos: [0, 1.5, -1], scale: [0.6, 3, 0.6] },
      { component: ShadowParticipation, data: { cast: true, receive: true } },
    );
    spawnMesh(
      world,
      MESH.cube,
      casting,
      { pos: [2, 1.5, -1], scale: [0.6, 3, 0.6] },
      {
        component: Visibility,
        data: { state: VisibilityStateValue.hidden },
      },
    );
    return {
      toggle(on) {
        world.set(pillar, ShadowParticipation, { cast: on }).unwrap();
      },
      checks: serial(async () => {
        const checks = new CheckList();
        await frames(2);
        checks.equal(
          'hidden caster counted as explicitly hidden',
          app.renderer.inspect().visibilityStats.explicitlyHidden,
          1,
        );
        return checks.items;
      }),
    };
  },
});
