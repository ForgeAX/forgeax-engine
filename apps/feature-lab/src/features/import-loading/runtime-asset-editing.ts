import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { Materials, MeshRenderer } from '@forgeax/engine/render';
import type { MaterialAsset } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { spawnCamera, spawnMesh } from '../../lab/stage';

const green = [0.15, 0.85, 0.3, 1] as const;
const blue = [0.15, 0.3, 0.95, 1] as const;

export default defineFeature({
  title: 'Runtime asset editing',
  catalog: 'Runtime asset editing',
  kind: 'visual',
  summary:
    'Two quads share one material handle; a third uses an independent copy. Updating the shared asset changes both consumers without rebinding their components.',
  expect:
    'ON: all three quads are green. OFF: the left and center turn blue; the independent right copy stays green. Checks retain a fixed snapshot and reject invalid edits without changing current content.',
  setup({ app, world }) {
    const assets = app.assets;
    if (assets === undefined) throw new Error('App asset service is unavailable');
    spawnCamera(world, { eye: [0, 1, 7], target: [0, 1, 0] });
    const mesh = assets.create(createPrimitiveMesh('quad').unwrap()).unwrap();
    const material = assets.create(Materials.unlit(green)).unwrap();
    const copy = assets.copy(material).unwrap();
    const fixed = assets.snapshot(material).unwrap();
    const left = spawnMesh(world, mesh, material, { pos: [-2, 1, 0], scale: [1.6, 1.6, 1] });
    const center = spawnMesh(world, mesh, material, { pos: [0, 1, 0], scale: [1.6, 1.6, 1] });
    spawnMesh(world, mesh, copy, { pos: [2, 1, 0], scale: [1.6, 1.6, 1] });
    const checks = new CheckList();
    const edit = (on: boolean) => {
      const color = on ? green : blue;
      assets.update(material, { values: { baseColor: color } }).unwrap();
      checks.equal(
        'shared content adopts the edit',
        assets.read(material).unwrap().values?.baseColor,
        color,
      );
      checks.equal('copy remains independent', assets.read(copy).unwrap().values?.baseColor, green);
      checks.equal(
        'snapshot retains the old version',
        fixed.read<MaterialAsset>(material).unwrap().values?.baseColor,
        green,
      );
      for (const entity of [left, center])
        checks.equal(
          'component retains the same handle',
          world.get(entity, MeshRenderer).unwrap().materials[0],
          material,
        );
    };
    try {
      edit(false);
      // @ts-expect-error An empty Pass roster exercises untyped input validation.
      checks.ok('invalid edit is rejected', !assets.update(material, { passes: [] }).ok);
      checks.equal(
        'rejected edit retains accepted content',
        assets.read(material).unwrap().values?.baseColor,
        blue,
      );
      edit(true);
    } finally {
      fixed.dispose();
    }
    // Components retain the live resources. The fixed snapshot was needed only for setup checks.
    assets.release(mesh).unwrap();
    assets.release(material).unwrap();
    assets.release(copy).unwrap();
    return {
      toggle(on) {
        assets.update(material, { values: { baseColor: on ? green : blue } }).unwrap();
      },
      checks: () => checks.items,
    };
  },
});
