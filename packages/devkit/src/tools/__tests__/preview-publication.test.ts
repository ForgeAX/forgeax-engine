import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publishPreviewArtifacts } from '../browser-host.js';
import type { PreviewHostResult } from '../preview-host.js';

function dataUri(bytes: Uint8Array, mediaType: string): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('resource preview artifact publication', () => {
  it('publishes report, capture, fresh replay, tape, and profile atomically', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'forgeax-preview-publication-'));
    const runId = 'material.preview:publication';
    const tapeBytes = Uint8Array.of(1, 2, 3);
    const captureBytes = Uint8Array.of(4, 5, 6);
    const replayBytes = Uint8Array.of(7, 8, 9);
    const profileBytes = Uint8Array.of(10, 11, 12);
    const manifest = {
      schemaVersion: '2.0.0' as const,
      identity: {
        runId,
        snapshotDigest: 'sha256:snapshot',
        subjectDigest: 'sha256:material',
        presentationDigest: 'sha256:presentation',
        captureId: 'capture',
        frameId: 0,
      },
      artifacts: [
        {
          owner: 'rhi-debug',
          kind: 'rhi-tape' as const,
          role: 'rhi-tape' as const,
          uri: dataUri(tapeBytes, 'application/json'),
          digest: digest(tapeBytes),
          byteLength: tapeBytes.byteLength,
          mediaType: 'application/json',
          derivedFrom: [],
        },
        {
          owner: 'capture',
          kind: 'png' as const,
          role: 'capture' as const,
          uri: dataUri(captureBytes, 'image/png'),
          digest: digest(captureBytes),
          byteLength: captureBytes.byteLength,
          mediaType: 'image/png',
          derivedFrom: [digest(tapeBytes)],
        },
        {
          owner: 'fresh-replay',
          kind: 'png' as const,
          role: 'fresh-replay' as const,
          uri: dataUri(replayBytes, 'image/png'),
          digest: digest(replayBytes),
          byteLength: replayBytes.byteLength,
          mediaType: 'image/png',
          derivedFrom: [digest(tapeBytes), digest(captureBytes)],
        },
        {
          owner: 'profiler',
          kind: 'profile-capture' as const,
          role: 'profile-capture' as const,
          uri: dataUri(profileBytes, 'application/json'),
          digest: digest(profileBytes),
          byteLength: profileBytes.byteLength,
          mediaType: 'application/json',
          derivedFrom: [],
        },
      ],
    };
    const result: PreviewHostResult = {
      actualCarrier: 'headless-private',
      trace: {
        events: [],
        backend: 'webgpu',
        adapter: 'webgpu-adapter',
        presentation: 'hidden',
      },
      captureId: 'capture',
      drawCalls: 1,
      committedDrawIndex: 0,
      nonBlackPixels: 1,
      actionTrace: [],
      tape: {
        runId,
        jsonUri: dataUri(tapeBytes, 'application/json'),
        blobUri: dataUri(tapeBytes, 'application/octet-stream'),
        byteLength: tapeBytes.byteLength,
      },
      profile: { captureId: 'capture', uri: dataUri(profileBytes, 'application/json') },
      capturePng: { uri: dataUri(captureBytes, 'image/png'), width: 1, height: 1 },
      png: { uri: dataUri(replayBytes, 'image/png'), width: 1, height: 1 },
      manifest,
      artifacts: [],
      operationTiming: { startedAtMs: 0, endedAtMs: 1, durationMs: 1 },
    };
    try {
      const published = await publishPreviewArtifacts(projectRoot, runId, result, {
        snapshot: { revision: 1, digest: 'sha256:snapshot' },
        subject: { kind: 'material', guid: 'material', digest: 'sha256:material' },
        presentation: {
          kind: 'lit-asset',
          geometry: 'handle-sphere',
          skylight: 'engine-canonical',
          directionalLight: 'engine-canonical',
          skybox: 'engine-canonical',
        },
        oracle: {
          status: 'passed',
          subjectBound: true,
          drawCalls: 1,
          dispatches: 0,
          rendererHealthy: true,
          detail: { kind: 'material', rendererHealthy: true },
        },
      });
      const runRoot = join(
        projectRoot,
        '.forgeax',
        'tool-runs',
        runId.replace(/[^a-zA-Z0-9._-]/g, '_'),
      );
      const publishedManifest = JSON.parse(
        await readFile(join(runRoot, 'manifest.json'), 'utf8'),
      ) as typeof manifest;
      const report = JSON.parse(await readFile(join(runRoot, 'report.json'), 'utf8')) as {
        readonly runId: string;
        readonly snapshot: { readonly digest: string };
      };
      expect(published.manifest.artifacts.map((artifact) => artifact.role)).toEqual([
        'report',
        'rhi-tape',
        'capture',
        'fresh-replay',
        'profile-capture',
      ]);
      expect(publishedManifest.identity).toEqual(manifest.identity);
      expect(report).toMatchObject({ runId, snapshot: { digest: 'sha256:snapshot' } });
      expect(published.artifacts).toHaveLength(5);
      const tamperedResult = {
        ...result,
        manifest: {
          ...result.manifest,
          artifacts: result.manifest.artifacts.map((artifact) =>
            artifact.role === 'rhi-tape' ? { ...artifact, digest: 'sha256:tampered' } : artifact,
          ),
        },
      };
      await expect(publishPreviewArtifacts(projectRoot, runId, tamperedResult)).rejects.toThrow(
        'digest mismatch',
      );
      const stagingEntries = await readdir(join(projectRoot, '.forgeax', 'tool-runs'));
      expect(stagingEntries.some((entry) => entry.startsWith('.staging-'))).toBe(false);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
