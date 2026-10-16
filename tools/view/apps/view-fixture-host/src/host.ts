import { createViewBackend } from '../../../src/plugins/backend.ts';
import { PROJECT_ROOT, SCENE_ASSET_ID } from './scenarios/default.ts';
import { createFixtureArtifacts } from './artifacts.ts';
import { createFixtureWorkspaceProvider } from './workspace-provider.ts';

export async function startFixtureHost({ port = 0 }: { port?: number } = {}) {
  const artifacts = await createFixtureArtifacts();
  let backend: Awaited<ReturnType<typeof createViewBackend>> | undefined;
  try {
    const started = await createViewBackend({
      workspaceEngine: createFixtureWorkspaceProvider(),
      workspaceHost: '127.0.0.1',
      workspacePort: port,
      staticRoot: artifacts.root,
    });
    backend = started;
    const core = started.workspaceCore;
    await core.openProject({ root: PROJECT_ROOT });
    const projectId = core.snapshot().project?.id;
    if (!projectId) throw new Error('Fixture project did not open');
    await core.listAssets({ projectId });
    await core.openAsset({ projectId, guid: SCENE_ASSET_ID });
    const state = core.snapshot();
    if (!state.preview?.target || !state.assets?.length) throw new Error('Fixture scene did not initialize');
    const origin = `http://127.0.0.1:${started.workspaceServer!.port}`;
    return {
      origin, backend: started, state,
      dispose: async () => {
        try { await started.dispose(); }
        finally { await artifacts.dispose(); }
      },
    };
  } catch (error) {
    try { await backend?.dispose(); }
    finally { await artifacts.dispose(); }
    throw error;
  }
}
