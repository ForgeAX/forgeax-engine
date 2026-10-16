import { expectTypeOf } from 'vitest';
import type { HostAssemblyErrorDetailByCode, HostErrorSummary } from '../protocol.js';

// Preserve the public wire detail independently of its implementation.
expectTypeOf<HostAssemblyErrorDetailByCode['host-assembly-not-ready']>().toEqualTypeOf<{
  readonly entryId: string;
  readonly fiberState: string;
  readonly failure?: HostErrorSummary;
}>();

import type { BackendHostActivationStatus } from '../backend.js';
import type { FrontendHostState, FrontendHostStatus } from '../frontend.js';

expectTypeOf<FrontendHostState>().toEqualTypeOf<
  'created' | 'loading' | 'active' | 'failed' | 'disposed'
>();
expectTypeOf<BackendHostActivationStatus['state']>().toEqualTypeOf<
  'created' | 'loading' | 'active' | 'failed' | 'disposed' | 'unavailable'
>();
expectTypeOf<FrontendHostStatus['error']>().toEqualTypeOf<unknown>();
expectTypeOf<BackendHostActivationStatus['error']>().toEqualTypeOf<unknown>();

import type { Context, Plugin } from '@forgeax/engine-plugin';
import type { BackendHostOptions } from '../backend.js';
import type { FrontendHostOptions } from '../frontend.js';

type StartupInput = {
  readonly context?: Context;
  readonly startupTimeoutMs?: number | null;
  readonly startupPlugins?: readonly Plugin[];
};
expectTypeOf<Pick<FrontendHostOptions, keyof StartupInput>>().toEqualTypeOf<StartupInput>();
expectTypeOf<Pick<BackendHostOptions, keyof StartupInput>>().toEqualTypeOf<StartupInput>();
expectTypeOf<BackendHostOptions>().not.toHaveProperty('cleanupTimeoutMs');
