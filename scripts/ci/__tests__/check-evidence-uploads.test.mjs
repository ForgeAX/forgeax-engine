import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isEvidenceUpload } from '../check-evidence-uploads.mjs';

const checkScript = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../check-evidence-uploads.mjs',
);

test('rejects generated evidence reports, raw measurements, logs and media', () => {
  for (const path of [
    'packages/audio-webaudio/bench/music/evidence/current/raw.json',
    'scripts/ci/evidence/dawn.log',
    'packages/path/evidence/performance.csv',
    'apps/bevy/fog/evidence/fog-visual.png',
    'apps/tetris/AUDIT-EVIDENCE.md',
    'apps/hello/taa/visual-evidence.json',
    'artifacts/format-tier1/final-gates.json',
    'artifacts/path-bench/performance.json',
    'packages/audio-webaudio/bench/music/evidence/current/raw.bin',
    'packages/audio-webaudio/bench/music/evidence/current/capture.unknown',
    'apps/hello/taa/evidence/capture.ogg',
    'packages/render/bench/render-bundle-evidence/performance.json',
    'scripts/dev-verify/roi-24-spline-ik/public-evidence/skin.png',
    'artifacts/release/receipt.unknown',
  ]) {
    assert.equal(isEvidenceUpload(path), true, path);
  }
});

test('allows evidence-producing source, schemas, tests and retained author inputs', () => {
  for (const path of [
    'packages/pack/src/evidence/offline-evidence.ts',
    'scripts/ci/evidence/fingerprint.mjs',
    'scripts/ci/evidence/vertex-color-gate-report.schema.json',
    'apps/hello/format-tier1/evidence/__tests__/recovery-scenarios.test.mjs',
    'apps/hello/physical-material/evidence/case-input.json',
    'apps/hello/taa/evidence/visual-cases.json',
  ]) {
    assert.equal(isEvidenceUpload(path), false, path);
  }
});

test('normal product and source files are not classified as evidence uploads', () => {
  for (const path of [
    'packages/audio-webaudio/src/music-transport.ts',
    'apps/hello/taa/scripts/capture-visual-evidence.mjs',
    'scripts/forgeax/visual-evidence.schema.json',
    'apps/hello/format-tier1/fixtures/meshopt-triangle-reference.json',
  ]) {
    assert.equal(isEvidenceUpload(path), false, path);
  }
});

test('the CI entrypoint rejects a committed capture and accepts an ordinary source change', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-evidence-upload-check-'));
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git(['init', '--quiet']);
    git(['config', 'user.email', 'ci@example.invalid']);
    git(['config', 'user.name', 'ForgeaX CI']);
    writeFileSync(join(root, 'package.json'), '{"private":true}\n');
    git(['add', 'package.json']);
    git(['commit', '--quiet', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']);

    const capturePath = join(root, 'artifacts', 'browser', 'frame.png');
    mkdirSync(dirname(capturePath), { recursive: true });
    writeFileSync(capturePath, 'capture');
    git(['add', 'artifacts/browser/frame.png']);
    git(['commit', '--quiet', '-m', 'capture']);
    const rejected = spawnSync(process.execPath, [checkScript], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_EVIDENCE_GUARD_BASE: base },
    });
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(rejected.stderr, /artifacts\/browser\/frame\.png/);

    const targetBase = git(['rev-parse', 'HEAD']);
    writeFileSync(join(root, 'src.ts'), 'export const ready = true;\n');
    git(['add', 'src.ts']);
    git(['commit', '--quiet', '-m', 'source on target branch']);
    const targetAccepted = spawnSync(process.execPath, [checkScript], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_EVIDENCE_GUARD_BASE: targetBase },
    });
    assert.equal(targetAccepted.status, 0, targetAccepted.stderr);
    assert.match(targetAccepted.stdout, /No generated evidence files/);

    const newCapturePath = join(root, 'artifacts', 'browser', 'new.png');
    writeFileSync(newCapturePath, 'new capture');
    git(['add', 'artifacts/browser/new.png']);
    git(['commit', '--quiet', '-m', 'new capture after target base']);
    const targetRejected = spawnSync(process.execPath, [checkScript], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_EVIDENCE_GUARD_BASE: targetBase },
    });
    assert.equal(targetRejected.status, 1, targetRejected.stdout);
    assert.match(targetRejected.stderr, /artifacts\/browser\/new\.png/);
    assert.doesNotMatch(targetRejected.stderr, /artifacts\/browser\/frame\.png/);

    git(['rm', '--quiet', 'artifacts/browser/new.png']);
    git(['rm', '--quiet', 'artifacts/browser/frame.png']);
    writeFileSync(join(root, 'src.ts'), 'export const ready = true;\n');
    git(['add', 'src.ts']);
    git(['commit', '--quiet', '-m', 'source']);
    const accepted = spawnSync(process.execPath, [checkScript], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_EVIDENCE_GUARD_BASE: base },
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /No generated evidence files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
