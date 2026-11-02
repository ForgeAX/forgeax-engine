import type {} from '@forgeax/engine/devkit/plugin-build';
import { createMeshJobCooker } from '@forgeax/engine/modeling';
import type { Plugin } from '@forgeax/engine/plugin';
import { G7_JOB } from '../../../../packages/modeling/examples/maid-whale/g7-face-job.ts';

/** Build root: the G7 face figure is a `modeling-mesh-job` cook source. */
export default {
  name: 'modeling-show/maid-whale-g7-build',
  inject: ['nativeCookers'],
  apply(ctx) {
    ctx.effect(() => ctx.nativeCookers!.register(createMeshJobCooker([G7_JOB])));
  },
} satisfies Plugin;
