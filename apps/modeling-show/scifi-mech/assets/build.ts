import type {} from '@forgeax/engine/devkit/plugin-build';
import type { Plugin } from '@forgeax/engine/plugin';
import { createC410Cooker } from '../../../../packages/modeling/examples/scifi-mech/show-job.ts';

/** Build root: the C-410 low meshes, baked maps and decimated detail preview are `modeling-mesh-job` cook sources. */
export default {
  name: 'modeling-show/scifi-mech-build',
  inject: ['nativeCookers'],
  apply(ctx) {
    ctx.effect(() => ctx.nativeCookers!.register(createC410Cooker()));
  },
} satisfies Plugin;
