import type { ToolApi, ToolCallerIdentity, ToolRuntimeError, ToolSchema, ToolDescriptor } from '@forgeax/engine-tool-runtime';
import { defineTool } from '@forgeax/engine-tool-runtime';

export const VIEW_STATUS_OPERATION = 'view.display.status';

function toolFailureError(failure: ToolRuntimeError) {
  const diagnostic =
    (typeof failure?.hint === 'string' && failure.hint.trim() !== '' ? failure.hint : undefined)
    ?? (typeof failure?.expected === 'string' && failure.expected.trim() !== '' ? failure.expected : undefined);
  const detail = failure.detail && typeof failure.detail === 'object' && !Array.isArray(failure.detail) ? failure.detail as Record<string, unknown> : {};
  return Object.assign(new Error(diagnostic ?? String(failure ?? 'view-status-provider-failed')), { name: 'ViewToolError', code: detail.code ?? detail.remoteCode ?? failure.code, expected: failure.expected, hint: failure.hint ?? diagnostic, detail: failure.detail ?? { failure } });
}

export async function runViewToolApi(
  api: ToolApi,
  { operation, args = {}, caller, signal, providerId, generation }: { operation: string; args?: unknown; caller?: ToolCallerIdentity; signal?: AbortSignal; providerId?: string; generation?: number },
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

export function createViewStatusToolContributions(broker: { handshake: (caller?: ToolCallerIdentity) => object | Promise<object> }, description: Pick<ToolDescriptor, "id" | "path" | "title" | "summary">) {
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
        ? { ok: true, value }
        : { ok: false, error: 'View status result must be an object' };
    },
    describe: 'JSON object returned by the View status operation.',
  };
  return [
    defineTool<unknown, object>(
      {
        id: description.id,
        path: description.path,
        title: description.title,
        summary: description.summary,
        realm: 'host',
        argsSchema,
        resultSchema,
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        evidence: [],
      },
      async (_args, context) => broker.handshake(context.caller),
    ),
  ];
}
