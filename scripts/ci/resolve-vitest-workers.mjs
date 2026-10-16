import { coverageVitestWorkers, runnerResources } from '../lib/runner-resources.mjs';

const resources = runnerResources();
const explicit = process.env.FORGEAX_VITEST_MAX_WORKERS;
const workers = explicit === undefined ? coverageVitestWorkers(resources) : Number(explicit);

if (!Number.isInteger(workers) || workers < 1 || workers > 6) {
  throw new Error(`FORGEAX_VITEST_MAX_WORKERS must be an integer from 1 to 6, got ${explicit}`);
}

process.stderr.write(
  `[vitest] maxWorkers=${workers} (${resources.cpus} cpu, ${Math.ceil(resources.memoryBytes / 1024 ** 3)}GB, ${resources.containerized ? 'cgroup' : 'host'})\n`,
);
process.stdout.write(`${workers}\n`);
