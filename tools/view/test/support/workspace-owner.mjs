import { createEngineWorkspaceRuntime, createEngineWorkspaceTools, createEngineWorkspaceAppPreview } from '@forgeax/engine/app';
import { createToolApi } from '@forgeax/engine-tool-runtime';
import { World } from '@forgeax/engine/ecs';
import { ViewWorkspaceBroker } from '@forgeax/view-workspace-core/broker';

/** Independent Engine owner for transport-only tests; no browser/GPU evidence. */
export class WorkspaceFixture extends ViewWorkspaceBroker {
  constructor({ engine, ...options } = {}) {
    const runtime = engine ? createEngineWorkspaceRuntime(engine) : undefined;
    const toolApi = createToolApi();
    if (runtime) toolApi.registerProvider({ providerId: 'fixture-engine', sourceId: 'engine-workspace', realm: 'host', tools: createEngineWorkspaceTools(runtime) });
    super({ ...options, engine: runtime, toolApi });
    this.disposeOwner = async () => { await runtime?.dispose(); await toolApi.dispose(); };
  }
  async dispose() { await super.dispose(); await this.disposeOwner(); }
}

/** Use Engine's transaction implementation over a deterministic observation port. */
export async function transactionPreview({ target, asset, camera, close, capture }) {
  let current = structuredClone(camera);
  const preview = await createEngineWorkspaceAppPreview({
    app: { world: new World(), observation: { camera: {
      get: () => structuredClone(current), set: value => { current = structuredClone(value); return current; },
    } } },
    assets: {}, asset: { ...asset, kind: 'mesh' }, target,
    openResourcePreview: () => ({}), close, capture,
  });
  return { ...preview, asset };
}

/** Test asset owner with a deliberate CAS rejection; View must forward it. */
export function assetOperationsFixture(engine) {
  engine.inspectAsset = async ({ guid }) => {
    const asset = await engine.assetInspect({ subject: guid });
    const source = { path: asset.sourcePath, kind: 'pack.ts' };
    const metadata = await engine.pack?.inspect?.(asset.sourcePath);
    return { guid, asset, source, ...metadata,
      ...(asset.cookReceiptUrl ? { ddc: { receiptUrl: asset.cookReceiptUrl } } : {}),
    };
  };
  engine.rebuildAssetSource = async ({ guid, expectedRevision, requestId, mode }) => {
    const before = await engine.inspectAsset({ guid });
    if (before.revision !== expectedRevision) throw Object.assign(new Error('pack-source-revision-conflict'), { code: 'pack-source-revision-conflict', expected: expectedRevision, hint: 'Inspect current revision.', detail: { requestId } });
    const result = await engine.pack.rebuild(before.source.path, mode);
    const response = { guid, mode, sourcePath: before.source.path, ...result, inspection: await engine.inspectAsset({ guid }) };
    return response;
  };
  return engine;
}
