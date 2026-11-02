// Assets jobs for the mesh-job Worker tests: plain JavaScript, so any Node imports them.
import { appendFileSync } from 'node:fs';
import { model } from '@forgeax/engine-modeling';
import { err, ok } from '@forgeax/engine-types';

const module = import.meta.url;

function lid(depth) {
  const m = model();
  m.box({ size: [0.2, depth, 0.2] });
  m.uv.project({ mode: 'box', scale: 1 });
  return m.finish({ key: 'lid' });
}

/** Synchronous kernel-like work: blocks its thread for `ms`. */
function block(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const FIXTURE_JOBS = [
  {
    kind: 'assets',
    name: 'fixture.lid',
    module,
    build: (p, { cache }) => {
      // Compute-cache traffic: a hit or a miss must never change the outputs.
      const key = `fixture.lid:${p.depth}`;
      if (cache?.get(key) === undefined) cache?.put(key, new Uint8Array([1, 2, 3]));
      return lid(p.depth);
    },
  },
  {
    kind: 'assets',
    name: 'fixture.block',
    module,
    build: (p) => {
      const start = Date.now();
      block(p.ms);
      appendFileSync(p.log, `${JSON.stringify({ tag: p.tag, start, end: Date.now() })}\n`);
      return lid(0.04);
    },
  },
  {
    kind: 'assets',
    name: 'fixture.probe',
    module,
    // Reports whether its cache read was answered: `mesh/hit` or `mesh/miss`.
    build: (_p, { cache }) => {
      const answered = cache?.get('probe') !== undefined;
      const built = lid(0.04);
      if (!built.ok) return built;
      return ok({ [answered ? 'mesh/hit' : 'mesh/miss']: built.value['mesh/lid'] });
    },
  },
  {
    kind: 'assets',
    name: 'fixture.fail',
    module,
    build: () =>
      err({
        code: 'fixture-failed',
        expected: 'the fixture job succeeds',
        detail: { stage: 'build' },
      }),
  },
];
