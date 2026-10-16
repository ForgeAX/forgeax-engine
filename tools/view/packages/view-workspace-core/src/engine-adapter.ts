import type { EngineWorkspaceProvider, EngineWorkspaceCameraInput, EngineWorkspacePreview } from '@forgeax/engine/app';
import type { WorkspaceAsset, WorkspaceProject } from './contract.ts';
import { workspaceDiagnosticRecord } from './command-error.ts';
type EngineAssetEntry = Partial<WorkspaceAsset> & { lifecycle?: string; state?: string; receiptUrl?: string };
type AssetAdapterInput = { project?: WorkspaceProject; root?: string; asset?: EngineAssetEntry; subject?: unknown; requestId?: string; sourcePath?: string; expectedRevision?: string; mode?: 'rebuild' | 'cold-cook' };
type CapabilityMethod = (...args: unknown[]) => unknown;
import { ViewWorkspaceError } from './contract.ts';

/**
 * View binds the Engine public workspace / DevKit / ScriptablePack surfaces.
 * It does not invent inspectAsset, applyParams, cookAsset, or inspectDdc.
 *
 * Engine owners:
 * - catalog: `assetList` / `asset.list` / existing `listAssets` → PackEntry[]
 * - inspect: DevKit `assetInspect({ root, subject })` plus optional
 *   ScriptablePack `inspect(sourcePath)` / gateway `inspect-meta`
 * - cook: ScriptablePack `rebuild(sourcePath, mode)` / gateway
 *   `rebuild`|`cold-cook` / ToolClient `asset.source.rebuild`|`asset.source.cold-cook`
 */
export const VIEW_ENGINE_WORKSPACE_ADAPTER = Object.freeze({
  openProject: 'openProject({ root })',
  closeProject: 'closeProject({ project })',
  listAssets: 'assetList({ root }) | listAssets({ project })',
  openPreview: 'openPreview({ project, asset, width, height })',
  closePreview: 'preview.close()',
  resizePreview: 'preview.resize({ width, height })',
  getCamera: 'preview.getCamera()',
  beginCamera: 'preview.beginCameraInteraction({ interactionId, baseVersion, clientId })',
  updateCamera: 'preview.updateCameraDraft({ interactionId, input | camera })',
  commitCamera: 'preview.commitCamera({ interactionId, operationId, expectedVersion, camera })',
  abortCamera: 'preview.abortCamera({ interactionId, reason })',
  capture: 'preview.capture(options)',
  assetInspect: 'assetInspect({ root, subject })',
  packInspect: 'ScriptablePackAuthoringPort.inspect(sourcePath)',
  packRebuild: "ScriptablePackAuthoringPort.rebuild(sourcePath, 'rebuild' | 'cold-cook')",
  packGateway: "gateway.execute({ kind: 'inspect-meta' | 'rebuild' | 'cold-cook', sourcePath, requestId, expectedRevision })",
  packTools: "ToolClient.run('asset.source.rebuild' | 'asset.source.cold-cook', args)",
});

export const VIEW_ENGINE_ASSET_SOURCE_TOOLS = Object.freeze({
  rebuild: 'asset.source.rebuild',
  'cold-cook': 'asset.source.cold-cook',
});

function missing(name: string): never {
  throw new ViewWorkspaceError(
    'view-engine-capability-unavailable',
    `Engine workspace capability ${name} to be installed`,
    'Build and install the matching Engine workspace plugin before opening a project.',
    { capability: name },
  );
}

function method(source: unknown, names: readonly string[], name: string): CapabilityMethod;
function method(source: unknown, names: readonly string[], name: string, options: { optional: true }): CapabilityMethod | undefined;
function method(source: unknown, names: readonly string[], name: string, { optional = false }: { optional?: boolean } = {}) {
  const methods = workspaceDiagnosticRecord(source);
  for (const candidate of names) {
    if (typeof methods[candidate] === 'function') return (methods[candidate] as CapabilityMethod).bind(source);
  }
  return optional ? undefined : () => missing(name);
}

function asObject<T extends object = Record<string, unknown>>(value: unknown, name: string): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ViewWorkspaceError(
      'view-engine-invalid-result',
      `Engine ${name} to return an object`,
      'Inspect the Engine workspace plugin result contract.',
      { capability: name },
    );
  }
  return value as T;
}

function previewMethod(preview: unknown, names: readonly string[], name: string) {
  // Engine's public shape puts operations on the outer preview. `handle` is
  // an opaque resource bundle and must never become a second operation
  // surface, otherwise a client can accidentally bypass the Engine contract.
  const methods = workspaceDiagnosticRecord(preview);
  for (const candidate of names) {
    if (typeof methods[candidate] === 'function') return (methods[candidate] as CapabilityMethod).bind(preview);
  }
  return () => missing(name);
}

function engineFailure(error: unknown, capability: string): never {
  if (error instanceof ViewWorkspaceError) throw error;
  const payload = error !== null && typeof error === 'object' ? workspaceDiagnosticRecord(error) : { message: String(error) };
  const message =
    typeof payload.message === 'string' && payload.message.trim() !== ''
      ? payload.message
      : String(error);
  const code =
    typeof payload.code === 'string' && payload.code.length > 0
      ? payload.code
      : 'view-engine-invalid-result';
  throw new ViewWorkspaceError(
    code,
    typeof payload.expected === 'string' ? payload.expected : message,
    typeof payload.hint === 'string' ? payload.hint : message,
    {
      capability,
      message,
      ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
      ...(typeof payload.stack === 'string' ? { stack: payload.stack } : {}),
      ...(payload.detail !== null && typeof payload.detail === 'object' && !Array.isArray(payload.detail)
        ? payload.detail
        : payload.detail === undefined
          ? {}
          : { engineDetail: payload.detail }),
      ...(typeof payload.actual === 'string' ? { actual: payload.actual } : {}),
    },
  );
}

function unwrapEngineResult(result: unknown, capability: string): unknown {
  if (Array.isArray(result)) return result;
  if (result === undefined) return result;
  if (result !== null && typeof result === 'object') {
    const record = workspaceDiagnosticRecord(result);
    if ('ok' in result) {
      if (record.ok === true) return record.value;
      engineFailure(record.error ?? result, capability);
    }
    if (record.outcome === 'succeeded') return record.result;
    if (record.outcome === 'failed') engineFailure(record.failure ?? result, capability);
  }
  return result;
}

function projectCatalogDdc(entry: EngineAssetEntry | null | undefined) {
  if (!entry || typeof entry !== 'object') return undefined;
  if (entry.ddc !== null && typeof entry.ddc === 'object' && !Array.isArray(entry.ddc)) {
    return entry.ddc;
  }
  const receiptUrl =
    typeof entry.cookReceiptUrl === 'string'
      ? entry.cookReceiptUrl
      : typeof entry.receiptUrl === 'string'
        ? entry.receiptUrl
        : undefined;
  const packageUrl = typeof entry.packageUrl === 'string' ? entry.packageUrl : undefined;
  const state =
    typeof entry.lifecycle === 'string'
      ? entry.lifecycle
      : typeof entry.state === 'string'
        ? entry.state
        : undefined;
  if (receiptUrl === undefined && packageUrl === undefined && state === undefined) return undefined;
  return {
    ...(entry.guid === undefined ? {} : { guid: String(entry.guid) }),
    ...(state === undefined ? {} : { state }),
    ...(receiptUrl === undefined ? {} : { receiptUrl }),
    ...(packageUrl === undefined ? {} : { hint: packageUrl }),
  };
}

function packNamespace(source: Record<string, unknown>) {
  return workspaceDiagnosticRecord(source?.pack ?? source?.scriptablePack ?? source?.authoring ?? source?.assetSource);
}

function gatewayOf(source: Record<string, unknown>, pack: Record<string, unknown>) {
  const candidate = workspaceDiagnosticRecord(source?.gateway ?? pack?.gateway ?? source?.scriptablePackGateway ?? pack);
  return typeof candidate?.execute === 'function' ? candidate as { execute: (input: Record<string, unknown>) => unknown } : null;
}

function toolClientOf(source: Record<string, unknown>) {
  const candidate = workspaceDiagnosticRecord(source?.tools ?? source?.toolClient ?? source);
  return typeof candidate?.run === 'function' ? candidate as { run: (id: string, args: Record<string, unknown>) => unknown } : null;
}

function isPackTs(sourcePath: unknown): sourcePath is string {
  return typeof sourcePath === 'string' && sourcePath.endsWith('.pack.ts');
}

/**
 * Normalize the Engine public workspace capability into one call surface.
 * This function only adapts naming; all project, asset, target, scene and
 * camera behavior remains in the supplied Engine implementation.
 */
export function createEngineWorkspaceAdapter(engine: unknown) {
  const source = workspaceDiagnosticRecord(workspaceDiagnosticRecord(engine).workspace ?? engine);
  const projectSource = source?.project ?? source;
  const assetSource = source?.assets ?? source;
  const previewSource = source?.preview ?? source;
  const pack = packNamespace(source);
  const gateway = gatewayOf(source, pack);
  const tools = toolClientOf(source);

  const openProject = method(projectSource, ['openProject', 'open'], 'project.open');
  const closeProject = method(projectSource, ['closeProject', 'close'], 'project.close');
  const listAssets = method(
    assetSource,
    ['listAssets', 'list', 'assetList', 'asset.list'],
    'assets.list',
  );
  const openPreview = method(previewSource, ['openPreview', 'openAsset', 'openScene', 'open'], 'asset.open');
  const assetInspect = method(
    assetSource,
    ['assetInspect', 'asset.inspect'],
    'asset.inspect',
    { optional: true },
  );
  const packInspect = method(
    pack ?? {},
    ['inspect', 'inspectMeta'],
    'asset.source.inspect-meta',
    { optional: true },
  );
  const packPreflight = method(pack ?? {}, ['preflight'], 'asset.preflight', { optional: true });
  const packRebuild = method(pack ?? {}, ['rebuild'], 'asset.source.rebuild', { optional: true });

  async function runTool(id: string, args: Record<string, unknown>, capability: string) {
    if (!tools) missing(capability);
    return unwrapEngineResult(await tools.run(id, args), capability);
  }

  async function inspectPackMeta(sourcePath: string | undefined, requestId?: string) {
    if (typeof sourcePath !== 'string' || sourcePath.length === 0) return undefined;
    if (packInspect) {
      return asObject(
        unwrapEngineResult(await packInspect(sourcePath), 'asset.source.inspect-meta'),
        'asset.source.inspect-meta',
      );
    }
    if (gateway) {
      return asObject(
        unwrapEngineResult(
          await gateway.execute({
            kind: 'inspect-meta',
            sourcePath,
            requestId: requestId ?? 'view-inspect-meta',
          }),
          'asset.source.inspect-meta',
        ),
        'asset.source.inspect-meta',
      );
    }
    return undefined;
  }

  return Object.freeze({
    async openProject(input: Parameters<EngineWorkspaceProvider['openProject']>[0]) {
      return asObject(await openProject(input), 'project.open');
    },
    async closeProject(input: Parameters<EngineWorkspaceProvider['closeProject']>[0]) {
      return closeProject(input);
    },
    async listAssets(input: Parameters<EngineWorkspaceProvider['listAssets']>[0] & { root?: string }) {
      const result = unwrapEngineResult(
        await listAssets({
          ...input,
          root: input?.project?.root ?? input?.root,
        }),
        'assets.list',
      );
      const entries = Array.isArray(result)
        ? result
        : Array.isArray(workspaceDiagnosticRecord(result).entries)
          ? workspaceDiagnosticRecord(result).entries
          : undefined;
      if (!Array.isArray(entries)) {
        throw new ViewWorkspaceError(
          'view-engine-invalid-result',
          'Engine assets.list to return an array',
          'Inspect the Engine asset catalog plugin result.',
          { capability: 'assets.list' },
        );
      }
      return entries;
    },
    async openPreview(input: Parameters<EngineWorkspaceProvider['openPreview']>[0]) {
      let rawResult;
      try {
        rawResult = await openPreview(input);
      } catch (error) {
        const failure = workspaceDiagnosticRecord(error);
        const detail = workspaceDiagnosticRecord(failure.detail);
        if (
          failure.code === 'engine-workspace-preview-capability-unavailable' ||
          detail.code === 'engine-workspace-preview-capability-unavailable' ||
          /workspace preview (?:does not support asset kind|only supports SceneAsset)/i.test(typeof failure.message === 'string' ? failure.message : '')
        ) {
          const kind =
            typeof detail.kind === 'string' ? detail.kind : input.asset?.kind;
          throw new ViewWorkspaceError(
            'view-workspace-asset-unsupported',
            `Engine asset.open to support asset kind ${kind}`,
            'Use an Engine type-preview capability for this asset kind.',
            { kind },
          );
        }
        throw error;
      }
      const result = asObject(rawResult, 'asset.open');
      const target = asObject(result.target, 'asset.open target');
      if (typeof target.targetId !== 'string' && typeof target.targetId !== 'number') {
        throw new ViewWorkspaceError(
          'view-engine-invalid-result',
          'Engine asset.open to return a stable target.targetId',
          'The Engine preview target must expose its identity for API routing.',
          { capability: 'asset.open' },
        );
      }
      const handle = result.handle ?? result.preview ?? result;
      return Object.freeze({
        ...result,
        target: Object.freeze({ ...target, targetId: String(target.targetId) }),
        handle,
      });
    },
    async closePreview(preview: EngineWorkspacePreview, input: EngineWorkspaceCameraInput & { reason?: string; width?: number; height?: number }) {
      const close = previewMethod(preview, ['close', 'dispose'], 'preview.close');
      return close(input);
    },
    async getCamera(preview: EngineWorkspacePreview, input: EngineWorkspaceCameraInput & { reason?: string; width?: number; height?: number }) {
      const get = previewMethod(preview, ['getCamera', 'cameraGet'], 'camera.get');
      return get(input);
    },
    async beginCamera(preview: EngineWorkspacePreview, input: EngineWorkspaceCameraInput & { reason?: string; width?: number; height?: number }) {
      const begin = previewMethod(preview, ['beginCameraInteraction', 'beginCamera'], 'camera.begin');
      return begin(input);
    },
    async updateCamera(preview: EngineWorkspacePreview, input: EngineWorkspaceCameraInput & { reason?: string; width?: number; height?: number }) {
      const update = previewMethod(preview, ['updateCameraDraft', 'updateCamera'], 'camera.update');
      return update(input);
    },
    async commitCamera(preview: EngineWorkspacePreview, input: EngineWorkspaceCameraInput & { reason?: string; width?: number; height?: number }) {
      const commit = previewMethod(preview, ['commitCamera', 'setCamera'], 'camera.commit');
      return commit(input);
    },
    async abortCamera(preview: EngineWorkspacePreview, input: EngineWorkspaceCameraInput & { reason?: string; width?: number; height?: number }) {
      const abort = previewMethod(preview, ['abortCameraInteraction', 'abortCamera'], 'camera.abort');
      return abort(input);
    },
    async capture(preview: EngineWorkspacePreview, input: EngineWorkspaceCameraInput & { reason?: string; width?: number; height?: number }) {
      const capture = previewMethod(preview, ['capture'], 'preview.capture');
      return capture(input);
    },
    async resizePreview(preview: EngineWorkspacePreview, input: EngineWorkspaceCameraInput & { reason?: string; width?: number; height?: number }) {
      const resize = previewMethod(preview, ['resize', 'resizePreview', 'setRenderSize'], 'preview.resize');
      return resize(input);
    },
    async inspectAsset(input: AssetAdapterInput) {
      const asset = input?.asset ?? {};
      const root = input?.project?.root ?? input?.root;
      const subject = input?.subject ?? asset.guid;
      let entry = asset;
      if (assetInspect) {
        const inspected = unwrapEngineResult(
          await assetInspect({
            ...input,
            root,
            subject,
          }),
          'asset.inspect',
        );
        entry = asObject<EngineAssetEntry>(inspected, 'asset.inspect');
      } else if (tools) {
        try {
          entry = asObject<EngineAssetEntry>(
            unwrapEngineResult(
              await tools.run('asset.inspect', { root, subject }),
              'asset.inspect',
            ),
            'asset.inspect',
          );
        } catch (error) {
          if (workspaceDiagnosticRecord(error).code === 'view-engine-capability-unavailable') throw error;
          if (!asset?.guid) throw error;
        }
      }
      const sourcePath = entry.sourcePath ?? asset.sourcePath;
      const packMeta = isPackTs(sourcePath) ? await inspectPackMeta(sourcePath, input?.requestId) : undefined;
      if (!entry?.guid && !asset?.guid) missing('asset.inspect');
      const revision = packMeta?.revision ?? entry.revision ?? asset.revision;
      return {
        guid: entry.guid ?? asset.guid,
        asset: { ...asset, ...entry },
        ...(sourcePath === undefined
          ? {}
          : {
              source: {
                path: sourcePath,
                ...(isPackTs(sourcePath) ? { kind: 'pack.ts' } : {}),
                ...(revision === undefined ? {} : { revision: String(revision) }),
              },
            }),
        ...(packMeta?.meta === undefined ? {} : { meta: packMeta.meta }),
        ...(revision === undefined ? {} : { revision: String(revision) }),
        ...(projectCatalogDdc({ ...asset, ...entry }) === undefined
          ? {}
          : { ddc: projectCatalogDdc({ ...asset, ...entry }) }),
      };
    },
    async rebuild(input: AssetAdapterInput) {
      const mode = input?.mode === 'cold-cook' ? 'cold-cook' : 'rebuild';
      const capability = VIEW_ENGINE_ASSET_SOURCE_TOOLS[mode];
      const sourcePath = input?.sourcePath ?? input?.asset?.sourcePath;
      const expectedRevision = input?.expectedRevision;
      const requestId = input?.requestId;
      const args = {
        ...(sourcePath === undefined ? {} : { sourcePath }),
        ...(input?.asset?.guid === undefined ? {} : { guid: input.asset.guid, ownerGuid: input.asset.guid }),
        ...(requestId === undefined ? {} : { requestId }),
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      };

      if (gateway && sourcePath) {
        return asObject(
          unwrapEngineResult(
            await gateway.execute({
              kind: mode,
              sourcePath,
              requestId: requestId ?? `view-${mode}`,
              ...(expectedRevision === undefined ? {} : { expectedRevision }),
            }),
            capability,
          ),
          capability,
        );
      }

      if (packRebuild && sourcePath) {
        if (packPreflight && expectedRevision !== undefined) {
          const preflight = asObject(
            unwrapEngineResult(await packPreflight(sourcePath), 'asset.preflight'),
            'asset.preflight',
          );
          if (String(preflight.revision) !== String(expectedRevision)) {
            engineFailure(
              {
                code: 'pack-source-revision-conflict',
                expected: expectedRevision,
                actual: preflight.revision,
                hint: 'inspect the current source revision, then retry the build with a new requestId',
                detail: { sourcePath, requestId },
              },
              capability,
            );
          }
        }
        return asObject(
          unwrapEngineResult(await packRebuild(sourcePath, mode), capability),
          capability,
        );
      }

      if (tools) {
        return asObject(await runTool(capability, args, capability), capability);
      }
      missing(capability);
    },
  });
}

export function isEngineWorkspaceAdapter(input: unknown) {
  const value = workspaceDiagnosticRecord(input);
  const assets = workspaceDiagnosticRecord(value?.assets ?? value);
  const preview = workspaceDiagnosticRecord(value?.preview ?? value);
  return Boolean(
    value &&
      typeof (value.openProject ?? value.open) === 'function' &&
      typeof (value.closeProject ?? value.close) === 'function' &&
      typeof (
        assets.listAssets ??
        assets.list ??
        assets.assetList ??
        assets['asset.list']
      ) === 'function' &&
      typeof (
        preview.openPreview ??
        preview.openAsset ??
        preview.openScene ??
        preview.open
      ) === 'function',
  );
}
