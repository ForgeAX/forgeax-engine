import type {} from '@forgeax/engine/devkit/plugin-build';
import { createMeshJobCooker } from '@forgeax/engine/modeling';
import type { Plugin } from '@forgeax/engine/plugin';
import { G6_JOB } from '../../../../packages/modeling/examples/maid-whale/faceting.ts';

/** Build root: the G6 faceted character is a `modeling-mesh-job` cook source. */
export default {
  name: 'modeling-show/maid-whale-build',
  inject: ['nativeCookers'],
  apply(ctx) {
    ctx.effect(() => ctx.nativeCookers!.register(createMeshJobCooker([G6_JOB])));
  },
} satisfies Plugin;
