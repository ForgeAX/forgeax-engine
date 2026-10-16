import { defineComponent } from '@forgeax/engine-ecs';

/**
 * World-owned local transforms for one explicit instanced renderable.
 * Packed column-major mat4 values compose as entityWorld * instanceLocal.
 * ECS owns copying, mutation and entity lifetime, including large arrays.
 * Renderer extraction derives its own snapshot and GPU residency; neither
 * authoring nor glTF SceneAsset lowering requires a Renderer identity.
 *
 * @example
 * const transforms = new Float32Array(20_000 * 16);
 * for (let i = 0; i < 20_000; i++) {
 *   transforms[i * 16] = transforms[i * 16 + 5] =
 *     transforms[i * 16 + 10] = transforms[i * 16 + 15] = 1;
 * }
 * const entity = world.spawn({ component: Instances, data: { transforms } }).unwrap();
 * world.set(entity, Instances, { transforms }).unwrap();
 */
export const Instances = defineComponent('Instances', {
  transforms: { type: 'array<f32>' },
});

export type InstancesData = { readonly transforms: Float32Array };
