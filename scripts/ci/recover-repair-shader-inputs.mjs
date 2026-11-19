import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reusableSharedShader, sharedShaderReceipt } from '../lib/shared-build-cache.mjs';
import {
  repairComparison,
  repairDeclaration,
  repairSourceBelongsToPr,
  requestGitHub,
  runJobs,
} from './ci-repair-qualification.mjs';
import { producerArtifact } from './core-shader-artifact.mjs';
import { coreBaseShaderDirectory } from './restore-core-shader-inputs.mjs';
import { runBrowserCommand } from './run-browser-gate-with-retry.mjs';

const ciPath = '.github/workflows/ci.yml';
const eligibleRun = (run) => run.path?.split('@')[0] === ciPath && run.status === 'completed';

export async function findRepairShaderSource({ pr, repository }, api) {
  const baseline = repairDeclaration(pr?.body, repository);
  if (!baseline || pr.head.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) return null;
  const anchor = await api(`repos/${repository}/actions/runs/${baseline}`);
  if (!eligibleRun(anchor) || !(await repairSourceBelongsToPr(api, anchor, pr, repository)))
    return null;
  const history = await api(
    `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&branch=${encodeURIComponent(pr.head.ref)}&per_page=12`,
  );
  const earlier = (history.workflow_runs ?? [])
    .filter((run) => run.run_number < anchor.run_number && eligibleRun(run))
    .sort((left, right) => right.run_number - left.run_number);
  for (const run of [anchor, ...earlier]) {
    if (!(await repairSourceBelongsToPr(api, run, pr, repository))) continue;
    const jobs = await runJobs(api, repository, run);
    const producers = jobs?.filter((job) => job.name === 'ci-core') ?? [];
    const producer = producers.length === 1 ? producers[0] : undefined;
    if (
      !producer ||
      producer.run_id !== run.id ||
      producer.status !== 'completed' ||
      producer.conclusion !== 'success'
    )
      continue;
    const sha = run.head_sha;
    if (!/^[a-f0-9]{40}$/.test(sha ?? '') || sha === pr.head.sha) continue;
    const comparison = await api(`repos/${repository}/compare/${sha}...${pr.head.sha}`);
    if (!repairComparison(comparison)) continue;
    try {
      const { artifact } = await producerArtifact({ repository, sha }, api, run, producer, 'point');
      return { artifactId: artifact.id, runId: run.id, sha };
    } catch (error) {
      console.log(`[shader-recovery] skipping run ${run.id}: ${error.message}`);
    }
  }
  return null;
}

function moveVerifiedPayload(source, target) {
  try {
    renameSync(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    copyFileSync(source, target);
    rmSync(source);
  }
}

export function restoreRepairShaderProfile(root, extracted, source, target, fingerprint) {
  if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint ?? '')) return false;
  const targetManifest = join(root, target, 'manifest.json');
  if (reusableSharedShader(root, targetManifest, fingerprint)) return false;
  const verified = reusableSharedShader(
    extracted,
    join(extracted, source, 'manifest.json'),
    fingerprint,
  );
  if (verified === null) return false;
  const payload = join(root, target, 'shaders', 'manifest.json');
  mkdirSync(dirname(payload), { recursive: true });
  moveVerifiedPayload(verified, payload);
  writeFileSync(
    targetManifest,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        producer: 'shared-app-inputs',
        shaderBuild: sharedShaderReceipt(root, payload, fingerprint),
        payload: { engineShaderManifest: relative(root, payload).replaceAll('\\\\', '/') },
      },
      null,
      2,
    )}\n`,
  );
  return reusableSharedShader(root, targetManifest, fingerprint) !== null;
}

async function recoverShaderArchive(staging) {
  const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY;
  const source = await findRepairShaderSource({ pr, repository }, (endpoint) =>
    requestGitHub(endpoint, process.env.GH_TOKEN),
  );
  if (!source) return;
  execFileSync(
    process.execPath,
    [
      'scripts/ci/download-artifact-with-retry.mjs',
      '--artifact-ids',
      String(source.artifactId),
      '--path',
      staging,
    ],
    { stdio: 'inherit', env: { ...process.env, FORGEAX_ARTIFACT_EXPECTED_SHA: source.sha } },
  );
  execFileSync(
    process.execPath,
    [
      'scripts/ci/unpack-shared-app-inputs.mjs',
      '--root',
      staging,
      '--archive',
      'shared-app-inputs.tar.gz',
      '--destination',
      'shared-app-inputs',
    ],
    { stdio: 'inherit' },
  );
  for (const [label, original, destination, input] of [
    [
      'base-ssao',
      'shared-app-inputs/profiles/base-ssao',
      coreBaseShaderDirectory,
      process.env.BASE_SHADER_FINGERPRINT,
    ],
    [
      'point-ssao',
      'shared-app-inputs',
      'shared-build-inputs',
      process.env.POINT_SHADER_FINGERPRINT,
    ],
  ]) {
    if (restoreRepairShaderProfile(process.cwd(), staging, original, destination, input)) {
      console.log(
        `[shader-recovery] verified ${label} from run ${source.runId} artifact ${source.artifactId}`,
      );
    }
  }
}

async function main() {
  if (
    process.env.GITHUB_EVENT_NAME !== 'pull_request' ||
    process.env.FORGEAX_BUILD_NO_TASK_CACHE === '1'
  )
    return;
  const staging = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'forgeax-shader-recovery-'),
  );
  try {
    const result = await runBrowserCommand(
      [process.execPath, fileURLToPath(import.meta.url), '--read-archive', staging],
      { label: 'CI shader archive recovery', timeoutMs: 75_000, gpuLease: false },
    );
    if (result.status !== 0)
      console.log('[shader-recovery] archive unavailable; Core will verify or build both profiles');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--read-archive') await recoverShaderArchive(process.argv[3]);
  else await main();
}
