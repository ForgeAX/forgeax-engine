import { AssetRegistry } from '@forgeax/engine/assets-runtime';
import { createPrimitiveMesh } from '@forgeax/engine/geometry';
import { DEFAULT_STANDARD_PROFILE, Skylight } from '@forgeax/engine/render';
import { CheckList, defineFeature, type FeatureDefinition } from '../../lab/feature';
import { spawnMesh, spawnStage, standard } from '../../lab/stage';

const AO = {
  algorithm: 'ssao',
  quality: 'medium',
  radius: 0.5,
  bias: 0.025,
  intensity: 1,
} as const;

function aoPasses(names: readonly string[]): string[] {
  return names.filter((name) => name.includes('ssao'));
}

export default defineFeature<FeatureDefinition>({
  title: 'AO forward/deferred path probe',
  catalog: 'AO forward/deferred path probe',
  kind: 'probe',
  summary:
    'The probe switches live AO through deferred and forward Standard profiles, then disables and restores it to verify each route owns the expected raw + blur work.',
  expect:
    'All checks pass: deferred and forward AO schedule the raw and blur passes, disabling AO removes them, and restoring the deferred profile restores its AO work.',
  appOptions: {
    standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred', ssao: AO },
  },
  setup({ app, world, frames }) {
    const primitiveAssets = world.assets;
    if (!(primitiveAssets instanceof AssetRegistry))
      throw new Error('Scene requires its runtime asset owner');

    const stageCube = primitiveAssets.create(createPrimitiveMesh('cube').unwrap()).unwrap();

    spawnStage(world);
    spawnMesh(world, stageCube, standard(world, { baseColor: [0.8, 0.8, 0.8, 1] }), {
      pos: [0, 0.5, 0],
    });
    world
      .spawn({ component: Skylight, data: { color: [1, 1, 1], intensity: 1 } as never })
      .unwrap();
    return {
      async checks() {
        const checks = new CheckList();
        const renderer = app.renderer;
        const base = renderer.inspect().profile;
        const enabled = aoPasses(renderer.inspect().perFramePassNames);
        checks.ok(
          'deferred + AO schedules at least two AO passes (raw + blur)',
          enabled.length >= 2,
          enabled.join(','),
        );
        const off = renderer.setProfile({ ...base, ssao: false });
        checks.ok('disable AO accepted', off.ok, off.ok ? undefined : off.error.code);
        await frames(3);
        const disabled = aoPasses(renderer.inspect().perFramePassNames);
        checks.equal('AO disabled removes every AO pass', disabled, []);
        const forward = renderer.setProfile({ ...base, renderPath: 'forward', ssao: AO });
        checks.ok(
          'forward + AO accepted',
          forward.ok,
          forward.ok ? undefined : `${forward.error.code}: ${forward.error.hint}`,
        );
        if (forward.ok) {
          await frames(3);
          const forwardPasses = aoPasses(renderer.inspect().perFramePassNames);
          checks.ok(
            'forward + AO schedules at least two AO passes (raw + blur)',
            forwardPasses.length >= 2,
            forwardPasses.join(','),
          );
        }
        const restore = renderer.setProfile(base);
        checks.ok(
          'restore deferred + AO accepted',
          restore.ok,
          restore.ok ? undefined : restore.error.code,
        );
        await frames(3);
        checks.ok(
          'AO passes return after restore',
          aoPasses(renderer.inspect().perFramePassNames).length >= 2,
        );
        return checks.items;
      },
    };
  },
});
