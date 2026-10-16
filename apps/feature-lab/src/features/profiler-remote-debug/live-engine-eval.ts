import type { FeatureCheck } from '../../lab/feature';
import { defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { evalInApp } from './_shared/eval';

export default defineFeature({
  title: 'Live Engine eval',
  catalog: 'Live Engine eval',
  kind: 'visual',
  summary:
    'eval(script) runs against the live World/Renderer/Assets; here a script rewrites a cube Transform in place.',
  expect:
    'ON: eval grows the magenta cube to fill the centre. OFF: eval shrinks it to a small cube on the floor.',
  async setup({ app, world }) {
    spawnStage(world, { eye: [0, 1.6, 5], target: [0, 0.8, 0] });
    const cube = spawnMesh(
      world,
      MESH.cube,
      standard(world, { baseColor: [1, 0.1, 0.9, 1], roughness: 0.5 }),
      { pos: [0, 0.2, 0], scale: [0.4, 0.4, 0.4] },
    );
    const results: FeatureCheck[] = [];
    const place = async (on: boolean): Promise<void> => {
      const pos = on ? '[0, 1, 0]' : '[0, 0.2, 0]';
      const scale = on ? '[2, 2, 2]' : '[0.4, 0.4, 0.4]';
      const result = await evalInApp(
        app,
        `const { Transform } = await _import('@forgeax/engine/scene');
         const set = world.set(${Number(cube)}, Transform, { pos: ${pos}, scale: ${scale} });
         return set.ok;`,
      );
      results.push({
        name: `eval ${on ? 'grow' : 'shrink'} returned ok`,
        ok: result.ok && result.value === true,
        detail: result.ok ? String(result.value) : result.error.code,
      });
    };
    await place(true);
    return {
      toggle: place,
      async checks() {
        const expression = await evalInApp(app, 'renderer.inspect().renderScene !== undefined;');
        return [
          ...results,
          {
            name: 'lone expression is auto-returned',
            ok: expression.ok && expression.value === true,
          },
        ];
      },
    };
  },
});
