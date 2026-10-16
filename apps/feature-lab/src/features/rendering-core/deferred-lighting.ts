import { DEFAULT_STANDARD_PROFILE } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const DEFERRED_PASS = /deferred|g-?buffer/i;

export default defineFeature({
  title: 'Standard Deferred lighting',
  catalog: 'Standard Deferred lighting',
  kind: 'probe',
  summary:
    "renderer.setProfile({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' }) switches the same Standard scene to a G-buffer geometry pass plus one fullscreen lighting resolve; switching back restores Forward.",
  expect:
    "All checks pass: Forward records no G-buffer pass, Deferred reports renderPath 'deferred' and records G-buffer/deferred passes, and returning to Forward removes them again (or the device reports the explicit Forward lane).",
  async setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.2, 0.8, 0.3, 1] }), {
      pos: [-0.8, 0.5, 0],
    });
    spawnMesh(
      world,
      MESH.sphere,
      standard(world, { baseColor: [0.9, 0.9, 0.9, 1], metallic: 1, roughness: 0.2 }),
      {
        pos: [0.8, 0.6, 0],
      },
    );
    await frames(3);
    return {
      async toggle(on) {
        app.renderer.setProfile({
          ...DEFAULT_STANDARD_PROFILE,
          renderPath: on ? 'deferred' : 'forward',
        });
        await frames(3);
      },
      async checks() {
        const checks = new CheckList();
        const passes = () =>
          app.renderer.inspect().perFramePassNames.filter((name) => DEFERRED_PASS.test(name));
        checks.ok('forward records no deferred pass', passes().length === 0, passes().join(','));
        const set = app.renderer.setProfile({
          ...DEFAULT_STANDARD_PROFILE,
          renderPath: 'deferred',
        });
        checks.ok('deferred profile accepted', set.ok, set.ok ? undefined : set.error.code);
        await frames(4);
        const facts = app.renderer.inspect();
        checks
          .equal('profile render path', facts.profile.renderPath, 'deferred')
          .equal('lighting render path', facts.standardLighting?.renderPath, 'deferred')
          .ok('deferred passes recorded', passes().length > 0, facts.perFramePassNames.join(','))
          .equal('renderer alive', app.renderer.state(), 'alive');
        app.renderer.setProfile({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' });
        await frames(4);
        checks.ok('forward restored', passes().length === 0, passes().join(','));
        return checks.items;
      },
    };
  },
});
