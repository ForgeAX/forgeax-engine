import type { Context } from '@forgeax/engine-plugin';
import type { Dispose, FrontendConfig } from '@forgeax/view-workspace-core/frontend-contract';
import type { WorkspaceTransport, WorkspaceCallOptions } from '@forgeax/view-workspace-core/client';
import type { ViewWorkspaceBroker } from '@forgeax/view-workspace-core/broker';
import type { HostTransportServer, HostCallerIdentity, BackendAssemblyAuthority, FrontendAssemblyState, HostTransportClient } from '@forgeax/engine-host';
import type { ToolApi, ToolSchema, ToolRuntimeError, ToolApiRunOptions } from '@forgeax/engine-tool-runtime';
import { workspaceDiagnosticRecord } from '@forgeax/view-workspace-core/command-error';
type RecordValue = Record<string, unknown>;
const recordOf = workspaceDiagnosticRecord;
const recordList = (value: unknown): RecordValue[] => Array.isArray(value) ? value.filter((item): item is RecordValue => item !== null && typeof item === 'object') : [];
import { createWorkspaceId } from '@forgeax/view-workspace-core/id';
import { reportWorkspaceCommandError } from '@forgeax/view-workspace-core/command-error';
import {
  VIEW_WORKSPACE_API_VERSION,
  VIEW_WORKSPACE_DOMAIN_OPERATIONS,
  ViewWorkspaceError,
  cloneWorkspaceValue,
  jsonUnchanged,
  requireWorkspaceObject,
  requireWorkspaceString,
  workspaceError,
} from '@forgeax/view-workspace-core/contract';
import { PLUGINS_OPERATION_DESCRIPTIONS } from './api.ts';
import { BACKEND_MODULE, BACKEND_PLUGIN_ID } from './identity.ts';
import { defineTool } from '@forgeax/engine-tool-runtime';
import { inspectPluginFiber, registerTools } from '@forgeax/engine-plugin';

export const VIEW_INSPECTOR_API_VERSION = 'forgeax.view.inspector/1';
export const VIEW_INSPECTOR_SERVICES = Object.freeze({
  sources: 'forgeax.view.inspector.sources',
  inspect: 'forgeax.view.inspector.inspect',
  watch: 'forgeax.view.inspector.watch',
  unwatch: 'forgeax.view.inspector.unwatch',
  report: 'forgeax.view.inspector.report',
});
export const VIEW_INSPECTOR_TOPIC = 'forgeax.view.inspector.changed';
export const VIEW_STATUS_OPERATION = 'view.status';
export const VIEW_INSPECTOR_OPERATIONS = Object.freeze(
  PLUGINS_OPERATION_DESCRIPTIONS.map((description) => description.id),
);
const VIEW_INSPECTOR_INTERNAL_OPERATIONS = Object.freeze(['plugins.report', 'plugins.unwatch']);

const INSPECTOR_OPERATION_SET = new Set([
  ...VIEW_INSPECTOR_OPERATIONS,
  ...VIEW_INSPECTOR_INTERNAL_OPERATIONS,
]);
const WORKSPACE_OPERATION_SET = new Set(VIEW_WORKSPACE_DOMAIN_OPERATIONS);
const MAX_TEXT = 512;
const SAFE_ERROR_FIELDS = new Set([
  'actual',
  'actualGeneration',
  'expectedGeneration',
  'fiberState',
  'generation',
  'module',
  'operation',
  'phase',
  'providerId',
  'reason',
  'remoteCode',
  'runId',
  'service',
  'sourceId',
  'watchId',
]);

function redactCredentials(value: string) {
  return value
    .replace(/([a-z][a-z\d+.-]*:\/\/)([^\s/?#]+)@/gi, '$1[redacted]@')
    .replace(/\b(authorization|proxy-authorization)\b\s*([:=])\s*(?:(?:bearer|basic)\s+)?[^\s,;)}\]]+/gi, (_match: string, key: string, separator: string) => `${key}${separator}[redacted]`)
    .replace(/\b(bearer|basic)\s+[a-z\d._~+\/-]+=*/gi, '$1 [redacted]')
    .replace(/([?&](?:token|password|passwd|secret|authorization|api[-_]?key|access[-_]?token)=)[^&#\s,;)}\]]+/gi, '$1[redacted]')
    .replace(/\b(token|password|passwd|secret|authorization|api[-_]?key|access[-_]?token)\b\s*([:=])\s*("[^"]*"|'[^']*'|\[[^\]]*\]|[^\s,;)}\]]+)/gi, (_match: string, key: string, separator: string) => `${key}${separator}[redacted]`)
    .replace(/\b(secret|password|passwd|token)(?:[-_][a-z\d][a-z\d_.-]*)?\b/gi, '[redacted]')
    .replace(/\b(secret|password|passwd|token|api[-_]?key|access[-_]?token)[-_][a-z\d][a-z\d_.-]*\b/gi, '[redacted]');
}
function safeText(value: unknown, fallback = 'unknown'): string {
  const text = typeof value === 'string' ? value : value === undefined ? fallback : String(value);
  const redacted = redactCredentials(text);
  return redacted.length > MAX_TEXT ? `${redacted.slice(0, MAX_TEXT)}...` : redacted;
}
function safeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string').slice(0, 64).map(entry => safeText(entry));
}
function safeClone<T>(value: T): T | null {
  try { return cloneWorkspaceValue(value); } catch { return null; }
}
export function safeDetail(value: unknown): RecordValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: RecordValue = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!SAFE_ERROR_FIELDS.has(key)) continue;
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean' || entry === null) result[key] = typeof entry === 'string' ? safeText(entry) : entry;
    else if (Array.isArray(entry) && entry.every(item => typeof item === 'string')) result[key] = entry.map(item => safeText(item));
  }
  return Object.keys(result).length === 0 ? undefined : result;
}
export function safeError(value: unknown) {
  if (value === undefined || value === null) return undefined;
  const error = recordOf(value), safe = safeDetail(error.detail);
  return { code: safeText(error.code, 'unknown-error'), expected: safeText(error.expected), hint: safeText(error.hint), ...(safe === undefined ? {} : { detail: safe }) };
}
function safeSchema(value: unknown): RecordValue | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const allowed = new Set(['additionalProperties','const','description','enum','items','maximum','minimum','properties','required','type']);
  const project = (schema: unknown): RecordValue | undefined => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
    const result: RecordValue = {};
    for (const [key, entry] of Object.entries(schema)) {
      if (!allowed.has(key)) continue;
      if (key === 'properties' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
        result.properties = Object.fromEntries(Object.entries(entry).map(([name, child]) => [name, project(child)]).filter(([, child]) => child !== undefined)); continue;
      }
      if (key === 'items') { const child = project(entry); if (child !== undefined) result.items = child; continue; }
      if (key === 'description') result.description = safeText(entry, '');
      else if (Array.isArray(entry)) result[key] = entry.filter(item => typeof item === 'string').map(item => safeText(item));
      else if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') result[key] = entry;
    }
    return result;
  };
  return project(value);
}
function safeOwner(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const owner = recordOf(value);
  return { providerId: safeText(owner.providerId), sourceId: safeText(owner.sourceId), generation: typeof owner.generation === 'number' && Number.isSafeInteger(owner.generation) ? owner.generation : null, realm: safeText(owner.realm), ...(owner.fiberId === undefined ? {} : { fiberId: safeText(owner.fiberId) }), ...(owner.module === undefined ? {} : { module: safeText(owner.module) }) };
}
function safeToolDescriptor(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const descriptor = recordOf(value);
  return { id: safeText(descriptor.id), path: Array.isArray(descriptor.path) ? descriptor.path.filter((value): value is string => typeof value === 'string').map(value => safeText(value)) : safeText(descriptor.id).split('.'), title: safeText(descriptor.title), summary: safeText(descriptor.summary), realm: safeText(descriptor.realm), evidence: Array.isArray(descriptor.evidence) ? descriptor.evidence.filter((value): value is string => typeof value === 'string').map(value => safeText(value)) : [], ...(descriptor.inputSchema === undefined ? {} : { inputSchema: safeSchema(descriptor.inputSchema) }), ...(descriptor.outputSchema === undefined ? {} : { outputSchema: safeSchema(descriptor.outputSchema) }), ...(Array.isArray(descriptor.capabilities) ? { capabilities: descriptor.capabilities.map(value => safeText(value)) } : {}), ...(Array.isArray(descriptor.errors) ? { errors: descriptor.errors.map(value => safeText(value)) } : {}) };
}
export function safePluginEntry(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const entry = recordOf(value), origin = recordOf(entry.origin);
  const desiredState = entry.desiredState === 'disabled' || entry.disabled === true ? 'disabled' : 'enabled';
  const candidate = entry.fiberState ?? entry.state;
  const state = typeof candidate === 'string' && ['pending','loading','active','failed','disposed','disabled','unloading','unknown'].includes(candidate) ? candidate : undefined;
  return {
    entryId: safeText(entry.entryId ?? entry.id ?? (entry.uid == null ? undefined : `fiber:${entry.uid}`)), module: safeText(entry.module ?? entry.name), realm: safeText(entry.realm), desiredState,
    ...((origin.guid ?? entry.assetGuid) === undefined ? {} : { assetGuid: safeText(origin.guid ?? entry.assetGuid) }),
    ...((origin.program ?? entry.program) === undefined ? {} : { program: safeText(origin.program ?? entry.program) }),
    ...((entry.fiberId ?? entry.uid) == null ? {} : { fiberId: safeText(String(entry.fiberId ?? entry.uid)) }),
    ...(entry.parent === undefined ? {} : { parent: safeText(entry.parent) }),
    ...(safeStringArray(entry.requiredServices) === undefined ? {} : { requiredServices: safeStringArray(entry.requiredServices) }),
    ...(safeStringArray(entry.providedServices) === undefined ? {} : { providedServices: safeStringArray(entry.providedServices) }),
    ...(safeStringArray(entry.missingServices) === undefined ? {} : { missingServices: safeStringArray(entry.missingServices) }),
    ...(entry.configDigest === undefined ? {} : { configDigest: safeText(entry.configDigest) }),
    ...(state === undefined ? {} : { fiberState: state }), ...(entry.failure === undefined ? {} : { failure: safeError(entry.failure) }),
  };
}
function safeToolSnapshot(value: unknown) {
  const snapshot = recordOf(value);
  return {
    providers: recordList(snapshot.providers).map(provider => ({ owner: safeOwner(provider.owner), state: safeText(provider.state), callable: provider.callable === true, ...(provider.fiberState === undefined ? {} : { fiberState: safeText(provider.fiberState) }), operationIds: Array.isArray(provider.operationIds) ? provider.operationIds.map(value => safeText(value)) : [] })),
    operations: recordList(snapshot.operations).map(operation => ({ descriptor: safeToolDescriptor(operation.descriptor), owner: safeOwner(operation.owner), providerState: safeText(operation.providerState), declared: operation.declared === true, callable: operation.callable === true, ...(operation.fiberState === undefined ? {} : { fiberState: safeText(operation.fiberState) }) })),
    ...(!value || typeof value !== 'object' ? { state: 'unavailable' } : {}),
  };
}
function actualPluginEntries(status: unknown, supplied: readonly unknown[] = []) {
  const entries = recordList(recordOf(status).entries).map(safePluginEntry).filter(entry => entry !== null);
  const byId = new Map(entries.map(entry => [entry.entryId, entry]));
  for (const entry of supplied) { const safe = safePluginEntry(entry); if (safe !== null) byId.set(safe.entryId, safe); }
  return [...byId.values()];
}
function safeAssembly(value: unknown) {
  const outer = recordOf(value), candidate = outer.current ?? value;
  if (!candidate || typeof candidate !== 'object') return null;
  const assembly = recordOf(candidate), root = recordOf(assembly.root);
  return { revision: safeText(assembly.revision), schemaVersion: safeText(assembly.schemaVersion), sessionGeneration: typeof assembly.sessionGeneration === 'number' ? assembly.sessionGeneration : undefined, root: assembly.root ? { program: safeText(root.program), codeRevision: safeText(root.codeRevision), ...(root.source === undefined ? {} : { assetGuid: safeText(root.source) }) } : null };
}
function safeActivationStatus(value: unknown): ActivationSnapshot {
  if (!value || typeof value !== 'object') return { state: 'unknown' } as { state: string; entries?: never };
  const status = recordOf(value);
  const entries = Array.isArray(status.entries) ? recordList(status.entries).map(entry => {
    const safe = safePluginEntry(entry);
    return { entryId: safe?.entryId ?? safeText(entry.entryId ?? entry.id), fiberState: safe?.fiberState ?? safeText(entry.fiberState), ...(safe?.parent === undefined ? {} : { parent: safe.parent }), ...(safe?.requiredServices === undefined ? {} : { requiredServices: safe.requiredServices }), ...(safe?.providedServices === undefined ? {} : { providedServices: safe.providedServices }), ...(safe?.configDigest === undefined ? {} : { configDigest: safe.configDigest }), ...(entry.failure === undefined ? {} : { failure: safeError(entry.failure) }) };
  }) : undefined;
  return { state: safeText(status.state), revision: safeText(status.revision), ...(entries === undefined ? {} : { entries: [...new Map(entries.map(entry => [entry.entryId, entry])).values()] }), ...(status.error === undefined ? {} : { error: safeError(status.error) }) };
}
function sourceIdFor(caller: Partial<HostCallerIdentity> | undefined) { return `view-frontend:${safeText(caller?.connectionId, 'unknown-connection')}`; }
function isAdmittedFrontend(value: unknown): value is HostCallerIdentity {
  const caller = recordOf(value);
  return caller.kind === 'frontend' && (caller.sourceId === 'view-frontend' || /^forgeax-workspace:[^:\s]+:[^:\s]+$/.test(typeof caller.sourceId === 'string' ? caller.sourceId : '')) && typeof caller.connectionId === 'string' && caller.connectionId.length > 0 && typeof caller.capability === 'string' && caller.capability.length > 0;
}
export type InspectorRequest = { apiVersion: string; operation: string; clientId: string; requestId: string; args: RecordValue; token?: string; caller?: ToolApiRunOptions['caller'] };
type SafePluginEntry = NonNullable<ReturnType<typeof safePluginEntry>>;
type ActivationSnapshot = { state: string; revision?: string; entries?: Array<Partial<SafePluginEntry> & { entryId: string; fiberState?: string }>; error?: ReturnType<typeof safeError> };
type SafeApiSnapshot = ReturnType<typeof safeToolSnapshot> & { error?: ReturnType<typeof safeError> };
export type InspectorSource = { apiVersion: string; sourceId: string; kind: string; generation: number; state: string; observedAt: string; connection?: { connectionId: string; kind: string }; coverage: { assembly: boolean; activation: string; api: boolean; frontend: boolean }; assembly: ReturnType<typeof safeAssembly>; actual: ReturnType<typeof safeActivationStatus>; api: SafeApiSnapshot; plugins: SafePluginEntry[] };
export type InspectorSources = { apiVersion: string; observedAt: string; sources: Array<Omit<InspectorSource, 'apiVersion' | 'api' | 'plugins' | 'assembly' | 'actual'> & { pluginCount: number; operationCount: number }>; caller: { connectionId?: string; kind?: string } };
type InspectorReport = Omit<InspectorSource, 'apiVersion' | 'kind' | 'coverage'>;
type InspectorWatch = { apiVersion: string; watchId: string; topic: string; source: InspectorSource };
type InspectorChange = { apiVersion?: string; watchId: string; state?: string; source?: InspectorSource };
export type InspectorBackendConfig = { accessToken?: string };
export type InspectorFrontendConfig = FrontendConfig & { transport?: WorkspaceTransport; workspace?: { clientId?: string; token?: string }; token?: string };
declare module '@forgeax/engine-plugin' { interface EngineContextServices { viewInspector: ViewInspectorBroker; viewInspectorClient: ViewInspectorClient | undefined } }
function assertInspectorRequest(value: unknown, expectedOperation: string): InspectorRequest {
  const request = requireWorkspaceObject(value, 'request');
  if (request.apiVersion !== VIEW_INSPECTOR_API_VERSION) {
    throw workspaceError(
      'view-inspector-version-mismatch',
      `API version ${VIEW_INSPECTOR_API_VERSION}`,
      'Install a matching View inspector client.',
      { actual: request.apiVersion, expected: VIEW_INSPECTOR_API_VERSION },
    );
  }
  if (!INSPECTOR_OPERATION_SET.has(String(request.operation)) || request.operation !== expectedOperation) {
    throw workspaceError(
      'view-inspector-operation-unknown',
      'operation to be present in the View inspector API',
      'Refresh inspector capabilities and use a supported operation.',
      { operation: request.operation },
    );
  }
  requireWorkspaceString(request.clientId, 'clientId');
  requireWorkspaceString(request.requestId, 'requestId');
  requireWorkspaceObject(request.args, 'args');
  return { ...request, apiVersion: String(request.apiVersion), operation: String(request.operation), clientId: requireWorkspaceString(request.clientId, 'clientId'), requestId: requireWorkspaceString(request.requestId, 'requestId'), args: requireWorkspaceObject(request.args, 'args') };
}

export function createInspectorRequest(
  operation: string,
  args: RecordValue = {},
  { clientId, token, requestId }: { clientId?: string; token?: string; requestId?: string } = {},
) {
  if (!INSPECTOR_OPERATION_SET.has(operation)) {
    throw workspaceError(
      'view-inspector-operation-unknown',
      'operation to be present in the View inspector API',
      'Refresh inspector capabilities and use a supported operation.',
      { operation },
    );
  }
  const request: InspectorRequest = {
    apiVersion: VIEW_INSPECTOR_API_VERSION,
    operation,
    clientId: requireWorkspaceString(clientId, 'clientId'),
    requestId:
      requestId === undefined
        ? createWorkspaceId('inspector-request')
        : requireWorkspaceString(requestId, 'requestId'),
    args: requireWorkspaceObject(args, 'args'),
  };
  if (token !== undefined) request.token = requireWorkspaceString(token, 'token');
  return Object.freeze(request);
}

function decodeInspectorError(cause: unknown) {
  if (cause instanceof ViewWorkspaceError) return cause;
  const error = recordOf(cause);
  const detail = recordOf(error.detail);
  const remoteCode = typeof detail.remoteCode === 'string' ? detail.remoteCode : undefined;
  const code = [error?.code, remoteCode].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.startsWith('view-inspector-'),
  );
  if (code === undefined) return cause;
  const message = typeof error?.message === 'string' && error.message.trim() !== ''
    ? error.message
    : String(error);
  return new ViewWorkspaceError(
    code,
    typeof error?.expected === 'string' ? error.expected : message,
    typeof error?.hint === 'string' ? error.hint : message,
    {
      ...(error?.detail && typeof error.detail === 'object' ? detail : {}),
      ...(remoteCode === undefined ? {} : { remoteCode }),
      ...(typeof error?.name === 'string' ? { name: error.name } : {}),
    },
  );
}

function toolFailureError(failure: ToolRuntimeError) {
  const detail = recordOf(failure.detail);
  const operationCode = [detail?.code, detail?.remoteCode].find(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.startsWith('view-'),
  );
  const payload = detail?.payload ?? detail?.detail;
  const diagnostic = [failure?.code, detail?.code, detail?.remoteCode]
    .filter((value, index, values) => typeof value === 'string' && values.indexOf(value) === index)
    .join(' -> ');
  const preservedHint =
    (typeof failure?.hint === 'string' && failure.hint.trim() !== '' ? failure.hint : undefined)
    ?? (typeof failure?.expected === 'string' && failure.expected.trim() !== '' ? failure.expected : undefined);
  const hint = `${preservedHint ?? ''}${diagnostic ? `${preservedHint ? ' ' : ''}(provider: ${diagnostic})` : ''}`.trim();
  if (operationCode !== undefined) {
    return workspaceError(
      operationCode,
      typeof detail.expected === 'string' ? detail.expected : failure.expected,
      typeof detail.hint === 'string' ? detail.hint : (hint || preservedHint),
      {
        failure: safeError(failure) ?? { failure },
        ...(payload && typeof payload === 'object' ? { cause: payload } : {}),
      },
    );
  }
  return workspaceError(
    'view-tool-provider-failed',
    typeof failure?.expected === 'string'
      ? safeText(failure.expected)
      : preservedHint,
    hint || preservedHint,
    { failure: safeError(failure) },
  );
}

/** Run a workspace operation through the Engine ToolApi provider. */
export async function runWorkspaceToolApi(
  api: ToolApi,
  { operation, args, clientId, token, requestId, caller, signal, providerId, generation }: ToolApiRunOptions & { operation: string; args: unknown; clientId?: string; token?: string; requestId?: string },
) {
  const run = api.run(
    operation,
    { args, clientId, token, requestId },
    { sourceId: 'view-backend', providerId, generation, caller, signal },
  );
  const terminal = await run.terminal;
  if (terminal.outcome === 'failed') throw toolFailureError(terminal.failure);
  return terminal.result;
}

/** Run an inspector envelope through the canonical ToolApi provider. */
export async function runInspectorToolApi(
  api: ToolApi,
  { operation, payload, caller, signal, providerId, generation }: ToolApiRunOptions & { operation: string; payload: unknown },
) {
  const run = api.run(operation, payload, {
    sourceId: 'view-backend',
    providerId,
    generation,
    caller,
    signal,
  });
  const terminal = await run.terminal;
  if (terminal.outcome === 'failed') throw toolFailureError(terminal.failure);
  return terminal.result;
}

/** Run any View-owned operation through the Engine ToolApi provider. */
export async function runViewToolApi(
  api: ToolApi,
  { operation, args = {}, caller, signal, providerId, generation }: ToolApiRunOptions & { operation: string; args?: unknown },
) {
  const run = api.run(operation, args, {
    sourceId: 'view-backend',
    providerId,
    generation,
    caller,
    signal,
  });
  const terminal = await run.terminal;
  if (terminal.outcome === 'failed') throw toolFailureError(terminal.failure);
  return terminal.result;
}

/**
 * Canonical View workspace contributions. The wire operation list remains a
 * validation/help projection; transport execution is admitted by ToolApi.
 */
export function createViewWorkspaceToolContributions(workspace: ViewWorkspaceBroker) {
  const schema: ToolSchema<RecordValue> = {
    parse(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? { ok: true, value: value as RecordValue }
        : { ok: false, error: 'workspace API arguments must be an object' };
    },
    describe: 'JSON object accepted by the View workspace operation.',
  };
  return VIEW_WORKSPACE_DOMAIN_OPERATIONS.filter((operation) => WORKSPACE_OPERATION_SET.has(operation)).map(
    (operation) =>
      defineTool(
        {
          id: operation,
          path: operation.split('.'),
          title: operation,
          summary: `View workspace operation ${operation}.`,
          realm: 'host',
          argsSchema: schema,
          resultSchema: schema,
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          evidence: [],
        },
        async (envelope, context) => {
          try {
            const request = {
              apiVersion: VIEW_WORKSPACE_API_VERSION,
              operation,
              clientId: requireWorkspaceString(envelope.clientId, 'clientId'),
              requestId: requireWorkspaceString(envelope.requestId, 'requestId'),
              args: requireWorkspaceObject(envelope.args, 'args'),
              ...(envelope.token === undefined ? {} : { token: requireWorkspaceString(envelope.token, 'token') }),
            };
            return safeClone(await workspace.call(request, { signal: context.signal, caller: context.caller }));
          } catch (error) {
            if (error instanceof ViewWorkspaceError) {
              return {
                ok: false,
                error: {
                  code: error.code,
                  expected: error.expected,
                  hint: error.hint,
                  detail: safeClone(error.detail),
                },
              };
            }
            throw error;
          }
        },
      ),
  );
}

function inspectorRequestSchema(operation: string): ToolSchema<InspectorRequest> {
  return {
    parse(value) {
      try {
        return { ok: true, value: assertInspectorRequest(value, operation) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    describe: '{"type":"object","required":["apiVersion","operation","clientId","requestId","args"]}',
  };
}

const inspectorResultSchema: ToolSchema<object> = {
  parse(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { ok: true, value: value as RecordValue }
      : { ok: false, error: 'inspector result must be an object' };
  },
  describe: '{"type":"object"}',
};

function inspectorFailure(error: unknown) {
  if (!(error instanceof ViewWorkspaceError)) throw error;
  return {
    ok: false,
    error: {
      code: error.code,
      expected: error.expected,
      hint: error.hint,
      detail: safeDetail(error.detail),
    },
  };
}

/** Canonical inspector contributions; the Host transport only adapts to these. */
export function createViewInspectorToolContributions(broker: ViewInspectorBroker) {
  return [...VIEW_INSPECTOR_OPERATIONS, ...VIEW_INSPECTOR_INTERNAL_OPERATIONS].map((operation) =>
    {
      const description = PLUGINS_OPERATION_DESCRIPTIONS.find((entry) => entry.id === operation);
      return defineTool<unknown, object>(
      {
        id: operation,
        path: description?.path ?? operation.split('.'),
        title: description?.title ?? `Inspect ${operation}`,
        summary: description?.summary ?? `Internal View inspector operation ${operation}.`,
        realm: 'host',
        argsSchema: inspectorRequestSchema(operation),
        resultSchema: inspectorResultSchema,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        evidence: [],
      },
      async (input, context) => {
        const request = input as InspectorRequest;
        try {
          const canonical = { ...request, caller: context.caller };
          if (operation === 'plugins.sources') {
            return broker.sources(canonical);
          }
          if (operation === 'plugins.inspect') return broker.inspect(canonical);
          if (operation === 'plugins.watch') return broker.watch(canonical);
          if (operation === 'plugins.unwatch') return broker.unwatch(canonical);
          return await broker.report(canonical, context.caller);
        } catch (error) {
          return inspectorFailure(error);
        }
      },
    );
    },
  );
}

export function createViewStatusToolContributions(broker: { handshake: () => object | Promise<object> }) {
  const argsSchema: ToolSchema<object> = {
    parse(value) {
      return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value))
        ? { ok: true, value: value ?? {} }
        : { ok: false, error: 'View status arguments must be an object' };
    },
    describe: 'JSON object accepted by the read-only View status operation.',
  };
  const resultSchema: ToolSchema<object> = {
    parse(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? { ok: true, value: value as RecordValue }
        : { ok: false, error: 'View status result must be an object' };
    },
    describe: 'JSON object returned by the View status operation.',
  };
  return [
    defineTool(
      {
        id: VIEW_STATUS_OPERATION,
        path: VIEW_STATUS_OPERATION.split('.'),
        title: 'View status',
        summary: 'Read the current View display and workspace status.',
        realm: 'host',
        argsSchema,
        resultSchema,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        evidence: [],
      },
      async () => broker.handshake(),
    ),
  ];
}

export class ViewInspectorBroker {
  declare readonly transport: HostTransportServer;
  declare readonly accessToken: string;
  declare readonly hostAssembly: BackendAssemblyAuthority | FrontendAssemblyState | undefined;
  declare readonly toolApi: ToolApi | undefined;
  declare readonly context: Context | undefined;
  declare readonly reports: Map<string, InspectorReport>;
  declare readonly watches: Map<string, { watchId: string; sourceId: string; generation: number; connectionId: string }>;
  declare readonly frontendCapabilities: Map<string, string>;
  declare readonly disposers: Array<() => void>;
  declare backendSourceGeneration: number;
  constructor({ transport, accessToken, hostAssembly, toolApi, context }: { transport?: HostTransportServer; accessToken?: string; hostAssembly?: BackendAssemblyAuthority | FrontendAssemblyState; toolApi?: ToolApi; context?: Context } = {}) {
    if (!transport || typeof transport.register !== 'function') {
      throw new TypeError('View inspector requires an Engine Host transport');
    }
    this.transport = transport;
    this.accessToken = requireWorkspaceString(accessToken, 'accessToken');
    this.hostAssembly = hostAssembly;
    this.toolApi = toolApi;
    this.context = context;
    this.reports = new Map();
    this.watches = new Map();
    this.frontendCapabilities = new Map();
    this.disposers = [];
    this.backendSourceGeneration = 1;
  }

  grantFrontendConnection(caller: unknown) {
    if (
      !isAdmittedFrontend(caller)
    ) {
      throw workspaceError(
        'view-inspector-unauthorized',
        'a real FrontendHost connection to receive the inspector capability',
        'Connect the frontend through the backend Host pairing before reporting activation.',
      );
    }
    this.frontendCapabilities.set(caller.connectionId, caller.capability);
    return caller.capability;
  }

  assertFrontendCaller(caller: unknown): asserts caller is HostCallerIdentity {
    if (
      !isAdmittedFrontend(caller) ||
      this.frontendCapabilities.get(caller.connectionId) !== caller.capability
    ) {
      throw workspaceError(
        'view-inspector-unauthorized',
        'a backend-issued inspector capability on a real FrontendHost connection',
        'Report frontend activation only through the paired FrontendHost transport.',
        { kind: recordOf(caller).kind, sourceId: recordOf(caller).sourceId },
      );
    }
  }

  backendSnapshot(): InspectorSource {
    let api: SafeApiSnapshot;
    let state = 'unknown';
    try {
      api = safeToolSnapshot(this.toolApi?.snapshot?.());
    } catch (error) {
      state = 'unavailable';
      api = { providers: [], operations: [], error: safeError(error) };
    }
    const assembly = safeAssembly(this.hostAssembly);
    const fibers = [];
    for (const runtime of this.context?.registry?.values?.() ?? []) {
      for (const fiber of runtime.fibers ?? []) {
        const inspected = inspectPluginFiber(fiber);
        if (inspected.uid !== null) fibers.push({ ...inspected, realm: 'host' });
      }
    }
    if (this.context) state = inspectPluginFiber(this.context.fiber).state;
    const actual = actualPluginEntries(undefined, fibers);
    const activation = { state, entries: structuredClone(actual) };
    return {
      apiVersion: VIEW_INSPECTOR_API_VERSION,
      sourceId: 'view-backend',
      kind: 'backend',
      generation: (this.hostAssembly && 'generation' in this.hostAssembly ? this.hostAssembly.generation : undefined) ?? this.backendSourceGeneration,
      state,
      observedAt: new Date().toISOString(),
      coverage: {
        assembly: assembly !== null,
        activation: this.context === undefined ? 'unknown' : 'actual',
        api: this.toolApi !== undefined,
        frontend: false,
      },
      assembly,
      actual: activation,
      api,
      plugins: actual,
    };
  }

  frontendSnapshot(record: InspectorReport): InspectorSource {
    return {
      apiVersion: VIEW_INSPECTOR_API_VERSION,
      sourceId: record.sourceId,
      kind: 'frontend',
      generation: record.generation,
      state: record.state,
      observedAt: record.observedAt,
      connection: record.connection,
      coverage: {
        assembly: record.assembly !== null,
        activation: record.actual?.entries === undefined ? 'unknown' : 'actual',
        api: true,
        frontend: true,
      },
      assembly: record.assembly,
      actual: record.actual,
      api: record.api,
      plugins: record.plugins,
    };
  }

  source(sourceId: string): InspectorSource | undefined {
    if (sourceId === 'view-backend') return this.backendSnapshot();
    const report = this.reports.get(sourceId);
    return report === undefined ? undefined : this.frontendSnapshot(report);
  }

  requireSource(inputSourceId: unknown, generation: unknown) {
    const sourceId = requireWorkspaceString(inputSourceId, 'sourceId');
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= 0) {
      throw workspaceError(
        'view-inspector-generation-required',
        'source generation to be a positive integer',
        'Call plugins.sources and pass the generation returned for the selected source.',
        { sourceId },
      );
    }
    const current = this.source(sourceId);
    if (current === undefined) {
      throw workspaceError(
        'view-inspector-source-unavailable',
        `source ${sourceId} to be connected and observed`,
        'Refresh plugins.sources and select an authenticated source that is still connected.',
        { sourceId },
      );
    }
    if (generation !== current.generation) {
      throw workspaceError(
        'view-inspector-stale-generation',
        `source ${sourceId} generation ${generation} to match ${current.generation}`,
        'Refresh plugins.sources before inspecting or watching this source.',
        { sourceId, expectedGeneration: current.generation, actualGeneration: generation },
      );
    }
    return current;
  }

  authorize(request: InspectorRequest) {
    if (request.token !== this.accessToken) {
      throw workspaceError(
        'view-inspector-unauthorized',
        'the caller to use the View Host inspector token',
        'Connect with the token issued by the View Host.',
        { clientId: request.clientId },
      );
    }
  }

  sources(request: InspectorRequest): InspectorSources {
    this.authorize(request);
    const backend = this.backendSnapshot();
    const frontend = [...this.reports.values()].map((record) => this.frontendSnapshot(record));
    return {
      apiVersion: VIEW_INSPECTOR_API_VERSION,
      observedAt: new Date().toISOString(),
      sources: [backend, ...frontend].map((source) => ({
        sourceId: source.sourceId,
        kind: source.kind,
        generation: source.generation,
        state: source.state,
        observedAt: source.observedAt,
        ...(source.connection === undefined ? {} : { connection: source.connection }),
        coverage: source.coverage,
        pluginCount: Array.isArray(source.plugins) ? source.plugins.length : 0,
        operationCount: source.api?.operations?.length ?? 0,
      })),
      caller: { connectionId: request.caller?.connectionId, kind: request.caller?.kind },
    };
  }

  inspect(request: InspectorRequest): InspectorSource {
    this.authorize(request);
    const source = this.requireSource(request.args.sourceId, request.args.generation);
    const entryId = request.args.entryId;
    if (entryId !== undefined) requireWorkspaceString(entryId, 'entryId');
    if (entryId === undefined) return source;
    return {
      ...source,
      plugins: source.plugins.filter((entry) => entry.entryId === entryId),
      api: {
        ...source.api,
        operations: source.api.operations.filter((operation) =>
          operation.owner?.fiberId === entryId || operation.descriptor?.id === entryId,
        ),
      },
    };
  }

  watch(request: InspectorRequest): InspectorWatch {
    this.authorize(request);
    const source = this.requireSource(request.args.sourceId, request.args.generation);
    const watchId = createWorkspaceId('inspector-watch');
    this.watches.set(watchId, {
      watchId,
      sourceId: source.sourceId,
      generation: source.generation,
      connectionId: request.caller!.connectionId,
    });
    return {
      apiVersion: VIEW_INSPECTOR_API_VERSION,
      watchId,
      topic: VIEW_INSPECTOR_TOPIC,
      source,
    };
  }

  unwatch(request: InspectorRequest) {
    this.authorize(request);
    const watchId = requireWorkspaceString(request.args.watchId, 'watchId');
    const watch = this.watches.get(watchId);
    if (watch !== undefined && watch.connectionId !== request.caller!.connectionId) {
      throw workspaceError(
        'view-inspector-unauthorized',
        'the watch to be owned by the authenticated caller',
        'Use the watchId returned by this connection.',
        { watchId },
      );
    }
    this.watches.delete(watchId);
    return { apiVersion: VIEW_INSPECTOR_API_VERSION, watchId, released: true };
  }

  async report(request: InspectorRequest, caller: unknown) {
    this.authorize(request);
    this.assertFrontendCaller(caller);
    const sourceId = sourceIdFor(caller);
    const previous = this.reports.get(sourceId);
    const generation = (previous?.generation ?? 0) + 1;
    const rawReport = request.args?.report ?? {};
    if (!rawReport || typeof rawReport !== 'object' || Array.isArray(rawReport)) {
      throw workspaceError(
        'view-inspector-invalid-report',
        'frontend report to be a structured object',
        'Send the activation status and safe API projection produced by FrontendHost.',
      );
    }
    const report = recordOf(rawReport);
    const record = {
      sourceId,
      generation,
      state: safeText(recordOf(report.actual).state ?? report.state, 'active'),
      observedAt: new Date().toISOString(),
      connection: { connectionId: caller.connectionId, kind: caller.kind ?? 'unknown' },
      assembly: safeAssembly(report.assembly),
      actual: safeActivationStatus(report.actual ?? report.status),
      api: safeToolSnapshot(report.api),
      plugins: actualPluginEntries(
        report.actual ?? report.status,
        Array.isArray(report.plugins) ? report.plugins : [],
      ),
    };
    this.reports.set(sourceId, record);
    this.publish(sourceId);
    return { apiVersion: VIEW_INSPECTOR_API_VERSION, sourceId, generation };
  }

  publish(sourceId: string) {
    const source = this.source(sourceId);
    if (source === undefined) return;
    for (const [watchId, watch] of this.watches) {
      if (watch.sourceId !== sourceId) continue;
      if (watch.generation !== source.generation) {
        this.transport.publish(
          VIEW_INSPECTOR_TOPIC,
          {
            apiVersion: VIEW_INSPECTOR_API_VERSION,
            watchId,
            sourceId,
            state: 'stale',
            generation: source.generation,
            reason: 'source-generation-changed',
          },
          { connectionId: watch.connectionId },
        );
        this.watches.delete(watchId);
        continue;
      }
      this.transport.publish(
        VIEW_INSPECTOR_TOPIC,
        { apiVersion: VIEW_INSPECTOR_API_VERSION, watchId, source },
        { connectionId: watch.connectionId },
      );
    }
  }

  install({ dispatch }: { dispatch?: (request: ToolApiRunOptions & { operation: string; payload: unknown }) => Promise<unknown> } = {}) {
    if (typeof dispatch !== 'function') {
      throw new TypeError('View inspector requires an Engine ToolApi dispatch adapter');
    }
    const register = (service: string, operation: string) => {
      this.disposers.push(
        this.transport.register(service, ({ payload, signal, caller }) =>
          dispatch({ operation, payload, signal, caller }),
        ),
      );
    };
    register(VIEW_INSPECTOR_SERVICES.sources, 'plugins.sources');
    register(VIEW_INSPECTOR_SERVICES.inspect, 'plugins.inspect');
    register(VIEW_INSPECTOR_SERVICES.watch, 'plugins.watch');
    register(VIEW_INSPECTOR_SERVICES.unwatch, 'plugins.unwatch');
    register(VIEW_INSPECTOR_SERVICES.report, 'plugins.report');
    if (typeof this.toolApi?.subscribe === 'function') {
      this.disposers.push(this.toolApi.subscribe(() => this.publish('view-backend')));
    }
    if (typeof this.transport.onClientConnect === 'function') {
      this.disposers.push(
        this.transport.onClientConnect((caller) => {
          if (isAdmittedFrontend(caller)) {
            try {
              this.grantFrontendConnection(caller);
            } catch {
              // A malformed connection identity remains unable to report.
            }
          }
        }),
      );
    }
    if (typeof this.transport.onClientDisconnect === 'function') {
      this.disposers.push(
        this.transport.onClientDisconnect((caller) => {
          const sourceId = sourceIdFor(caller);
          const report = this.reports.get(sourceId);
          if (report !== undefined) {
            for (const [watchId, watch] of this.watches) {
              if (watch.sourceId !== sourceId || watch.connectionId === caller.connectionId) continue;
              this.transport.publish(
                VIEW_INSPECTOR_TOPIC,
                {
                  apiVersion: VIEW_INSPECTOR_API_VERSION,
                  watchId,
                  sourceId,
                  state: 'stale',
                  generation: report.generation + 1,
                  reason: 'source-disconnected',
                },
                { connectionId: watch.connectionId },
              );
              this.watches.delete(watchId);
            }
          }
          this.reports.delete(sourceId);
          this.frontendCapabilities.delete(caller.connectionId);
          for (const [watchId, watch] of this.watches) {
            if (watch.connectionId === caller.connectionId) this.watches.delete(watchId);
          }
        }),
      );
    }
    return () => {
      for (const dispose of this.disposers.splice(0)) dispose?.();
      this.reports.clear();
      this.watches.clear();
      this.frontendCapabilities.clear();
    };
  }
}

export const viewInspectorBackendPlugin = {
  name: BACKEND_PLUGIN_ID,
  inject: ['toolApi'],
  provide: ['viewInspector'],
  async apply(ctx: Context, config: InspectorBackendConfig = {}) {
    const nativeTransport = ctx.get?.('hostTransport', false);
    if (!nativeTransport || !('register' in nativeTransport)) return;
    const transport = nativeTransport;
    const broker = new ViewInspectorBroker({
      transport,
      accessToken: config.accessToken ?? ctx.get?.('viewWorkspaceAccessToken', false),
      hostAssembly: ctx.get?.('hostAssembly', false),
      context: ctx,
      toolApi: ctx.get?.('toolApi', false),
    });
    ctx.provide('viewInspector', broker);
    const inspectorTools = createViewInspectorToolContributions(broker);
    const inspectorProviderId = `view-inspector:${String(ctx.fiber.uid)}`;
    let uninstall: (() => void) | undefined;
    let revokeTools: Dispose | undefined;
    ctx.effect(() => async () => {
      await revokeTools?.();
      uninstall?.();
    });
    revokeTools = registerTools(ctx, inspectorTools, {
      providerId: inspectorProviderId,
      sourceId: 'view-backend',
      module: BACKEND_MODULE,
      realm: 'host',
    });
    const inspectorOwner = ctx
      .get?.('toolApi', false)
      ?.describe('plugins.sources', 'view-backend')
      ?.find((record) => record.owner.providerId === inspectorProviderId)?.owner;
    if (!inspectorOwner) {
      throw new Error('View inspector ToolApi provider did not activate');
    }
    uninstall = broker.install({
      dispatch: ({ operation, payload, signal, caller }) =>
        runInspectorToolApi(ctx.get('toolApi')!, {
          operation,
          payload,
          signal,
          caller,
          providerId: inspectorOwner.providerId,
          generation: inspectorOwner.generation,
        }),
    });
  },
};

function projectLocalAssembly(value: unknown) {
  const assembly = recordOf(value).current ?? value;
  return safeAssembly(assembly);
}

export class ViewInspectorClient {
  declare readonly transport: WorkspaceTransport;
  declare readonly clientId: string;
  declare readonly token: string | undefined;
  constructor({ transport, clientId, token }: { transport?: WorkspaceTransport; clientId?: string; token?: string } = {}) {
    if (!transport || typeof transport.request !== 'function') {
      throw new TypeError('View inspector client requires an Engine Host transport');
    }
    this.transport = transport;
    this.clientId = requireWorkspaceString(clientId, 'clientId');
    this.token = token === undefined ? undefined : requireWorkspaceString(token, 'token');
  }

  request<T = unknown>(service: string, operation: string, args: RecordValue = {}, options: WorkspaceCallOptions = {}): Promise<T> {
    const request = createInspectorRequest(operation, args, {
      clientId: this.clientId,
      token: this.token,
      requestId: options.requestId,
    });
    return this.transport
      .request<typeof request, T>(service, request, { signal: options.signal })
      .catch((error) => {
        const decoded = decodeInspectorError(error);
        reportWorkspaceCommandError(decoded, { operation, signal: options.signal });
        throw decoded;
      });
  }

  sources(options: WorkspaceCallOptions = {}): Promise<InspectorSources> {
    return this.request<InspectorSources>(VIEW_INSPECTOR_SERVICES.sources, 'plugins.sources', {}, options);
  }

  inspect({ sourceId, generation, entryId, ...options }: WorkspaceCallOptions & { sourceId?: string; generation?: number; entryId?: string } = {}): Promise<InspectorSource> {
    return this.request<InspectorSource>(
      VIEW_INSPECTOR_SERVICES.inspect,
      'plugins.inspect',
      { sourceId, generation, ...(entryId === undefined ? {} : { entryId }) },
      options,
    );
  }

  watch({ sourceId, generation, ...options }: WorkspaceCallOptions & { sourceId?: string; generation?: number } = {}): Promise<InspectorWatch> {
    return this.request<InspectorWatch>(VIEW_INSPECTOR_SERVICES.watch, 'plugins.watch', { sourceId, generation }, options);
  }

  unwatch(watchId: string, options: WorkspaceCallOptions = {}) {
    return this.request(VIEW_INSPECTOR_SERVICES.unwatch, 'plugins.unwatch', { watchId }, options);
  }

  report(report: object, options: WorkspaceCallOptions = {}) {
    return this.request<{ apiVersion: string; sourceId: string; generation: number }>(VIEW_INSPECTOR_SERVICES.report, 'plugins.report', { report }, options);
  }

  subscribe(listener: (change: InspectorChange) => void) {
    return this.transport.subscribe?.(VIEW_INSPECTOR_TOPIC, listener) ?? (() => {});
  }

  onDisconnect(listener: Parameters<HostTransportClient["onDisconnect"]>[0]) {
    return this.transport.onDisconnect?.(listener) ?? (() => {});
  }
}

export const viewInspectorFrontendPlugin = {
  name: 'forgeax.view.service.plugin-inspection-reporter.frontend',
  provide: ['viewInspectorClient'],
  async apply(ctx: Context, config: InspectorFrontendConfig = {}) {
    const nativeTransport = config.transport ?? ctx.get?.('hostTransport', false);
    const transport = nativeTransport && 'request' in nativeTransport ? nativeTransport : undefined;
    const workspace = config.workspace ?? {};
    const token = config.token ?? workspace.token;
    const client =
      transport && typeof token === 'string' && typeof workspace.clientId === 'string'
        ? new ViewInspectorClient({ transport, clientId: workspace.clientId, token })
        : undefined;
    ctx.provide('viewInspectorClient', client);
    if (client) {
      const toolApi = ctx.get?.('toolApi', false);
      const assemblyService = ctx.get?.('hostAssembly', false);
      const hostAssembly = assemblyService && 'status' in assemblyService ? assemblyService : undefined;
      const report = () => {
        const entries = hostAssembly?.inspection ?? [inspectPluginFiber(ctx.fiber)];
        return {
          actual: { ...(hostAssembly?.status ?? { state: 'unknown' }), entries },
          assembly: projectLocalAssembly(hostAssembly),
          api: safeToolSnapshot(toolApi?.snapshot?.()),
          plugins: entries.map(safePluginEntry).filter(entry => entry !== null),
        };
      };
      let reporting = Promise.resolve();
      let queued = false;
      const lifetime = new AbortController();
      const publishReport = ({ allowUnready = false } = {}) => {
        if (lifetime.signal.aborted || queued) return reporting;
        const state = hostAssembly?.status?.state;
        if (!allowUnready && hostAssembly !== undefined && (state === 'created' || state === 'loading')) {
          return reporting;
        }
        queued = true;
        reporting = reporting
          .then(async () => {
            queued = false;
            if (lifetime.signal.aborted) return;
            await client.report(report(), { signal: lifetime.signal });
          })
          .catch(() => {});
        return reporting;
      };
      const unsubscribeAssembly = hostAssembly?.subscribe?.(() => {
        void publishReport();
      });
      const unsubscribeToolApi = toolApi?.subscribe?.(() => {
        void publishReport();
      });
      // Presentation children can start or fail after the Shell becomes ACTIVE,
      // without changing tools or the Host assembly revision.
      ctx.on('internal/plugin', () => { void publishReport(); });
      ctx.on('internal/status', () => { void publishReport(); });
      ctx.effect(() => async () => {
        lifetime.abort();
        unsubscribeAssembly?.();
        unsubscribeToolApi?.();
      });
      await publishReport({ allowUnready: true });
    }
  },
};
