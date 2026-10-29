import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { pnpmCommand } from '../../lib/pnpm-command.mjs';

const root = fileURLToPath(new URL('../../..', import.meta.url));

function installsRootRuntime(step) {
  if (step.if !== undefined || step['continue-on-error'] || step['working-directory']) return false;
  const command = String(step.run ?? '');
  if (/node scripts\/ci\/prepare-pnpm-workspace\.mjs --install\b/u.test(command)) return true;
  return command
    .split('\n')
    .some(
      (line) =>
        /\bpnpm install\b/u.test(line) &&
        /--frozen-lockfile\b/u.test(line) &&
        (!/--filter\b/u.test(line) || /--filter forgeax-engine(?:\s|$)/u.test(line)),
    );
}

function missingRuntimeSteps(workflow) {
  const missing = [];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    let installed = false;
    for (const step of job.steps ?? []) {
      installed ||= installsRootRuntime(step);
      if (
        (/\.github\/actions\/upload-(?:artifact-with-retry|optional-artifact)$/u.test(
          step.uses ?? '',
        ) ||
          /pnpm check:no-reports\b/u.test(step.run ?? '')) &&
        !installed
      )
        missing.push(`${jobId}: ${step.name ?? step.uses}`);
    }
  }
  return missing;
}

test('all maintained upload lanes and the reports gate provision their declared runtime first', () => {
  for (const file of readdirSync(resolve(root, '.github/workflows')).filter((file) =>
    /\.ya?ml$/u.test(file),
  )) {
    const workflow = parse(readFileSync(resolve(root, '.github/workflows', file), 'utf8'));
    assert.deepEqual(missingRuntimeSteps(workflow), [], file);
  }
  const upload = { uses: './.github/actions/upload-artifact-with-retry' };
  const setupOnly = { jobs: { native: { steps: [{ uses: 'actions/setup-node@v5' }, upload] } } };
  assert.deepEqual(missingRuntimeSteps(setupOnly), [
    'native: ./.github/actions/upload-artifact-with-retry',
  ]);
  const install = {
    run: 'pnpm install --frozen-lockfile --ignore-scripts --filter forgeax-engine',
  };
  for (const invalid of [
    { ...install, 'continue-on-error': true },
    { ...install, if: 'false' },
    { ...install, run: install.run.replace('forgeax-engine', '@forgeax/engine-physics-rapier3d') },
  ])
    assert.equal(missingRuntimeSteps({ jobs: { native: { steps: [invalid, upload] } } }).length, 1);
  assert.deepEqual(missingRuntimeSteps({ jobs: { native: { steps: [install, upload] } } }), []);
});

function copyInstallInputs(destination) {
  const paths = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--',
      'package.json',
      '**/package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
      '.npmrc',
      'patches/**',
    ],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  for (const path of paths) {
    mkdirSync(dirname(resolve(destination, path)), { recursive: true });
    copyFileSync(resolve(root, path), resolve(destination, path));
  }
  const manifestPath = resolve(destination, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.scripts.postinstall =
    'node -e "throw new Error(\'native lifecycle must stay disabled\')"';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  mkdirSync(resolve(destination, 'scripts/ci'), { recursive: true });
  copyFileSync(
    resolve(root, 'scripts/ci/check-no-reports.mjs'),
    resolve(destination, 'scripts/ci/check-no-reports.mjs'),
  );
}

test('a clean source-only lane installs the frozen root runtime without running lifecycle scripts', () => {
  const destination = mkdtempSync(join(tmpdir(), 'forgeax-artifact-runtime-'));
  try {
    copyInstallInputs(destination);
    mkdirSync(resolve(destination, 'artifacts/reports'), { recursive: true });
    writeFileSync(resolve(destination, 'artifacts/receipt.json'), '{"originalEvidence":true}');
    writeFileSync(
      resolve(destination, 'artifacts/reports/raw.json'),
      '{"prohibitedEvidence":true}',
    );
    const check = (path) =>
      spawnSync(process.execPath, ['scripts/ci/check-no-reports.mjs', '--upload-inputs'], {
        cwd: destination,
        encoding: 'utf8',
        env: {
          ...process.env,
          FORGEAX_ARTIFACT_NAME: 'native-evidence',
          FORGEAX_ARTIFACT_PATH: path,
        },
      });
    const absent = check('artifacts/receipt.json');
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /declared @actions\/glob dependency is unavailable/u);
    const [command, ...prefix] = pnpmCommand();
    // The fixture can live on another filesystem. Reuse the store populated by
    // the owning checkout instead of pnpm choosing an empty fixture-local store.
    const store = execFileSync(command, [...prefix, 'store', 'path'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    const installed = spawnSync(
      command,
      [
        ...prefix,
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--filter',
        'forgeax-engine',
        '--offline',
        '--store-dir',
        store,
        '--package-import-method=copy',
      ],
      { cwd: destination, encoding: 'utf8', env: { ...process.env, CI: 'true' } },
    );
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    const allowed = check('artifacts/receipt.json');
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    const rejected = check('artifacts/**');
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /reports-upload-file/u);
    const excluded = check('artifacts/**\n!artifacts/reports/**');
    assert.equal(excluded.status, 0, excluded.stdout + excluded.stderr);
    assert.equal(
      readFileSync(resolve(destination, 'artifacts/receipt.json'), 'utf8'),
      '{"originalEvidence":true}',
    );
    assert.equal(
      readFileSync(resolve(destination, 'artifacts/reports/raw.json'), 'utf8'),
      '{"prohibitedEvidence":true}',
    );
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
