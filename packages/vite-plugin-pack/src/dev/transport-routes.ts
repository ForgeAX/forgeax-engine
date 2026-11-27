import { normalizeSourcePackageError, type SourcePackageError } from '@forgeax/engine-import';
import {
  catalogProjectionFor,
  metaPathForGuid,
  RUNTIME_PACK_SUFFIX,
} from '@forgeax/engine-pack/build';
import type {
  CatalogDiagnostic,
  PackIndexEntry,
  ResourceRevision,
  RuntimeAssetBinding,
} from '@forgeax/engine-types';
import { projectFailureCause } from '../errors.js';
import { HttpArtifactCompression } from '../http-artifact.js';
import { stringifyPluginDiagnostic } from '../structured-plugin-error.js';
import type { DevSession } from './dev-session.js';
import type { DispatcherHandler, DispatcherRequest, DispatcherResponse } from './dispatcher.js';
import {
  type PluginServerRouteCallbacks,
  type PluginServerState,
  packBodyContent,
} from './plugin-server.js';

export function isMaterializedDevRow(row: PackIndexEntry, state: PluginServerState): boolean {
  return (
    row.lifecycle === 'current' &&
    row.publication !== undefined &&
    state.metaPackBodies.has(row.packageUrl)
  );
}

export interface TransportRouteContext {
  readonly startupReady: Promise<void>;
  readonly transportBase?: string | undefined;
  readonly state: PluginServerState;
  readonly callbacks: PluginServerRouteCallbacks;
  readonly devSession: DevSession | undefined;
  readonly freshnessBarrier?: (() => Promise<void>) | undefined;
  readonly scopedCatalogEntry: (
    binding: RuntimeAssetBinding | undefined,
    entry: PackIndexEntry,
  ) => PackIndexEntry;
  readonly scopedCatalogBody: (binding: RuntimeAssetBinding) => string;
}

const DEV_PACK_PREFIX = '/__forgeax-ddc/';

function transportBasePrefix(base: string | undefined): string {
  const normalized = (base ?? '').replace(/^\/+|\/+$/g, '');
  return normalized.length === 0 ? '' : `/${normalized}`;
}

function normalizeTransportUrl(url: string, base: string | undefined): string {
  const prefix = transportBasePrefix(base);
  if (prefix.length === 0) return url;
  if (url === prefix) return '/';
  return url.startsWith(`${prefix}/`) ? url.slice(prefix.length) || '/' : url;
}

interface RuntimeScopeRoute {
  readonly scopeId: string;
  readonly generation: number;
  readonly suffix: string;
}

function parseRuntimeScopeRoute(url: string): RuntimeScopeRoute | undefined {
  const match = /^\/__pack\/scopes\/([^/]+)\/(\d+)(\/.*)?$/.exec(url);
  if (match === null) return undefined;
  const encodedScopeId = match[1];
  if (encodedScopeId === undefined) return undefined;
  let scopeId: string;
  try {
    scopeId = decodeURIComponent(encodedScopeId);
  } catch {
    return undefined;
  }
  const generation = Number(match[2]);
  if (!Number.isSafeInteger(generation)) return undefined;
  return { scopeId, generation, suffix: match[3] ?? '/' };
}

export function createTransportRouteHandler(context: TransportRouteContext): DispatcherHandler {
  return (req, res, next) => handleTransportRequest(context, req, res, next);
}

function sendJsonText(res: DispatcherResponse, text: string | Uint8Array, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  // Development catalog/import responses are mutable within one runtime
  // generation. Never let a browser or an intermediary replay an older
  // projection after a lazy import publishes a newer row.
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
}

function sendJson(res: DispatcherResponse, body: unknown, statusCode = 200): void {
  sendJsonText(
    res,
    statusCode >= 400 ? stringifyPluginDiagnostic(body) : JSON.stringify(body),
    statusCode,
  );
}

export function catalogDiagnosticForSourcePackageError(
  error: SourcePackageError,
): CatalogDiagnostic {
  const affected = new Set(error.detail.affectedGuids.map((guid) => guid.toLowerCase()));
  return {
    code: error.code,
    severity: 'blocking',
    authority: 'producer',
    subject: { type: 'resource', id: error.detail.sourceMeta },
    expected: error.expected,
    ...(error.detail.reason === undefined ? {} : { actual: error.detail.reason }),
    hint: error.hint,
    evidence: [...affected].map((guid) => ({ type: 'asset', id: guid })),
    recoveryIntents: [error.hint],
  };
}

/** Project one producer failure for the Catalog regardless of its request path. */
export function projectCatalogSourceFailure(
  catalog: PluginServerState['catalogProjection'],
  cause: unknown,
  affectedGuids: readonly string[],
  sourcePath: string,
  metaPath?: string,
) {
  const anchorGuid = affectedGuids[0] ?? sourcePath;
  const owner = catalog.entries.find((row) => row.guid.toLowerCase() === anchorGuid.toLowerCase());
  const sidecar = metaPath ?? metaPathForGuid(catalog.declarations, anchorGuid);
  const meta = sidecar === undefined ? undefined : catalog.declarations.get(sidecar);
  const provider = owner?.provenance?.provider ?? 'vite-plugin-pack';
  const error = normalizeSourcePackageError(cause, {
    sourceMeta: sidecar ?? sourcePath,
    anchorGuid,
    affectedGuids,
    producer: provider,
    importer: meta?.importer ?? owner?.provenance?.provider ?? 'unknown',
  });
  const diagnostic = catalogDiagnosticForSourcePackageError(error);
  return {
    error,
    diagnostic,
    catalog: {
      ...catalog,
      entries: projectSourcePackageFailure(catalog.entries, error, diagnostic),
    },
  };
}

export function projectSourcePackageFailure(
  rows: readonly PackIndexEntry[],
  error: SourcePackageError,
  diagnostic = catalogDiagnosticForSourcePackageError(error),
): PackIndexEntry[] {
  const affected = new Set(error.detail.affectedGuids.map((guid) => guid.toLowerCase()));
  const observedAt = Date.now();
  return rows.map((row) => {
    if (!affected.has(row.guid.toLowerCase())) return row;
    const subject = row.subject ?? 'imported-output';
    const execution = row.execution ?? 'cooked';
    const projection = catalogProjectionFor(subject, execution, 'failed');
    // The first failed observation often follows a plain `current` row that
    // has not yet carried an explicit LKG projection. That accepted package
    // is still the recovery target; only promote it when the prior lifecycle
    // proves it was current, so missing/unaccepted inventory rows cannot be
    // mistaken for a usable last-known-good product.
    const lastKnownGood =
      row.projection?.lastKnownGood ??
      (row.lifecycle === 'current' && row.revision !== undefined
        ? { packageUrl: row.packageUrl }
        : undefined);
    // A failed source is still a new producer observation. Advance the row
    // revision so CatalogReplica can apply the lifecycle/diagnostic change
    // without treating it as a payload rewrite that reused the verified
    // revision. The digest is deliberately synthetic: no accepted DDC bytes
    // exist for a failed publication, while the prior digest remains in the
    // LKG projection for recovery.
    const revision: ResourceRevision | undefined =
      row.revision === undefined
        ? undefined
        : {
            digest: `failure:${error.code}:${error.detail.stage}:${row.revision.digest}`,
            observedAt: Math.max(observedAt, row.revision.observedAt + 1),
            rootId: row.revision.rootId,
          };
    return {
      ...row,
      ...(revision === undefined ? {} : { revision }),
      lifecycle: projection.lifecycle,
      diagnostics: [...(row.diagnostics ?? []), diagnostic],
      projection: {
        ...projection,
        ...(lastKnownGood === undefined ? {} : { lastKnownGood }),
      },
    };
  });
}

function gateSession(context: TransportRouteContext, res: DispatcherResponse): boolean {
  const sessionState = context.devSession?.state();
  if (sessionState === undefined || sessionState.status === 'starting') {
    sendJson(
      res,
      {
        error: 'pack-session-starting',
        expected: 'an accepted ForgeAX pack snapshot',
        hint: 'wait for startup, then enumerate and retry',
      },
      503,
    );
    return false;
  }
  if (sessionState.status === 'closing' || sessionState.status === 'closed') {
    sendJson(
      res,
      {
        error: 'pack-session-closed',
        expected: 'an open ForgeAX pack session',
        hint: 'create a new Vite server session before retrying',
      },
      410,
    );
    return false;
  }
  if (sessionState.status === 'failed') {
    const sessionFailure = sessionState.error;
    sendJson(
      res,
      {
        error: sessionFailure?.code ?? 'scan-failed',
        expected: sessionFailure?.expected ?? 'an accepted ForgeAX pack snapshot',
        hint: sessionFailure?.hint ?? 'repair the producer, rebuild, verify, and retry',
        ...(sessionFailure === undefined
          ? {}
          : { detail: sessionFailure.detail, cause: projectFailureCause(sessionFailure.cause) }),
      },
      500,
    );
    return false;
  }
  return true;
}

async function awaitStartupReady(
  context: TransportRouteContext,
  res: DispatcherResponse,
): Promise<boolean> {
  try {
    await context.startupReady;
    return true;
  } catch (error) {
    const failure =
      typeof error === 'object' && error !== null
        ? (error as {
            readonly code?: unknown;
            readonly expected?: unknown;
            readonly hint?: unknown;
            readonly detail?: unknown;
            readonly cause?: unknown;
          })
        : undefined;
    sendJson(
      res,
      {
        error: typeof failure?.code === 'string' ? failure.code : 'scan-failed',
        expected:
          typeof failure?.expected === 'string'
            ? failure.expected
            : 'startup readiness to settle before serving the Pack route',
        hint:
          typeof failure?.hint === 'string'
            ? failure.hint
            : 'inspect the startup producer failure and retry the request',
        ...(failure?.detail === undefined ? {} : { detail: failure.detail }),
        ...(failure?.cause === undefined ? {} : { cause: projectFailureCause(failure.cause) }),
      },
      500,
    );
    return false;
  }
}

function recordFreshnessTiming(res: DispatcherResponse, startedAt: number | undefined): void {
  if (startedAt === undefined) return;
  const timing = `forgeax-freshness;dur=${(performance.now() - startedAt).toFixed(3)}`;
  const previous = res.getHeader?.('Server-Timing');
  res.setHeader(
    'Server-Timing',
    previous === undefined ? timing : `${String(previous)}, ${timing}`,
  );
}

async function awaitFreshness(
  context: TransportRouteContext,
  res: DispatcherResponse,
): Promise<boolean> {
  const startedAt = process.env.FORGEAX_WORKSPACE_TIMING === '1' ? performance.now() : undefined;
  try {
    await context.freshnessBarrier?.();
    recordFreshnessTiming(res, startedAt);
    return true;
  } catch (error) {
    recordFreshnessTiming(res, startedAt);
    sendJson(
      res,
      {
        error:
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { readonly code: unknown }).code)
            : 'watch-failed',
        expected: 'the filesystem revision and accepted Catalog to settle before consume',
        hint: 'inspect the watcher diagnostic, repair the source, rebuild, verify, and retry',
        ...(typeof error === 'object' && error !== null && 'detail' in error
          ? { detail: (error as { readonly detail: unknown }).detail }
          : {}),
      },
      503,
    );
    return false;
  }
}

function currentScopedBinding(
  context: TransportRouteContext,
  parsed: RuntimeScopeRoute,
  req: DispatcherRequest,
  res: DispatcherResponse,
): RuntimeAssetBinding | undefined {
  if (!gateSession(context, res)) return undefined;
  const latest = context.devSession?.runtimeScope();
  if (
    latest === undefined ||
    latest.scopeId !== parsed.scopeId ||
    latest.generation !== parsed.generation
  ) {
    sendJson(res, { error: 'runtime-scope-generation-expired' }, 410);
    return undefined;
  }
  if (latest.status === 'transitioning' || latest.status === 'unavailable') {
    sendJson(res, { error: 'runtime-scope-unavailable', status: latest.status }, 503);
    return undefined;
  }
  if (parsed.suffix === '/catalog.json') return latest;
  const explicitRebuild =
    parsed.suffix.startsWith('/import/') &&
    req.method === 'POST' &&
    req.headers?.['x-forgeax-import-mode'] === 'rebuild';
  const assetUrl = parsed.suffix.startsWith('/asset/')
    ? parsed.suffix.slice('/asset'.length)
    : undefined;
  const acceptedAsset =
    assetUrl !== undefined &&
    (context.state.metaPackBodies.has(assetUrl) || context.state.devArtifactBodies.has(assetUrl));
  // Degradation fences new production, not explicit recovery or immutable
  // bytes already accepted by this generation.
  if (
    (latest.status === 'degraded' || latest.authority === 'degraded') &&
    !explicitRebuild &&
    !acceptedAsset
  ) {
    sendJson(
      res,
      { error: 'runtime-scope-catalog-degraded', diagnostics: latest.diagnostics ?? [] },
      409,
    );
    return undefined;
  }
  return latest;
}

async function handleScopedRoute(
  context: TransportRouteContext,
  parsed: RuntimeScopeRoute,
  req: Parameters<DispatcherHandler>[0],
  res: DispatcherResponse,
  next: Parameters<DispatcherHandler>[2],
): Promise<void> {
  const current = context.devSession?.runtimeScope();
  if (current === undefined) {
    sendJson(res, { error: 'runtime-scope-unbound' }, 404);
    return;
  }
  if (current.scopeId !== parsed.scopeId) {
    sendJson(res, { error: 'runtime-scope-not-found', scopeId: parsed.scopeId }, 404);
    return;
  }
  if (current.generation !== parsed.generation) {
    sendJson(
      res,
      {
        error: 'runtime-scope-generation-expired',
        scopeId: parsed.scopeId,
        generation: parsed.generation,
        currentGeneration: current.generation,
      },
      410,
    );
    return;
  }

  if (!(await awaitStartupReady(context, res))) return;
  if (!(await awaitFreshness(context, res))) return;
  const fresh = currentScopedBinding(context, parsed, req, res);
  if (fresh === undefined) return;
  if (parsed.suffix === '/catalog.json') {
    sendJsonText(res, context.scopedCatalogBody(fresh));
    return;
  }

  // Let queued scope transitions settle and recheck before dispatching resources.
  await Promise.resolve();
  const latest = currentScopedBinding(context, parsed, req, res);
  if (latest === undefined) return;
  if (parsed.suffix.startsWith('/import/')) {
    const guid = parsed.suffix.slice('/import/'.length);
    if (guid.length === 0 || guid.includes('/')) {
      res.statusCode = 404;
      res.end('');
      return;
    }
    return handleImportRoute(context, req, guid, latest, res);
  }
  if (parsed.suffix.startsWith('/asset/')) {
    const url = parsed.suffix.slice('/asset'.length);
    if (handleScopedLookupRoute(context, url, latest, res)) return;
    if (await handlePackRoute(req, context, url, latest, res)) return;
    next();
    return;
  }
  sendJson(res, { error: 'runtime-scope-route-not-found' }, 404);
}

async function handleGenericImport(
  context: TransportRouteContext,
  guid: string,
  rebuildRequested: boolean,
  scopedBinding: RuntimeAssetBinding,
  res: DispatcherResponse,
): Promise<void> {
  let resultEntries: readonly PackIndexEntry[];
  try {
    resultEntries =
      (await (rebuildRequested
        ? context.callbacks.rebuildAsset?.(guid)
        : context.callbacks.materializeAsset?.(guid))) ?? [];
    if (!gateSession(context, res)) return;
  } catch (error) {
    if (!gateSession(context, res)) return;
    const catalog = context.state.catalogProjection.entries;
    const row = catalog.find((entry) => entry.guid.toLowerCase() === guid);
    if (row?.sourcePath.endsWith('.pack.ts')) {
      const failure = projectCatalogSourceFailure(
        context.state.catalogProjection,
        error,
        [row.guid],
        row.sourcePath,
      );
      context.state.catalogProjection = failure.catalog;
      sendJson(
        res,
        {
          error: 'source-package-failed',
          guid,
          code: failure.error.code,
          expected: failure.error.expected,
          hint: failure.error.hint,
          detail: failure.error.detail,
        },
        422,
      );
      return;
    }
    const detail =
      typeof error === 'object' && error !== null && 'detail' in error
        ? (error as { detail?: unknown }).detail
        : { reason: error instanceof Error ? error.message : String(error) };
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'import-internal-error';
    const hint =
      typeof error === 'object' && error !== null && 'hint' in error
        ? String((error as { hint: unknown }).hint)
        : 'importer threw while converting the source';
    sendJson(res, { error: 'import-failed', guid, code, detail, hint }, 422);
    return;
  }
  if (resultEntries.length === 0) {
    sendJson(res, { error: 'import-failed', guid, hint: 'producer closure omitted the GUID' }, 422);
    return;
  }
  sendJson(
    res,
    resultEntries.map((entry) => context.scopedCatalogEntry(scopedBinding, entry)),
  );
}

async function handleImportRoute(
  context: TransportRouteContext,
  req: Parameters<DispatcherHandler>[0],
  guid: string,
  scopedBinding: RuntimeAssetBinding,
  res: DispatcherResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, { error: 'method-not-allowed', hint: 'use POST to trigger lazy import' }, 405);
    return;
  }
  const guidLower = guid.toLowerCase();
  const importModeHeader = req.headers?.['x-forgeax-import-mode'];
  const rebuildRequested = importModeHeader === 'rebuild';
  const row = context.state.catalogProjection.entries.find(
    (entry) => entry.guid.toLowerCase() === guidLower,
  );
  if (
    row === undefined &&
    metaPathForGuid(context.state.catalogProjection.declarations, guidLower) === undefined
  ) {
    sendJson(res, { error: 'meta-not-found', guid, hint: 'no source declares this GUID' }, 404);
    return;
  }
  if (row !== undefined && !rebuildRequested && isMaterializedDevRow(row, context.state)) {
    sendJson(res, [context.scopedCatalogEntry(scopedBinding, row)]);
    return;
  }
  return handleGenericImport(context, guidLower, rebuildRequested, scopedBinding, res);
}

function handleScopedLookupRoute(
  context: TransportRouteContext,
  url: string,
  scopedBinding: RuntimeAssetBinding,
  res: DispatcherResponse,
): boolean {
  if (!url.startsWith('/__pack/lookup/')) return false;
  const guid = url.slice('/__pack/lookup/'.length);
  const entry = context.state.catalogProjection.entries.find(
    (candidate) => candidate.guid.toLowerCase() === guid.toLowerCase(),
  );
  if (entry === undefined) {
    sendJson(res, { error: 'not-found', guid }, 404);
    return true;
  }
  sendJson(res, context.scopedCatalogEntry(scopedBinding, entry));
  return true;
}

function devArtifactOwnerGuidForUrl(url: string): string | undefined {
  if (!url.startsWith(DEV_PACK_PREFIX)) return undefined;
  const suffix = url.slice(DEV_PACK_PREFIX.length);
  const separator = suffix.indexOf('/');
  if (separator <= 0) return undefined;
  const guid = suffix.slice(0, separator).toLowerCase();
  return guid.length === 0 ? undefined : guid;
}

async function handlePackRoute(
  req: DispatcherRequest,
  context: TransportRouteContext,
  url: string,
  scopedBinding: RuntimeAssetBinding | undefined,
  res: DispatcherResponse,
): Promise<boolean> {
  let artifactBody = context.state.devArtifactBodies.get(url);
  if (artifactBody !== undefined) {
    (context.state.artifactCompression ?? new HttpArtifactCompression()).send(
      req,
      res,
      artifactBody,
    );
    return true;
  }
  const artifactOwnerGuid = devArtifactOwnerGuidForUrl(url);
  const authoredPack = context.state.catalogProjection.entries.some(
    (entry) => entry.packageUrl === url && entry.sourcePath.endsWith('.pack.json'),
  );
  if (!url.startsWith(DEV_PACK_PREFIX) && !authoredPack) return false;
  let body: string | Uint8Array | undefined;
  try {
    if (artifactOwnerGuid !== undefined) {
      await context.callbacks.ensureMetaPackBody(
        `${DEV_PACK_PREFIX}${artifactOwnerGuid}${RUNTIME_PACK_SUFFIX}`,
        scopedBinding,
      );
      artifactBody = context.state.devArtifactBodies.get(url);
      if (artifactBody !== undefined) {
        if (!gateSession(context, res)) return true;
        (context.state.artifactCompression ?? new HttpArtifactCompression()).send(
          req,
          res,
          artifactBody,
        );
        return true;
      }
    }
    // A degraded generation exposes its accepted bytes for recovery; invoking
    // the producer here would retry the known-broken source on every read.
    body =
      context.devSession?.state().status === 'degraded'
        ? packBodyContent(context.state.metaPackBodies.get(url))
        : undefined;
    if (body === undefined) body = await context.callbacks.ensureMetaPackBody(url, scopedBinding);
    if (!gateSession(context, res)) return true;
  } catch (error) {
    if (!gateSession(context, res)) return true;
    const failure =
      error !== null && typeof error === 'object'
        ? error
        : { hint: error instanceof Error ? error.message : String(error) };
    sendJson(
      res,
      {
        ...failure,
        error: 'pack-cook-failed',
        url,
      },
      422,
    );
    return true;
  }
  if (body === undefined) {
    sendJson(
      res,
      { error: 'pack-body-not-found', url, hint: 'no producer output exists for this URL' },
      404,
    );
    return true;
  }
  sendJsonText(res, body);
  return true;
}

async function handleTransportRequest(
  context: TransportRouteContext,
  req: Parameters<DispatcherHandler>[0],
  res: DispatcherResponse,
  next: Parameters<DispatcherHandler>[2],
): Promise<void> {
  const url = normalizeTransportUrl(req.url ?? '', context.transportBase);
  const scopedRoute = parseRuntimeScopeRoute(url);
  if (scopedRoute) return handleScopedRoute(context, scopedRoute, req, res, next);

  if (
    url === '/__pack/index' ||
    url === '/pack-index.json' ||
    url.startsWith('/__pack/lookup/') ||
    url.startsWith('/__import/') ||
    url.startsWith(DEV_PACK_PREFIX)
  ) {
    if (
      context.devSession?.runtimeScope() === undefined &&
      !(await awaitStartupReady(context, res))
    )
      return;
    if (!gateSession(context, res) || !(await awaitFreshness(context, res))) return;
    sendJson(res, { error: 'global-runtime-scope-route-disabled' }, 404);
    return;
  }
  if (await handlePackRoute(req, context, url, undefined, res)) return;
  next();
}
