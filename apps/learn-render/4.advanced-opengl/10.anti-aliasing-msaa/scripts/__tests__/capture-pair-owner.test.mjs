import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeTape } from '@forgeax/engine-rhi-debug';
import { compareCapturePair } from '../capture-pair-owner.mjs';

test('MSAA browser pair owns an ephemeral Vite port and reaps its process group', () => {
  const source = readFileSync(new URL('../smoke-browser-pair.mjs', import.meta.url), 'utf8');
  if (!source.includes('async function findFreePort()')) {
    throw new Error('MSAA browser pair must reserve an ephemeral Vite port');
  }
  if (!source.includes("portServer.listen(0, '127.0.0.1'")) {
    throw new Error('MSAA browser pair must bind its port probe to loopback');
  }
  if (!source.includes("'--port',\n  vitePort")) {
    throw new Error('MSAA browser pair must pass its owned port to Vite');
  }
  if (!source.includes('await stopViteServer(server)') || !source.includes("signal('SIGKILL')")) {
    throw new Error('MSAA browser pair must reap Vite after bounded SIGTERM/SIGKILL cleanup');
  }
  if (source.includes('localhost:5183') || source.includes('DEV_SERVER_URL')) {
    throw new Error('MSAA browser pair must not probe a shared fixed fallback port');
  }
});

test('pair owner reads bounded manifest projection and raw tape artifacts', () => {
  const tape = {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: [],
    events: [],
    blobs: [],
  };
  const encoded = encodeTape(tape);
  if (!encoded.ok) throw new Error('test tape encoding failed');
  const root = mkdtempSync(join(tmpdir(), 'forgeax-msaa-pair-'));
  const tapePath = join(root, 'capture.rhitape');
  writeFileSync(tapePath, encoded.value);
  const tapeDigest = `sha256:${createHash('sha256').update(encoded.value).digest('hex')}`;
  const artifact = (msaa, red) => ({
    artifactId: msaa ? 'on' : 'off',
    controls: { msaa },
    finalColorRgb8: [red, 0, 0, 255],
    pairedCaptureLineage: 'learn-render-msaa-browser-pair',
    workload: 'learn-render-4.10-anti-aliasing-msaa',
    logicalFrame: 'frame-1',
    captureEnvironment: 'browser-webgpu',
    evidenceScope: 'final-color-rgb8',
    outputShape: { width: 1, height: 1, channels: 4 },
    tapePath,
    tapeDigest,
    tapeFacts: { eventCount: 0, blobCount: 0 },
  });
  const manifestPath = join(root, 'pair.json');
  writeFileSync(
    manifestPath,
    JSON.stringify({ baseline: artifact(false, 10), comparison: artifact(true, 20) }),
  );

  const result = compareCapturePair(manifestPath);
  if (result.status !== 'accepted' || result.outcome !== 'divergence') {
    throw new Error(`bounded pair projection was not accepted: ${JSON.stringify(result)}`);
  }
  if (result.eventResource.lineage.total !== 0 || result.derivedMetrics.changedPixelCount !== 1) {
    throw new Error('raw tape and final-color proof were not preserved');
  }
});

test('pair owner rejects an external tape whose digest does not match', () => {
  const tape = {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: [],
    events: [],
    blobs: [],
  };
  const encoded = encodeTape(tape);
  if (!encoded.ok) throw new Error('test tape encoding failed');
  const root = mkdtempSync(join(tmpdir(), 'forgeax-msaa-pair-digest-'));
  const tapePath = join(root, 'capture.rhitape');
  writeFileSync(tapePath, encoded.value);
  const artifact = (msaa) => ({
    artifactId: msaa ? 'on' : 'off',
    controls: { msaa },
    finalColorRgb8: [0, 0, 0, 255],
    pairedCaptureLineage: 'learn-render-msaa-browser-pair',
    workload: 'learn-render-4.10-anti-aliasing-msaa',
    logicalFrame: 'frame-1',
    captureEnvironment: 'browser-webgpu',
    evidenceScope: 'final-color-rgb8',
    outputShape: { width: 1, height: 1, channels: 4 },
    tapePath,
    tapeDigest: 'sha256:wrong',
    tapeFacts: { eventCount: 0, blobCount: 0 },
  });
  const manifestPath = join(root, 'pair.json');
  writeFileSync(manifestPath, JSON.stringify({ baseline: artifact(false), comparison: artifact(true) }));

  if (!/digest: expected sha256:wrong, computed sha256:/.test(assertThrows(() => compareCapturePair(manifestPath)))) {
    throw new Error('external tape digest mismatch was not rejected');
  }
});

function assertThrows(callback) {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected callback to throw');
}
