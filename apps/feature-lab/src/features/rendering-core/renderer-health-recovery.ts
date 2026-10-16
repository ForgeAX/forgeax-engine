import { MeshRenderer } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Renderer health and recovery',
  catalog: 'Renderer health and recovery',
  kind: 'probe',
  summary:
    'renderer.state() is the closed health union; recover() only acts on device-lost and returns a guard error when healthy. App-owned surface release/restore keeps the World and resumes frames.',
  expect:
    "All checks pass: state 'alive' with no recovery phase, recover() on a healthy renderer is refused with a structured code, the surface goes 'released' then 'available', and frames resume afterwards.",
  async setup({ app, world, frames }) {
    spawnStage(world);
    const cube = spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.9, 0.2, 0.6, 1] }), {
      pos: [0, 0.5, 0],
    });
    await frames(3);
    return {
      async checks() {
        const checks = new CheckList();
        const facts = app.renderer.inspect();
        checks
          .equal('state alive', app.renderer.state(), 'alive')
          .equal('no recovery phase', facts.recovery.phase, null);
        const recovered = await app.renderer.recover();
        checks.ok(
          'healthy recover() is guarded',
          !recovered.ok,
          recovered.ok ? 'accepted' : recovered.error.code,
        );
        const released = await app.releaseSurfacePreserveWorld();
        checks
          .ok(
            'surface release accepted',
            released.ok,
            released.ok ? undefined : released.error.code,
          )
          .equal('surface released', app.renderer.inspect().surface, 'released');
        const restored = await app.restoreSurface();
        checks.ok(
          'surface restore accepted',
          restored.ok,
          restored.ok ? undefined : restored.error.code,
        );
        const before = app.renderer.inspect().recoveryEvidence.submissions.count;
        await frames(3);
        const after = app.renderer.inspect();
        checks
          .equal('surface available', after.surface, 'available')
          .ok(
            'frames resumed',
            after.recoveryEvidence.submissions.count > before,
            `${before} -> ${after.recoveryEvidence.submissions.count}`,
          )
          .ok('World preserved', world.hasComponent(cube, MeshRenderer))
          .equal('state alive after restore', app.renderer.state(), 'alive');
        return checks.items;
      },
    };
  },
});
