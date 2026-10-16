import { defineTool, type ToolContribution, toolJsonSchema } from '@forgeax/engine-tool-runtime';
import { animationPlayback, animationPlaybackSchema } from './animation-playback.js';
import { executionWorkers, executionWorkersSchema } from './execution-workers.js';
import { liveDevControl, liveDevStatus, startLiveDev } from './live-dev.js';

/** Thin operation adapters over the existing live owner and its discovery file. */
export function createWorkspaceLiveTools(defaultRoot?: string): readonly ToolContribution[] {
  const descriptor = (operation: string) => ({
    id: `engine.run.${operation}`,
    path: ['engine', 'run', ...operation.split('.')],
    title: `Engine run ${operation}`,
    summary: `${operation} an independent Engine run with fixed project inputs.`,
    realm: 'host' as const,
    argsSchema: toolJsonSchema<Record<string, unknown>>({
      type: 'object',
      required: defaultRoot ? [] : ['root'],
      properties: { root: { type: 'string', minLength: 1 } },
    }),
    resultSchema: toolJsonSchema({}),
    inputSchema: {
      type: 'object',
      required: defaultRoot ? [] : ['root'],
      properties: {
        root: { type: 'string', minLength: 1 },
        headless: { type: 'boolean' },
        backend: { enum: ['hardware', 'software', 'auto'] },
        workers: executionWorkersSchema,
        animation: animationPlaybackSchema,
        revision: { type: 'string' },
        code: { type: 'string' },
        output: { type: 'string' },
        checkpoint: { type: 'string' },
        name: { type: 'string' },
        ref: { type: 'string' },
        timeoutMs: { type: 'integer' },
        lease: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        distance: { type: 'number' },
        lens: { type: 'object' },
        exposure: { type: 'object' },
        requireUi: { type: 'boolean' },
        entity: { type: 'number' },
        position: { type: 'array', items: { type: 'number' } },
        target: { type: 'array', items: { type: 'number' } },
        up: { type: 'array', items: { type: 'number' } },
      },
    },
    outputSchema: {},
    evidence: [],
  });
  const root = (args: Record<string, unknown>) => String(args.root ?? defaultRoot);
  const json = async (value: unknown) => JSON.parse(JSON.stringify(await value));
  return [
    defineTool(descriptor('start'), (args) => {
      const headless = args.headless !== false;
      return json(
        startLiveDev(root(args), {
          headless,
          snapshot: true,
          ...(args.backend === 'hardware' || args.backend === 'software' || args.backend === 'auto'
            ? { backend: args.backend }
            : {}),
          ...(args.workers === undefined ? {} : { workers: executionWorkers(args.workers) }),
          ...(args.animation === undefined ? {} : { animation: animationPlayback(args.animation) }),
        }),
      );
    }),
    defineTool(descriptor('status'), (args) => json(liveDevStatus(root(args), { snapshot: true }))),
    ...(
      [
        'observe',
        'reload',
        'stop',
        'capture',
        'eval',
        'find',
        'focus',
        'camera/get',
        'camera/set',
        'camera/release',
      ] as const
    ).map((operation) =>
      defineTool(descriptor(operation.replace('/', '.')), (args) =>
        json(liveDevControl(root(args), operation, args, { snapshot: true })),
      ),
    ),
  ] as readonly ToolContribution[];
}
