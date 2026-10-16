import { CameraView } from '@forgeax/engine/render';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnCamera, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Multi-camera CameraView composition',
  catalog: 'Multi-camera CameraView composition',
  kind: 'visual',
  summary:
    'Each Camera with a CameraView renders an independently culled view with its own depth, post and history; all views and the composition share one Renderer submission.',
  expect:
    'ON: a picture-in-picture top-down view (floor, cube and sphere seen from above) sits in the top-right corner over the main view. OFF: the PiP view is disabled and only the main view fills the screen.',
  async setup({ app, world, canvas, frames }) {
    const { camera } = spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.2, 0.5, 1, 1] }), {
      pos: [-0.8, 0.5, 0],
    });
    spawnMesh(world, MESH.sphere, standard(world, { baseColor: [1, 0.3, 0.1, 1] }), {
      pos: [0.8, 0.6, 0],
    });
    world
      .addComponent(camera, { component: CameraView, data: { viewport: [0, 0, 1, 1], order: 0 } })
      .unwrap();
    const pip = spawnCamera(world, {
      eye: [0, 6, 0.01],
      target: [0, 0, 0],
      data: { clearColor: [1, 0.85, 0.1, 1], autoAspect: true },
    });
    world
      .addComponent(pip, {
        component: CameraView,
        data: { viewport: [0.6, 0.05, 0.36, 0.36], order: 1 },
      })
      .unwrap();
    await frames(2);
    return {
      toggle(on) {
        world.set(pip, CameraView, { enabled: on } as never).unwrap();
      },
      async checks() {
        const checks = new CheckList();
        const before = app.renderer.inspect().recoveryEvidence.submissions.count;
        await frames(4);
        const facts = app.renderer.inspect();
        const views = facts.views ?? [];
        const pipWidth = 0.36 * canvas.width;
        return checks
          .equal('two views reported', views.length, 2)
          .ok(
            'each view rendered',
            views.every((view) => view.renderedFrames > 0),
            views.map((view) => view.renderedFrames).join(','),
          )
          .ok(
            'each view has its own passes',
            views.every((view) => view.passes.length > 0),
          )
          .ok(
            'PiP viewport honored (pixel rect)',
            views.some((view) => Math.abs((view.viewport[2] ?? 0) - pipWidth) <= 1),
            `canvas=${canvas.width}x${canvas.height} ${JSON.stringify(views.map((view) => view.viewport))}`,
          )
          .ok(
            'one submission per frame',
            facts.recoveryEvidence.submissions.count - before <= 5,
            `delta=${facts.recoveryEvidence.submissions.count - before} over 4 frames`,
          ).items;
      },
    };
  },
});
