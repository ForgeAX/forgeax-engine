import type { RenderFeature } from '@forgeax/engine/render';
import { ok } from '@forgeax/engine/types';
import { CheckList, defineFeature } from '../../lab/feature';
import { MESH, spawnMesh, spawnStage, standard } from '../../lab/stage';

const trace = {
  extracts: 0,
  plans: 0,
  submitted: 0,
  aborted: 0,
  lastFrame: -1,
  views: 0,
  worlds: 0,
  order: [] as string[],
};

function probeFeature(identity: string): RenderFeature<number> {
  return {
    identity,
    extract(context) {
      if (identity === 'fl-passthrough-a') {
        trace.extracts += 1;
        trace.lastFrame = context.frameNumber;
        trace.views = context.views.length;
        trace.worlds = context.worlds.length;
      }
      if (trace.order.length < 4) trace.order.push(identity);
      return ok(context.frameNumber);
    },
    plan() {
      if (identity === 'fl-passthrough-a') trace.plans += 1;
      return ok({ work: [] });
    },
    onFrameSubmitted() {
      if (identity === 'fl-passthrough-a') trace.submitted += 1;
    },
    onFrameAborted() {
      if (identity === 'fl-passthrough-a') trace.aborted += 1;
    },
  };
}

const features = [probeFeature('fl-passthrough-a'), probeFeature('fl-passthrough-b')];

export default defineFeature({
  title: 'Renderer feature passthrough',
  catalog: 'Renderer feature passthrough',
  kind: 'probe',
  appOptions: { features },
  summary:
    'CreateAppOptions.features is forwarded by reference and order to the Renderer; each RenderFeature receives extract -> plan -> one terminal callback per frame (onFrameSubmitted for admitted work, onFrameAborted for an empty plan).',
  expect:
    'All checks pass: both features are called every frame in declared order, with the App World and at least one view.',
  setup({ app, world, frames }) {
    spawnStage(world);
    spawnMesh(world, MESH.cube, standard(world, { baseColor: [0.1, 0.8, 0.8, 1] }), {
      pos: [0, 0.5, 0],
    });
    return {
      async checks() {
        const c = new CheckList();
        const e0 = trace.extracts;
        const p0 = trace.plans;
        const s0 = trace.submitted;
        const a0 = trace.aborted;
        await frames(8);
        await frames(1);
        const de = trace.extracts - e0;
        c.ok('extract called per frame', de >= 8, `extracts=${de}`);
        c.equal('plan called once per extract', trace.plans - p0, de);
        const ds = trace.submitted - s0;
        const da = trace.aborted - a0;
        c.equal('empty plan admits no work, so onFrameSubmitted never runs', ds, 0);
        c.ok(
          'one terminal callback (onFrameAborted) per planned frame',
          da >= 7 && da <= trace.plans - p0,
          `aborted=${da} plans=${trace.plans - p0}`,
        );
        c.equal('declared order kept', trace.order.slice(0, 2), [
          'fl-passthrough-a',
          'fl-passthrough-b',
        ]);
        c.ok('extract sees at least one view', trace.views >= 1, `views=${trace.views}`);
        c.equal('extract sees the single App World', trace.worlds, 1);
        c.ok('frameNumber advances', trace.lastFrame > 0, `frame=${trace.lastFrame}`);
        c.equal('no dispatch error', app.lastError?.code ?? null, null);
        return c.items;
      },
    };
  },
});
