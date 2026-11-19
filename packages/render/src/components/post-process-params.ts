import { defineComponent } from '@forgeax/engine-ecs';

/** Per-shader parameter bytes. Producers supply an explicit Uint8Array byte view. */
export const PostProcessParams = defineComponent('PostProcessParams', {
  shader: 'string',
  data: 'array<u8>',
});
