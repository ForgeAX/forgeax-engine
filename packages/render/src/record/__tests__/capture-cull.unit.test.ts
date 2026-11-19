import { createBoxGeometry } from '@forgeax/engine-geometry';
import { mat4 } from '@forgeax/engine-math';
import { standardTextureMask } from '@forgeax/engine-shader';
import { assert, expect, it } from 'vitest';
import { buildPlanarReflectionView } from '../../capture/planar-view';
import type { CameraSnapshot } from '../../render-contract';
import { captureCullFixture } from './capture-cull.fixture';

it('culls front/back, observes camera rotation and keeps held admission immutable', () => {
  const f = captureCullFixture();
  const front = f.put(1),
    back = f.put(2, 0, 0, 5);
  const first = f.prepare();
  expect(first.visible(front)).toBe(true);
  expect(first.visible(back)).toBe(false);
  const world = mat4.identity(mat4.create());
  world[0] = world[10] = -1;
  const turned = f.prepare({ ...f.camera, world });
  expect(turned.visible(front)).toBe(false);
  expect(turned.visible(back)).toBe(true);
  expect(first.visible(front)).toBe(true);
  expect(first.visible(back)).toBe(false);
});

it('uses the actual oblique mirror projection, including its half-space clip', () => {
  const f = captureCullFixture();
  const world = mat4.invert(
    mat4.create(),
    mat4.lookAt(mat4.create(), [0, 3, 5], [0, 0, 0], [0, 1, 0]),
  );
  const projection = mat4.perspectiveReverseZ(mat4.create(), Math.PI / 3, 1, 0.1, 100);
  const mirror = buildPlanarReflectionView({ world, projection, plane: [0, 1, 0, 0], clipBias: 0 });
  assert(mirror);
  const camera: CameraSnapshot = {
    ...f.camera,
    world: mirror.world,
    position: mirror.position,
    captureProjection: mirror.projection,
  };
  const above = f.put(1, 0, 1, 0),
    below = f.put(2, 0, -1, 0);
  const visible = f.prepare(camera);
  expect(visible.visible(above)).toBe(true);
  expect(visible.visible(below)).toBe(false);
});

it('reads no quiet bounds, follows pose/deletion/slot reuse and keeps prior answers', () => {
  const f = captureCullFixture();
  f.put(1);
  f.put(2, 0, 0, 5);
  const before = f.prepare();
  expect(f.materials.hasBorrowedValues).toBe(false);
  f.reads.mockClear();
  expect(f.prepare().admission).toBe(before.admission);
  expect(f.reads).not.toHaveBeenCalled();
  const changed = f.put(2);
  const moved = f.prepare();
  expect(moved.visible(changed)).toBe(true);
  expect(f.reads.mock.calls.map(([key]) => key)).toEqual([2]);
  const oldSlot = f.scene.slot(2)?.slot;
  f.scene.apply([{ kind: 'remove', entityKey: 2 }]);
  const replacement = f.put(3, 0, 0, 5);
  expect(f.scene.slot(3)?.slot).toBe(oldSlot);
  expect(f.prepare().visible(replacement)).toBe(false);
  expect(moved.visible(changed)).toBe(true);
});

it('rechecks only referenced geometry and observes displacement interval changes', () => {
  const f = captureCullFixture();
  f.meshes = f.meshes.with(1, createBoxGeometry(0.1, 0.1, 0.1).unwrap());
  const source = f.put(1, 4, 0, -5);
  expect(f.prepare().visible(source)).toBe(false);
  f.reads.mockClear();
  f.meshes = f.meshes.with(99, createBoxGeometry(20, 20, 20).unwrap());
  f.prepare();
  expect(f.reads).not.toHaveBeenCalled();
  f.materials = f.materials.with(f.material, undefined, {
    ...f.material.snapshot,
    immutableValues: true,
    standardTextureMask: standardTextureMask([{ name: 'displacementTexture', type: 'texture2d' }]),
    paramSnapshot: { displacementScale: 3, displacementBias: 0 },
  });
  expect(f.prepare().visible(source)).toBe(true);
});

it('retains unknown bounds and invalid projection as conservative visible work', () => {
  const f = captureCullFixture();
  const unknown = f.put(1, 0, 0, 5, { localAabb: new Float32Array(0) });
  const known = f.put(2, 0, 0, 5);
  expect(f.prepare().visible(unknown)).toBe(true);
  expect(f.prepare().visible(known)).toBe(false);
  expect(
    f.prepare({ ...f.camera, captureProjection: new Float32Array(16).fill(NaN) }).visible(known),
  ).toBe(true);
});

it('does not reuse a native entity box for view-generated geometry of that entity', () => {
  const f = captureCullFixture();
  f.put(1, 0, 0, 5);
  const visible = f.prepare();
  const world = mat4.identity(mat4.create());
  world[14] = -5;
  expect(
    visible.visible({
      ...f.source(1),
      generatedMesh: createBoxGeometry(0.6, 0.6, 0.02).unwrap(),
      transform: { world },
    }),
  ).toBe(true);
});

it('uses the aggregate instance extent and rechecks changed instance transforms', () => {
  const f = captureCullFixture();
  f.meshes = f.meshes.with(1, createBoxGeometry(0.1, 0.1, 0.1).unwrap());
  const transforms = mat4.identity(mat4.create());
  transforms[12] = 10;
  const first = f.put(1, 0, 0, -5, {
    instances: {
      transforms,
      instanceCount: 1,
      cacheKey: 1,
      archVersion: 1,
      revision: 1,
    },
  });
  expect(f.prepare().visible(first)).toBe(false);
  const current = f.put(1, 0, 0, -5, {
    instances: {
      transforms: mat4.identity(mat4.create()),
      instanceCount: 1,
      cacheKey: 1,
      archVersion: 1,
      revision: 2,
    },
  });
  expect(f.prepare().visible(current)).toBe(true);
});

it('observes borrowed displacement values edited in place within the same material frame', () => {
  const f = captureCullFixture();
  f.meshes = f.meshes.with(1, createBoxGeometry(0.1, 0.1, 0.1).unwrap());
  const source = f.put(1, 4, 0, -5);
  const values = { displacementScale: 0, displacementBias: 0 };
  const { immutableValues: _owned, ...borrowed } = f.material.snapshot;
  f.materials = f.materials.with(f.material, undefined, {
    ...borrowed,
    standardTextureMask: standardTextureMask([{ name: 'displacementTexture', type: 'texture2d' }]),
    paramSnapshot: values,
  });
  expect(f.materials.hasBorrowedValues).toBe(true);
  expect(f.prepare().visible(source)).toBe(false);
  values.displacementScale = 3;
  expect(f.prepare().visible(source)).toBe(true);
});
