import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { Materials } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnMesh, spawnStage } from '../../lab/stage';

export default defineFeature({
  title: 'AssetRegistry',
  catalog: 'AssetRegistry',
  kind: 'probe',
  summary:
    'App.assets owns runtime asset identities. create returns the reference used by ECS, read returns a detached snapshot, and update atomically publishes validated changes to the same reference.',
  expect:
    'A green quad renders. ON/OFF changes its shared material between green and blue without replacing the component. Checks reject invalid material creation and updates, and verify detached reads cannot alter the live asset.',
  setup({ app, world }) {
    const assets = app.assets;
    if (assets === undefined) throw new Error('App asset service is unavailable');
    spawnStage(world);
    const quad = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
    const material = assets.create(Materials.unlit([0.2, 0.85, 0.3, 1])).unwrap();
    spawnMesh(world, quad, material, { pos: [0, 1, 0], scale: [2, 2, 2] });
    const checks = new CheckList();
    const snapshot = assets.read(material).unwrap();
    Object.assign(snapshot.values ?? {}, { baseColor: [1, 0, 0, 1] });
    checks.equal(
      'detached read cannot mutate live values',
      assets.read(material).unwrap().values?.baseColor,
      [0.2, 0.85, 0.3, 1],
    );
    checks.ok(
      'empty-pass creation is rejected',
      // @ts-expect-error Empty pass arrays exercise the untyped caller validation.
      !assets.create({ ...Materials.unlit([1, 1, 1, 1]), passes: [] }).ok,
    );
    // @ts-expect-error Empty pass arrays exercise the untyped caller validation.
    checks.ok('empty-pass update is rejected', !assets.update(material, { passes: [] }).ok);
    checks.equal(
      'rejected update retains the current material',
      assets.read(material).unwrap().passes?.length,
      1,
    );
    return {
      toggle(on) {
        assets
          .update(material, {
            values: { baseColor: on ? [0.2, 0.85, 0.3, 1] : [0.2, 0.3, 0.85, 1] },
          })
          .unwrap();
      },
      checks: () => checks.items,
    };
  },
});
