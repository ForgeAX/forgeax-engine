import { defineTool, type ToolContribution, toolJsonSchema } from '@forgeax/engine-tool-runtime';
import { animationPlayback, animationPlaybackSchema } from './animation-playback.js';
import { executionWorkers, executionWorkersSchema } from './execution-workers.js';
import { liveDevControl, liveDevStatus, startLiveDev } from './live-dev.js';

/** Both dev and run select the same execution controls. Page and capture defaults belong to each owner. */
export function liveExecutionOptions(
  args: Readonly<Record<string, unknown>>,
): Pick<NonNullable<Parameters<typeof startLiveDev>[1]>, 'backend' | 'workers' | 'animation'> {
  const { backend } = args;
  return {
    ...(backend === 'hardware' || backend === 'software' || backend === 'auto' ? { backend } : {}),
    ...(args.workers === undefined ? {} : { workers: executionWorkers(args.workers) }),
    ...(args.animation === undefined ? {} : { animation: animationPlayback(args.animation) }),
  };
}

/** Thin operation adapters over the existing live owner and its discovery file. */
export function createWorkspaceLiveTools(defaultRoot?: string): readonly ToolContribution[] {
  const descriptor = (operation: string) => {
    const admission = {
      type: 'object',
      required: [...(defaultRoot ? [] : ['root']), ...(operation === 'verify' ? ['revision'] : [])],
      properties: {
        root: { type: 'string', minLength: 1 },
        revision: { type: 'string', minLength: 1 },
        timeoutMs: { type: 'integer', ...(operation === 'verify' ? { minimum: 1 } : {}) },
      },
    } as const;
    return {
      id: `engine.run.${operation}`,
      path: ['engine', 'run', ...operation.split('.')],
      title: `Engine run ${operation}`,
      summary: `${operation} an independent Engine run with fixed project inputs.`,
      realm: 'host' as const,
      argsSchema: toolJsonSchema<Record<string, unknown>>(admission),
      resultSchema: toolJsonSchema({}),
      inputSchema: {
        ...admission,
        properties: {
          ...admission.properties,
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
          lease: { type: 'boolean' },
          readyTimeoutMs: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          distance: { type: 'number' },
          lens: { type: 'object' },
          exposure: { type: 'object' },
          requireUi: { type: 'boolean' },
          entity: { type: 'number' },
          x: { type: 'number' },
          y: { type: 'number' },
          position: { type: 'array', items: { type: 'number' } },
          target: { type: 'array', items: { type: 'number' } },
          up: { type: 'array', items: { type: 'number' } },
        },
      },
      outputSchema: {},
      evidence: [],
    };
  };
  const root = (args: Record<string, unknown>) => String(args.root ?? defaultRoot);
  const json = async (value: unknown) => JSON.parse(JSON.stringify(await value));
  return [
    defineTool(descriptor('start'), (args) => {
      const headless = args.headless !== false;
      return json(
        startLiveDev(root(args), {
          headless,
          snapshot: true,
          ...liveExecutionOptions(args),
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
        'verify',
        'eval',
        'find',
        'pick',
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
