import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

export default defineFeature({
  title: 'Renderer extract/prepare/record',
  catalog: 'Renderer extract/prepare/record',
  kind: 'probe',
  summary:
    'Each frame the Renderer extracts ECS facts into its persistent scene, prepares GPU resources, records one graph, and submits once, emitting a frame-submitted receipt.',
  expect:
    'All checks pass: submissions and receipts advance one per frame, the compiled graph is ready with passes, the render scene holds the spawned renderables, and each frame-submitted event carries a receipt.',
  async setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.2, 0.6, 1, 1] }), {
      pos: [-0.8, 0.5, 0],
    });
    spawnMesh(world, MESH.sphere, standard(world, { baseColor: [1, 0.5, 0.1, 1] }), {
      pos: [0.8, 0.5, 0],
    });
    await frames(3);
    return {
      async checks() {
        const checks = new CheckList();
        const before = app.renderer.inspect().recoveryEvidence;
        const events: number[] = [];
        const stop = app.renderer.subscribe((event) => {
          if (event.kind === 'frame-submitted' && event.receipt.frameId === event.frameId)
            events.push(event.frameId);
        });
        await frames(4);
        stop();
        const facts = app.renderer.inspect();
        const after = facts.recoveryEvidence;
        checks
          .ok(
            'submissions advanced',
            after.submissions.count - before.submissions.count >= 4,
            JSON.stringify(after.submissions),
          )
          .ok(
            'receipts advanced',
            after.receipts.count - before.receipts.count >= 4,
            JSON.stringify(after.receipts),
          )
          .ok(
            'frame-submitted events carry their receipt',
            events.length >= 4,
            `events=${events.join(',')}`,
          )
          .ok(
            'frame ids increase',
            events.every((id, i) => i === 0 || id > (events[i - 1] ?? 0)),
          )
          .ok(
            'graph ready',
            after.graph.ready && after.graph.passCount > 0,
            JSON.stringify(after.graph),
          )
          .ok(
            'recorded passes listed',
            facts.perFramePassNames.length > 0,
            facts.perFramePassNames.join(','),
          )
          .ok(
            'render scene holds the renderables',
            facts.renderScene.projectionRecords >= 2,
            `projectionRecords=${facts.renderScene.projectionRecords}`,
          )
          .equal('renderer alive', app.renderer.state(), 'alive');
        return checks.items;
      },
    };
  },
});
