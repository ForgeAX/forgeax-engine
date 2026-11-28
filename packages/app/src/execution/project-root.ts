import {
  type Context,
  type Fiber,
  mountPluginAsset,
  startNativePlugin,
} from '@forgeax/engine-plugin';
import type { PreparedExecutionBootstrap } from './bootstrap-entry';

/** Start outside apply so children may inject services provided by their parent. */
export async function activateExecutionRoot(
  context: Context,
  root: NonNullable<PreparedExecutionBootstrap['root']>,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number | null } = {},
): Promise<{ readonly fiber: Fiber }> {
  const result = await startNativePlugin(
    context,
    {
      name: 'forgeax:project-root',
      inject: ['assets', 'pluginPrograms'],
      async apply(ctx) {
        const mounted = await mountPluginAsset(ctx, root.guid, options.signal);
        if (!mounted.ok) {
          throw Object.assign(
            new Error(`Root PluginAsset mount failed: ${mounted.error.code}`, {
              cause: mounted.error,
            }),
            mounted.error,
          );
        }
      },
    },
    undefined,
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  );
  if (!result.ok) throw result.error;
  return { fiber: result.value };
}
