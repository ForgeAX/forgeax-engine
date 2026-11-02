import type {} from '@forgeax/engine/devkit/plugin-build';
import { createMeshJobCooker } from '@forgeax/engine/modeling';
import type { Plugin } from '@forgeax/engine/plugin';
import { S6_JOBS } from '../../../../packages/modeling/examples/mech-gt/s6-job.ts';
import { S7_JOB } from '../../../../packages/modeling/examples/mech-gt/s7-job.ts';

// The S7 rig build alone exceeded the 10 min default on a loaded host.
const COOK_TIMEOUT_MS = 1_800_000;

/**
 * Build root: the S7 rig and the S6 part groups (with their LODs and baked maps) are
 * `modeling-mesh-job` cook sources; one cooker builds each job once for all its outputs.
 */
export default {
  name: 'modeling-show/mech-gt-build',
  inject: ['nativeCookers'],
  apply(ctx) {
    ctx.effect(() => ctx.nativeCookers!.register(createMeshJobCooker([S7_JOB, ...S6_JOBS], { timeoutMs: COOK_TIMEOUT_MS })));
  },
} satisfies Plugin;
