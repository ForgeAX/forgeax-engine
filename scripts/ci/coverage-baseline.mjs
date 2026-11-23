import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { changedCiInputs, comparedCiInputs, internalSourceOwners } from './ci-input-changes.mjs';
import {
  inheritedSource,
  repairSourceBelongsToPr,
  requestGitHub,
  runArtifacts,
  runJobs,
} from './ci-repair-qualification.mjs';
import { downloadArtifact } from './download-artifact-with-retry.mjs';
import { postMergeQualification } from './post-merge-qualification.mjs';

const snapshot = 'group-baseline.json';
const receiptVersion = 1;
const snapshotBudget = 32 * 1024 * 1024;
const coverageShards = [0, 1, 2, 3];
const projectionName = 'Vitest coverage (v8) (bounded runtime children)';

function groupKey(group) {
  return createHash('sha256')
    .update(JSON.stringify([group.label, group.projects, group.files, group.excludes]))
    .digest('hex');
}

function rel(root, file) {
  return relative(root, file).replaceAll('\\', '/');
}

function relativePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !/^[A-Za-z]:/.test(path) &&
    !path.split('/').some((part) => part === '..' || part === '')
  );
}

export function coveragePackageGraph(root) {
  const packages = new Map();
  for (const dir of readdirSync(join(root, 'packages'))) {
    const path = join(root, 'packages', dir, 'package.json');
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    packages.set(manifest.name, { dir, manifest });
  }
  return packages;
}

export function reusableCoverageGroup(group, packages, affected) {
  if (
    group.sourceCompilation ||
    group.gpuLease ||
    group.files.some((file) => /(?:\.e2e|\.browser)\.test\./.test(file)) ||
    [...affected].some((dir) => ![...packages.values()].some((owner) => owner.dir === dir))
  )
    return false;
  const visited = new Set();
  function stable(name) {
    if (visited.has(name)) return true;
    visited.add(name);
    const owner = packages.get(name);
    if (!owner || affected.has(owner.dir)) return false;
    const { manifest } = owner;
    return Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    }).every(([dep, range]) =>
      packages.has(dep) || range.startsWith('workspace:') ? stable(dep) : true,
    );
  }
  return group.projects.every(stable);
}

export function writeCoverageBaseline(root, destination, source, groups, results) {
  const packages = coveragePackageGraph(root);
  const receipts = {};
  let used = 0;
  // Prefer the largest reusable jobs and bound the extra transfer.
  const indexes = groups
    .map((_, index) => index)
    .sort((a, b) => groups[b].weight - groups[a].weight);
  for (const index of indexes) {
    const group = groups[index];
    if (!reusableCoverageGroup(group, packages, new Set())) continue;
    const { report, coveragePath, inherited } = results[index];
    if (statSync(coveragePath).size > snapshotBudget - used) continue;
    const tests = report.testResults.map((result) => ({ ...result, name: rel(root, result.name) }));
    const entries = Object.entries(JSON.parse(readFileSync(coveragePath, 'utf8')));
    if (
      !tests.length ||
      !entries.length ||
      tests.some(({ name }) => !relativePath(name)) ||
      entries.some(([path]) => !relativePath(rel(root, path)))
    )
      continue;
    const coverage = Object.fromEntries(
      entries.map(([file, entry]) => {
        const path = rel(root, file);
        return [path, { ...entry, path }];
      }),
    );
    const receipt = {
      report: { ...report, testResults: tests },
      coverage,
      ...(inherited ? { origin: inherited } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(receipt));
    if (used + bytes > snapshotBudget) continue;
    receipts[groupKey(group)] = receipt;
    used += bytes;
  }
  writeFileSync(
    join(destination, snapshot),
    JSON.stringify({
      version: receiptVersion,
      source,
      node: process.version,
      platform: process.platform,
      receipts,
    }),
  );
}

export function baselineGroupResult(root, group, baseline, changed, isGreen) {
  const entry = baseline.receipts[groupKey(group)];
  if (!entry || !isGreen(entry.report) || !Array.isArray(entry.report.testResults))
    return undefined;
  const files = Object.keys(entry.coverage ?? {});
  const tests = entry.report.testResults.map(({ name }) => name);
  if (
    !files.length ||
    !tests.length ||
    [...files, ...tests].some((path) => !relativePath(path) || changed.has(path)) ||
    files.some((path) => entry.coverage[path]?.path !== path) ||
    (entry.origin !== undefined && !validCoverageOrigin(entry.origin))
  )
    return undefined;
  const coverage = Object.fromEntries(
    files.map((relative) => {
      const path = resolve(root, relative);
      return [path, { ...entry.coverage[relative], path }];
    }),
  );
  const tempDir = mkdtempSync(join(tmpdir(), 'forgeax-coverage-baseline-group-'));
  const coveragePath = join(tempDir, 'coverage-final.json');
  writeFileSync(coveragePath, JSON.stringify(coverage));
  const report = {
    ...entry.report,
    testResults: entry.report.testResults.map((row) => ({ ...row, name: resolve(root, row.name) })),
  };
  return { tempDir, coveragePath, report, origin: entry.origin };
}

function validCoverageOrigin(origin) {
  return (
    /^[0-9a-f]{40}$/.test(origin?.source ?? '') &&
    [origin.run, origin.job, origin.artifact].every((id) => Number.isSafeInteger(id) && id > 0)
  );
}

export async function findCoverageProducer(api, repository, base, shard) {
  const prefix = `repos/${repository}`;
  const workflow = `${prefix}/actions/workflows/ci.yml/runs`;
  const response = await api(
    `${workflow}?branch=main&event=push&head_sha=${base}&status=success&per_page=5`,
  );
  const run = response.workflow_runs?.find(
    (candidate) =>
      candidate.head_sha === base &&
      candidate.head_branch === 'main' &&
      candidate.event === 'push' &&
      candidate.status === 'completed' &&
      candidate.conclusion === 'success' &&
      candidate.path === '.github/workflows/ci.yml',
  );
  // On ordinary merges Main inherits the identical PR tree. That PR may
  // provide an original, completed shard where the push intentionally has none.
  if (run) {
    const producer = await coverageProducerJob(api, repository, run, shard);
    if (producer) return producer;
  }
  return mergedCoverageProducer(api, repository, base, shard, workflow);
}

async function mergedCoverageProducer(api, repository, base, shard, workflow) {
  const prefix = `repos/${repository}`;
  const associated = await api(`${prefix}/commits/${base}/pulls`);
  const pr = associated.find(
    (entry) => entry.base.ref === 'main' && entry.merged_at && entry.merge_commit_sha === base,
  );
  if (!pr || !/^[0-9a-f]{40}$/.test(pr.head.sha)) return undefined;
  const [merge, head, result] = await Promise.all([
    api(`${prefix}/git/commits/${base}`),
    api(`${prefix}/git/commits/${pr.head.sha}`),
    api(`${workflow}?event=pull_request&head_sha=${pr.head.sha}&per_page=100`),
  ]);
  const proof = postMergeQualification({
    repository,
    pr,
    mergeTree: merge.tree.sha,
    headTree: head.tree.sha,
    runs: result.workflow_runs,
  });
  if (!proof.skip) return undefined;
  const run = result.workflow_runs.find((entry) => entry.id === proof.runId);
  return coverageProducerJob(api, repository, run, shard, pr);
}

async function successfulCoverageJob(api, repository, run, shard) {
  const jobs = await runJobs(api, repository, run);
  const job = jobs?.find((entry) => entry.name === `coverage-pnpm-shard-${shard}`);
  if (job?.run_id !== run.id || job?.head_sha !== run.head_sha || job?.conclusion !== 'success')
    return undefined;
  return job;
}

function producedCoverage(job) {
  return job?.steps?.some((step) => step.name === projectionName && step.conclusion === 'success');
}

async function coverageProducerJob(api, repository, run, shard, pr) {
  const job = await successfulCoverageJob(api, repository, run, shard);
  if (!job) return undefined;
  if (producedCoverage(job) && inheritedSource(job) === null) return { run, job };
  const marker = inheritedSource(job);
  if (!pr || !marker) return undefined;
  // A repair marker identifies a candidate. Independently compare that actual
  // producer with the current checkout before admitting any individual group.
  const source = await api(`repos/${repository}/actions/runs/${marker.runId}`);
  if (
    source.id !== marker.runId ||
    source.id >= run.id ||
    source.path?.split('@')[0] !== '.github/workflows/ci.yml' ||
    !(await repairSourceBelongsToPr(api, source, pr, repository))
  )
    return undefined;
  const original = await successfulCoverageJob(api, repository, source, shard);
  if (
    original?.id !== marker.jobId ||
    !producedCoverage(original) ||
    inheritedSource(original) !== null
  )
    return undefined;
  return { run: source, job: original };
}

async function findCoverageArtifact(api, repository, run, shard) {
  const artifacts = await runArtifacts(api, repository, run);
  const candidates = artifacts?.filter((artifact) => artifact.name === `coverage-shard-${shard}`);
  const artifact = candidates?.[0];
  if (
    candidates?.length !== 1 ||
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? '') ||
    artifact.workflow_run?.id !== run.id ||
    artifact.workflow_run.head_sha !== run.head_sha
  )
    return undefined;
  return artifact;
}

async function readCoverageSnapshot(repository, run, artifact, signal) {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-coverage-baseline-'));
  try {
    const archive = join(directory, 'coverage.zip');
    await downloadArtifact(repository, artifact.id, archive, {
      requestTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      signal,
    });
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(archive)) hash.update(bytes);
    if (`sha256:${hash.digest('hex')}` !== artifact.digest)
      throw new Error('coverage baseline artifact digest mismatch');
    const data = JSON.parse(
      execFileSync('unzip', ['-p', archive, snapshot], {
        encoding: 'utf8',
        maxBuffer: snapshotBudget + 1024 * 1024,
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    if (
      data.version !== receiptVersion ||
      data.source !== run.head_sha ||
      data.node !== process.version ||
      data.platform !== process.platform ||
      !data.receipts ||
      typeof data.receipts !== 'object'
    )
      throw new Error('coverage baseline identity mismatch');
    return data;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function coverageHistoryClient(token, deadline) {
  const request = (url, options) =>
    fetch(url, { ...options, signal: AbortSignal.any([options.signal, deadline]) });
  const responses = new Map();
  return (endpoint) => {
    if (!responses.has(endpoint)) {
      responses.set(
        endpoint,
        requestGitHub(endpoint, token, request, {
          sleepFn: () => {
            throw new Error('coverage baseline lookup deferred');
          },
        }),
      );
    }
    return responses.get(endpoint);
  };
}

async function baselineArchive(repository, api, base, shard, signal) {
  const producer = await findCoverageProducer(api, repository, base, shard);
  if (!producer) return undefined;
  const { run, job } = producer;
  const artifact = await findCoverageArtifact(api, repository, run, shard);
  if (
    !artifact ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    artifact.size_in_bytes > 2 * snapshotBudget
  )
    return undefined;
  const data = await readCoverageSnapshot(repository, run, artifact, signal);
  return { ...data, run: run.id, job: job.id, artifact: artifact.id };
}

// Keep only eligible receipts from the old placements. The total retained
// payload uses the same byte budget as one baseline artifact.
export async function collectCoverageBaselines(groups, load, limit = snapshotBudget) {
  const pending = new Map(groups.map((group) => [groupKey(group), group]));
  const result = new Map();
  let remaining = limit;
  for await (const { baseline, changed, eligible } of load()) {
    for (const [key, group] of pending) {
      const entry = baseline.receipts[key];
      if (!entry || !Array.isArray(entry.report?.testResults) || !eligible(group)) continue;
      if (
        Object.keys(entry.coverage ?? {}).some((file) => changed.has(file)) ||
        entry.report?.testResults?.some(({ name }) => changed.has(name))
      )
        continue;
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (size > remaining) continue;
      remaining -= size;
      result.set(group, { baseline: { ...baseline, receipts: { [key]: entry } }, changed });
      pending.delete(key);
    }
    if (pending.size === 0 || remaining === 0) break;
  }
  return result;
}

export async function loadCoverageBaseline(root, shard, groups, environment = process.env) {
  if (environment.GITHUB_EVENT_NAME !== 'pull_request' || !environment.GITHUB_TOKEN)
    return undefined;
  const comparison = comparedCiInputs(root, environment);
  if (!comparison) return undefined;
  const initialOwners = internalSourceOwners(comparison.files);
  if (!initialOwners) return undefined;
  const packages = coveragePackageGraph(root);
  const wanted = groups.filter((group) => reusableCoverageGroup(group, packages, initialOwners));
  if (wanted.length === 0) return undefined;
  const deadline = AbortSignal.timeout(20_000);
  const repository = environment.GITHUB_REPOSITORY;
  const api = coverageHistoryClient(environment.GITHUB_TOKEN, deadline);
  return collectCoverageBaselines(wanted, async function* () {
    for (const candidate of [shard, ...coverageShards.filter((lane) => lane !== shard)]) {
      if (deadline.aborted) return;
      try {
        const baseline = await baselineArchive(
          repository,
          api,
          comparison.base,
          candidate,
          deadline,
        );
        if (!baseline) continue;
        const files =
          baseline.source === comparison.base
            ? comparison.files
            : changedCiInputs(root, baseline.source, comparison.target);
        const affected = files && internalSourceOwners(files);
        if (!affected) continue;
        yield {
          baseline,
          changed: new Set(files.map(({ path }) => path)),
          eligible: (group) => reusableCoverageGroup(group, packages, affected),
        };
      } catch (error) {
        console.warn(`[vitest] coverage baseline shard ${candidate} unavailable: ${error.message}`);
      }
    }
  });
}
