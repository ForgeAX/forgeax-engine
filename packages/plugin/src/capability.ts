import type { Context } from '@deepseek-ai/cordis';
import {
  createCapabilityResolver,
  type ToolCapabilityResolver,
} from '@forgeax/engine-tool-runtime';

/** Bridge one active Cordis realm into the realm-neutral ToolRuntime seam. */
export function createContextCapabilityResolver(ctx: Context): ToolCapabilityResolver {
  return createCapabilityResolver((capability) => Reflect.get(ctx, capability.id));
}
