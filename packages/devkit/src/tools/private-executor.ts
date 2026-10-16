import type {
  ToolContribution,
  ToolRunOptions,
  ToolRuntime,
  ToolTerminal,
} from '@forgeax/engine-tool-runtime';

export function runPrivateTool<TArgs, TResult>(
  runtime: ToolRuntime,
  contribution: ToolContribution<TArgs, TResult>,
  args: TArgs,
  options?: ToolRunOptions,
): Promise<ToolTerminal<TResult>> {
  return runtime.run(contribution, args, options).terminal;
}
