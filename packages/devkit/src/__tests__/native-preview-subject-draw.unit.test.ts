import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runBrowserResourcePreviewHost = vi.hoisted(() => vi.fn());
const publishPreviewArtifacts = vi.hoisted(() => vi.fn());

vi.mock('../tools/browser-host.js', () => ({
  publishPreviewArtifacts,
  runBrowserResourcePreviewHost,
}));

import { runNativePreviewTool } from '../tools/native-preview.js';
import { nativePreviewTools } from '../tools/preview-catalog.js';

const temporaryRoots: string[] = [];

async function previewProject(row: Record<string, unknown>, scoped = false): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-preview-catalog-'));
  temporaryRoots.push(root);
  await mkdir(resolve(root, 'dist'));
  await writeFile(
    resolve(root, 'forge.json'),
    '{"id":"preview","name":"Preview","schemaVersion":"3.0.0","roots":{}}\n',
  );
  await writeFile(
    resolve(root, 'package.json'),
    '{"name":"preview","version":"0.0.0","packageManager":"pnpm@12.10.1"}\n',
  );
  const catalog = scoped
    ? {
        schemaVersion: 'runtime-catalog-snapshot-v1',
        scopeId: 'preview',
        generation: 1,
        authority: 'authoritative',
        entries: [row],
        diagnostics: [],
      }
    : [row];
  await writeFile(resolve(root, 'dist', 'pack-index.json'), `${JSON.stringify(catalog)}\n`);
  return root;
}

afterEach(async () => {
  runBrowserResourcePreviewHost.mockReset();
  publishPreviewArtifacts.mockReset();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('native preview subject evidence', () => {
  it('retries an unavailable adapter once with the software backend', async () => {
    const unavailable = {
      ok: false,
      error: {
        code: 'tool-preview-browser-host-failed',
        expected: 'an available adapter',
        hint: 'select an available adapter',
        detail: { phase: 'capture-startup', cause: { code: 'adapter-unavailable' } },
      },
    };
    runBrowserResourcePreviewHost.mockResolvedValue(unavailable);
    const preview = nativePreviewTools.find((tool) => tool.descriptor.id === 'asset.mesh.preview');
    if (!preview) throw new Error('Missing mesh preview');
    await expect(
      runNativePreviewTool(
        preview,
        { guid: '019fb7ce-3200-7000-8000-00000000000d' },
        {},
        '/tmp/forgeax-preview-adapter-unavailable',
      ),
    ).resolves.toMatchObject({ outcome: 'failed' });
    expect(runBrowserResourcePreviewHost).toHaveBeenCalledTimes(2);
    expect(runBrowserResourcePreviewHost.mock.calls[1]?.[6]).toMatchObject({ backend: 'software' });
  });

  it('returns a GPU replay failure once without rerunning the completed capture', async () => {
    const evidence = { kind: 'png' as const, digest: 'sha256:failed', uri: 'capture.png' };
    runBrowserResourcePreviewHost.mockResolvedValue({
      ok: false,
      error: {
        code: 'tool-preview-browser-host-failed',
        expected: 'fresh replay',
        hint: 'repair the replay validation error',
        detail: { phase: 'replay-run', cause: { code: 'webgpu-runtime-error' } },
      },
      artifacts: [evidence],
    });
    const preview = nativePreviewTools.find((tool) => tool.descriptor.id === 'asset.mesh.preview');
    if (!preview) throw new Error('Missing mesh preview');
    await expect(
      runNativePreviewTool(
        preview,
        { guid: '019fb7ce-3200-7000-8000-00000000000d' },
        {},
        '/tmp/forgeax-preview-replay-failed',
      ),
    ).resolves.toMatchObject({ outcome: 'failed', artifacts: [evidence] });
    expect(runBrowserResourcePreviewHost).toHaveBeenCalledOnce();
  });

  it('retains capture artifacts while returning a structured capability failure', async () => {
    const guid = '019fb7ce-3200-7000-8000-00000000000e';
    const evidence = {
      kind: 'png' as const,
      digest: 'sha256:fresh-replay',
      uri: 'preview/fresh-replay.png',
      sizeBytes: 12,
    };
    runBrowserResourcePreviewHost.mockResolvedValue({
      ok: true,
      value: {
        actualCarrier: 'headless-private',
        artifacts: [],
        drawCalls: 2,
        nonBlackPixels: 512 * 512,
        resource: {
          asset: { kind: 'material' },
          guid,
          kind: 'material',
          ownerFacts: { subjectDigest: 'sha256:subject' },
        },
        capabilityFailure: {
          code: 'tool-preview-capability-unavailable',
          expected: 'a skinned material preview mesh with skin bindings',
          hint: 'Preview this material through a scene or mesh that supplies the skinning contract.',
          detail: { phase: 'capture-render' },
        },
        trace: { events: ['renderer-created', 'world-updated'] },
      },
    });
    publishPreviewArtifacts.mockResolvedValue({
      artifacts: [evidence],
      png: { uri: 'preview/fresh-replay.png', width: 512, height: 512 },
    });
    const materialPreview = nativePreviewTools.find(
      (candidate) => candidate.descriptor.id === 'asset.material.preview',
    );
    expect(materialPreview).toBeDefined();
    if (materialPreview === undefined) return;

    await expect(
      runNativePreviewTool(
        materialPreview,
        { guid, size: 512 },
        {},
        '/tmp/forgeax-preview-capability',
      ),
    ).resolves.toMatchObject({
      outcome: 'failed',
      failure: {
        code: 'tool-domain-failed',
        detail: { code: 'tool-preview-capability-unavailable' },
      },
      artifacts: [evidence],
    });
    expect(publishPreviewArtifacts).toHaveBeenCalledOnce();
    expect(publishPreviewArtifacts.mock.calls[0]?.[3]).toBeUndefined();
  });

  it('rejects a material capture containing only canonical presentation draws', async () => {
    runBrowserResourcePreviewHost.mockResolvedValue({
      ok: true,
      value: {
        actualCarrier: 'headless-private',
        artifacts: [],
        drawCalls: 2,
        nonBlackPixels: 512 * 512,
        resource: {
          asset: { kind: 'material' },
          guid: '019fb7ce-3200-7000-8000-00000000000d',
          kind: 'material',
          ownerFacts: { subjectDigest: 'sha256:subject' },
        },
        trace: { events: ['renderer-created', 'world-updated'] },
      },
    });
    const materialPreview = nativePreviewTools.find(
      (candidate) => candidate.descriptor.id === 'asset.material.preview',
    );
    expect(materialPreview).toBeDefined();
    if (materialPreview === undefined) return;

    await expect(
      runNativePreviewTool(
        materialPreview,
        { guid: '019fb7ce-3200-7000-8000-00000000000d', size: 512 },
        {},
        '/tmp/forgeax-preview-subject-draw',
        { backend: 'software', headless: false, width: 128, height: 64, output: 'capture.png' },
      ),
    ).resolves.toMatchObject({
      outcome: 'failed',
      failure: {
        code: 'tool-domain-failed',
        detail: {
          code: 'tool-preview-subject-not-rendered',
          payload: { kind: 'material', drawCalls: 2 },
        },
      },
    });
    expect(runBrowserResourcePreviewHost).toHaveBeenCalledWith(
      '/tmp/forgeax-preview-subject-draw',
      expect.objectContaining({ viewport: { width: 128, height: 64 } }),
      expect.anything(),
      expect.any(String),
      expect.any(AbortSignal),
      expect.objectContaining({ kind: 'material', guid: '019fb7ce-3200-7000-8000-00000000000d' }),
      { publish: false, backend: 'software', headless: false },
    );
  });

  it('returns a bounded structured failure when the Browser Host does not settle', async () => {
    let aborted = false;
    runBrowserResourcePreviewHost.mockImplementation(
      (_root: string, _recipe: unknown, _snapshot: unknown, _runId: string, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('Browser Host aborted'));
            },
            { once: true },
          );
        }),
    );
    const meshPreview = nativePreviewTools.find(
      (candidate) => candidate.descriptor.id === 'asset.mesh.preview',
    );
    expect(meshPreview).toBeDefined();
    if (meshPreview === undefined) return;

    const pending = runNativePreviewTool(
      meshPreview,
      { guid: '019fb7ce-3200-7000-8000-00000000000d', size: 64 },
      { deadlineMs: 20 },
      '/tmp/forgeax-preview-timeout',
    );
    await expect(pending).resolves.toMatchObject({
      outcome: 'failed',
      failure: {
        code: 'tool-domain-failed',
        detail: { code: 'tool-preview-timeout' },
      },
    });
    expect(aborted).toBe(true);
  });

  it.each([
    false,
    true,
  ])('rejects disabled preview before Browser Host startup: scoped=%s', async (scoped) => {
    const guid = '019fb7ce-3200-7000-8000-00000000000d';
    const root = await previewProject(
      {
        guid,
        kind: 'mesh',
        lifecycle: 'current',
        projection: { operations: { preview: { enabled: false, reason: 'direct asset' } } },
        operations: { preview: { enabled: true } },
        publication: { current: { packageUrl: '/assets/direct.pack.json' } },
      },
      scoped,
    );
    const meshPreview = nativePreviewTools.find(
      (candidate) => candidate.descriptor.id === 'asset.mesh.preview',
    );
    expect(meshPreview).toBeDefined();
    if (meshPreview === undefined) return;

    await expect(
      runNativePreviewTool(meshPreview, { guid, size: 64 }, {}, root),
    ).resolves.toMatchObject({
      outcome: 'failed',
      failure: { detail: { code: 'asset-preview-disabled' } },
    });
    expect(runBrowserResourcePreviewHost).not.toHaveBeenCalled();
  });

  it.each([
    false,
    true,
  ])('allows a published imported catalog row without Pack identity: scoped=%s', async (scoped) => {
    const guid = '019fb7ce-3200-7000-8000-00000000000d';
    const root = await previewProject(
      {
        guid,
        kind: 'mesh',
        lifecycle: 'current',
        subject: 'imported-output',
        projection: { operations: { preview: { enabled: true } } },
        operations: { preview: { enabled: false } },
        publication: { current: { packageUrl: '/assets/imported.pack.json' } },
      },
      scoped,
    );
    runBrowserResourcePreviewHost.mockResolvedValue({
      ok: true,
      value: {
        actualCarrier: 'headless-private',
        artifacts: [],
        drawCalls: 2,
        nonBlackPixels: 512 * 512,
        resource: {
          asset: {
            kind: 'mesh',
            digest: 'sha256:mesh-subject',
            vertexDigest: 'sha256:mesh-vertices',
            indexDigest: 'sha256:mesh-indices',
            submeshDigest: 'sha256:mesh-submeshes',
            aabbDigest: 'sha256:mesh-aabb',
            aabb: [-1, -1, 0, 1, 1, 0],
            submeshes: [
              { topology: 'triangle-list', indexOffset: 0, indexCount: 3, materialSlot: 0 },
            ],
            materialSlots: [{ slotName: 'default' }],
          },
          guid,
          kind: 'mesh',
          ownerFacts: { subjectDigest: 'sha256:subject' },
        },
        trace: { events: ['renderer-created', 'world-updated'] },
      },
    });
    const evidence = {
      kind: 'rhi-tape' as const,
      digest: 'sha256:tape',
      uri: 'preview/rhi-tape.json',
      sizeBytes: 12,
    };
    publishPreviewArtifacts.mockResolvedValue({
      artifacts: [evidence],
      png: { uri: 'preview/fresh-replay.png', width: 64, height: 64 },
    });
    const meshPreview = nativePreviewTools.find(
      (candidate) => candidate.descriptor.id === 'asset.mesh.preview',
    );
    expect(meshPreview).toBeDefined();
    if (meshPreview === undefined) return;

    await expect(
      runNativePreviewTool(meshPreview, { guid, size: 64 }, {}, root),
    ).resolves.toMatchObject({
      outcome: 'failed',
      failure: { code: 'tool-domain-failed' },
      artifacts: [evidence],
    });
    expect(runBrowserResourcePreviewHost).toHaveBeenCalledOnce();
    expect(publishPreviewArtifacts).toHaveBeenCalledOnce();
  });
});
