// Runs one Worker-pool job under a heap limit and prints `{ ok, code, text }`. A child process
// because `--max-old-space-size` in NODE_OPTIONS overrides a Worker's resourceLimits, so the
// parent test run's flags must not reach the pool.
import { bakeMapsParallel, model } from '@forgeax/engine-modeling';
import { bakeWorkers, meshJobWorkers } from '@forgeax/engine-modeling/tools';
import { FIXTURE_JOBS } from './mesh-jobs.mjs';

const [mode, heap] = process.argv.slice(2);
const maxHeapMb = Number(heap);

async function mesh() {
  const executor = meshJobWorkers({ minFreeGb: 0, maxJobs: 1, maxHeapMb });
  const ask = (name, params) => {
    const fixture = FIXTURE_JOBS.find((job) => job.name === name);
    return executor(
      {
        module: fixture.module,
        job: name,
        key: 'lid',
        packageId: '01900000-0000-7000-8000-0000000c7001',
        params,
        identity: 'heap-child@1',
      },
      {},
    );
  };
  const result = await ask('fixture.heap', { mb: 400 });
  // The executor must still serve after its Worker died of the cap.
  const after = await ask('fixture.fail', {});
  return {
    ok: result.ok,
    code: result.ok ? undefined : result.error.code,
    text: result.ok ? '' : JSON.stringify(result.error),
    afterCode: after.ok ? undefined : after.error.code,
  };
}

async function bake() {
  const base = model();
  base.box({ size: [0.1, 0.1, 0.1], tag: 'bake:a' });
  base.uv.auto({ resolution: 64, padding: 4 });
  const detail = model();
  detail.sphere({ radius: 0.07, widthSegments: 128, heightSegments: 128, tag: 'bake:a' });
  const result = await bakeMapsParallel(
    {
      base,
      detail,
      maps: ['normal'],
      resolution: 64,
      samples: 1,
      normals: { mode: 'autoSmooth', angle: 40 },
      detailNormals: { mode: 'weighted' },
      tags: { groupPrefix: 'bake:' },
    },
    bakeWorkers({ workers: 1, maxHeapMb }),
  );
  return result.ok
    ? { ok: true }
    : { ok: false, code: result.error.code, text: JSON.stringify(result.error) };
}

if (mode === 'idle') {
  // No process.exit: an idle pool must not keep the process alive.
  const executor = meshJobWorkers({ minFreeGb: 0, maxJobs: 1 });
  const fixture = FIXTURE_JOBS.find((job) => job.name === 'fixture.fail');
  await executor(
    {
      module: fixture.module,
      job: fixture.name,
      key: 'lid',
      packageId: '01900000-0000-7000-8000-0000000c7001',
      params: {},
      identity: 'idle@1',
    },
    {},
  );
  process.stdout.write('{"ok":true}\n');
} else {
  process.stdout.write(`${JSON.stringify(await (mode === 'mesh' ? mesh() : bake()))}\n`);
  process.exit(0);
}
