import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  createCandidateConsumerReports,
  createCandidateSeedManifest,
  verifyCandidateSeedManifest,
} from '../sdk-candidate-consumers.mjs';
import { SDK_ARCHIVE_VERIFY_GROUPS, SDK_NPM_PARTITIONS } from '../sdk-pr-preflight.mjs';

const engineCommit = 'a'.repeat(40);
const viewCommit = 'b'.repeat(40);
const version = '0.3.10';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'sdk-candidate-consumers-'));
  const sdkRoot = resolve(root, 'sdk');
  const archiveName = `forgeax-sdk-v${version}.zip`;
  const archivePath = resolve(sdkRoot, archiveName);
  mkdirSync(resolve(sdkRoot, 'npm/packages'), { recursive: true });
  writeFileSync(archivePath, 'exact candidate archive bytes');
  writeFileSync(resolve(sdkRoot, 'npm/packages/engine.tgz'), 'engine package bytes');
  writeFileSync(resolve(sdkRoot, `npm/forgeax-engine-sdk-${version}.tgz`), 'carrier package bytes');
  const archiveDigest = sha256(readFileSync(archivePath));
  writeFileSync(resolve(sdkRoot, 'SHA256SUMS'), `${archiveDigest}  ${archiveName}\n`);
  writeFileSync(
    resolve(sdkRoot, 'sdk-build-result.json'),
    JSON.stringify({
      ok: true,
      engineCommit,
      viewCommit,
      sdkVersion: version,
      sha256: archiveDigest,
      npm: { packageCount: 1 },
    }),
  );
  const seedManifest = createCandidateSeedManifest({
    sdkRoot,
    expectedHead: engineCommit,
    version,
  });
  const identity = {
    ok: true,
    engineCommit,
    viewCommit,
    sdkVersion: version,
    sha256: archiveDigest,
  };
  const reports = [
    ...SDK_ARCHIVE_VERIFY_GROUPS.map((group) => ({
      ...identity,
      group,
      archive: archivePath,
      capabilities: ['runtime'],
      source: { format: 'public-source' },
      ...(group === 'project' ? { projectEvidence: { status: 'passed' } } : {}),
      ...(group === 'source' ? { sourceTemplate: { status: 'passed' } } : {}),
    })),
    ...Object.entries(SDK_NPM_PARTITIONS).map(([partition, workloads]) => ({
      ...identity,
      group: 'npm',
      partition,
      workloads,
      packageCount: 1,
    })),
  ];
  return { root, sdkRoot, archivePath, seedManifest, reports };
}

test('candidate seed manifest binds every archive and npm byte without rewriting official SHA256SUMS', () => {
  const input = fixture();
  try {
    assert.equal(input.seedManifest.engineCommit, engineCommit);
    assert.equal(input.seedManifest.viewCommit, viewCommit);
    assert.equal(input.seedManifest.archive.path, `forgeax-sdk-v${version}.zip`);
    assert.equal(input.seedManifest.archive.sha256, sha256(readFileSync(input.archivePath)));
    assert.equal(input.seedManifest.npmPackageCount, 1);
    assert.deepEqual(
      input.seedManifest.npm.map(({ path }) => path),
      [`npm/forgeax-engine-sdk-${version}.tgz`, 'npm/packages/engine.tgz'],
    );
    assert.equal(input.seedManifest.npm.length, 2);
    assert.deepEqual(
      verifyCandidateSeedManifest({
        sdkRoot: input.sdkRoot,
        manifest: input.seedManifest,
        expectedHead: engineCommit,
        version,
      }),
      JSON.parse(readFileSync(resolve(input.sdkRoot, 'sdk-build-result.json'), 'utf8')),
    );
    assert.equal(
      readFileSync(resolve(input.sdkRoot, 'SHA256SUMS'), 'utf8'),
      `${sha256(readFileSync(input.archivePath))}  forgeax-sdk-v${version}.zip\n`,
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test('candidate consumer aggregation binds all four full owners to the exact ZIP and package seed', () => {
  const input = fixture();
  try {
    const gates = createCandidateConsumerReports({
      ...input,
      expectedHead: engineCommit,
      version,
    });
    assert.deepEqual(gates.npmConsumer.partitions, Object.keys(SDK_NPM_PARTITIONS));
    assert.deepEqual(gates.npmConsumer.workloads, Object.values(SDK_NPM_PARTITIONS).flat());
    assert.equal(gates.npmConsumer.packageCount, 1);
    assert.deepEqual(
      gates.npmConsumer.owners.map(({ partition }) => partition),
      Object.keys(SDK_NPM_PARTITIONS),
    );
    assert.equal(gates.npmConsumer.sha256, sha256(readFileSync(input.archivePath)));

    assert.equal(gates.archiveBrowser.group, 'all');
    assert.deepEqual(gates.archiveBrowser.groups, SDK_ARCHIVE_VERIFY_GROUPS);
    assert.deepEqual(
      gates.archiveBrowser.owners.map(({ group }) => group),
      [...SDK_ARCHIVE_VERIFY_GROUPS].sort(),
    );
    assert.deepEqual(gates.archiveBrowser.projectEvidence, { status: 'passed' });
    assert.deepEqual(gates.archiveBrowser.sourceTemplate, { status: 'passed' });
    assert.equal(gates.archiveBrowser.sha256, gates.npmConsumer.sha256);
    assert.equal(gates.archiveBrowser.engineCommit, engineCommit);
    assert.equal(gates.archiveBrowser.viewCommit, viewCommit);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test('archive consumers verify transported ZIP bytes without downloading the npm payload', () => {
  const input = fixture();
  try {
    rmSync(resolve(input.sdkRoot, 'npm'), { recursive: true });
    const verify = () =>
      verifyCandidateSeedManifest({
        sdkRoot: input.sdkRoot,
        manifest: input.seedManifest,
        expectedHead: engineCommit,
        version,
        group: 'archive',
      });
    assert.equal(verify().sha256, input.seedManifest.archive.sha256);
    writeFileSync(input.archivePath, 'changed archive');
    assert.throws(verify, /sdk-candidate-seed-archive-bytes/);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test('npm consumers verify their complete package closure without downloading the ZIP', () => {
  const input = fixture();
  try {
    rmSync(input.archivePath);
    const verify = (manifest = input.seedManifest) =>
      verifyCandidateSeedManifest({
        sdkRoot: input.sdkRoot,
        manifest,
        expectedHead: engineCommit,
        version,
        group: 'npm',
      });
    assert.equal(verify().sha256, input.seedManifest.archive.sha256);
    assert.throws(
      () =>
        verify({
          ...input.seedManifest,
          archive: { ...input.seedManifest.archive, sha256: 'f'.repeat(64) },
        }),
      /sdk-candidate-seed-archive-identity/,
    );
    writeFileSync(resolve(input.sdkRoot, 'npm/packages/engine.tgz'), 'changed package');
    assert.throws(verify, /sdk-candidate-seed-byte-closure/);
    assert.throws(
      () => createCandidateConsumerReports({ ...input, expectedHead: engineCommit, version }),
      /ENOENT/,
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test('seed verification rejects an unknown transport group', () => {
  const input = fixture();
  try {
    assert.throws(
      () =>
        verifyCandidateSeedManifest({
          sdkRoot: input.sdkRoot,
          manifest: input.seedManifest,
          expectedHead: engineCommit,
          version,
          group: 'typo',
        }),
      /sdk-candidate-seed-group/,
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

for (const group of ['archive', 'npm'])
  test(`the actual consumer CLI verifies a ${group}-only transport`, () => {
    const input = fixture();
    try {
      const manifestPath = resolve(input.root, 'seed.json');
      writeFileSync(manifestPath, JSON.stringify(input.seedManifest));
      if (group === 'archive') rmSync(resolve(input.sdkRoot, 'npm'), { recursive: true });
      else rmSync(input.archivePath);
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            resolve(import.meta.dirname, '../sdk-candidate-consumers.mjs'),
            '--verify-seed',
            '--sdk',
            input.sdkRoot,
            '--seed-manifest',
            manifestPath,
            '--expected-head',
            engineCommit,
            '--version',
            version,
            '--group',
            group,
          ],
          { encoding: 'utf8' },
        ),
      );
      assert.deepEqual(result, { ok: true, engineCommit, sdkVersion: version, viewCommit });
    } finally {
      rmSync(input.root, { recursive: true, force: true });
    }
  });

test('candidate consumer aggregation rejects missing, extra, mismatched, or stale evidence and seed bytes', () => {
  const input = fixture();
  try {
    const aggregate = (
      reports = input.reports,
      expectedHead = engineCommit,
      selectedVersion = version,
      seedManifest = input.seedManifest,
    ) =>
      createCandidateConsumerReports({
        ...input,
        reports,
        seedManifest,
        expectedHead,
        version: selectedVersion,
      });
    assert.throws(() => aggregate(input.reports.slice(1)), /sdk-pr-consumer-conservation/);
    assert.throws(
      () => aggregate([...input.reports, input.reports[0]]),
      /sdk-pr-consumer-conservation/,
    );
    assert.throws(
      () =>
        aggregate(
          input.reports.map((report, index) =>
            index === 0 ? { ...report, viewCommit: 'c'.repeat(40) } : report,
          ),
        ),
      /sdk-pr-consumer-identity|sdk-pr-consumer-byte-mismatch/,
    );
    assert.throws(
      () =>
        aggregate(
          input.reports.map((report, index) =>
            index === 0 ? { ...report, sha256: 'd'.repeat(64) } : report,
          ),
        ),
      /sdk-pr-consumer-byte-mismatch/,
    );
    assert.throws(() => aggregate(input.reports, 'e'.repeat(40)), /sdk-candidate-seed-identity/);
    assert.throws(
      () => aggregate(input.reports, engineCommit, '0.3.9'),
      /sdk-candidate-seed-identity/,
    );
    assert.throws(
      () =>
        aggregate(input.reports, engineCommit, version, {
          ...input.seedManifest,
          npm: input.seedManifest.npm.map((entry) => ({ ...entry, sha256: 'f'.repeat(64) })),
        }),
      /sdk-candidate-seed-byte-closure/,
    );

    writeFileSync(resolve(input.sdkRoot, 'npm/packages/engine.tgz'), 'changed package bytes');
    assert.throws(
      () =>
        verifyCandidateSeedManifest({
          sdkRoot: input.sdkRoot,
          manifest: input.seedManifest,
          expectedHead: engineCommit,
          version,
        }),
      /sdk-candidate-seed-byte-closure/,
    );

    writeFileSync(input.archivePath, 'different archive bytes');
    assert.throws(() => aggregate(), /sdk-candidate-seed-archive-bytes/);
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});

test('candidate consumer CLI writes, verifies, and aggregates the same manifest without changing checksums', () => {
  const input = fixture();
  try {
    const reportsRoot = resolve(input.root, 'reports');
    const outputRoot = resolve(input.root, 'gates');
    const manifestPath = resolve(input.root, 'manifest/seed.json');
    const script = resolve(import.meta.dirname, '../sdk-candidate-consumers.mjs');
    mkdirSync(reportsRoot);
    for (const report of input.reports) {
      const suffix = report.partition ? `-${report.partition}` : '';
      writeFileSync(
        resolve(reportsRoot, `sdk-verify-${report.group}${suffix}-result.json`),
        JSON.stringify(report),
      );
    }
    const writeOutput = execFileSync(
      process.execPath,
      [
        script,
        '--write-seed',
        '--sdk',
        input.sdkRoot,
        '--expected-head',
        engineCommit,
        '--version',
        version,
        '--output',
        manifestPath,
      ],
      { encoding: 'utf8' },
    );
    assert.deepEqual(JSON.parse(writeOutput), {
      ok: true,
      enginePackageCount: 1,
      tarballCount: 2,
    });
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), input.seedManifest);

    const verifyOutput = execFileSync(
      process.execPath,
      [
        script,
        '--verify-seed',
        '--sdk',
        input.sdkRoot,
        '--seed-manifest',
        manifestPath,
        '--expected-head',
        engineCommit,
        '--version',
        version,
      ],
      { encoding: 'utf8' },
    );
    assert.deepEqual(JSON.parse(verifyOutput), {
      ok: true,
      engineCommit,
      sdkVersion: version,
      viewCommit,
    });

    const output = execFileSync(
      process.execPath,
      [
        script,
        '--sdk',
        input.sdkRoot,
        '--reports',
        reportsRoot,
        '--seed-manifest',
        manifestPath,
        '--archive',
        input.archivePath,
        '--expected-head',
        engineCommit,
        '--version',
        version,
        '--output',
        outputRoot,
      ],
      { encoding: 'utf8' },
    );
    assert.deepEqual(JSON.parse(output), {
      ok: true,
      groups: SDK_ARCHIVE_VERIFY_GROUPS,
      npm: Object.keys(SDK_NPM_PARTITIONS),
    });
    assert.deepEqual(readdirSync(outputRoot).sort(), [
      'npm-consumer.json',
      'sdk-verify-result.json',
    ]);
    assert.equal(
      JSON.parse(readFileSync(resolve(outputRoot, 'npm-consumer.json'), 'utf8')).owners.length,
      Object.keys(SDK_NPM_PARTITIONS).length,
    );
    assert.equal(
      JSON.parse(readFileSync(resolve(outputRoot, 'sdk-verify-result.json'), 'utf8')).owners.length,
      SDK_ARCHIVE_VERIFY_GROUPS.length,
    );
    assert.equal(
      readFileSync(resolve(input.sdkRoot, 'SHA256SUMS'), 'utf8'),
      `${sha256(readFileSync(input.archivePath))}  forgeax-sdk-v${version}.zip\n`,
    );
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
});
