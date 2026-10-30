import { Context, type Fiber, type Plugin, startNativePlugin } from '@forgeax/engine-plugin';
import { beforeDeadline } from './deadline.js';
import { HostAssemblyError } from './protocol.js';

/**
 * The product-neutral host bootstrap. It owns only a Cordis Context and the
 * supplied startup entries; assembly, transport, Project, and App are all
 * ordinary plugins layered above this seam.
 */
export interface HostStartupOptions {
  readonly context?: Context;
  readonly startupTimeoutMs?: number | null;
  readonly startupPlugins?: readonly Plugin[];
}

export interface HostStartup {
  readonly context: Context;
  readonly ownedContext: boolean;
  readonly fibers: readonly Fiber[];
  dispose(): Promise<void>;
}

export async function createHostStartup(options: HostStartupOptions = {}): Promise<HostStartup> {
  const context = options.context ?? new Context();
  const ownedContext = options.context === undefined;
  const fibers: Fiber[] = [];
  let disposal: Promise<void> | undefined;
  try {
    const startupRoot: Plugin = {
      name: 'forgeax:host-startup',
      apply(ctx) {
        for (const plugin of options.startupPlugins ?? []) ctx.plugin(plugin);
      },
    };
    const result = await startNativePlugin(context, startupRoot, undefined, {
      timeoutMs: options.startupTimeoutMs ?? null,
    });
    if (!result.ok) throw result.error;
    fibers.push(result.value);
  } catch (error) {
    const failures: unknown[] = [error];
    if (ownedContext) {
      try {
        await beforeDeadline(
          context.fiber.dispose(),
          5_000,
          () =>
            new HostAssemblyError(
              'host-assembly-cleanup-timeout',
              'Host cleanup to settle',
              'terminate the owning environment',
              { milliseconds: 5_000 },
            ),
        );
      } catch (cause) {
        failures.push(cause);
      }
    }
    throw failures.length === 1
      ? error
      : new AggregateError(failures, 'Host startup and cleanup failed');
  }
  return {
    context,
    ownedContext,
    fibers,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposal = (async () => {
        const failures: unknown[] = [];
        for (const fiber of [...fibers].reverse()) {
          try {
            await fiber.dispose();
          } catch (cause) {
            failures.push(cause);
          }
        }
        if (ownedContext) {
          try {
            await context.fiber.dispose();
          } catch (cause) {
            failures.push(cause);
          }
        }
        if (failures.length) throw new AggregateError(failures, 'Host startup cleanup failed');
      })();
      return disposal;
    },
  };
}
