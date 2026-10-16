import { Context, createToolApiPlugin, registerTools } from '@forgeax/engine-plugin';
import type {
  ToolApi,
  ToolContribution,
  ToolRunOptions,
  ToolTerminal,
} from '@forgeax/engine-tool-runtime';

export async function runLibraryTool<TArgs, TResult>(
  contribution: ToolContribution<TArgs, TResult>,
  args: TArgs,
  options?: ToolRunOptions,
): Promise<ToolTerminal<TResult>> {
  const context = new Context();
  await context.plugin(createToolApiPlugin());
  const api = context.get('toolApi', false) as ToolApi | undefined;
  if (api === undefined) throw new Error('library tool owner did not install ToolApi');
  const providerId = `devkit-library:${contribution.descriptor.id}:${crypto.randomUUID()}`;
  const fiber = await context.plugin({
    name: `forgeax:library-tool/${contribution.descriptor.id}`,
    inject: ['toolApi'],
    apply(ctx) {
      ctx.effect(() =>
        registerTools(ctx, [contribution as ToolContribution], {
          sourceId: 'devkit-library',
          providerId,
          module: '@forgeax/engine-devkit',
          realm: contribution.descriptor.realm,
        }),
      );
    },
  });
  try {
    const { owner: _owner, ...runOptions } = options ?? {};
    return (await api.run<TResult>(contribution.descriptor.id, args, {
      ...runOptions,
      providerId,
      sourceId: 'devkit-library',
    }).terminal) as ToolTerminal<TResult>;
  } finally {
    await fiber.dispose();
    await context.fiber.dispose();
  }
}
