import UniformNode from 'three/src/nodes/core/UniformNode.js';
import {
  BufferGeometry,
  Color,
  Line,
  PerspectiveCamera,
  Sprite,
  Texture,
  Vector2,
  Vector3,
} from 'three/src/Three.Core.js';
import { expect, it } from 'vitest';
import { projectGeometry } from '../geometry';
import { lineStyle } from '../lines';
import { validateMaterial } from '../material';
import {
  LineDashedNodeMaterial,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  PointsNodeMaterial,
  SpriteNodeMaterial,
} from '../node-materials';
import { spriteMatrix } from '../sprite';

it('projects Sprite local position, rotation and positive scale without modifying source authoring values', () => {
  const material = new SpriteNodeMaterial({ rotation: -0.5 });
  const sprite = new Sprite(material),
    camera = new PerspectiveCamera();
  sprite.position.set(1, 2, -4);
  sprite.scale.set(2, 3, 1);
  sprite.center.set(0.2, 0.7);
  sprite.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  material.positionNode = new UniformNode<'vec3', Vector3>(new Vector3(0.3, -0.2, 0));
  material.rotationNode = new UniformNode(0.6);
  material.scaleNode = new UniformNode<'vec2', Vector2>(new Vector2(0.7, 1.2));
  expect(validateMaterial(material).ok).toBe(true);
  const expected = sprite.clone();
  expected.material = material.clone();
  expected.material.positionNode =
    expected.material.rotationNode =
    expected.material.scaleNode =
      null;
  expected.material.rotation = 0.6;
  expected.position.set(1.6, 1.4, -4);
  expected.scale.set(1.4, 3.6, 1);
  expected.updateMatrixWorld(true);
  const actual = spriteMatrix(sprite, camera).elements,
    reference = spriteMatrix(expected, camera).elements;
  for (let i = 0; i < 16; i++) expect(actual[i]).toBeCloseTo(reference[i] ?? 0, 6);
  expect(sprite.position.toArray()).toEqual([1, 2, -4]);
  expect(material.rotation).toBe(-0.5);
  expect(sprite.scale.toArray()).toEqual([2, 3, 1]);
  material.dispose();
  expected.material.dispose();
});

it('uses dash uniform values in existing affine line-distance normalization, including negative and zero rates', () => {
  const geometry = new BufferGeometry();
  const line = new Line(geometry, new LineDashedNodeMaterial());
  line.geometry.setFromPoints([new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(2, 0, 0)]);
  line.computeLineDistances();
  const material = line.material as LineDashedNodeMaterial;
  const scale = new UniformNode(2);
  material.offsetNode = new UniformNode(0.1);
  material.dashScaleNode = scale;
  material.dashSizeNode = new UniformNode(0.4);
  material.gapSizeNode = new UniformNode(0.2);
  const payload = projectGeometry(geometry, false, undefined, 'line-strip').unwrap();
  if (payload === undefined) throw Error('missing line payload');
  const read = () => lineStyle(line, payload, [validateMaterial(material).unwrap()]);
  expect(read()).toEqual({ dashSize: 0.2, gapSize: 0.1, dashOffset: 0.05 });
  scale.value = -2;
  expect(read()).toMatchObject({ dashSize: 0.2, gapSize: 0.1 });
  expect(read()?.dashOffset).toBeCloseTo(0.15, 10);
  scale.value = 0;
  expect(read()).toEqual({ dashSize: 1, gapSize: 0, dashOffset: 0 });
  expect(material.scale).toBe(1);
  material.dispose();
  geometry.dispose();
});

it('keeps anisotropy node input rejected while native pixel parity remains unqualified', () => {
  const source = new MeshPhysicalNodeMaterial();
  source.anisotropyNode = new UniformNode<'vec2', Vector2>(new Vector2(0.3, 0.4));
  expect(() => validateMaterial(source).unwrap()).toThrow('NodeMaterial.anisotropyNode');
  source.dispose();
});

it('rejects out-of-model, invalid vector shapes and unsupported Sprite scale values', () => {
  for (const Type of [MeshBasicNodeMaterial, PointsNodeMaterial]) {
    const material = new Type();
    Reflect.set(material, 'rotationNode', new UniformNode(0.4));
    expect(() => validateMaterial(material).unwrap()).toThrow('NodeMaterial.rotationNode');
    material.dispose();
  }
  const material = new SpriteNodeMaterial();
  material.positionNode = new UniformNode<'color', Color>(new Color('red'));
  expect(() => validateMaterial(material).unwrap()).toThrow('Vector3');
  material.positionNode = null;
  for (const vector of [new Vector2(0, 1), new Vector2(-1, 1), new Vector2(NaN, 1)]) {
    material.scaleNode = new UniformNode<'vec2', Vector2>(vector);
    expect(() => validateMaterial(material).unwrap()).toThrow('three-invalid-value');
  }
  material.dispose();
});

it('rejects Sprite graph getters before publication and keeps material assets quiet for pose-only edits', async () => {
  const { AssetRegistry } = await import('@forgeax/engine-assets-runtime');
  const { MeshRenderer, samplerContribution } = await import('@forgeax/engine-render');
  const { Scene, NoToneMapping } = await import('three/src/Three.Core.js');
  const { default: TextureNode } = await import('three/src/nodes/accessors/TextureNode.js');
  const { cameraData } = await import('../camera');
  const { SceneProjection } = await import('../scene');
  const assets = new AssetRegistry();
  assets.installDecoder(samplerContribution.kind, samplerContribution.decoder);
  const projection = new SceneProjection(assets),
    scene = new Scene(),
    camera = new PerspectiveCamera();
  camera.position.z = 5;
  const material = new SpriteNodeMaterial(),
    sprite = new Sprite(material);
  scene.add(sprite);
  const invalid = new TextureNode(new Texture());
  Reflect.set(invalid, 'referenceNode', invalid);
  material.positionNode = invalid;
  const sync = () => projection.sync(scene, camera, cameraData(camera, NoToneMapping, 1));
  try {
    expect(sync).toThrow('NodeMaterial.positionNode');
    const pending = projection.entityFor(sprite);
    if (pending === undefined) throw new Error('expected a projected pose');
    expect(projection.world.hasComponent(pending, MeshRenderer)).toBe(false);
    const position = new UniformNode<'vec3', Vector3>(new Vector3(0, 0, 0));
    material.positionNode = position;
    sync();
    const entity = projection.entityFor(sprite);
    if (entity === undefined) throw Error('missing sprite');
    const handle = () => projection.world.get(entity, MeshRenderer).unwrap().materials[0];
    const original = handle(),
      observer = assets.observe().unwrap();
    for (let i = 0; i < 20; i++) sync();
    expect(observer.read().unwrap().changes).toEqual([]);
    position.value.x = 0.5;
    sync();
    expect(handle()).toBe(original);
    expect(observer.read().unwrap().changes).toEqual([]);
    observer.dispose();
  } finally {
    Reflect.set(invalid, 'referenceNode', null);
    invalid.value.dispose();
    material.dispose();
    sprite.geometry.dispose();
    projection.dispose();
    assets.dispose();
  }
});

it('keeps a zero-scale dash visible when its constant phase equals dashSize', () => {
  const geometry = new BufferGeometry().setFromPoints([
    new Vector3(-1, 0, 0),
    new Vector3(1, 0, 0),
  ]);
  const material = new LineDashedNodeMaterial();
  material.offsetNode = new UniformNode(0.3);
  material.dashScaleNode = new UniformNode(0);
  material.dashSizeNode = new UniformNode(0.3);
  material.gapSizeNode = new UniformNode(0.15);
  const line = new Line(geometry, material),
    payload = projectGeometry(geometry, false, undefined, 'line-strip').unwrap();
  if (payload === undefined) throw Error('missing line payload');
  expect(lineStyle(line, payload, [validateMaterial(material).unwrap()])).toEqual({
    dashSize: 1,
    gapSize: 0,
    dashOffset: 0,
  });
  geometry.dispose();
  material.dispose();
});
