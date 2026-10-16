import type { ToolApi, ToolApiRunOptions, ToolRuntimeError, ToolSchema, JsonValue } from '@forgeax/engine-tool-runtime';
import type { WorkspaceRequest } from './contract.ts';
import type { ViewWorkspaceBroker } from './broker.ts';
import { workspaceDiagnosticRecord } from './command-error.ts';
export type WorkspaceOperation = { id: string; operation?: string; path?: readonly string[]; title?: string; summary?: string };
import { defineTool, toolJsonSchema } from '@forgeax/engine-tool-runtime';

import {
  VIEW_WORKSPACE_API_VERSION,
  createWorkspaceRequest,
  ViewWorkspaceError,
  cloneWorkspaceValue,
  workspaceError,
} from './contract.ts';

function safeClone<T>(value: T) {
  try {
    return cloneWorkspaceValue(value);
  } catch {
    return null;
  }
}

export function workspaceToolValue(value: unknown) {
  return { ok: true, value: safeClone(value) };
}

function toolFailureError(failure: ToolRuntimeError) {
  const detail = workspaceDiagnosticRecord(failure?.detail);
  const code = [detail?.code, detail?.remoteCode].find(
    (candidate) => typeof candidate === 'string' && candidate.startsWith('view-'),
  );
  const payload = detail?.payload ?? detail?.detail;
  const diagnostic =
    (typeof failure?.hint === 'string' && failure.hint.trim() !== '' ? failure.hint : undefined)
    ?? (typeof failure?.expected === 'string' && failure.expected.trim() !== '' ? failure.expected : undefined)
    ?? (failure === undefined || failure === null ? undefined : String(failure));
  if (typeof code === 'string') {
    return workspaceError(
      code,
      typeof detail.expected === 'string' ? detail.expected : failure.expected,
      typeof detail.hint === 'string' ? detail.hint : diagnostic,
      {
        failure: safeClone(failure) ?? { failure },
        ...(payload && typeof payload === 'object' ? { cause: payload } : {}),
      },
    );
  }
  return workspaceError(
    'view-workspace-provider-failed',
    typeof failure?.expected === 'string' ? failure.expected : diagnostic,
    diagnostic,
    { failure: safeClone(failure) ?? { failure } },
  );
}

export async function runWorkspaceToolApi(
  api: ToolApi,
  {
    operation,
    args,
    clientId,
    token,
    requestId,
    caller,
    signal,
    providerId,
    generation,
    sourceId = 'view-backend',
    apiVersion = VIEW_WORKSPACE_API_VERSION,
  }: ToolApiRunOptions & { operation: string; args?: Record<string, unknown>; clientId: string; token?: string; requestId?: string; apiVersion?: string },
) {
  const run = api.run(
    operation,
    {
      apiVersion,
      operation,
      ...args,
      args,
      clientId,
      token,
      requestId,
    },
    { sourceId, providerId, generation, caller, signal },
  );
  const terminal = await run.terminal;
  if (terminal.outcome === 'failed') throw toolFailureError(terminal.failure);
  const result = workspaceDiagnosticRecord(terminal.result);
  if (result.ok === false) {
    const error = workspaceDiagnosticRecord(result.error);
    throw workspaceError(
      typeof error.code === 'string' ? error.code : 'view-workspace-provider-failed',
      typeof error.expected === 'string' ? error.expected : undefined,
      typeof error.hint === 'string' ? error.hint : undefined,
      workspaceDiagnosticRecord(error.detail),
    );
  }
  return terminal.result;
}

export function defineWorkspaceOperations(operations: readonly WorkspaceOperation[]) {
  return Object.freeze(
    operations.map((operation) =>
      Object.freeze({
        path: operation.id.split('.'),
        title: operation.id,
        summary: `View workspace operation ${operation.id}.`,
        ...operation,
      }),
    ),
  );
}

export function createWorkspaceToolContributions(workspace: Pick<ViewWorkspaceBroker, 'call' | 'accessToken'>, operations: ReturnType<typeof defineWorkspaceOperations>) {
  const schema: ToolSchema<unknown> = {
    parse(value: unknown) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? { ok: true, value: value as WorkspaceRequest }
        : { ok: false, error: 'workspace API arguments must be an object' };
    },
    describe: 'JSON object accepted by the View workspace operation.',
  };
  return operations.map((description) =>
    defineTool(
      {
        id: description.id,
        path: description.path,
        title: description.title,
        summary: description.summary,
        realm: 'host',
        argsSchema: schema,
        resultSchema: toolJsonSchema({}),
        inputSchema: { type: 'object' },
        outputSchema: {},
        evidence: [],
      },
      async (input, context) => {
        const envelope = input as WorkspaceRequest;
        const backendClient = context.caller?.kind === 'cli' && context.caller.sourceId === 'devkit-backend-client';
        const direct = backendClient && envelope.apiVersion === undefined;
        try {
          return workspaceToolValue(
            await workspace.call(
              direct ? createWorkspaceRequest(description.operation ?? description.id,
                input as Record<string, unknown>, { clientId: context.caller!.sourceId,
                  token: workspace.accessToken, requestId: envelope.requestId }) : {
                apiVersion: VIEW_WORKSPACE_API_VERSION,
                operation: description.operation ?? description.id,
                clientId: envelope.clientId,
                requestId: envelope.requestId,
                args: envelope.args,
                ...(envelope.token === undefined ? {} : { token: envelope.token }),
              },
              { signal: context.signal, caller: context.caller },
            ),
          );
        } catch (error) {
          if (error instanceof ViewWorkspaceError) {
            return {
              ok: false,
              error: {
                code: error.code,
                expected: error.expected,
                hint: error.hint,
                detail: safeClone(error.detail) as JsonValue,
              },
            };
          }
          throw error;
        }
      },
    ),
  );
}
