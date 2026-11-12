import type {} from '@forgeax/engine/devkit/plugin-build';
import { createMeshJobCooker } from '@forgeax/engine/modeling';
import type { Plugin } from '@forgeax/engine/plugin';
import { S6_JOBS } from '../../../../packages/modeling/examples/mech-gt/s6-job.ts';

// A cook of the part groups exceeded the 10 min default on a loaded host.
const COOK_TIMEOUT_MS = 1_800_000;

/** Build root: the S6 part groups (with their LODs and baked maps) are `modeling-mesh-job` cook sources. */
export default {
  name: 'modeling-show/mech-gt-car-build',
  inject: ['nativeCookers'],
  apply(ctx) {
    ctx.effect(() => ctx.nativeCookers!.register(createMeshJobCooker(S6_JOBS, { timeoutMs: COOK_TIMEOUT_MS })));
  },
} satisfies Plugin;
