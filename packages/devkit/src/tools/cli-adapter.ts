import { describeResourcePreviewFailure } from '@forgeax/engine-preview';
import {
  capabilityUnavailableError,
  type JsonValue,
  type ToolRuntime,
  type ToolTerminal,
} from '@forgeax/engine-tool-runtime';

export function decorateResourcePreviewTerminal<TResult>(
  terminal: ToolTerminal<TResult>,
): ToolTerminal<TResult> {
  if (terminal.outcome === 'succeeded') return terminal;
  const recovery = describeResourcePreviewFailure(terminal.failure);
  if (recovery === undefined) return terminal;
  if (terminal.failure.code !== 'tool-domain-failed') return terminal;
  return {
    ...terminal,
    failure: {
      ...terminal.failure,
      detail: {
        ...terminal.failure.detail,
        ...(recovery.suggestedOperation === undefined
          ? {}
          : { suggestedOperation: recovery.suggestedOperation }),
        recovery: recovery.actions,
      },
    },
  };
}

function missingTool(id: string): ToolTerminal<never> {
  return {
    outcome: 'failed',
    failure: capabilityUnavailableError(`tool:${id}`, 'build'),
    artifacts: [],
  };
}

export function runNamedTool(
  runtime: ToolRuntime,
  id: string,
  args: unknown,
): Promise<ToolTerminal<unknown>> {
  const contribution = runtime.get(id);
  if (contribution === undefined) return Promise.resolve(missingTool(id));
  return runtime.run(contribution, args).terminal.then(decorateResourcePreviewTerminal);
}

export function runGenericTool(
  runtime: ToolRuntime,
  id: string,
  encodedArgs: string,
): Promise<ToolTerminal<unknown>> {
  let args: JsonValue;
  try {
    args = JSON.parse(encodedArgs) as JsonValue;
  } catch {
    return Promise.resolve({
      outcome: 'failed',
      failure: {
        code: 'tool-invalid-args',
        expected: 'generic CLI arguments to be valid JSON',
        hint: 'Encode one JSON value that conforms to the descriptor argsSchema.',
        detail: { message: 'Invalid JSON', value: null },
      },
      artifacts: [],
    });
  }
  return runNamedTool(runtime, id, args);
}
