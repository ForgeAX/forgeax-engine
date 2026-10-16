import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => {
  const guid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const png = Buffer.from('fixture-png');
  const runtime = {
    openProject: vi.fn(),
    listAssets: vi.fn(),
    openPreview: vi.fn(),
    closePreview: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const session = {
    capture: vi.fn(),
    report: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const browser = {
    open: vi.fn(async () => session),
    close: vi.fn(async () => {}),
  };
  return { browser, guid, png, runtime, session };
});

vi.mock('@forgeax/engine-app', () => ({
  createEngineWorkspaceRuntime: vi.fn(() => fixtures.runtime),
}));
vi.mock('../software-capture.js', () => ({
  createBrowserCapture: vi.fn(() => fixtures.browser),
}));
vi.mock('../workspace-provider.js', () => ({
  createDevKitWorkspaceProvider: vi.fn(() => ({})),
}));

import { runScenePreviewTool } from '../tools/scene-preview.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('SceneAsset preview artifact retention', () => {
  it('retains Engine capture and renderer errors when compositor validation fails', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-scene-preview-artifact-'));
    temporaryRoots.push(root);
    const dataUri = `data:image/png;base64,${fixtures.png.toString('base64')}`;
    fixtures.runtime.openProject.mockResolvedValue({
      project: { id: 'fixture' },
      handle: { id: 'handle' },
      target: { url: 'http://127.0.0.1:4173/' },
    });
    fixtures.runtime.listAssets.mockResolvedValue([{ kind: 'scene', guid: fixtures.guid }]);
    fixtures.runtime.openPreview.mockResolvedValue({
      target: { targetId: 'target' },
      getCamera: vi.fn(async () => ({ entity: 1 })),
      capture: vi.fn(async () => ({
        targetId: 'target',
        frameId: 1,
        width: 2,
        height: 2,
        png: dataUri,
        errors: [{ code: 'render-record-failed', hint: 'injected owner failure' }],
      })),
    });
    fixtures.session.capture.mockRejectedValue(new Error('compositor validation rejected'));
    fixtures.session.report.mockReturnValue({ report: resolve(root, 'run.json') });

    const terminal = await runScenePreviewTool(
      { guid: fixtures.guid, width: 2, height: 2, backend: 'software' },
      root,
    );

    expect(terminal).toMatchObject({
      outcome: 'failed',
      failure: {
        detail: {
          code: 'scene-preview-failed',
          payload: {
            guid: fixtures.guid,
            errors: [{ code: 'render-record-failed', hint: 'injected owner failure' }],
            engineCapture: expect.stringContaining('engine-canvas.png'),
            report: 'run.json',
          },
        },
      },
    });
    expect(terminal.artifacts).toHaveLength(1);
    const engineArtifact = terminal.artifacts[0];
    expect(engineArtifact?.uri).toContain('engine-canvas.png');
    expect(engineArtifact?.sizeBytes).toBe(fixtures.png.byteLength);
    expect(await readFile(resolve(root, engineArtifact?.uri ?? 'missing'))).toEqual(fixtures.png);
  });
});
