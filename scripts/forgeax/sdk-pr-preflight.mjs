import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { collectRepairArtifactSources } from '../ci/ci-repair-artifacts.mjs';
import { repairDeclaration, requestGitHub } from '../ci/ci-repair-qualification.mjs';
import { downloadArtifact, retryArtifact } from '../ci/download-artifact-with-retry.mjs';

export const SDK_COMPACT_PREVIEW_FRAMES = 60;
export const SDK_ARCHIVE_VERIFY_GROUPS = Object.freeze(['project', 'source']);
export const SDK_PR_CONSUMERS = Object.freeze(['npm', ...SDK_ARCHIVE_VERIFY_GROUPS]);
export const SDK_NPM_PARTITIONS = Object.freeze({
  diagnostics: Object.freeze(['diagnostics', 'game3d-installed']),
  js: Object.freeze(['runtime-js-live', 'runtime-js-cold']),
});
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

// The regular Engine build and required runtime checks own internal changes
// in these packages. Source distribution, bundler or consumer changes use
// the expanded proof. New or ambiguous paths are expanded by default.
function archiveGroups(profile) {
  if (profile === 'pr-consumer') return ['project'];
  if (profile === undefined || profile === 'pr-expanded') return SDK_ARCHIVE_VERIFY_GROUPS;
  throw new Error('sdk-pr-archive-profile');
}

export function sdkPrConsumerMatrix(profile) {
  return {
    include: [
      ...archiveGroups(profile).map((group) => ({ group })),
      ...Object.keys(SDK_NPM_PARTITIONS).map((partition) => ({ group: 'npm', partition })),
    ],
  };
}

const sdkReferenceDocs = /^skills\/.+\.md$/;
const testsOrWorkspaceImplementation =
  /^packages\/(?:[^/]+\/(?:src\/)?__tests__\/|devkit\/src\/workspace-[^/]+\.ts$)/;
const internalRuntimeSource =
  /^packages\/(?:ecs|math|render|rhi|runtime|animation|audio|state|water)\/src\//;

function compactArchivePath(path) {
  return (
    typeof path === 'string' &&
    (internalRuntimeSource.test(path) ||
      sdkReferenceDocs.test(path) ||
      testsOrWorkspaceImplementation.test(path))
  );
}

export function sdkPrArchiveProfile(comparison) {
  const files = comparison?.files;
  if (!Array.isArray(files) || files.length === 0 || files.length >= 300) return 'pr-expanded';
  const internalOnly = files.every(
    (file) =>
      file !== null &&
      typeof file === 'object' &&
      ['added', 'modified', 'removed', 'renamed'].includes(file.status) &&
      compactArchivePath(file.filename) &&
      (file.status !== 'renamed' || compactArchivePath(file.previous_filename)),
  );
  return internalOnly ? 'pr-consumer' : 'pr-expanded';
}

async function writeSdkPrArchiveProfile() {
  let profile = 'pr-expanded';
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const base = event.pull_request?.base.sha;
  const head = event.pull_request?.head.sha;
  if (
    process.env.GITHUB_EVENT_NAME === 'pull_request' &&
    /^[0-9a-f]{40}$/.test(base) &&
    /^[0-9a-f]{40}$/.test(head) &&
    head === execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  ) {
    try {
      const comparison = await requestGitHub(
        `repos/${process.env.GITHUB_REPOSITORY}/compare/${base}...${head}`,
        process.env.GH_TOKEN,
      );
      profile = sdkPrArchiveProfile(comparison);
    } catch {
      console.warn('[sdk-pr] immutable input comparison unavailable; using expanded verification');
    }
  }
  const declaredRepair =
    process.env.GITHUB_EVENT_NAME === 'pull_request' &&
    Boolean(repairDeclaration(event.pull_request?.body, process.env.GITHUB_REPOSITORY));
  const matrix = sdkPrConsumerMatrix(profile);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `profile=${profile}\ndeclared_repair=${declaredRepair}\nmatrix=${JSON.stringify(matrix)}\nconsumer_count=${matrix.include.length}\n`,
  );
  console.log(`[sdk-pr] Archive verification profile: ${profile}`);
}

function seedFiles(root, version, group = 'all') {
  return [
    ...(group === 'npm' ? [] : [`forgeax-sdk-v${version}.zip`]),
    ...(group === 'all' || group === 'npm'
      ? readdirSync(resolve(root, 'npm'), { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) =>
            relative(root, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/'),
          )
          .sort()
      : []),
  ];
}

export function writeSeedChecksums(root, version) {
  writeFileSync(
    resolve(root, 'SHA256SUMS'),
    seedFiles(root, version)
      .map((path) => `${digest(resolve(root, path))}  ${path}\n`)
      .join(''),
  );
}

export function checkSeed(root, expectedHead, version, group = 'all') {
  if (group !== 'all' && !SDK_PR_CONSUMERS.includes(group)) throw new Error('sdk-pr-seed-group');
  const build = JSON.parse(readFileSync(resolve(root, 'sdk-build-result.json'), 'utf8'));
  if (!build.ok || build.engineCommit !== expectedHead || build.sdkVersion !== version)
    throw new Error('sdk-pr-seed-identity');
  // Every route retains the complete producer declaration. Only the bytes it
  // actually consumes travel to that runner; the consumer aggregate binds
  // the real archive digest back to every npm receipt.
  const lines = readFileSync(resolve(root, 'SHA256SUMS'), 'utf8').split('\n');
  const terminal = lines.pop();
  const npmPaths = lines
    .slice(1)
    .map((line) => /^[0-9a-f]{64} {2}(npm\/[^\r\n\\]+\.tgz)$/.exec(line)?.[1]);
  if (
    terminal !== '' ||
    !/^[0-9a-f]{64}$/.test(build.sha256) ||
    lines[0] !== `${build.sha256}  forgeax-sdk-v${version}.zip` ||
    !Number.isSafeInteger(build.npm?.packageCount) ||
    build.npm.packageCount < 1 ||
    lines.length !== build.npm.packageCount + 2 ||
    npmPaths.some(
      (path) =>
        path === undefined ||
        path.split('/').some((part) => part === '' || part === '.' || part === '..'),
    ) ||
    new Set(npmPaths).size !== npmPaths.length ||
    JSON.stringify(npmPaths) !== JSON.stringify([...npmPaths].sort())
  )
    throw new Error('sdk-pr-seed-byte-closure');
  const files = seedFiles(root, version, group);
  const selected = group === 'all' ? lines : group === 'npm' ? lines.slice(1) : lines.slice(0, 1);
  const actual = files.map((path) => `${digest(resolve(root, path))}  ${path}`);
  if (JSON.stringify(selected) !== JSON.stringify(actual))
    throw new Error('sdk-pr-seed-byte-closure');
  return build;
}

function consumerKey(report) {
  return `${report.group}${report.partition ? `-${report.partition}` : ''}`;
}

export function sdkConsumerChecks(profile) {
  return sdkPrConsumerMatrix(profile).include.map(
    (consumer) => `sdk-consumer-${consumerKey(consumer)}`,
  );
}

function repairSourceMap(sources, profile) {
  if (sources === undefined) return undefined;
  const checks = sdkConsumerChecks(profile);
  if (sources.length !== checks.length) throw new Error('sdk-pr-repair-conservation');
  const result = new Map();
  for (const source of sources) {
    if (
      !checks.includes(source.checkName) ||
      result.has(source.checkName) ||
      !/^[0-9a-f]{40}$/.test(source.sourceSha) ||
      typeof source.reused !== 'boolean' ||
      ![source.sourceRunId, source.sourceJobId, source.artifactId].every(
        (id) => Number.isSafeInteger(id) && id > 0,
      ) ||
      !/^sha256:[0-9a-f]{64}$/.test(source.artifactDigest)
    )
      throw new Error('sdk-pr-repair-provenance');
    result.set(source.checkName, source);
  }
  return result;
}

function assertConsumerIdentity(report, source, expectedHead, version) {
  const sourceHead = source?.sourceSha ?? expectedHead;
  const sourceVersion = source === undefined ? version : `0.0.0-pr.${sourceHead}`;
  if (
    report.ok !== true ||
    !SDK_PR_CONSUMERS.includes(report.group) ||
    report.engineCommit !== sourceHead ||
    (report.sdkVersion ?? report.version) !== sourceVersion ||
    !/^[0-9a-f]{64}$/.test(report.sha256) ||
    !/^[0-9a-f]{40}$/.test(report.viewCommit)
  )
    throw new Error(`sdk-pr-consumer-identity:${report.group}`);
  if (source?.reused === false && sourceHead !== expectedHead)
    throw new Error('sdk-pr-repair-current-identity');
}

function assertConsumerIdentities(reports, expectedHead, version, sources) {
  const identities = new Map();
  for (const report of reports) {
    const source = sources?.get(`sdk-consumer-${consumerKey(report)}`);
    const sourceHead = source?.sourceSha ?? expectedHead;
    assertConsumerIdentity(report, source, expectedHead, version);
    const previous = identities.get(sourceHead);
    if (previous !== undefined && previous !== `${report.sha256}:${report.viewCommit}`)
      throw new Error('sdk-pr-consumer-byte-mismatch');
    identities.set(sourceHead, `${report.sha256}:${report.viewCommit}`);
  }
}

function missingCompactPreviewEvidence(report) {
  if (report.group !== 'project' || report.profile !== 'pr-consumer') return false;
  const readyFrames = report.previewBrowser?.readyFrames;
  return !Number.isSafeInteger(readyFrames) || readyFrames < SDK_COMPACT_PREVIEW_FRAMES;
}

export function aggregateSdkConsumers(reports, expectedHead, version, repairSources, profile) {
  const archive = archiveGroups(profile);
  if (
    profile !== undefined &&
    reports.some(
      (report) =>
        report.group !== 'npm' &&
        report.profile !== 'pr-expanded' &&
        !(profile === 'pr-consumer' && ['core', 'pr-consumer'].includes(report.profile)),
    )
  )
    throw new Error('sdk-pr-archive-profile-evidence');
  if (reports.some(missingCompactPreviewEvidence))
    throw new Error('sdk-pr-compact-preview-evidence');
  const sources = repairSourceMap(repairSources, profile);
  if (sources !== undefined && version !== `0.0.0-pr.${expectedHead}`)
    throw new Error('sdk-pr-repair-current-identity');
  const npmReports = reports.filter((report) => report.group === 'npm');
  const partitions = Object.keys(SDK_NPM_PARTITIONS);
  if (
    !/^[0-9a-f]{40}$/.test(expectedHead) ||
    reports.length !== archive.length + partitions.length ||
    npmReports.length !== partitions.length
  )
    throw new Error('sdk-pr-consumer-conservation');
  assertConsumerIdentities(reports, expectedHead, version, sources);
  for (const group of archive) {
    if (reports.filter((report) => report.group === group).length !== 1)
      throw new Error(`sdk-pr-consumer-missing-or-duplicate:${group}`);
  }
  const packageCounts = new Set();
  for (const [partition, workloads] of Object.entries(SDK_NPM_PARTITIONS)) {
    const matches = npmReports.filter((report) => report.partition === partition);
    if (matches.length !== 1)
      throw new Error(`sdk-pr-npm-partition-missing-or-duplicate:${partition}`);
    const report = matches[0];
    if (
      JSON.stringify(report.workloads) !== JSON.stringify(workloads) ||
      !Number.isSafeInteger(report.packageCount) ||
      report.packageCount <= 0
    )
      throw new Error(`sdk-pr-npm-partition-incomplete:${partition}`);
    packageCounts.add(report.packageCount);
  }
  if (packageCounts.size !== 1) throw new Error('sdk-pr-npm-package-count-mismatch');
  return {
    ok: true,
    engineCommit: expectedHead,
    sdkVersion: version,
    groups: ['npm', ...archive],
    ...(profile === undefined ? {} : { archiveProfile: profile }),
    ...(sources === undefined ? {} : { qualification: 'ci-repair', executions: repairSources }),
    npm: {
      partitions,
      workloads: Object.values(SDK_NPM_PARTITIONS).flat(),
      packageCount: npmReports[0].packageCount,
    },
  };
}

export async function collectSdkRepairReports(context, api, readArtifact, profile) {
  const rows = await collectRepairArtifactSources(
    {
      ...context,
      workflow: 'sdk-pr-preflight.yml',
      jobKey: 'consumers',
      checkPrefix: 'sdk-consumer-',
    },
    sdkConsumerChecks(profile),
    (name) => name.replace('sdk-consumer-', 'sdk-pr-result-'),
    api,
  );
  const result = { reports: [], sources: [] };
  for (const { checkName, artifact, source } of rows) {
    const report = await readArtifact(artifact, source);
    if (`sdk-consumer-${consumerKey(report)}` !== checkName)
      throw new Error('sdk-pr-repair-report-owner');
    result.reports.push(report);
    result.sources.push({
      checkName,
      reused: source.reused,
      sourceSha: source.sourceSha,
      sourceRunId: source.sourceRunId,
      sourceJobId: source.sourceJobId,
      artifactId: artifact.id,
      artifactDigest: artifact.digest,
    });
  }
  return result;
}

async function readSdkConsumerArtifact(repository, root, artifact, source) {
  const directory = resolve(root, String(source.sourceRunId), artifact.name);
  mkdirSync(directory, { recursive: true });
  const zip = resolve(directory, 'original-artifact.zip');
  await retryArtifact(() => downloadArtifact(repository, String(artifact.id), zip));
  if (`sha256:${digest(zip)}` !== artifact.digest) throw new Error('sdk-pr-repair-artifact-digest');
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
  if (names.length !== 1 || !/^[a-z0-9_.-]+-result\.json$/i.test(names[0]))
    throw new Error('sdk-pr-repair-artifact-content');
  const bytes = execFileSync('unzip', ['-p', zip, names[0]], { maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(resolve(directory, names[0]), bytes);
  return JSON.parse(bytes.toString('utf8'));
}

if (import.meta.main) {
  const value = (name) => process.argv[process.argv.indexOf(name) + 1];
  const version = value('--version');
  if (process.argv.includes('--select-archive-profile')) await writeSdkPrArchiveProfile();
  else if (process.argv.includes('--write-seed'))
    writeSeedChecksums(resolve(value('--write-seed')), version);
  else if (process.argv.includes('--check-seed'))
    checkSeed(
      resolve(value('--check-seed')),
      value('--expected-head'),
      version,
      process.argv.includes('--group') ? value('--group') : 'all',
    );
  else if (process.argv.includes('--aggregate')) {
    const root = resolve(value('--aggregate'));
    const profile = process.argv.includes('--archive-profile')
      ? value('--archive-profile')
      : undefined;
    const repair = process.argv.includes('--ci-repair') ? value('--ci-repair') : 'false';
    if (!['true', 'false'].includes(repair)) throw new Error('sdk-pr-repair-context');
    if (repair === 'true') {
      const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
      const repository = process.env.GITHUB_REPOSITORY;
      const { reports, sources } = await collectSdkRepairReports(
        {
          eventName: process.env.GITHUB_EVENT_NAME,
          pr: event.pull_request,
          repository,
          currentRunId: process.env.GITHUB_RUN_ID,
          targetSha: value('--expected-head'),
        },
        (endpoint) => requestGitHub(endpoint, process.env.GH_TOKEN),
        (artifact, source) => readSdkConsumerArtifact(repository, root, artifact, source),
        profile,
      );
      console.log(
        JSON.stringify(
          aggregateSdkConsumers(reports, value('--expected-head'), version, sources, profile),
        ),
      );
    } else {
      const reports = readdirSync(root)
        .filter((name) => name.endsWith('-result.json'))
        .map((name) => JSON.parse(readFileSync(resolve(root, name), 'utf8')));
      console.log(
        JSON.stringify(
          aggregateSdkConsumers(reports, value('--expected-head'), version, undefined, profile),
        ),
      );
    }
  } else throw new Error(`unknown-sdk-pr-command:${basename(process.argv[1])}`);
}
