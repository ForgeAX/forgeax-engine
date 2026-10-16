import type { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { createGizmoPresentation, TransformGizmo } from '@forgeax/engine-interaction';
import { quat } from '@forgeax/engine-math';
import {
  Camera,
  DirectionalLight,
  Materials,
  MeshFilter,
  MeshRenderer,
  orthographic,
  perspective,
} from '@forgeax/engine-render';
import { ChildOf, Name, propagateTransforms, Transform } from '@forgeax/engine-scene';
import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';

export function createGizmoScene(world: World, width: number, height: number) {
  const mesh = world.allocSharedRef<'MeshAsset', MeshAsset>(
    'MeshAsset',
    createBoxGeometry(1, 1, 1).unwrap(),
  );
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.08, 0.5, 0.57, 1], metallic: 0.1, roughness: 0.5 }),
  );
  const floorMat = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.09, 0.12, 0.17, 1], roughness: 0.85 }),
  );
  world
    .spawn({
      component: DirectionalLight,
      data: { direction: [-0.4, -1, -0.5], color: [1, 0.95, 0.85], intensity: 3 },
    })
    .unwrap();
  world
    .spawn(
      { component: Transform, data: { pos: [0, -0.85, 0], scale: [9, 0.15, 9] } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [floorMat] } },
    )
    .unwrap();
  const parent = world.spawn({ component: Transform, data: {} }).unwrap();
  const target = world
    .spawn(
      { component: Name, data: { value: 'Editable object' } as never },
      { component: Transform, data: { scale: [1.6, 1.1, 0.8] } },
      { component: ChildOf, data: { parent } },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const rotation = quat.create();
  quat.fromLookAt(rotation, [4, 3, 6], [0, 0, 0], [0, 1, 0]);
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [4, 3, 6], quat: rotation } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 4, aspect: width / height, autoAspect: false }),
          clearColor: [0.025, 0.035, 0.055, 1],
        },
      },
    )
    .unwrap();
  const gizmo = new TransformGizmo(world);
  gizmo.attach(target);
  const presentation = createGizmoPresentation(gizmo);
  let ortho = false;
  const sync = () => {
    propagateTransforms(world).unwrap();
    gizmo.update(camera, width, height);
    presentation.sync();
    propagateTransforms(world).unwrap();
  };
  return {
    target,
    parent,
    camera,
    gizmo,
    presentation,
    sync,
    resize(w: number, h: number) {
      if (w === width && h === height) return;
      width = w;
      height = h;
      if (w > 0 && h > 0)
        world
          .set(
            camera,
            Camera,
            ortho
              ? orthographic({ left: (-4 * w) / h, right: (4 * w) / h, top: 4, bottom: -4 })
              : { aspect: w / h },
          )
          .unwrap();
    },
    enable(value: boolean) {
      gizmo.attach(value ? target : undefined);
      sync();
    },
    reset() {
      gizmo.cancel();
      world
        .set(target, Transform, { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1.6, 1.1, 0.8] })
        .unwrap();
      sync();
    },
    parented(value: boolean) {
      gizmo.cancel();
      const q = quat.create();
      quat.fromAxisAngle(q, [0, 1, 0], value ? 0.6 : 0);
      world
        .set(parent, Transform, {
          pos: value ? [0.4, 0, 0] : [0, 0, 0],
          quat: q,
          scale: value ? [1.3, 0.8, 1.1] : [1, 1, 1],
        })
        .unwrap();
      sync();
    },
    orthographic(value: boolean) {
      ortho = value;
      gizmo.cancel();
      world
        .set(
          camera,
          Camera,
          value
            ? orthographic({
                left: (-4 * width) / height,
                right: (4 * width) / height,
                top: 4,
                bottom: -4,
              })
            : perspective({ fov: Math.PI / 4, aspect: width / height, autoAspect: false }),
        )
        .unwrap();
      sync();
    },
  };
}
