import { Context, createToolApiPlugin, registerTools } from '@forgeax/engine-plugin';
import type {
  ToolApi,
  ToolApiProviderInput,
  ToolApiRunOptions,
  ToolContribution,
  ToolRunOptions,
  ToolTerminal,
} from '@forgeax/engine-tool-runtime';

export async function runLibraryTool<TArgs, TResult>(
  contribution: ToolContribution<TArgs, TResult>,
  args: TArgs,
  options?: ToolRunOptions,
): Promise<ToolTerminal<TResult>> {
  const providerId = `devkit-library:${contribution.descriptor.id}:${crypto.randomUUID()}`;
  const { api, mount } = await startLibraryToolProvider([
    {
      name: `forgeax:library-tool/${contribution.descriptor.id}`,
      sourceId: 'devkit-library',
      providerId,
      realm: contribution.descriptor.realm,
      tools: [contribution as ToolContribution],
    },
  ]);
  try {
    const { owner: _owner, ...runOptions } = options ?? {};
    return (await api.run<TResult>(contribution.descriptor.id, args, {
      ...runOptions,
      providerId,
      sourceId: 'devkit-library',
    }).terminal) as ToolTerminal<TResult>;
  } finally {
    await mount.dispose();
  }
}

type ToolProviderRoute = Pick<ToolApiProviderInput, 'providerId' | 'sourceId'>;
type ToolProviderMountInput = ToolProviderRoute &
  Pick<ToolApiProviderInput, 'realm' | 'module' | 'tools'> & { readonly name: string };

async function disposeToolFibers(fibers: Context['fiber'][]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const fiber of fibers.splice(0).reverse()) {
    try {
      await fiber.dispose();
    } catch (cause) {
      failures.push(cause);
    }
  }
  return failures;
}

function installationFailure(cause: unknown, cleanupFailures: readonly unknown[]): never {
  if (cleanupFailures.length > 0)
    throw new AggregateError([cause, ...cleanupFailures], 'Tool provider installation failed');
  throw cause;
}

async function startLibraryToolProvider(providers: readonly ToolProviderMountInput[]) {
  const context = new Context();
  let api: ToolApi;
  try {
    await context.plugin(createToolApiPlugin());
    const installed = context.get('toolApi', false) as ToolApi | undefined;
    if (installed === undefined) throw new Error('library tool owner did not install ToolApi');
    api = installed;
  } catch (cause) {
    installationFailure(cause, await disposeToolFibers([context.fiber]));
  }
  return { api, mount: await mountToolProviders(context, providers, true) };
}

export async function mountToolProviders(
  context: Context,
  providers: readonly ToolProviderMountInput[],
  ownsContext: boolean,
) {
  const fibers: Context['fiber'][] = ownsContext ? [context.fiber] : [];
  const routes = new Map<string, ToolProviderRoute[]>();
  let closing: Promise<unknown[]> | undefined;
  const close = () => (closing ??= Promise.resolve().then(() => disposeToolFibers(fibers)));
  try {
    for (const { name, tools, ...authority } of providers) {
      if (tools.length === 0) continue;
      const fork = context.plugin({
        name,
        inject: ['toolApi'],
        apply(ctx) {
          ctx.effect(() =>
            registerTools(ctx, tools, {
              ...authority,
              module: authority.module ?? '@forgeax/engine-devkit',
            }),
          );
        },
      });
      fibers.push(fork);
      await fork;
      const route = { providerId: authority.providerId, sourceId: authority.sourceId };
      for (const { descriptor } of tools) {
        const matches = routes.get(descriptor.id);
        if (matches === undefined) routes.set(descriptor.id, [route]);
        else matches.push(route);
      }
    }
  } catch (cause) {
    installationFailure(cause, await close());
  }
  return {
    prefer<T extends ToolApiRunOptions>(id: string, options: T): T {
      const matches = routes.get(id);
      return options.providerId === undefined &&
        options.sourceId === undefined &&
        matches?.length === 1
        ? { ...options, ...matches[0] }
        : options;
    },
    async dispose(previous: readonly unknown[] = [], message?: string): Promise<void> {
      const failures = [...previous, ...(await close())];
      if (failures.length === 1 && message === undefined) throw failures[0];
      if (failures.length > 0)
        throw new AggregateError(failures, message ?? 'Tool provider cleanup failed');
    },
  };
}
