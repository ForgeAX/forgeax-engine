import { createDecalGeometry, createSphereGeometry } from '@forgeax/engine/geometry';
import { mat4 } from '@forgeax/engine/math';
import { Materials, Visibility, VisibilityStateValue } from '@forgeax/engine/render';
import { defineFeature } from '../../lab/feature';
import { material, spawnMesh, spawnStage, standard } from '../../lab/stage';
import { checker } from './lib/textures';

export default defineFeature({
  title: 'Mesh decals',
  catalog: 'Mesh decals',
  kind: 'visual',
  summary:
    'createDecalGeometry(receiver, { transform }) clips receiver triangles against a receiver-local unit box and returns an ordinary MeshAsset with projector UVs, drawn with a biased overlay material and the receiver transform.',
  expect:
    'ON: a red/white checker sticker wraps around the front of the grey sphere following its curvature. OFF: the decal entity is hidden and the sphere is plain.',
  setup({ world }) {
    spawnStage(world);
    const sphereMesh = createSphereGeometry(0.5, 48, 32).unwrap();
    const receiver = world.allocSharedRef('MeshAsset', sphereMesh);
    const box = mat4.compose(mat4.create(), [0, 0, 0.4], [0, 0, 0, 1], [0.6, 0.6, 0.4]);
    const decal = createDecalGeometry(sphereMesh, { transform: box as never });
    const pose = { pos: [0, 0.9, 0] as const, scale: [1.6, 1.6, 1.6] as const };
    spawnMesh(
      world,
      receiver as never,
      standard(world, { baseColor: [0.6, 0.6, 0.62, 1], roughness: 0.5 }),
      pose,
    );
    const sticker = material(
      world,
      Materials.unlit([1, 1, 1, 1], {
        baseColorTexture: checker(world, [230, 20, 30, 255], [255, 255, 255, 255], 4) as never,
        queue: 3000,
        renderState: {
          depthWriteEnabled: false,
          depthBias: -2,
          depthBiasSlopeScale: -2,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        },
      }),
    );
    const decalMesh =
      decal.ok && decal.value !== null ? world.allocSharedRef('MeshAsset', decal.value) : undefined;
    const entity =
      decalMesh === undefined
        ? undefined
        : spawnMesh(world, decalMesh as never, sticker, pose, {
            component: Visibility,
            data: { state: VisibilityStateValue.visible },
          });
    return {
      toggle(on) {
        if (entity === undefined) return;
        world.set(entity, Visibility, {
          state: on ? VisibilityStateValue.visible : VisibilityStateValue.hidden,
        } as never);
      },
      checks: () => [
        {
          name: 'createDecalGeometry ok',
          ok: decal.ok,
          detail: decal.ok ? 'ok' : decal.error.code,
        },
        { name: 'decal intersects the receiver', ok: decal.ok && decal.value !== null },
        {
          name: 'decal carries projector uv',
          ok: decal.ok && decal.value !== null && decal.value.attributes.uv !== undefined,
        },
      ],
    };
  },
});
