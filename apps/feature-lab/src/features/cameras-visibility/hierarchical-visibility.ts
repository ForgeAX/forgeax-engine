import { resolveVisibility, Visibility, VisibilityStateValue } from '@forgeax/engine/render';
import { ChildOf } from '@forgeax/engine/scene';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { serial } from './support/serial';

export default defineFeature({
  title: 'Hierarchical visibility',
  catalog: 'Hierarchical visibility',
  kind: 'visual',
  summary:
    'Visibility resolves along ChildOf: hiding the parent hides inherited children, while a child set to visible overrides it.',
  expect:
    'ON: the red parent and its green inherited child disappear; only the blue child (Visibility visible) stays. OFF: all three cubes are shown.',
  setup({ app, world, frames }) {
    spawnStage(world, { eye: [0, 2, 6], target: [0, 0.8, 0] });
    const parent = spawnMesh(
      world,
      MESH.cube,
      standard(world, { baseColor: [0.9, 0.1, 0.1, 1] }),
      { pos: [0, 0.8, 0] },
      {
        component: Visibility,
        data: { state: VisibilityStateValue.hidden },
      },
    );
    const inherited = spawnMesh(
      world,
      MESH.cube,
      standard(world, { baseColor: [0.1, 0.85, 0.2, 1] }),
      { pos: [-1.6, 0, 0] },
      {
        component: ChildOf,
        data: { parent },
      },
    );
    const override = spawnMesh(
      world,
      MESH.cube,
      standard(world, { baseColor: [0.15, 0.3, 1, 1] }),
      { pos: [1.6, 0, 0] },
      { component: ChildOf, data: { parent } },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    );
    const setHidden = (hidden: boolean) =>
      world.set(parent, Visibility, {
        state: hidden ? VisibilityStateValue.hidden : VisibilityStateValue.inherited,
      } as never);
    return {
      toggle(on) {
        setHidden(on);
      },
      checks: serial(async () => {
        const checks = new CheckList();
        setHidden(true);
        await frames(3);
        const resolved = resolveVisibility(world);
        checks.equal(
          'inherited child resolves hidden from parent',
          resolved.effective(inherited),
          'hidden',
        );
        checks.equal(
          'visible child overrides hidden parent',
          resolved.effective(override),
          'visible',
        );
        const hidden = app.renderer.inspect().visibilityStats.explicitlyHidden;
        checks.equal('renderer counts parent + inherited child as hidden', hidden, 2);
        setHidden(false);
        await frames(3);
        checks.equal(
          'inherited parent hides nothing',
          app.renderer.inspect().visibilityStats.explicitlyHidden,
          0,
        );
        setHidden(true);
        await frames(2);
        return checks.items;
      }),
    };
  },
});
