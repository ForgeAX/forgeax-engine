import {
  Group,
  Matrix4,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { hasPositiveUniformSourceBasis, POSE_LANES, readLocalPose, SourcePosePage } from '../pose';
import { SpritePoseReader, spriteMatrix } from '../sprite';

function compose(pose: number[]): Matrix4 {
  return new Matrix4().compose(
    new Vector3().fromArray(pose, 0),
    new Quaternion().fromArray(pose, 3),
    new Vector3().fromArray(pose, 7),
  );
}

function expectMatrix(a: Matrix4, b: Matrix4): void {
  for (let lane = 0; lane < 16; lane++)
    expect(a.elements[lane]).toBeCloseTo(b.elements[lane] ?? 0, 5);
}

it('publishes a Sprite pose through a turning perspective or orthographic camera', () => {
  const material = new SpriteMaterial({ rotation: 0.72, sizeAttenuation: false });
  const sprite = new Sprite(material);
  const group = new Group();
  group.add(sprite);
  group.rotation.set(-0.4, 0.2, 0.4);
  sprite.position.set(-0.25, 1.4, 1.6);
  sprite.center.set(0.85, 0.22);
  sprite.scale.set(0.35, 1.2, 1);
  group.updateMatrixWorld(true);
  const reader = new SpritePoseReader();
  const pose: number[] = [];
  try {
    for (const camera of [new PerspectiveCamera(), new OrthographicCamera()]) {
      for (const side of [-1, 1]) {
        camera.position.set(side * 2, 3, 6);
        camera.lookAt(0, 1, 0);
        camera.updateMatrixWorld(true);
        reader.begin();
        expect(reader.read(sprite, camera, material, material, pose)).toBe(true);
        expectMatrix(compose(pose), spriteMatrix(sprite, camera));
      }
      camera.matrixWorldInverse.scale(new Vector3(2, 1, 1));
      reader.begin();
      expect(reader.read(sprite, camera, material, material, pose)).toBe(false);
    }
    sprite.scale.x = 0;
    group.updateMatrixWorld(true);
    const camera = new PerspectiveCamera();
    camera.position.z = 5;
    camera.updateMatrixWorld(true);
    reader.begin();
    expect(reader.read(sprite, camera, material, material, pose)).toBe(false);
  } finally {
    material.dispose();
  }
});

it('issues independent bounded pose rows that preserve the exact validated scalar values', () => {
  const page = new SourcePosePage();
  const rows = Array.from({ length: 65 }, () => page.issueRecord());
  const first = rows[0] as Float64Array;
  const last = rows[64] as Float64Array;
  expect(first.length).toBe(POSE_LANES);
  expect(rows[1]?.buffer).toBe(first.buffer);
  expect(last.buffer).not.toBe(first.buffer);
  expect(first.buffer.byteLength).toBeLessThanOrEqual(
    8 * POSE_LANES * Float64Array.BYTES_PER_ELEMENT,
  );
  const staged = page.reserve(2);
  staged.set([-0, 1 + 2 ** -40, 2, 0, 0, 0, 1, 1, 1, 1], POSE_LANES);
  const offset = POSE_LANES;
  page.writeRecord(first, offset);
  expect(page.matchesRecord(first, offset)).toBe(true);
  staged[offset] = 0;
  expect(page.matchesRecord(first, offset)).toBe(false);
  staged[offset] = -0;
  staged[offset + 1] = 1;
  expect(page.matchesRecord(first, offset)).toBe(false);
  page.release(0);
  expect(Object.is(first[0], -0)).toBe(true);
  expect(first[1]).toBe(1 + 2 ** -40);
  expect(last).toEqual(new Float64Array(POSE_LANES));
  expect(page.issueRecord().buffer).not.toBe(last.buffer);
});

it('reads the source local pose independently of the inherited world transform', () => {
  const parent = new Group(),
    child = new Group();
  parent.add(child);
  parent.position.set(1, -2, 3);
  parent.rotation.set(0.1, 0.4, -0.3);
  parent.scale.setScalar(2);
  child.position.set(-0.4, 1.5, 2);
  child.rotation.set(0.23, 0.8, -0.42);
  child.scale.set(0.3, 1.5, 2);
  parent.updateMatrixWorld(true);
  const pose: number[] = [];
  expect(readLocalPose(child, pose)).toBe(true);
  expectMatrix(compose(pose), child.matrix);
  expectMatrix(parent.matrixWorld.clone().multiply(compose(pose)), child.matrixWorld);
  child.scale.x = 0;
  expect(readLocalPose(child, pose)).toBe(false);
});

it('uses authored hierarchy scales to identify a positive uniform basis', () => {
  const outer = new Group(),
    parent = new Group();
  outer.add(parent);
  outer.rotation.set(0.1, 0.4, -0.3);
  outer.scale.setScalar(0.75);
  parent.rotation.set(0.53, -0.93, 0.76);
  parent.scale.setScalar(2.3);
  const eligible = () => hasPositiveUniformSourceBasis(parent);
  expect(eligible()).toBe(true);
  parent.scale.set(2, 3, 4);
  expect(eligible()).toBe(false);
  parent.scale.setScalar(0);
  expect(eligible()).toBe(false);
});
