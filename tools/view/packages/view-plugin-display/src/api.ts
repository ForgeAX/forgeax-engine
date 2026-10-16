import type { ToolCallerIdentity, ToolSchema } from '@forgeax/engine-tool-runtime';
import type { DisplayStatusInput } from './status.ts';
export type DisplayBindArgs = { root: string | null; runId?: string };
export type DisplayService = { handshake: (caller?: ToolCallerIdentity) => object | Promise<object>; bind?: (input: DisplayBindArgs, caller?: ToolCallerIdentity, signal?: AbortSignal) => DisplayStatusInput | Promise<DisplayStatusInput> };
import { createViewStatusToolContributions } from './tool-runtime.ts';
import { defineTool, toolJsonSchema } from '@forgeax/engine-tool-runtime';
export const DISPLAY_STATUS_OPERATION_DESCRIPTION = Object.freeze({
  id: 'view.display.status',
  path: ['view', 'display', 'status'],
  title: 'View status',
  summary: 'Read the current View display and workspace status.',
});

const bindingInput = {
  type: 'object',
  properties: { root: { type: ['string', 'null'] }, runId: { type: 'string', minLength: 1 } },
  required: ['root'], additionalProperties: false,
};
const bindingArgs: ToolSchema<DisplayBindArgs> = {
  describe: JSON.stringify(bindingInput),
  parse(value: unknown) {
    const input = value as Partial<DisplayBindArgs> | null;
    const valid = value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).every(key => key === 'root' || key === 'runId')
      && (input?.root === null || (typeof input?.root === 'string' && input?.root.trim()
        && (input.runId === undefined || (typeof input.runId === 'string' && input.runId.trim()))));
    return valid ? { ok: true, value: value as DisplayBindArgs } : { ok: false, error: 'Provide a project root, optionally an exact runId, or null root to disconnect.' };
  },
};

/** API (Tool) contributions for the display product plugin. */
export function createDisplayApiTools(broker: DisplayService) {
  return [
    ...createViewStatusToolContributions(broker, DISPLAY_STATUS_OPERATION_DESCRIPTION),
    ...(broker.bind ? [defineTool<unknown, unknown>({
      id: 'view.display.bind', path: ['view', 'display', 'bind'], title: 'Bind observed run',
      summary: 'Observe a project run. Omit runId to discover and pin its current run once; null root disconnects. Never follows replacements.',
      realm: 'host',
      argsSchema: bindingArgs,
      resultSchema: toolJsonSchema({ type: 'object' }), inputSchema: bindingInput, outputSchema: { type: 'object' }, evidence: [],
    }, (args, context) => broker.bind!(args as DisplayBindArgs, context.caller, context.signal))] : []),
  ];
}
