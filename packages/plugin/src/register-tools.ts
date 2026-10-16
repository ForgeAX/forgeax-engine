import type { Context } from '@deepseek-ai/cordis';
import {
  commandContribution,
  isToolCommandContract,
  type ToolApi,
  type ToolContribution,
  type ToolRealm,
} from '@forgeax/engine-tool-runtime';
import { pluginAssetOrigin } from './asset.js';

export interface ToolRegistrationOptions {
  readonly sourceId?: string;
  readonly providerId?: string;
  readonly module?: string;
  readonly realm?: ToolRealm;
}

/** Yield the disposer last in the same generator effect as resources used by these tools. */
export function registerTools(
  ctx: Context,
  tools: readonly ToolContribution[],
  options: ToolRegistrationOptions = {},
): () => Promise<void> {
  const api = ctx.get('toolApi', false) as ToolApi | undefined;
  if (!api) throw new TypeError('registerTools requires the toolApi service; declare it in inject');
  const origin = ctx[pluginAssetOrigin];
  const providerId =
    options.providerId ??
    (origin
      ? `${origin.contextId}:${origin.target}:${origin.guid}:${ctx.fiber.uid}`
      : `${crypto.randomUUID()}:${ctx.fiber.uid}`);
  const module = options.module ?? origin?.program;
  const handle = api.registerProvider({
    providerId,
    sourceId: options.sourceId ?? origin?.sessionId ?? 'native',
    realm: options.realm ?? origin?.target ?? 'engine',
    ...(ctx.fiber.uid === null ? {} : { fiberId: ctx.fiber.uid }),
    ...(origin ? { generation: origin.sessionGeneration } : {}),
    ...(module === undefined ? {} : { module }),
    initialState: ctx.fiber.state === 2 ? 'active' : 'pending',
    fiberState: ctx.fiber.state === 2 ? 'active' : 'loading',
    tools,
  });
  const stop = ctx.on('internal/status', (fiber) => {
    if (fiber !== ctx.fiber) return;
    if (fiber.state === 2) handle.activate('active');
    else if (fiber.state === 3) handle.fail('native plugin failed', 'failed');
    else if (fiber.state === 4 || fiber.state === 5 || fiber.state === 0) {
      void handle.revoke('native plugin no longer active');
    }
  });
  return async () => {
    try {
      await handle.revoke('native plugin disposed');
    } finally {
      stop();
    }
  };
}

/** Asset descriptors and executor edges come from the same delivered contract projection. */
export function registerAssetTools(ctx: Context): () => Promise<void> {
  const origin = ctx[pluginAssetOrigin];
  // Capture the installing asset's projection; callers depend on toolApi,
  // without declaring this loader-owned program table as a service dependency.
  const programs = ctx.get('pluginPrograms', false);
  const contract = origin && programs?.tools?.get(origin.guid);
  if (!programs || !isToolCommandContract(contract))
    throw new TypeError('asset tools are not delivered for this plugin and target');
  const tools = structuredClone(contract).commands.map((declaration) => {
    if (declaration.realm !== programs.target)
      throw new TypeError('asset tool target differs from its program projection');
    const entry =
      declaration.executor === undefined ? undefined : programs.programs.get(declaration.executor);
    if (declaration.executor !== undefined && !entry)
      throw new TypeError(`asset tool executor is not delivered: ${declaration.executor}`);
    return commandContribution(
      declaration,
      entry === undefined
        ? undefined
        : async () => {
            const executor = await entry.load();
            if (typeof executor !== 'function')
              throw new TypeError('invalid delivered tool executor');
            return executor as import('@forgeax/engine-tool-runtime').ToolExecutor<
              unknown,
              unknown
            >;
          },
    );
  });
  if (tools.length === 0) return async () => {};
  return registerTools(ctx, tools);
}
