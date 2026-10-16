import { Instances } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

function grid(side: number): Float32Array {
  const transforms = new Float32Array(side * side * 16);
  for (let i = 0; i < side * side; i++) {
    const at = i * 16;
    transforms[at] = transforms[at + 5] = transforms[at + 10] = 0.6;
    transforms[at + 15] = 1;
    transforms[at + 12] = ((i % side) - (side - 1) / 2) * 1.1;
    transforms[at + 14] = (Math.floor(i / side) - (side - 1) / 2) * 1.1;
  }
  return transforms;
}

export default defineFeature({
  title: 'GPU Instancing',
  catalog: 'GPU Instancing',
  kind: 'visual',
  summary:
    'Instances packs column-major instance-local mat4s (16 floats each) on one renderable; the renderer draws them as one instanced batch.',
  expect:
    'ON: a 5x5 grid of 25 orange cubes from one entity. OFF: the same entity holds a single instance, so only the center cube remains.',
  setup({ world }) {
    spawnStage(world, { eye: [0, 5, 7], target: [0, 0, 0] });
    const entity = spawnMesh(
      world,
      MESH.cube,
      standard(world, { baseColor: [1, 0.45, 0.1, 1] }),
      { pos: [0, 0.3, 0] },
      {
        component: Instances,
        data: { transforms: grid(5) },
      },
    );
    return {
      toggle(on) {
        world.set(entity, Instances, { transforms: grid(on ? 5 : 1) } as never);
      },
      checks() {
        const checks = new CheckList();
        const data = world.get(entity, Instances);
        checks.ok('Instances readable', data.ok);
        if (data.ok)
          checks.equal('25 packed instance matrices', data.value.transforms.length / 16, 25);
        return checks.items;
      },
    };
  },
});
