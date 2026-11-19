import type { ExecutionWorker, ExecutionWorkersOptions } from '@forgeax/engine-app';
import type { ToolJsonSchema } from '@forgeax/engine-tool-runtime';

/** The CLI transports the App policy unchanged; App owns capability selection. */
const policy = { enum: ['auto', true, false] } satisfies ToolJsonSchema;
const workerProperties = { engine: policy, render: policy, kernels: policy } satisfies Record<
  ExecutionWorker,
  ToolJsonSchema
>;

export const executionWorkersSchema = {
  type: 'object',
  additionalProperties: false,
  properties: workerProperties,
} satisfies ToolJsonSchema;

export function executionWorkers(value: unknown): ExecutionWorkersOptions {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([key, policy]) =>
        !Object.hasOwn(workerProperties, key) || (policy !== 'auto' && typeof policy !== 'boolean'),
    )
  ) {
    throw new TypeError(
      'workers requires an object with engine, render and kernels policies: auto, true or false',
    );
  }
  return value as ExecutionWorkersOptions;
}

/** Ordinary projects select the strongest available worker composition by default. */
export function environmentExecutionWorkers(
  authored: ExecutionWorkersOptions = {},
): ExecutionWorkersOptions {
  const value = process.env.FORGEAX_EXECUTION_WORKERS;
  return value === undefined ? authored : { ...authored, ...executionWorkers(JSON.parse(value)) };
}
