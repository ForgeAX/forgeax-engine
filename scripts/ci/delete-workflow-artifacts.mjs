import { spawn } from 'node:child_process';
import {
  coverageMembers,
  metricArtifactName,
  metricProducers,
} from './ci-repair-qualification.mjs';

const repository = process.env.GITHUB_REPOSITORY;

function parseArgs(argv) {
  const options = {
    runId: process.env.GITHUB_RUN_ID,
    preserveNames: new Set(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run-id') {
      options.runId = argv[++index];
    } else if (arg === '--preserve-name') {
      const name = argv[++index];
      if (typeof name !== 'string' || name === '') throw new Error('--preserve-name needs a value');
      options.preserveNames.add(name);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const runId = options.runId;

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
  throw new Error('GITHUB_REPOSITORY must be an owner/name pair');
}
if (!/^\d+$/.test(runId ?? '')) {
  throw new Error('GITHUB_RUN_ID must be numeric');
}

function runGh(args) {
  return new Promise((resolve) => {
    const child = spawn('gh', args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', () => resolve({ code: 1, stdout: '' }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

function cleanupSourceAdmitted(source) {
  if (source.status === 'completed' && source.conclusion === 'success') return true;
  // This in-run job is gated on every consumer result; the completion backstop
  // instead reads a completed source run from the API above.
  return (
    source.status === 'in_progress' &&
    source.conclusion === null &&
    process.env.GITHUB_JOB === 'cleanup-transient-artifacts' &&
    runId === process.env.GITHUB_RUN_ID
  );
}

async function repairPreservation() {
  const result = await runGh([
    'api',
    `repos/${repository}/actions/runs/${runId}`,
    '--jq',
    '{path,status,conclusion,run_attempt}',
  ]);
  let source;
  try {
    if (result.code !== 0) throw new Error('source unavailable');
    source = JSON.parse(result.stdout);
    if (!cleanupSourceAdmitted(source)) throw new Error('source has not completed successfully');
  } catch {
    console.log(
      '::warning::source identity unavailable or unsuccessful; retaining producer expiry',
    );
    return undefined;
  }
  const names = new Set();
  if (source.path?.split('@')[0] !== '.github/workflows/ci.yml') return names;
  if (
    !Number.isSafeInteger(source.run_attempt) ||
    source.run_attempt <= 0 ||
    source.run_attempt > 1000
  ) {
    console.log('::warning::source attempt unavailable; retaining producer expiry');
    return undefined;
  }
  for (const member of coverageMembers)
    names.add(member.replace('coverage-pnpm-shard-', 'coverage-shard-'));
  for (let attempt = 1; attempt <= source.run_attempt; attempt += 1) {
    // A failed-only retry can copy successful producers from an earlier attempt.
    names.add(`core-build-a${attempt}`);
    names.add(`shared-app-inputs-a${attempt}`);
    for (const producer of metricProducers)
      names.add(metricArtifactName(producer, { run_attempt: attempt }));
  }
  return names;
}

const repairNames = await repairPreservation();
if (repairNames === undefined) process.exit(0);

const listed = await runGh([
  'api',
  '--paginate',
  `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
  '--jq',
  '.artifacts[] | [.id, .name] | @tsv',
]);

if (listed.code !== 0) {
  console.log('::warning::could not list transient artifacts for this run');
  process.exit(0);
}

let deleted = 0;
let preserved = 0;
let failed = 0;
const rows = listed.stdout.split(/\r?\n/).filter(Boolean);
let nextRow = 0;
await Promise.all(
  Array.from({ length: Math.min(4, rows.length) }, async () => {
    while (nextRow < rows.length) {
      const row = rows[nextRow++];
      const separator = row.indexOf('\t');
      const artifactId = separator === -1 ? row : row.slice(0, separator);
      const artifactName = separator === -1 ? '' : row.slice(separator + 1);
      // Failure captures must survive a later successful same-head retry;
      // their producer's bounded retention remains the storage limit.
      if (
        options.preserveNames.has(artifactName) ||
        repairNames.has(artifactName) ||
        artifactName.split('-').includes('failure') ||
        artifactName.startsWith('coverage-diagnostics')
      ) {
        preserved += 1;
        continue;
      }
      const result = await runGh([
        'api',
        '--method',
        'DELETE',
        `repos/${repository}/actions/artifacts/${artifactId}`,
      ]);
      if (result.code === 0) deleted += 1;
      else failed += 1;
    }
  }),
);

console.log(
  `transient artifacts deleted: ${deleted}; preserved: ${preserved}; failed deletions: ${failed}`,
);
if (failed !== 0) {
  console.log('::warning::some transient artifacts could not be deleted; inspect the job log');
}
