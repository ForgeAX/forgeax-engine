import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { aggregateSdkConsumers, SDK_ARCHIVE_VERIFY_GROUPS } from './sdk-pr-preflight.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function filesUnder(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`sdk-candidate-seed-file-type:${relative(root, path)}`);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

export function createCandidateSeedManifest({ sdkRoot, expectedHead, version }) {
  const root = resolve(sdkRoot);
  const build = JSON.parse(readFileSync(resolve(root, 'sdk-build-result.json'), 'utf8'));
  if (!build.ok || build.engineCommit !== expectedHead || build.sdkVersion !== version)
    throw new Error('sdk-candidate-seed-identity');
  if (!/^[0-9a-f]{40}$/.test(build.viewCommit ?? ''))
    throw new Error('sdk-candidate-seed-view-commit');

  const archiveName = `forgeax-sdk-v${version}.zip`;
  const archivePath = resolve(root, archiveName);
  const archiveBytes = readFileSync(archivePath);
  const archiveDigest = sha256(archiveBytes);
  if (archiveDigest !== build.sha256) throw new Error('sdk-candidate-seed-archive-bytes');
  if (readFileSync(resolve(root, 'SHA256SUMS'), 'utf8') !== `${archiveDigest}  ${archiveName}\n`)
    throw new Error('sdk-candidate-seed-checksum-contract');

  const npmRoot = resolve(root, 'npm');
  const npmFiles = filesUnder(npmRoot);
  if (
    !Number.isSafeInteger(build.npm?.packageCount) ||
    build.npm.packageCount < 1 ||
    npmFiles.length !== build.npm.packageCount + 1 ||
    npmFiles.some((path) => !path.endsWith('.tgz'))
  )
    throw new Error('sdk-candidate-seed-package-count');

  return {
    schemaVersion: 1,
    engineCommit: expectedHead,
    sdkVersion: version,
    viewCommit: build.viewCommit,
    archive: {
      path: archiveName,
      bytes: archiveBytes.byteLength,
      sha256: archiveDigest,
    },
    npmPackageCount: build.npm.packageCount,
    npm: npmFiles.map((path) => {
      const bytes = readFileSync(path);
      return {
        path: `npm/${relative(npmRoot, path).split(sep).join('/')}`,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      };
    }),
  };
}

export function verifyCandidateSeedManifest({ sdkRoot, manifest, expectedHead, version }) {
  const expected = createCandidateSeedManifest({ sdkRoot, expectedHead, version });
  if (JSON.stringify(manifest) !== JSON.stringify(expected))
    throw new Error('sdk-candidate-seed-byte-closure');
  return JSON.parse(readFileSync(resolve(sdkRoot, 'sdk-build-result.json'), 'utf8'));
}

export function createCandidateConsumerReports({
  sdkRoot,
  archivePath,
  reports,
  seedManifest,
  expectedHead,
  version,
}) {
  const root = resolve(sdkRoot);
  const archive = resolve(archivePath);
  const build = verifyCandidateSeedManifest({
    sdkRoot: root,
    manifest: seedManifest,
    expectedHead,
    version,
  });
  if (archive !== resolve(root, `forgeax-sdk-v${version}.zip`))
    throw new Error('sdk-candidate-consumer-archive-path');
  const archiveDigest = sha256(readFileSync(archive));
  if (archiveDigest !== build.sha256) throw new Error('sdk-candidate-consumer-archive-bytes');
  if (!/^[0-9a-f]{40}$/.test(build.viewCommit ?? ''))
    throw new Error('sdk-candidate-consumer-view-commit');

  const aggregate = aggregateSdkConsumers(reports, expectedHead, version);
  if (aggregate.npm.packageCount !== build.npm.packageCount)
    throw new Error('sdk-candidate-consumer-package-count');
  if (
    reports.some(
      (report) => report.sha256 !== archiveDigest || report.viewCommit !== build.viewCommit,
    )
  )
    throw new Error('sdk-candidate-consumer-seed-identity');

  const archiveReports = reports
    .filter((report) => SDK_ARCHIVE_VERIFY_GROUPS.includes(report.group))
    .sort((left, right) => left.group.localeCompare(right.group));
  const projectReport = archiveReports.find((report) => report.group === 'project');
  const sourceReport = archiveReports.find((report) => report.group === 'source');
  const npmReports = reports
    .filter((report) => report.group === 'npm')
    .sort(
      (left, right) =>
        aggregate.npm.partitions.indexOf(left.partition) -
        aggregate.npm.partitions.indexOf(right.partition),
    );

  return {
    npmConsumer: {
      ok: true,
      status: 'passed',
      group: 'npm',
      engineCommit: expectedHead,
      sdkVersion: version,
      viewCommit: build.viewCommit,
      sha256: archiveDigest,
      packageCount: build.npm.packageCount,
      partitions: aggregate.npm.partitions,
      workloads: aggregate.npm.workloads,
      owners: npmReports,
    },
    archiveBrowser: {
      ok: true,
      status: 'passed',
      group: 'all',
      archive: basename(archive),
      engineCommit: expectedHead,
      sdkVersion: version,
      viewCommit: build.viewCommit,
      sha256: archiveDigest,
      capabilities: projectReport.capabilities,
      source: projectReport.source,
      projectEvidence: projectReport.projectEvidence,
      sourceTemplate: sourceReport.sourceTemplate,
      groups: SDK_ARCHIVE_VERIFY_GROUPS,
      owners: archiveReports,
    },
  };
}

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  const value = argv[index + 1];
  if (index < 0 || value === undefined || value.startsWith('--'))
    throw new Error(`sdk-candidate-consumers-option:${name}`);
  return value;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const sdkRoot = resolve(option(argv, 'sdk'));
  const expectedHead = option(argv, 'expected-head');
  const version = option(argv, 'version');
  if (argv.includes('--write-seed')) {
    const manifest = createCandidateSeedManifest({ sdkRoot, expectedHead, version });
    const outputPath = resolve(option(argv, 'output'));
    await mkdir(resolve(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        enginePackageCount: manifest.npmPackageCount,
        tarballCount: manifest.npm.length,
      })}\n`,
    );
  } else if (argv.includes('--verify-seed')) {
    const manifest = JSON.parse(await readFile(resolve(option(argv, 'seed-manifest')), 'utf8'));
    const build = verifyCandidateSeedManifest({ sdkRoot, manifest, expectedHead, version });
    process.stdout.write(
      `${JSON.stringify({ ok: true, engineCommit: expectedHead, sdkVersion: version, viewCommit: build.viewCommit })}\n`,
    );
  } else {
    const reportsRoot = resolve(option(argv, 'reports'));
    const outputRoot = resolve(option(argv, 'output'));
    const seedManifest = JSON.parse(await readFile(resolve(option(argv, 'seed-manifest')), 'utf8'));
    const archivePath = resolve(option(argv, 'archive'));
    const reports = await Promise.all(
      (await readdir(reportsRoot))
        .filter((name) => name.endsWith('-result.json'))
        .sort()
        .map(async (name) => JSON.parse(await readFile(resolve(reportsRoot, name), 'utf8'))),
    );
    const gates = createCandidateConsumerReports({
      sdkRoot,
      archivePath,
      reports,
      seedManifest,
      expectedHead,
      version,
    });
    await mkdir(outputRoot, { recursive: true });
    await Promise.all([
      writeFile(
        resolve(outputRoot, 'npm-consumer.json'),
        `${JSON.stringify(gates.npmConsumer, null, 2)}\n`,
      ),
      writeFile(
        resolve(outputRoot, 'sdk-verify-result.json'),
        `${JSON.stringify(gates.archiveBrowser, null, 2)}\n`,
      ),
    ]);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        groups: gates.archiveBrowser.groups,
        npm: gates.npmConsumer.partitions,
      })}\n`,
    );
  }
}
