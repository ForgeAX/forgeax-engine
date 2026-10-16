import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';

export const SDK_ARCHIVE_VERIFY_GROUPS = Object.freeze(['project', 'source']);
export const SDK_PR_CONSUMERS = Object.freeze(['npm', ...SDK_ARCHIVE_VERIFY_GROUPS]);
export const SDK_NPM_PARTITIONS = Object.freeze({
  diagnostics: Object.freeze(['diagnostics', 'game3d-installed']),
  js: Object.freeze(['runtime-js-live', 'runtime-js-cold']),
});
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

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

export function aggregateSdkConsumers(reports, expectedHead, version) {
  const npmReports = reports.filter((report) => report.group === 'npm');
  const partitions = Object.keys(SDK_NPM_PARTITIONS);
  if (
    !/^[0-9a-f]{40}$/.test(expectedHead) ||
    reports.length !== SDK_ARCHIVE_VERIFY_GROUPS.length + partitions.length ||
    npmReports.length !== partitions.length
  )
    throw new Error('sdk-pr-consumer-conservation');
  const identities = new Set();
  for (const report of reports) {
    if (
      report.ok !== true ||
      !SDK_PR_CONSUMERS.includes(report.group) ||
      report.engineCommit !== expectedHead ||
      (report.sdkVersion ?? report.version) !== version ||
      !/^[0-9a-f]{64}$/.test(report.sha256) ||
      !/^[0-9a-f]{40}$/.test(report.viewCommit)
    )
      throw new Error(`sdk-pr-consumer-identity:${report.group}`);
    identities.add(`${report.sha256}:${report.viewCommit}`);
  }
  if (identities.size !== 1) throw new Error('sdk-pr-consumer-byte-mismatch');
  for (const group of SDK_ARCHIVE_VERIFY_GROUPS) {
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
    groups: SDK_PR_CONSUMERS,
    npm: {
      partitions,
      workloads: Object.values(SDK_NPM_PARTITIONS).flat(),
      packageCount: npmReports[0].packageCount,
    },
  };
}

if (import.meta.main) {
  const value = (name) => process.argv[process.argv.indexOf(name) + 1];
  const version = value('--version');
  if (process.argv.includes('--write-seed'))
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
    const reports = readdirSync(root)
      .filter((name) => name.endsWith('-result.json'))
      .map((name) => JSON.parse(readFileSync(resolve(root, name), 'utf8')));
    console.log(JSON.stringify(aggregateSdkConsumers(reports, value('--expected-head'), version)));
  } else throw new Error(`unknown-sdk-pr-command:${basename(process.argv[1])}`);
}
