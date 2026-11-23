import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const completedPrefix = '[forgeax.desktop.completed] ';
const sha256 = /^[a-f0-9]{64}$/;

function installedLaunch(log, receipt) {
  for (const line of log.split(/\r?\n/).reverse()) {
    if (!line.startsWith(completedPrefix)) continue;
    const event = JSON.parse(line.slice(completedPrefix.length));
    if (event.gameManifestSha256 === receipt.gameManifestSha256) return event;
  }
  throw new Error('No completed installed launch matches the packaged game manifest');
}

function validateUpgrade(previous, current) {
  assert.equal(previous.schemaVersion, 1);
  assert.equal(previous.checkpointObservation, 'saved');
  for (const field of ['platform', 'arch', 'projectId', 'installIdentity', 'checkpointSha256']) {
    assert.equal(current[field], previous[field], `Upgrade changed ${field}`);
  }
  assert.ok(
    current.version.localeCompare(previous.version, 'en', { numeric: true }) > 0,
    'Upgrade must install a newer version',
  );
  assert.notEqual(current.artifactSha256, previous.artifactSha256, 'Installer was reused');
  assert.notEqual(current.gameManifestSha256, previous.gameManifestSha256, 'Game was not replaced');
  assert.notEqual(current.launch.id, previous.launch.id, 'Launch receipt was reused');
  assert.ok(
    Date.parse(current.launch.startedAt) >= Date.parse(previous.recordedAt),
    'Upgrade must launch after the baseline evidence was recorded',
  );
}

/** Project Game 3D installed evidence without launching an installer or changing user data. */
export function checkInstalledDesktop({
  receipt,
  artifactSha256,
  log,
  checkpoint,
  checkpointObservation,
  previous,
  devices = {},
  recordedAt = new Date().toISOString(),
}) {
  assert.equal(receipt.format, 'native');
  assert.ok(sha256.test(receipt.gameManifestSha256), 'Package receipt lacks sealed game identity');
  assert.ok(sha256.test(artifactSha256), 'Invalid installer digest');
  assert.equal(artifactSha256, receipt.sha256, 'Installer differs from its package receipt');
  assert.match(receipt.version, /^\d+\.\d+\.\d+$/);
  const installIdentity = receipt.platform === 'macos' ? receipt.bundleId : receipt.upgradeCode;
  assert.ok(installIdentity, 'Missing installer family identity');
  const event = installedLaunch(log, receipt);
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.platform, receipt.platform);
  assert.equal(event.arch, receipt.arch);
  assert.equal(event.projectId, receipt.project.id);
  assert.equal(event.nodeVersion, receipt.nodeVersion);
  assert.ok(['webgpu', 'wgpu-native'].includes(event.backend), 'Unexpected Renderer backend');
  assert.equal(
    event.adapter?.nativeBackend,
    receipt.platform === 'macos' ? 'Metal' : 'Dx12',
    'Unexpected native adapter backend',
  );
  assert.equal(event.completedFrames, 60);
  assert.equal(event.frame?.presentation, 'ready');
  assert.ok(event.launch?.id && Number.isFinite(Date.parse(event.launch.startedAt)));
  const { version, data } = JSON.parse(checkpoint);
  assert.equal(version, 1);
  assert.ok(
    [data?.x, data?.y, data?.z, data?.yaw, data?.pitch].every(Number.isFinite),
    'Game 3D checkpoint has no saved position and view',
  );
  assert.equal(checkpointObservation, previous === undefined ? 'saved' : 'restored');
  const result = {
    schemaVersion: 1,
    recordedAt,
    platform: event.platform,
    arch: event.arch,
    projectId: event.projectId,
    installIdentity,
    version: receipt.version,
    artifactSha256,
    gameManifestSha256: event.gameManifestSha256,
    launch: event.launch,
    completedFrames: event.completedFrames,
    backend: event.backend,
    adapter: event.adapter,
    rayQuery: event.rayQuery,
    diffuseGi: event.diffuseGi,
    checkpointSha256: createHash('sha256').update(checkpoint).digest('hex'),
    checkpointObservation,
    devices,
  };
  if (previous !== undefined) validateUpgrade(previous, result);
  return result;
}

async function logTail(path) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

async function readJson(path) {
  const bytes = await readFile(path);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8';
  return JSON.parse(new TextDecoder(encoding).decode(bytes));
}

async function main() {
  const { values } = parseArgs({
    options: {
      receipt: { type: 'string' },
      artifact: { type: 'string' },
      log: { type: 'string' },
      output: { type: 'string' },
      baseline: { type: 'string' },
      observed: { type: 'string' },
      controller: { type: 'boolean' },
      ime: { type: 'boolean' },
      audio: { type: 'boolean' },
    },
  });
  assert.ok(
    values.receipt && values.artifact && values.log && values.output && values.observed,
    'Pass --receipt, --artifact, --log, --output and --observed saved|restored',
  );
  const receipt = (await readJson(values.receipt)).value;
  assert.ok(receipt?.project?.id, 'Expected forgeax project package --json output');
  const platform = { win32: 'windows', darwin: 'macos' }[process.platform];
  assert.ok(platform && platform === receipt.platform, 'Run this on the installed release target');
  assert.equal(process.arch, receipt.arch, 'Run with the target architecture Node');
  const dataRoot =
    platform === 'windows'
      ? (process.env.LOCALAPPDATA ?? homedir())
      : join(homedir(), '.local', 'share');
  const key = Buffer.from(receipt.project.id, 'utf8').toString('base64url');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(values.artifact)) hash.update(bytes);
  const evidence = checkInstalledDesktop({
    receipt,
    artifactSha256: hash.digest('hex'),
    log: await logTail(values.log),
    checkpoint: await readFile(join(dataRoot, 'ForgeaX', key, 'saves', 'slot-checkpoint.json')),
    checkpointObservation: values.observed,
    previous: values.baseline === undefined ? undefined : await readJson(values.baseline),
    devices: {
      controller: values.controller === true ? 'observed' : 'unverified',
      ime: values.ime === true ? 'observed' : 'unverified',
      audio: values.audio === true ? 'observed' : 'unverified',
    },
  });
  await writeFile(values.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  console.log(`Recorded installed desktop evidence at ${values.output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((cause) => {
    console.error(cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  });
}
