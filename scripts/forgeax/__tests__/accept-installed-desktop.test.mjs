import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkInstalledDesktop } from '../accept-installed-desktop.mjs';

const priorTime = '2026-11-22T01:00:00Z';
const upgradeTime = '2026-11-22T01:01:00Z';

function inputs(platform, upgraded = false) {
  const receipt = {
    format: 'native',
    platform,
    arch: platform === 'macos' ? 'arm64' : 'x64',
    project: { id: 'template-game-3d' },
    bundleId: 'com.example.game',
    upgradeCode: 'upgrade-family',
    version: upgraded ? '1.10.0' : '1.2.0',
    sha256: (upgraded ? 'b' : 'a').repeat(64),
    gameManifestSha256: (upgraded ? 'd' : 'c').repeat(64),
    nodeVersion: '24.11.1',
  };
  const event = {
    schemaVersion: 1,
    platform,
    arch: receipt.arch,
    projectId: receipt.project.id,
    gameManifestSha256: receipt.gameManifestSha256,
    backend: 'webgpu',
    adapter: { nativeBackend: platform === 'macos' ? 'Metal' : 'Dx12' },
    nodeVersion: receipt.nodeVersion,
    launch: {
      id: upgraded ? 'second-run' : 'first-run',
      startedAt: upgraded ? upgradeTime : priorTime,
    },
    completedFrames: 60,
    frame: { presentation: 'ready' },
  };
  return {
    receipt,
    artifactSha256: receipt.sha256,
    log: `[forgeax.desktop.completed] ${JSON.stringify(event)}\r\n`,
    checkpoint: JSON.stringify({ version: 1, data: { x: 8, y: 2, z: 0, yaw: 0, pitch: 0 } }),
    checkpointObservation: upgraded ? 'restored' : 'saved',
    recordedAt: upgraded ? upgradeTime : priorTime,
  };
}

for (const platform of ['windows', 'macos']) {
  test(`correlates ${platform} installer, actual launch and unchanged checkpoint across upgrade`, () => {
    const baseline = checkInstalledDesktop(inputs(platform));
    const updated = inputs(platform, true);
    const verified = checkInstalledDesktop({ ...updated, previous: baseline });
    assert.equal(verified.checkpointSha256, baseline.checkpointSha256);
    assert.equal(verified.checkpointObservation, 'restored');
    assert.throws(
      () =>
        checkInstalledDesktop({ ...updated, log: updated.log.replace('nativeBackend', 'other') }),
      /native adapter backend/,
    );
    assert.throws(
      () => checkInstalledDesktop({ ...updated, previous: baseline, log: inputs(platform).log }),
      /manifest/,
    );
    assert.throws(
      () =>
        checkInstalledDesktop({
          ...updated,
          previous: baseline,
          checkpoint: updated.checkpoint.replace('"x":8', '"x":9'),
        }),
      /checkpointSha256/,
    );
    assert.throws(
      () =>
        checkInstalledDesktop({
          ...updated,
          previous: baseline,
          artifactSha256: baseline.artifactSha256,
        }),
      /Installer differs/,
    );
    assert.throws(
      () =>
        checkInstalledDesktop({
          ...updated,
          previous: baseline,
          log: updated.log.replace('second-run', 'first-run'),
        }),
      /Launch receipt was reused/,
    );
  });
}
