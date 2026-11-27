import { runtimePackTaskKinds } from '@forgeax/engine-import';
import { runtimeTaskKinds } from '@forgeax/engine-runtime/internal/tasks';
import type { TaskRegistry } from '@forgeax/engine-types';

/** Dispatcher and worker use the same registration and resource budget. */
export const executionTaskKinds: TaskRegistry = { ...runtimeTaskKinds, ...runtimePackTaskKinds };
