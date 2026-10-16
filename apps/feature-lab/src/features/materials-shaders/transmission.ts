import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { materialToggle } from './lib/swap';
import { checker } from './lib/textures';

export default defineFeature({
  title: 'Transmission / refraction',
  catalog: 'Transmission/refraction material',
  kind: 'visual',
  summary:
    'Standard transmission / ior / thickness / attenuation sample the renderer-owned TransmissionBackdrop, refracting what is behind the object; the app never copies the backdrop.',
  expect:
    'ON: the glass sphere shows a refracted, magnified view of the checker wall behind it (the dark ellipse at its base is the floor shadow directly beneath). OFF: transmission 0, the sphere is an opaque pale-blue ball.',
  setup({ app, world }) {
    const errors: string[] = [];
    app.onError((error) => {
      errors.push(
        JSON.stringify({
          code: error.code,
          detail: (error as { detail?: unknown }).detail ?? null,
          cause: String((error as { cause?: unknown }).cause ?? ''),
        }),
      );
    });
    spawnStage(world);
    const wall = checker(world, [240, 40, 40, 255], [40, 60, 240, 255], 8);
    spawnMesh(
      world,
      MESH.cube,
      standard(world, { baseColor: [1, 1, 1, 1], baseColorTexture: wall as never, roughness: 0.9 }),
      {
        pos: [0, 1, -1.5],
        scale: [4, 2.4, 0.2],
      },
    );
    const glass = {
      baseColor: [0.85, 0.92, 1, 1] as const,
      roughness: 0.05,
      ior: 1.5,
      thickness: 1,
    };
    const on = standard(world, { ...glass, transmission: 1 });
    const off = standard(world, { ...glass, transmission: 0 });
    const sphere = spawnMesh(world, MESH.sphere, on, {
      pos: [0, 0.9, 0.6],
      scale: [1.4, 1.4, 1.4],
    });
    return {
      toggle: materialToggle(world, sphere, on, off),
      checks() {
        const checks = new CheckList();
        checks.ok(
          'no app error while refracting',
          errors.length === 0,
          errors.slice(0, 2).join(' | '),
        );
        return checks.items;
      },
    };
  },
});
