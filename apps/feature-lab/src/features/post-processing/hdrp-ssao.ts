import { DEFAULT_STANDARD_PROFILE, Skylight } from '@forgeax/engine/render';
import { CheckList, defineFeature, type FeatureDefinition } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

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
  title: 'HDRP SSAO',
  catalog: 'HDRP SSAO',
  kind: 'probe',
  summary:
    'The half-resolution AO raw + blur passes exist only on the deferred (HDRP-style) configuration. The probe switches the live profile between deferred+AO, deferred without AO and forward+AO.',
  expect:
    'All checks pass: deferred+AO schedules the raw and blur AO passes, disabling AO removes them, and requesting AO on the forward path is refused with a structured error.',
  appOptions: {
    standardProfile: { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred', ssao: AO },
  },
  setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.8, 0.8, 0.8, 1] }), {
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
          'forward + AO is refused with a structured error',
          !forward.ok && typeof forward.error.code === 'string',
          forward.ok ? 'accepted' : `${forward.error.code}: ${forward.error.hint}`,
        );
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
