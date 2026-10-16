import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { createLabComputeFeature } from './support/compute-feature';

const IDENTITY = 'feature-lab::lkg-fault';
const lab = createLabComputeFeature(IDENTITY);

export default defineFeature({
  title: 'RenderGraph last-known-good',
  catalog: 'RenderGraph last-known-good',
  kind: 'probe',
  expectsAppError: true,
  appOptions: { features: [lab.feature] },
  summary:
    'A feature starts declaring a pass bound to a missing program. The Renderer isolates the rejected plan, keeps its executable graph, and keeps submitting frames; clearing the fault re-admits the feature.',
  expect:
    "All checks pass: during the fault the feature is 'failed' with a structured error while frames keep submitting and the graph stays ready; after repair it returns to 'active'.",
  async setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.sphere, standard(world, { baseColor: [1, 0.4, 0.1, 1] }), {
      pos: [0, 0.6, 0],
    });
    await frames(3);
    return {
      async checks() {
        const checks = new CheckList();
        const status = () =>
          app.renderer.inspect().featureDiagnostics.find((entry) => entry.identity === IDENTITY);
        checks.equal('healthy before fault', status()?.status, 'active');
        const submissionsBefore = app.renderer.inspect().recoveryEvidence.submissions.count;
        const events: string[] = [];
        const lastBefore = app.lastError?.code;
        let phase = 'fault';
        const stop = app.onError((error) => {
          events.push(`${phase}:${error.code}`);
        });
        lab.state.fault = true;
        await frames(4);
        const faulted = status();
        const facts = app.renderer.inspect();
        checks
          .equal('faulted feature status', faulted?.status, 'failed')
          .ok(
            'structured error recorded',
            faulted?.latestError !== undefined,
            JSON.stringify(faulted?.latestError),
          )
          .ok(
            'frames kept submitting',
            facts.recoveryEvidence.submissions.count - submissionsBefore >= 3,
            `delta=${facts.recoveryEvidence.submissions.count - submissionsBefore}`,
          )
          .ok(
            'executable graph retained',
            facts.recoveryEvidence.graph.ready,
            JSON.stringify(facts.recoveryEvidence.graph),
          )
          .equal('renderer still alive', app.renderer.state(), 'alive');
        phase = 'repair';
        lab.state.fault = false;
        await frames(4);
        stop();
        checks
          .equal('repaired feature re-admitted', status()?.status, 'active')
          .ok(
            'fault surfaced through app.onError',
            events.some((entry) => entry.startsWith('fault:')) ||
              JSON.stringify(
                app.lastError === undefined ? null : Object.entries(app.lastError),
              ).includes(IDENTITY),
            `events=${events.join(',')} lastError=${app.lastError?.code} beforeFault=${lastBefore}`,
          );
        return checks.items;
      },
    };
  },
});
